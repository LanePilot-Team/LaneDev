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
import { angleDelta, haversine } from '../src/core/geo'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import {
  buildTurnBays, buildChannelization, buildStopLines, buildRightLanes, buildLaneArrows,
  BAY_TEXT_ARROW_CLEARANCE_M,
} from '../src/core/turnbays'
import { buildRoadTexts } from '../src/core/roadtext'
import { buildCenterIslands, buildMotoSepIslands, buildTwinIslands } from '../src/core/medians'
import {
  cleanIntersectionFeatures, inIntersectionCleanup, roadsWithCleanupFlags,
} from '../src/core/intersectionCleanup'

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
const allRoadTexts = buildRoadTexts(graph).features
const closeDuplicate = allRoadTexts.some((a, i) => allRoadTexts.slice(i + 1).some((b) =>
  a.properties?.roadKey === b.properties?.roadKey && a.properties?.lane === b.properties?.lane &&
  a.properties?.label === b.properties?.label &&
  Math.abs(angleDelta(Number(a.properties?.brg), Number(b.properties?.brg))) < 20 &&
  haversine((a.geometry as unknown as { coordinates: [number, number] }).coordinates,
    (b.geometry as unknown as { coordinates: [number, number] }).coordinates) < 25))
check('連續短區塊不會在同道路、同方向、同車道重複印字', !closeDuplicate,
  `${allRoadTexts.length} 個路面資訊`)
console.log(`底圖：${roads.length} 區塊, journal ${journal.length} 筆, nodeRemap ${nodeRemap.size}`)

// ── 路面規則：必須從各自行向的入口開始，且圖頂端朝行進方向 ──
const textProbe: RoadFeature = {
  ...roads[0],
  geometry: { type: 'LineString', coordinates: [[120, 22], [120, 22.001]] },
  properties: {
    ...roads[0].properties,
    osm_id: 999_000_001,
    blockNode: 999_000_001,
    nodes: [999_000_001, 999_000_002],
    oneway: 'no', lanesForward: 1, lanesBackward: 1,
    width_m: 6.4, centerM: 0, divOffM: 0,
    rulesF: ['no_moto'], rulesB: ['no_moto'], motorcycle: undefined,
    elevated: false,
  },
}
const textFeatures = buildRoadTexts(new RoadGraph([textProbe])).features
const textBearings = textFeatures.map((f) => Number(f.properties?.brg)).sort((a, b) => a - b)
const probeEnds = textProbe.geometry.coordinates as [number, number][]
const entryDistances = textFeatures.map((f) => Math.min(
  haversine(f.geometry.coordinates as [number, number], probeEnds[0]),
  haversine(f.geometry.coordinates as [number, number], probeEnds[1]),
))
check('禁行機車在雙向道路的兩個車道入口各生成一次',
  textFeatures.length === 2 && textFeatures.every((f) =>
    f.properties?.label === '禁行機車' && f.properties?.color === '#facc15' &&
    f.properties?.laneType === 'car'))
check('路面規則位於剛進入車道處（入口後約 7m）',
  entryDistances.every((d) => d >= 6.5 && d <= 8), entryDistances.map((d) => d.toFixed(1)).join('m / ') + 'm')
check('路面規則方向與雙向行徑方向一致',
  textBearings.length === 2 && textBearings[0] === 0 && textBearings[1] === 180,
  textBearings.join('° / ') + '°')
const atSouthEntry = textFeatures.find((f) =>
  haversine(f.geometry.coordinates as [number, number], probeEnds[0]) < 20)
const atNorthEntry = textFeatures.find((f) =>
  haversine(f.geometry.coordinates as [number, number], probeEnds[1]) < 20)
check('道路兩端只標離開路口方向，不標朝向路口的出口車道',
  textFeatures.length === 2 && atSouthEntry?.properties?.brg === 0 &&
  atNorthEntry?.properties?.brg === 180)

const laneMarkProbe: RoadFeature = {
  ...textProbe,
  properties: {
    ...textProbe.properties,
    osm_id: 999_000_003, oneway: 'yes', lanesForward: 2, lanesBackward: 0,
    motoF: true, motoB: false, motoSepF: 1, width_m: 9.6,
    rulesF: [], rulesB: [],
    laneMarksF: [
      { text: '禁行機車', color: '#facc15' },
      null,
      { text: '機慢車優先', color: '#34d399' },
    ],
  },
}
const laneMarkFeatures = buildRoadTexts(new RoadGraph([laneMarkProbe])).features
check('逐車道只能各自生成一種資訊，未選車道保持空白',
  laneMarkFeatures.length === 2 && laneMarkFeatures.some((f) => f.properties?.lane === 0) &&
  !laneMarkFeatures.some((f) => f.properties?.lane === 1))
