/**
 * 機車停等格「人工新增卻被刷回關閉」診斷：
 * 比對「面板允許設定的上限（useEditor.inferMotoBoxMax）」與
 * 「buildMotoBoxes 實際接受並畫出的行向」，統計落差原因（分兩向）。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, laneSpanM, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import {
  buildTurnBays, buildRightLanes, buildMotoBoxes, buildStopLines, isMajorStopRoad,
  makeMotoBoxSlot, stopLineEdges,
} from '../src/core/turnbays'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')

const parsed = parseImported(readFileSync(join(DATA, 'lanepilot/area_4212599.segments.jsonl'), 'utf8'))
if (parsed.kind !== 'map') throw new Error('shard 解析失敗')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal: EnhancementRecord[] = JSON.parse(readFileSync(join(DATA, 'seed_journal.json'), 'utf8'))
  .filter((r: EnhancementRecord) => r.author !== 'lanepilot')
applyToRoads(roads, foldJournal(journal))
const graph = new RoadGraph(roads)
const bays = buildTurnBays(graph, journal)
const rightLanes = buildRightLanes(graph, journal)

const scopeFn = (r: RoadFeature) =>
  !!r.properties.coupletMerged && r.properties.centerKind === 'hatch'
const hasTl = (r: RoadFeature) =>
  !!(r.properties.turnLanes?.length || r.properties.turnLanesB?.length)

// ── 面板端：完全照抄 useEditor 的鍵推導與 inferMotoBoxMax ──
interface PanelDir {
  road: RoadFeature; back: boolean; node: number; dir: string; key: string; panelMax: number
}
const panelDirs: PanelDir[] = []
const slotOf = makeMotoBoxSlot(graph)
for (const road of roads) {
  const p2 = road.properties
  const directionEdges = stopLineEdges(graph, (c) => c === road)
  const forwardEdge = directionEdges.find((e) => !e.back)
  const backwardEdge = directionEdges.find((e) => e.back)
  const nodeLast = forwardEdge?.toNode ?? p2.nodes[p2.nodes.length - 1] ?? 0
  const nodeFirst = backwardEdge?.toNode ?? p2.nodes[0] ?? 0
  const inferMotoBoxMax = (back: boolean) => {
    const edge = back ? backwardEdge : forwardEdge
    if (!edge) return 0
    const slot = slotOf(edge)
    return slot.eligible && !slot.sepIsland ? slot.maxLanes : 0
  }
  const push = (back: boolean, node: number) => {
    const suffix = back ? '~b' : ''
    panelDirs.push({
      road, back, node,
      dir: `${p2.osm_id}@${node}${suffix}`,
      key: `way/${p2.osm_id}@node/${node}${suffix}~m`,
      panelMax: inferMotoBoxMax(back),
    })
  }
  push(false, nodeLast)
  if (p2.oneway === 'no') push(true, nodeFirst)
}

// ── 建置端：把面板允許的上限全部寫成人工紀錄，看有幾個真的畫得出來 ──
const forced: EnhancementRecord[] = [...journal]
for (const d of panelDirs) {
  if (d.panelMax > 0) {
    forced.push({ op: 'set', target: { type: 'moto_box', key: d.key }, fields: { lanes: d.panelMax } } as EnhancementRecord)
  }
}
const built = buildMotoBoxes(graph, bays, rightLanes, forced)
const byDir = new Map(built.boxes.map((b) => [b.dir, b]))

// buildMotoBoxes 的各道關卡在該行向的判定（用來歸因）
const inter = new Set(graph.intersections().map((i) => i.id))
const rlWays = new Set(rightLanes.map((r) => r.wayId))
const explicitWays = new Set(panelDirs.filter((d) => d.panelMax > 0).map((d) => d.road.properties.osm_id))
const scopeEdgeOf = new Map<string, ReturnType<RoadGraph['scopeEdges']>[number]>()
for (const e of stopLineEdges(graph, (r) =>
  scopeFn(r) || hasTl(r) || rlWays.has(r.properties.osm_id)
  || isMajorStopRoad(r) || explicitWays.has(r.properties.osm_id))) {
  const k = `${e.road.properties.osm_id}@${e.toNode}${e.back ? '~b' : ''}`
  if (!scopeEdgeOf.has(k)) scopeEdgeOf.set(k, e)
}

const reasons = new Map<string, PanelDir[]>()
const bump = (why: string, d: PanelDir) => {
  if (!reasons.has(why)) reasons.set(why, [])
  reasons.get(why)!.push(d)
}
let ok = 0
for (const d of panelDirs) {
  if (d.panelMax <= 0) continue
  const box = byDir.get(d.dir)
  if (box?.ring) { ok++; continue }
  const p = d.road.properties
  const e = scopeEdgeOf.get(d.dir)
  if (p.roadMarkingMode !== 'all') bump('roadMarkingMode !== all', d)
  else if (!e) bump('scopeEdges 沒有這個行向鍵（面板 node 與 graph toNode 不一致）', d)
  else if (!inter.has(e.toNode)) bump('toNode 不是路口（相鄰節點 < 3）', d)
  else if (e.endSetbackM <= 2) bump('endSetbackM <= 2（該端沒有夠格的交叉路）', d)
  else if (laneSpanM(p, d.back) <= 0) bump('laneSpanM <= 0', d)
  else if (!box) bump('其他前置 continue', d)
  else bump('候選存在但 ring=null（幾何放不下）', d)
}

console.log(`面板可設定的行向：${panelDirs.filter((d) => d.panelMax > 0).length} / 全部 ${panelDirs.length}`)
console.log(`其中真的畫得出來：${ok}`)
for (const [why, list] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n❌ ${why}：${list.length}`)
  for (const d of list.slice(0, 6)) {
    console.log(`   ${d.road.properties.name ?? '?'} way/${d.road.properties.osm_id}@b/${d.road.properties.blockNode}`
      + ` ${d.back ? '逆向' : '順向'} node=${d.node} panelMax=${d.panelMax}`
      + ` hw=${d.road.properties.highway} w=${d.road.properties.width_m.toFixed(1)}`)
  }
}

// ── 同一區塊兩向落差（使用者回報「單邊可以、另一邊不行」）──
const perBlock = new Map<string, PanelDir[]>()
for (const d of panelDirs) {
  const k = `${d.road.properties.osm_id}@b/${d.road.properties.blockNode}`
  if (!perBlock.has(k)) perBlock.set(k, [])
  perBlock.get(k)!.push(d)
}
let asym = 0
const samples: string[] = []
for (const [k, list] of perBlock) {
  if (list.length !== 2) continue
  const drawn = list.map((d) => !!byDir.get(d.dir)?.ring)
  const wanted = list.map((d) => d.panelMax > 0)
  if (wanted[0] && wanted[1] && drawn[0] !== drawn[1]) {
    asym++
    if (samples.length < 8) {
      samples.push(`${list[0].road.properties.name ?? '?'} ${k}`
        + ` 順向=${drawn[0] ? '✔' : '✘'}(node ${list[0].node})`
        + ` 逆向=${drawn[1] ? '✔' : '✘'}(node ${list[1].node})`)
    }
  }
}
console.log(`\n兩向都可設定、卻只有單邊畫得出來的區塊：${asym}`)
for (const s of samples) console.log('   ' + s)

// ── 「有停止線卻不給停等格」：兩者的 crossQualifies 不同（isStopLineRoad vs isMajorStopRoad）──
const stopDirs = new Set(buildStopLines(graph, bays, rightLanes)
  .map((l) => l.ownerKey).filter(Boolean) as string[])
const hasStopLineButNoBox = panelDirs.filter((d) =>
  d.panelMax > 0 && stopDirs.has(d.dir) && !byDir.get(d.dir)?.ring)
console.log(`\n有停止線、面板允許設定、卻畫不出停等格的行向：${hasStopLineButNoBox.length}`)
for (const d of hasStopLineButNoBox.slice(0, 8)) {
  const e = scopeEdgeOf.get(d.dir)
  console.log(`   ${d.road.properties.name ?? '?'} way/${d.road.properties.osm_id}@b/${d.road.properties.blockNode}`
    + ` ${d.back ? '逆向' : '順向'} node=${d.node} endSetback(moto)=${e ? e.endSetbackM.toFixed(1) : 'n/a'}`
    + ` hw=${d.road.properties.highway}`)
}


// ── seen 早標記：同一行向鍵是否有多個切塊候選（buildStopLines 已修過同類問題）──
const dupCount = new Map<string, number>()
for (const e of graph.scopeEdges(() => true, 7, 1.2, isMajorStopRoad)) {
  const k = `${e.road.properties.osm_id}@${e.toNode}${e.back ? '~b' : ''}`
  dupCount.set(k, (dupCount.get(k) ?? 0) + 1)
}
const dups = [...dupCount].filter(([, n]) => n > 1)
console.log(`\n同一行向鍵有多個切塊候選（seen 早標記會誤殺）：${dups.length}`)
for (const [k, n] of dups.slice(0, 5)) console.log(`   ${k} × ${n}`)
