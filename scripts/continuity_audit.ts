// 路網連續性審計：找出「圖上看起來相連、實際不可行駛」的斷點。
//
// 檢查兩類：
//   A. 同 way 斷鏈——prepareBaseRoads 會把一條 way 依路口切成連續區塊，
//      區塊鍵（blockNode）應能首尾相接成一條鏈。若鏈中間缺一段，該處就是
//      幾何上看不出來、A* 卻走不過去的斷點（導航會鑽小巷或大迴轉繞路）。
//   B. 端點懸空——某區塊端點附近（<GAP_M）有別條路的頂點，但兩者不共用節點，
//      也就是畫面上貼在一起、拓撲上互不相干。
//
// 用法：node scripts/run_offline.mjs scripts/continuity_audit.ts [--gap=6] [--stage]
//   --stage 會額外回報斷點在管線哪一階段消失（prepared / journal / merge）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
} from '../src/core/laneBase'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const has = (name: string) => process.argv.includes(`--${name}`)
const GAP_M = Number(arg('gap', '6'))

const db = JSON.parse(readFileSync(
  arg('db', join(HERE, '../public/data/road_database.json')), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const preparedRoads = prepared.roads

const extraction = extractLaneBase(Array.isArray(db.annotations) ? db.annotations : [])
const remapped = remapLaneBase(extraction.records, {
  existingWayIds: new Set(preparedRoads.map((r) => r.properties.osm_id)),
  nodeRemap: prepared.nodeRemap,
  wayRemap: prepared.wayRemap,
  wayApproachNodes: preparedRoads.reduce((index, road) => {
    const nodes = index.get(road.properties.osm_id) ?? {
      forward: new Set<number>(), backward: new Set<number>(),
    }
    nodes.forward.add(road.properties.nodes.at(-1)!)
    if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
    index.set(road.properties.osm_id, nodes)
    return index
  }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
})
applyLaneBaseToRoads(preparedRoads, buildLaneBaseIndex(remapped.records))

const journal = db.editor?.journal ?? []
const folded = foldJournal(journal)
const roadsAll = [...preparedRoads, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
applyToRoads(roadsAll, folded)
const undeleted = roadsAll.filter((r) => !r.properties.deleted)
const view = buildRoadMergeViews(undeleted, journal)
const roads = view.routingRoads

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const stageSets = {
  prepared: new Set(preparedRoads.map(blockKey)),
  journal: new Set(roadsAll.map(blockKey)),
  undeleted: new Set(undeleted.map(blockKey)),
  routing: new Set(roads.map(blockKey)),
}
const deletedKeys = new Set(roadsAll.filter((r) => r.properties.deleted).map(blockKey))

console.log(`路網：${roads.length} 區塊（prepared ${preparedRoads.length}、journal 後 ${roadsAll.length}、`
  + `未刪除 ${undeleted.length}）`)

// ── A. 同 way 斷鏈 ───────────────────────────────────────────────
interface Break {
  wayId: number
  name: string
  fromNode: number
  toNode: number
  gapM: number
  at: [number, number]
  stage: string
}
// 節點相鄰關係：疊圖重複 way（區界 shard 重疊）刪掉其中一份是正當清理，
// 只要還有別條現存道路把同一組節點直接連起來，路網就沒有洞。
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const adjacency = new Set<string>()
const liveNodes = new Set<number>()
for (const r of roads) {
  const ns = r.properties.nodes
  for (let i = 0; i < ns.length; i++) {
    liveNodes.add(ns[i])
    if (i > 0) adjacency.add(pairKey(ns[i - 1], ns[i]))
  }
}

// 消失的區塊裡，哪些帶走了沒人接手的節點相鄰關係
const routingKeys = stageSets.routing
const missing = preparedRoads.filter((r) => !routingKeys.has(blockKey(r)))
interface Gap { block: RoadFeature; pairs: [number, number][] }
const gaps: Gap[] = []
for (const block of missing) {
  const ns = block.properties.nodes
  const pairs: [number, number][] = []
  for (let i = 1; i < ns.length; i++) {
    if (!adjacency.has(pairKey(ns[i - 1], ns[i]))) pairs.push([ns[i - 1], ns[i]])
  }
  if (pairs.length) gaps.push({ block, pairs })
}

// 連著消失的好幾段要當成同一個缺口看：中間節點已經沒人使用，逐塊判定每一塊都會
// 看起來像「末端殘段」，實際上整段是主幹道上的一個洞（德中路／援中路 那 14m）。
const parent = new Map<number, number>()
const find = (x: number): number => {
  if (!parent.has(x)) { parent.set(x, x); return x }
  let root = x
  while (parent.get(root) !== root) root = parent.get(root)!
  let cur = x
  while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next }
  return root
}
for (const g of gaps) for (const [a, b] of g.pairs) {
  const ra = find(a); const rb = find(b)
  if (ra !== rb) parent.set(ra, rb)
}
const runs = new Map<number, Gap[]>()
for (const g of gaps) {
  const root = find(g.pairs[0][0])
  runs.set(root, [...(runs.get(root) ?? []), g])
}
const runLive = (list: Gap[]) => {
  const live = new Set<number>()
  for (const g of list) for (const [a, b] of g.pairs) {
    if (liveNodes.has(a)) live.add(a)
    if (liveNodes.has(b)) live.add(b)
  }
  return live
}

const breaks: Break[] = []
let stubRuns = 0
for (const [, list] of runs) {
  // 只接回 ≤1 個仍在路網上的節點 = 死路末端，刪掉不影響通行
  if (runLive(list).size < 2) { stubRuns++; continue }
  for (const g of list) {
    const key = blockKey(g.block)
    const stage = !stageSets.journal.has(key) ? 'journal 前就沒有'
      : deletedKeys.has(key) ? 'journal 標記 deleted'
      : !stageSets.undeleted.has(key) ? 'journal 後消失'
      : 'roadMerge routingRoads 移除'
    const cs = g.block.geometry.coordinates as [number, number][]
    breaks.push({
      wayId: g.block.properties.osm_id,
      name: g.block.properties.name ?? '(無名)',
      fromNode: g.block.properties.nodes[0],
      toNode: g.block.properties.nodes.at(-1)!,
      gapM: cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0),
      at: cs[0],
      stage,
    })
  }
}
const uniqueBreaks = [...new Map(breaks.map((b) =>
  [`${b.wayId}:${b.fromNode}>${b.toNode}`, b])).values()]

console.log(`\n=== A. 路網中間的洞：${uniqueBreaks.length} 區塊`
  + `（另有 ${stubRuns} 處死路末端消失，不影響通行）===`)
const byStage = new Map<string, Break[]>()
for (const b of uniqueBreaks) {
  const list = byStage.get(b.stage) ?? []
  list.push(b)
  byStage.set(b.stage, list)
}
for (const [stage, list] of [...byStage].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${stage}：${list.length}`)
}
const shown = uniqueBreaks.sort((a, b) => b.gapM - a.gapM)
for (const b of shown.slice(0, Number(arg('top', '40')))) {
  console.log(`  ❌ ${b.name} way/${b.wayId} 缺 ${b.fromNode}>${b.toNode}`
    + ` 長 ${b.gapM.toFixed(1)}m @ ${b.at[0].toFixed(6)},${b.at[1].toFixed(6)}（${b.stage}）`)
}
if (shown.length > 40) console.log(`  …另有 ${shown.length - 40} 處`)

// ── B. 端點懸空 ──────────────────────────────────────────────────
if (has('dangling')) {
  const nodeAt = new Map<number, [number, number]>()
  const nodeUse = new Map<number, number>()
  for (const r of roads) {
    const cs = r.geometry.coordinates as [number, number][]
    r.properties.nodes.forEach((n, i) => {
      nodeAt.set(n, cs[i])
      nodeUse.set(n, (nodeUse.get(n) ?? 0) + 1)
    })
  }
  // 粗網格加速鄰近查詢
  const cell = (c: [number, number]) =>
    `${Math.round(c[0] / 0.0002)},${Math.round(c[1] / 0.0002)}`
  const grid = new Map<string, { node: number; pos: [number, number] }[]>()
  for (const [node, pos] of nodeAt) {
    const k = cell(pos)
    const list = grid.get(k) ?? []
    list.push({ node, pos })
    grid.set(k, list)
  }
  const near = (pos: [number, number]) => {
    const [cx, cy] = cell(pos).split(',').map(Number)
    const out: { node: number; pos: [number, number] }[] = []
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      out.push(...(grid.get(`${cx + dx},${cy + dy}`) ?? []))
    }
    return out
  }
  const wayOfNode = new Map<number, Set<number>>()
  for (const r of roads) for (const n of r.properties.nodes) {
    const s = wayOfNode.get(n) ?? new Set<number>()
    s.add(r.properties.osm_id)
    wayOfNode.set(n, s)
  }

  const dangling: string[] = []
  for (const r of roads) {
    const cs = r.geometry.coordinates as [number, number][]
    for (const idx of [0, r.properties.nodes.length - 1]) {
      const node = r.properties.nodes[idx]
      // 端點只被自己這條 way 用到 = 死路端點
      const ways = wayOfNode.get(node)!
      if (ways.size > 1) continue
      if ((nodeUse.get(node) ?? 0) > 1) continue // 同 way 續行
      const pos = cs[idx]
      for (const cand of near(pos)) {
        if (cand.node === node) continue
        if (wayOfNode.get(cand.node)?.has(r.properties.osm_id)) continue
        const d = haversine(pos, cand.pos)
        if (d > GAP_M) continue
        dangling.push(`  ⚠ ${r.properties.name ?? '(無名)'} way/${r.properties.osm_id}`
          + ` 端點 node=${node} 距 node=${cand.node}`
          + ` ${d.toFixed(2)}m 但未共用 @ ${pos[0].toFixed(6)},${pos[1].toFixed(6)}`)
        break
      }
    }
  }
  console.log(`\n=== B. 端點懸空（<${GAP_M}m 貼著別條路卻不共點）：${dangling.length} 處 ===`)
  for (const line of dangling.slice(0, 60)) console.log(line)
  if (dangling.length > 60) console.log(`  …另有 ${dangling.length - 60} 處`)
}

process.exitCode = shown.length === 0 ? 0 : 1