check('已定義機車道可使用專用／優先或自訂文字與顏色',
  laneMarkFeatures.some((f) => f.properties?.laneType === 'moto' &&
    f.properties?.label === '機慢車優先' && f.properties?.color === '#34d399'))

// ── 小路口箭頭：窄巷也必須形成路口退界，箭頭不可插在中心節點 ──
const smallJunctionNode = 999_000_012
const arrowProbe = (id: number, nodes: number[], coordinates: [number, number][],
  width: number, explicit = false): RoadFeature => ({
  ...textProbe,
  geometry: { type: 'LineString', coordinates },
  properties: {
    ...textProbe.properties,
    osm_id: id, blockNode: nodes[0], nodes, width_m: width,
    name: `測試道路${id}`,
    oneway: explicit ? 'yes' : 'no', lanesForward: 1, lanesBackward: explicit ? 0 : 1,
    turnLanes: explicit ? ['through'] : undefined,
    rulesF: [], rulesB: [], motorcycle: undefined,
  },
})
const smallJunctionPos: [number, number] = [120, 22.001]
const smallGraph = new RoadGraph([
  arrowProbe(999_000_021, [999_000_021, smallJunctionNode], [[120, 22], smallJunctionPos], 6.4, true),
  arrowProbe(999_000_022, [999_000_022, smallJunctionNode], [[119.999, 22.001], smallJunctionPos], 3.2),
  arrowProbe(999_000_023, [smallJunctionNode, 999_000_023], [smallJunctionPos, [120.001, 22.001]], 3.2),
])
const smallArrows = buildLaneArrows(smallGraph, [])
const smallArrowDist = smallArrows[0] ? haversine(smallArrows[0].pos, smallJunctionPos) : 0
check('窄巷交叉的小路口箭頭完整退到路口前',
  smallArrows.length === 1 && smallArrowDist >= 6.5,
  `${smallArrows.length} 個箭頭，距中心 ${smallArrowDist.toFixed(1)}m`)

const targetSpurs = roads.filter((r) =>
  [287447934, 287447935, 289555544].includes(r.properties.osm_id))
check('明確排除 way/287447934、way/287447935，並清除附近短殘段', targetSpurs.length === 0,
  targetSpurs.map((r) => `way/${r.properties.osm_id}@${r.properties.blockNode}`).join(', '))
check('明確排除 way/126247810、way/126247864',
  roads.every((r) => ![126247810, 126247864].includes(r.properties.osm_id)))
check('明確排除 way/126247798',
  roads.every((r) => r.properties.osm_id !== 126247798))
const alley676 = roads.find((r) => r.properties.osm_id === 676539849)
const alley676End = alley676?.geometry.coordinates.at(-1) as [number, number] | undefined
const alley676Lines = buildDividers(roads).features.filter((f) => f.properties?.osm_id === 676539849)
const alley676Nearest = alley676End ? Math.min(...alley676Lines.flatMap((f) => {
  const cs = f.geometry.coordinates as [number, number][]
  return [haversine(cs[0], alley676End), haversine(cs[cs.length - 1], alley676End)]
})) : 0
check('way/676539849 道路繪圖線停在德民路口前',
  !!alley676 && alley676Lines.length > 0 && alley676Nearest >= 13.5,
  `退界 ${alley676Nearest.toFixed(1)}m`)
check('way/912306400 已恢復為德民新橋下方連接道',
  roads.some((r) => r.properties.osm_id === 912306400))
const deminBridge = roads.filter((r) =>
  [126247872, 126247885, 126247846, 126247898].includes(r.properties.osm_id))
check('德民新橋主橋與機車道已納入高架樣式',
  deminBridge.length > 0 && deminBridge.every((r) => r.properties.elevated === true),
  `${deminBridge.length} 個橋面區塊`)
const trimmedBridgeWay = roads.find((r) => r.properties.osm_id === 287673498)
check('way/287673498 已裁掉益群橋路口左側多餘尾巴',
  !!trimmedBridgeWay && trimmedBridgeWay.properties.nodes[0] === 2912433399)
