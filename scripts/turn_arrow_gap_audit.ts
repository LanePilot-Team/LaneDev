// 轉向箭頭缺口審計（node scripts/run_offline.mjs scripts/turn_arrow_gap_audit.ts）
//
// 「路口明明可以右轉，導航卻直行過去再大迴轉」的成因通常不在 A*，而在車道箭頭：
// resolveLaneDecision 只要看到該方向的箭頭是「明確標註」的，就把沒列出的動作當成
// 禁止。少畫一個右轉箭頭 = 那個轉向在導航裡完全不存在，A* 只好繞。
//
// 這支審計把每個路口的每組「進入邊 → 離開邊」都問一次車道決策，挑出
// 「被箭頭擋掉、而且擋掉之後要繞遠路」的組合——單純的禁左/禁迴轉不會被列出來，
// 因為那些本來就繞得過去而且是真的禁止。
//
//   --ratio=<倍數>  繞路比門檻（預設 1.6）
//   --probe=<公尺>  進出探測點距路口的距離（預設 70）
//   --minclass=<n>  只看離開道路的等級（預設排除無名巷弄）
//   --top=<n>       列出前 n 筆（預設 40）
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
  guidanceForRoadDirection,
} from '../src/core/laneBase'
import { RoadGraph, carAllowed, type Profile } from '../src/core/graph'
import { haversine, bearing, angleDelta } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const RATIO = Number(arg('ratio', '1.6'))
const PROBE_M = Number(arg('probe', '70'))
const TOP = Number(arg('top', '40'))
const PROFILE = arg('profile', 'car') as Profile

