// 離線 harness（npx tsx scripts/ground_audit.ts）：
// 2026-07-18 新增地面元件的回歸驗證——
//   1. 停止線（buildStopLines）：實驗範圍/轉向真值行向有生成、不畫進死路端
//   2. 分向線終止端收邊（buildDividers）：大學西路黃線不再延伸到援中路路面上
//   3. 路寬微調（extra_width_m）：width_m 變、divOffM/車道位置不動
//   4. 右轉附加車道（right_lane journal）：幾何生成 + 停止線跟著加寬
// 與 app 相同管線建底圖（僅楠梓 shard，同 mapCore 預設）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, buildDividers, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { haversine } from '../src/core/geo'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import {
  buildTurnBays, buildStopLines, buildRightLanes, buildLaneArrows,
} from '../src/core/turnbays'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

// ── 底圖（同 mapCore：楠梓 shard + seed journal）──
const parsed = parseImported(readFileSync(join(DATA, 'lanepilot/area_4212599.segments.jsonl'), 'utf8'))
if (parsed.kind !== 'map') throw new Error('shard 解析失敗')
const { roads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal: EnhancementRecord[] = JSON.parse(readFileSync(join(DATA, 'seed_journal.json'), 'utf8'))
  .filter((r: EnhancementRecord) => r.author !== 'lanepilot')
applyToRoads(roads, foldJournal(journal))
const graph = new RoadGraph(roads)
console.log(`底圖：${roads.length} 區塊, journal ${journal.length} 筆, nodeRemap ${nodeRemap.size}`)

// ── 1. 停止線 ──
const bays = buildTurnBays(graph, journal)
const stops = buildStopLines(graph, bays, [])
check('停止線有生成', stops.length > 0, `${stops.length} 條（bay ${bays.length} 個）`)
check('停止線皆為兩點橫線', stops.every((s) => s.coords.length === 2 && s.color === 'stop'))
const stopLens = stops.map((s) => haversine(s.coords[0], s.coords[1]))
check('停止線長度合理（1.5m~40m）',
  stopLens.every((L) => L > 1.5 && L < 40),
  `min ${Math.min(...stopLens).toFixed(1)}m / max ${Math.max(...stopLens).toFixed(1)}m`)

// ── 2. 分向線終止端收邊（大學西路 → 援中路）──
const byName = (nm: string) => roads.filter((r) => r.properties.name === nm)
const daxue = byName('大學西路')
const yuanzhong = byName('援中路')
check('底圖含大學西路/援中路', daxue.length > 0 && yuanzhong.length > 0,
  `大學西路 ${daxue.length} 區塊、援中路 ${yuanzhong.length} 區塊`)
if (daxue.length && yuanzhong.length) {
  const yzNodes = new Set(yuanzhong.flatMap((r) => r.properties.nodes))
  // 大學西路「終止」在援中路上的節點（端點在 yzNodes、且大學西路不續行）
  const ends: { node: number; pos: [number, number] }[] = []
  const endUse = new Map<number, number>()
  for (const r of daxue) {
    const ns = r.properties.nodes
    for (const n of [ns[0], ns[ns.length - 1]]) endUse.set(n, (endUse.get(n) ?? 0) + 1)
  }
  for (const r of daxue) {
    const ns = r.properties.nodes
    const cs = r.geometry.coordinates as [number, number][]
    for (const [i, n] of [[0, ns[0]], [ns.length - 1, ns[ns.length - 1]]] as [number, number][]) {
      if (yzNodes.has(n) && endUse.get(n) === 1) ends.push({ node: n, pos: cs[i] })
    }
  }
  check('找到大學西路終止於援中路的端點', ends.length > 0, `${ends.length} 處`)
  const dividers = buildDividers(roads)
  const dxIds = new Set(daxue.map((r) => r.properties.osm_id))
  const dxLines = dividers.features.filter((f) => dxIds.has(Number(f.properties?.osm_id)))
  for (const e of ends) {
    // 大學西路所有分隔線（含黃色分向線）離該端點至少「援中路半寬」以上
    let minD = Infinity
    for (const f of dxLines) {
      for (const c of f.geometry.coordinates as [number, number][]) {
        minD = Math.min(minD, haversine(e.pos, c))
      }
    }
    const yzHalf = Math.max(...yuanzhong.map((r) => r.properties.width_m)) / 2
    check(`node/${e.node} 分隔線已收邊（≥ 援中路半寬 ${yzHalf.toFixed(1)}m）`,
      minD >= yzHalf, `最近距離 ${minD.toFixed(1)}m`)
  }
  // 援中路自身（續行）分隔線仍存在（合併段分向黃線由 turnbays 畫，
  // buildDividers 只出車道白線——查任何 kind 即可確認未被收邊誤刪）
  const yzIds = new Set(yuanzhong.map((r) => r.properties.osm_id))
  const yzLines = dividers.features.filter((f) => yzIds.has(Number(f.properties?.osm_id)))
  check('援中路（續行）分隔線仍在', yzLines.length > 0, `${yzLines.length} 條`)
  // 2026-07-18「路口中間全清」：主線通過的路口也收邊——援中路自己的分隔線
  // 離大學西路交會節點至少大學西路半寬
  for (const e of ends) {
    let minD = Infinity
    for (const f of yzLines) {
      for (const c of f.geometry.coordinates as [number, number][]) {
        minD = Math.min(minD, haversine(e.pos, c))
      }
    }
    const dxHalf = Math.max(...daxue.map((r) => r.properties.width_m)) / 2
    check(`node/${e.node} 主線（援中路）分隔線也收邊（≥ 大學西路半寬 ${dxHalf.toFixed(1)}m）`,
      minD >= dxHalf, `最近距離 ${minD.toFixed(1)}m`)
  }
}

// ── 3. 路寬微調 ──
const target = roads.find((r) => r.properties.oneway === 'no' && r.properties.lanesForward >= 2)!
const p0 = { w: target.properties.width_m, dv: target.properties.divOffM }
const key = `way/${target.properties.osm_id}@b/${target.properties.blockNode}`
const j2: EnhancementRecord[] = [...journal, {
  seq: 9999, ts: '', author: 'audit', op: 'set',
  target: { type: 'road', key }, fields: { extra_width_m: 1.6 },
}]
applyToRoads(roads, foldJournal(j2))
check('extra_width_m=1.6 → width_m +1.6',
  Math.abs(target.properties.width_m - p0.w - 1.6) < 1e-6,
  `${p0.w.toFixed(1)} → ${target.properties.width_m.toFixed(1)}`)
check('divOffM（車道位置）不動', Math.abs(target.properties.divOffM - p0.dv) < 1e-6)

// ── 4. 右轉附加車道 ──
const anchor = graph.bayAnchors(() => true).find((a) => {
  const cs = a.coords
  let len = 0
  for (let i = 1; i < cs.length; i++) len += haversine(cs[i - 1], cs[i])
  return len > 80 && a.road.properties.name === '藍田路'
})
check('找得到藍田路右轉道錨點', !!anchor, anchor ? `node/${anchor.nodeId}` : '')
if (anchor) {
  const rlKey = `way/${anchor.wayId}@node/${anchor.nodeId}${anchor.back ? '~b' : ''}~r`
  const j3: EnhancementRecord[] = [...j2, {
    seq: 10000, ts: '', author: 'audit', op: 'set',
    target: { type: 'right_lane', key: rlKey }, fields: { present: 1 },
  }]
  const rls = buildRightLanes(graph, j3)
  check('右轉道生成', rls.length === 1, rls[0] ? `儲車 ${rls[0].lenM.toFixed(0)}m、寬 ${rls[0].widthM}m` : '')
  if (rls.length === 1) {
    const rl = rls[0]
    check('右轉道幾何完整（polygon/白線/右轉箭頭）',
      rl.polygon.length > 4 && rl.lines[0].coords.length >= 2 &&
      rl.arrows.every((a2) => a2.icon === 'lane-arrow-right'))
    // 該行向停止線因右轉道而加寬
    const bays3 = buildTurnBays(graph, j3)
    const stops3 = buildStopLines(graph, bays3, rls)
    const near = (ss: typeof stops3) => ss
      .map((s) => ({ s, d: haversine(s.coords[0], rl.polygon[rl.polygon.length - 2]) }))
      .sort((a2, b2) => a2.d - b2.d)[0]
    const before = near(buildStopLines(graph, bays3, []))
    const after = near(stops3)
    const lenB = haversine(before.s.coords[0], before.s.coords[1])
    const lenA = haversine(after.s.coords[0], after.s.coords[1])
    check('停止線橫跨右轉道（加寬 ≈ 車道寬）',
      Math.abs(lenA - lenB - rl.widthM) < 1.0, `${lenB.toFixed(1)}m → ${lenA.toFixed(1)}m`)
    // 地面箭頭：右轉由附加車道承擔，最外一般車道不再補 through;right
    const arrows3 = buildLaneArrows(graph, bays3, rls)
    const combined = arrows3.filter((a2) => a2.icon === 'lane-arrow-through-right')
      .some((a2) => haversine(a2.pos, rl.arrows[0].pos) < 12)
    check('右轉道行向最外車道不再畫合體右轉箭頭', !combined)
  }
}

console.log(fails ? `\n共 ${fails} 項未通過` : '\n全部通過')
process.exit(fails ? 1 : 0)