const trimmedXiugun = roads.filter((r) => r.properties.osm_id === 126247903)
check('秀群路539巷已截在外環西路口，不再露出北側圓頭',
  trimmedXiugun.length > 0 && trimmedXiugun.some((r) =>
    [2206232306, 2206232308].includes(r.properties.nodes[0])) &&
  trimmedXiugun.every((r) => !r.properties.nodes.some((n) =>
    [2206232311, 2206232309].includes(n))),
  trimmedXiugun.map((r) => r.properties.nodes.join('>')).join(' | '))

// ── 1. 停止線 ──
const bays = buildTurnBays(graph, journal)
const pairedBays = bays.filter((b) => b.paired)
const singleBays = bays.filter((b) => b.kind === 'center' && !b.paired)
const channelization = buildChannelization(graph, bays)
check('雙端偏心左轉道採成對生成', pairedBays.length > 0 && pairedBays.length % 2 === 0,
  `${pairedBays.length} 條偏心道`)
check('雙端偏心道不再各自繪製槽化斜線',
  pairedBays.every((b) => b.lines.every((line) => line.color !== 'yellow')))
check('單端偏心道仍保留黃色槽化起始邊線',
  singleBays.length === 0 || singleBays.every((b) => b.lines.some((line) => line.color === 'yellow')),
  `${singleBays.length} 條單端偏心道`)
check('偏心道路中央標線有正常生成', channelization.length > 0,
  `${channelization.length} 條中央標線`)
const pairedCenterLines = channelization.filter((line) => line.style === 'paired-center')
const channelCaps = channelization.filter((line) => line.style === 'channel-cap')
const hatchOwners = new Set(channelization
  .filter((line) => line.style === 'channel-hatch' && line.ownerKey)
  .map((line) => line.ownerKey))
const capOwners = new Set(channelCaps.map((line) => line.ownerKey))
check('每組雙端偏心道都生成兩條 S 型黃線',
  pairedCenterLines.length === pairedBays.length,
  `${pairedCenterLines.length} 條 S 型線 / ${pairedBays.length / 2} 組偏心道`)
check('所有實際生成的單端槽化區都有且只有一個封口',
  channelCaps.length === capOwners.size &&
  [...hatchOwners].every((key) => capOwners.has(key)),
  `${channelCaps.length} 個封口 / ${hatchOwners.size} 個槽化區`)
const deminJhongchang = 1398634938
const deminJhongchangBlocks = roads.filter((r) =>
  r.properties.nodes.includes(deminJhongchang) &&
  (r.properties.name === '德民路' || r.properties.name === '中昌街'))
const deminJhongchangNames = new Set(deminJhongchangBlocks.map((r) => r.properties.name))
check('德民路 × 中昌街已收旂為單一十字路口中心',
  nodeRemap.get(1398634137) === deminJhongchang && deminJhongchangNames.size === 2 &&
  roads.every((r) => !r.properties.nodes.includes(1398634137)),
  `${deminJhongchangBlocks.length} 個相接區塊`)
check('德民中昌路口沒有殘留零長度或重複節點區塊',
  roads.every((r) => r.properties.nodes.length >= 2 &&
    r.properties.nodes.every((n, i, ns) => i === 0 || n !== ns[i - 1])))
const hueiduNode = 7477787914
const hueiduTouches = roads.filter((r) => r.properties.nodes.includes(hueiduNode))
const hueiduPoints = hueiduTouches.flatMap((r) => r.properties.nodes.flatMap((n, i) =>
  n === hueiduNode ? [r.geometry.coordinates[i] as [number, number]] : []))
check('德民路 × 惠都街只保留有名支路，無名平行重複路已移除',
  roads.every((r) => r.properties.osm_id !== 799551653) &&
  hueiduTouches.some((r) => r.properties.name === '惠都街'))
check('惠都街端點已吸附到德民路主線中心',
  hueiduPoints.length >= 2 && hueiduPoints.every((p) => haversine(p, hueiduPoints[0]) < 0.1),
  `${hueiduPoints.length} 個共用座標`)
const bayRoadTexts = buildRoadTexts(graph, bays).features.filter((f) =>
  f.properties?.laneType === 'turn_bay')
check('每條偏心左轉道都有黃色禁行機車標示',
  bayRoadTexts.length === bays.length && bayRoadTexts.every((f) =>
    f.properties?.label === '禁行機車' && f.properties?.color === '#facc15'),
  `${bayRoadTexts.length}/${bays.length} 條`)