const db = JSON.parse(readFileSync(
  arg('db', join(HERE, '../public/data/road_database.json')), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const roads0 = prepared.roads
const extraction = extractLaneBase(Array.isArray(db.annotations) ? db.annotations : [])
const remapped = remapLaneBase(extraction.records, {
  existingWayIds: new Set(roads0.map((r) => r.properties.osm_id)),
  nodeRemap: prepared.nodeRemap,
  wayRemap: prepared.wayRemap,
  wayApproachNodes: roads0.reduce((index, road) => {
    const nodes = index.get(road.properties.osm_id) ?? {
      forward: new Set<number>(), backward: new Set<number>(),
    }
    nodes.forward.add(road.properties.nodes.at(-1)!)
    if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
    index.set(road.properties.osm_id, nodes)
    return index
  }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
})
applyLaneBaseToRoads(roads0, buildLaneBaseIndex(remapped.records))
const journal: EnhancementRecord[] = db.editor?.journal ?? []
const folded = foldJournal(journal)
const roadsAll = [...roads0, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
applyToRoads(roadsAll, folded)
const view = buildRoadMergeViews(roadsAll.filter((r) => !r.properties.deleted), journal)
const roads = view.routingRoads
const graph = new RoadGraph(roads)

interface InternalEdge {
  from: number; to: number; coords: [number, number][]
  lengthM: number; road: RoadFeature; back: boolean
}
const internals = graph as unknown as {
  adj: Map<number, InternalEdge[]>
  adjIn: Map<number, InternalEdge[]>
  nodePos: Map<number, [number, number]>
  laneTransitionPlan: (
    incoming: InternalEdge, outgoing: InternalEdge, nodeId: number,
    profile: Profile, policy: object, entryLaneIndex?: number,
  ) => { decision: { allowed: boolean; reason: string } }
}

// 前置檢查：箭頭是「整個區塊 × 方向」一份，套用的路口就是該方向的區塊末端。
// 若 RoadGraph 又把區塊切成好幾條邊（區塊內部節點被別條路共用），那些中間路口
// 會沿用不屬於它的箭頭——那就是系統性錯誤，不是逐個路口的資料問題。
let splitBlocks = 0
for (const [, outs] of internals.adj) for (const e of outs) {
  const ns = e.road.properties.nodes
  const blockEnd = e.back ? ns[0] : ns[ns.length - 1]
  if (e.to !== blockEnd) splitBlocks++
}
console.log(`區塊被 RoadGraph 再切開、導致中途路口沿用他處箭頭的邊：${splitBlocks}`)

const label = (e: InternalEdge) => {
  const p = e.road.properties
  return `${p.name ?? '(無名)'} way/${p.osm_id}@b/${p.blockNode}${e.back ? '(逆)' : ''}`
}
/** 巷弄不計：那些本來就常常不准轉，列出來只會淹沒真正的問題。 */
const isAlley = (r: RoadFeature) =>
  !r.properties.name || /巷|弄/.test(r.properties.name)
  || r.properties.highway === 'service' || r.properties.highway === 'track'

interface Blocked {
  nodeId: number
  incoming: InternalEdge
  outgoing: InternalEdge
  kind: string
  movements: string
}
const blocked: Blocked[] = []
for (const [nodeId, outs] of internals.adj) {
  const ins = internals.adjIn.get(nodeId) ?? []
  // 真正的路口才看：至少三個方向
  const arms = new Set([...ins, ...outs].map((e) => e.road.properties.osm_id))
  if (arms.size < 3) continue
  for (const inE of ins) {
    if (!carAllowed(inE.road, inE.back)) continue
    if (isAlley(inE.road)) continue
    const guidance = guidanceForRoadDirection(inE.road, inE.back)
    // 沒有明確箭頭時 resolveLaneDecision 一律放行，不會是這裡的成因
    if (guidance.source === 'inferred' || guidance.source === 'osm') continue
    const c = inE.coords
    const inB = bearing(c[c.length - 2], c[c.length - 1])
    for (const outE of outs) {
      if (!carAllowed(outE.road, outE.back)) continue
      if (isAlley(outE.road)) continue
      if (outE.road.properties.osm_id === inE.road.properties.osm_id
        && outE.back !== inE.back) continue // 原路折返
      const delta = angleDelta(inB, bearing(outE.coords[0], outE.coords[1]))
      if (Math.abs(delta) > 155) continue // 迴轉本來就常態禁止
      let plan
      try {
        plan = internals.laneTransitionPlan(inE, outE, nodeId, PROFILE, {}, undefined)
      } catch { continue }
      if (plan.decision.allowed) continue
      if (plan.decision.reason !== 'explicitly-incompatible') continue
      blocked.push({
        nodeId,
        incoming: inE,
        outgoing: outE,
        kind: Math.abs(delta) < 25 ? '直行' : delta > 0 ? '右轉' : '左轉',
        movements: (guidance.laneMovements ?? []).map((m) => m || '(空)').join('|'),
      })
    }
  }
}
console.log(`被車道箭頭擋掉的非迴轉轉向：${blocked.length} 組（只計名路對名路的真路口）`)

// 整個進入方向都被封死 = 資料本身自相矛盾：真的開到那裡的人沒有任何合法出口。
// 這種不需要現地查證就知道箭頭是錯的（多半是別的路口的箭頭被沿用或漏畫）。
const sealed: { nodeId: number; incoming: InternalEdge; movements: string; exits: number }[] = []
for (const [nodeId, outs] of internals.adj) {
  const ins = internals.adjIn.get(nodeId) ?? []
  if (new Set([...ins, ...outs].map((e) => e.road.properties.osm_id)).size < 3) continue
  for (const inE of ins) {
    if (!carAllowed(inE.road, inE.back)) continue
    const guidance = guidanceForRoadDirection(inE.road, inE.back)
    if (guidance.source === 'inferred' || guidance.source === 'osm') continue
    let exits = 0
    let allowed = 0
    for (const outE of outs) {
      if (!carAllowed(outE.road, outE.back)) continue
      if (outE.road.properties.osm_id === inE.road.properties.osm_id
        && outE.back !== inE.back) continue // 原路折返不算出口
      exits++
      try {
        if (internals.laneTransitionPlan(inE, outE, nodeId, PROFILE, {}, undefined)
          .decision.allowed) allowed++
      } catch { allowed++ }
    }
    if (exits > 0 && allowed === 0) {
      sealed.push({
        nodeId, incoming: inE, exits,
        movements: (guidance.laneMovements ?? []).map((m) => m || '(空)').join('|'),
      })
    }
  }
}
console.log(`\n=== 進入方向被箭頭完全封死（${sealed.length} 組）——資料必錯，不必現地查證 ===`)
for (const s of sealed) {
  const pos = internals.nodePos.get(s.nodeId)!
  const p = s.incoming.road.properties
  console.log(`  ⛔ node=${s.nodeId} @ ${pos[0].toFixed(6)},${pos[1].toFixed(6)}`
    + `｜${p.name ?? '(無名)'} way/${p.osm_id}@b/${p.blockNode}${s.incoming.back ? '(逆)' : ''}`
    + `｜箭頭 ${s.movements}｜出口 ${s.exits} 個全擋`)
}
console.log('')

/** 沿邊往回／往前退 PROBE_M 取探測點，避開路口本身的吸附。 */
function probe(edge: InternalEdge, fromEnd: boolean): [number, number] | null {
  const cs = edge.coords
  let walked = 0
  if (fromEnd) {
    for (let i = cs.length - 1; i > 0; i--) {
      walked += haversine(cs[i], cs[i - 1])
      if (walked >= PROBE_M) return cs[i - 1]
    }
    return walked >= 20 ? cs[0] : null
  }
  for (let i = 0; i < cs.length - 1; i++) {
    walked += haversine(cs[i], cs[i + 1])
    if (walked >= PROBE_M) return cs[i + 1]
  }
  return walked >= 20 ? cs[cs.length - 1] : null
}

interface Row extends Blocked {
  direct: number; actual: number; ratio: number
  from: [number, number]; to: [number, number]
}
const rows: Row[] = []
for (const b of blocked) {
  const from = probe(b.incoming, true)
  const to = probe(b.outgoing, false)
  if (!from || !to) continue
  // 「直接轉過去」的長度：進入段 + 離開段（沿路網幾何，不是直線）
  const direct = haversine(from, internals.nodePos.get(b.nodeId)!)
    + haversine(internals.nodePos.get(b.nodeId)!, to)
  const route = graph.route(from, to, PROFILE)
  if (!route) { rows.push({ ...b, direct, actual: Infinity, ratio: Infinity, from, to }); continue }
  const ratio = route.lengthM / Math.max(direct, 1)
  rows.push({ ...b, direct, actual: route.lengthM, ratio, from, to })
}
const bad = rows.filter((r) => r.ratio > RATIO)
  .sort((a, b) => (b.ratio === Infinity ? 1e9 : b.ratio) - (a.ratio === Infinity ? 1e9 : a.ratio))
console.log(`其中造成繞路 >${RATIO}× 的：${bad.length} 組\n`)
const KIND = arg('kind', '')
const shown = KIND ? bad.filter((r) => r.kind === KIND) : bad
if (KIND) console.log(`（只列 ${KIND}：${shown.length} 組）\n`)
for (const r of shown.slice(0, TOP)) {
  const pos = internals.nodePos.get(r.nodeId)!
  const p = r.incoming.road.properties
  // 使用者的現地規則：右轉通常只有「有快慢分隔島的中央汽車道」才禁止。
  // 該方向有機車道且 motoSep>0 才算有島。
  const hasMoto = r.incoming.back ? p.motoB : p.motoF
  const sep = r.incoming.back ? p.motoSepB : p.motoSepF
  const island = hasMoto && (sep || 0) > 0
  console.log(`  ❌ node=${r.nodeId} @ ${pos[1].toFixed(6)},${pos[0].toFixed(6)}`
    + `  https://www.google.com/maps/@${pos[1].toFixed(6)},${pos[0].toFixed(6)},20z`)
  console.log(`     ${label(r.incoming)} 　${r.kind}→ ${label(r.outgoing)}`)
  console.log(`     進入方向箭頭：${r.movements}`
    + `｜機車道=${hasMoto ? `有(${(r.incoming.back ? p.motoCountB : p.motoCountF)}道)` : '無'}`
    + `｜快慢分隔島=${island ? `有 ${sep}m` : '無'}`)
  console.log(`     直接轉 ${r.direct.toFixed(0)}m → 實際要走`
    + ` ${r.actual === Infinity ? '不通' : `${r.actual.toFixed(0)}m`}`
    + `（${r.ratio === Infinity ? '∞' : `${r.ratio.toFixed(1)}×`}）`)
}
if (shown.length > TOP) console.log(`  …另有 ${shown.length - TOP} 組`)

// --json=<路徑>：輸出給 Google 地圖對照用的機器可讀清單（起訖探測點即比對用的座標）
const JSON_OUT = arg('json', '')
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(shown.map((r) => {
    const p = r.incoming.road.properties
    const hasMoto = r.incoming.back ? p.motoB : p.motoF
    const sep = r.incoming.back ? p.motoSepB : p.motoSepF
    return {
      nodeId: r.nodeId,
      kind: r.kind,
      inKey: `way/${p.osm_id}@b/${p.blockNode}`,
      inBack: r.incoming.back,
      inName: p.name ?? '(無名)',
      outName: r.outgoing.road.properties.name ?? '(無名)',
      movements: r.movements,
      island: !!(hasMoto && (sep || 0) > 0),
      from: r.from,
      to: r.to,
      node: internals.nodePos.get(r.nodeId),
      direct: Math.round(r.direct),
      ours: r.actual === Infinity ? null : Math.round(r.actual),
    }
  }), null, 1), 'utf8')
  console.log(`\n已寫出 ${JSON_OUT}（${shown.length} 筆）`)
}
process.exitCode = bad.length === 0 ? 0 : 1