check('偏心道禁行機車方向與該車道行進方向一致',
  bayRoadTexts.every((f) => {
    const bay = bays.find((b) => b.key === f.properties?.roadKey)
    return !!bay && Math.abs(angleDelta(Number(f.properties?.brg), bay.roadText.brg)) < 0.2
  }))
check('偏心左轉箭頭全部位於文字前方、靠近路口端',
  bays.every((b) => b.arrows.length >= 1 && b.arrows.every((a) =>
    a.dM > b.roadText.dM && b.endM - a.dM <= 15)))
check('偏心道箭頭與禁行機車文字保留安全間距',
  bays.every((b) => b.arrows.every((a) =>
    a.dM - b.roadText.dM >= BAY_TEXT_ARROW_CLEARANCE_M - 0.01)),
  `至少 ${BAY_TEXT_ARROW_CLEARANCE_M}m`)
const allIslands = [...buildMotoSepIslands(graph), ...buildCenterIslands(graph, bays)]
const universityGreen = buildTwinIslands(roads, journal)
check('高雄大學路綠化帶使用道路面差集後的多邊形填滿空隙',
  universityGreen.length > 0 && universityGreen.every((m) =>
    m.polygon.length >= 4 && m.polygon[0][0] === m.polygon[m.polygon.length - 1][0] &&
    m.polygon[0][1] === m.polygon[m.polygon.length - 1][1]),
  `${universityGreen.length} 塊多邊形`)
const cleanedWideJunctionDividers = cleanIntersectionFeatures(buildDividers(roads))
const cleanedWideJunctionTexts = cleanIntersectionFeatures(buildRoadTexts(graph, bays))
const wideJunctionDisplayRoads = roadsWithCleanupFlags(roads)
check('高雄大學路 × 援中路寬路口中央沒有分隔線或路面文字',
  cleanedWideJunctionDividers.features.every((f) =>
    f.geometry.type !== 'LineString' || f.geometry.coordinates.every((p) =>
      !inIntersectionCleanup(p as [number, number]))) &&
  cleanedWideJunctionTexts.features.every((f) =>
    f.geometry.type !== 'Point' || !inIntersectionCleanup(f.geometry.coordinates as [number, number])))
check('寬路口相交區塊不繪製道路名稱與連續方向箭頭',
  wideJunctionDisplayRoads.some((r) => r.properties.name === '高雄大學路' &&
    r.properties.hideIntersectionInfo === true) &&
  wideJunctionDisplayRoads.some((r) => r.properties.name === '援中路' &&
    r.properties.hideIntersectionInfo === true))
const waihuanJunction: [number, number] = [120.3000115, 22.7183436]
const nearestIslandAtWaihuan = Math.min(...allIslands.flatMap((m) =>
  m.polygon.map((p) => haversine(p, waihuanJunction))))
check('外環西路 × 秀群路539巷的綠化帶已留出轉彎口',
  nearestIslandAtWaihuan >= 3.5, `最近 ${nearestIslandAtWaihuan.toFixed(1)}m`)
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

// ── 3. 短死巷共用單車道 ──
const shared = roads.filter((r) => r.properties.sharedLane)
check('短死巷有套用共用單車道', shared.length > 0, `${shared.length} 個區塊`)
check('共用單車道路寬為一道且仍保留雙向通行', shared.every((r) =>
  Math.abs(r.properties.width_m - 3.2) < 1e-6 &&
  r.properties.oneway === 'no' && r.properties.lanesForward === 1 && r.properties.lanesBackward === 1))
check('共用單車道不生成中央線或車道線',
  buildDividers(shared).features.length === 0)

const wideNoCenter = roads.filter((r) => r.properties.oneway === 'no' &&
  !r.properties.sharedLane && r.properties.centerM === 0 &&
  r.properties.lanesForward + r.properties.lanesBackward >= 4)
const wideDividers = buildDividers(wideNoCenter).features
check('無偏心左轉帶的四線道以上道路使用雙黃線',
  wideNoCenter.length > 0 &&
  wideDividers.filter((f) => f.properties?.kind === 'center-double').length > 0 &&
  wideDividers.filter((f) => f.properties?.kind === 'center-double').length % 2 === 0 &&
  wideDividers.every((f) => f.properties?.kind !== 'center'),
  `${wideNoCenter.length} 區塊 / ${wideDividers.filter((f) => f.properties?.kind === 'center-double').length} 條黃線`)

// ── 4. 路寬微調 ──
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

// ── 5. 右轉附加車道 ──
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
