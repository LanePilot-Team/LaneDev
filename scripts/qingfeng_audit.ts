// 清豐路特殊斷面稽核（node scripts/run_offline.mjs scripts/qingfeng_audit.ts）
// 中央汽車道＋兩側機車側車道視為同一廊帶：停止線只能落在兩個外緣。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'
import { buildTurnBays, buildRightLanes, buildStopLines } from '../src/core/turnbays'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((road) => !road.properties.deleted)
const view = buildRoadMergeViews(active, journal)
const graph = new RoadGraph(view.renderRoads)
const bays = buildTurnBays(graph, journal)
const rightLanes = buildRightLanes(graph, journal)
const stops = buildStopLines(graph, bays, rightLanes, journal)
const stopKeys = new Set(stops.map((line) => line.ownerKey))

const sideNodes = new Set<number>()
const mainNodes = new Set<number>()
for (const road of view.renderRoads) {
  const p = road.properties
  if (p.name !== '清豐路') continue
  const target = p.lanesForward + p.lanesBackward === 0 ? sideNodes : mainNodes
  for (const node of p.nodes) target.add(node)
}
const corridorNodes = new Set([...sideNodes, ...mainNodes])
const owner = (edge: ReturnType<RoadGraph['scopeEdges']>[number]) =>
  `${edge.road.properties.osm_id}@${edge.toNode}${edge.back ? '~b' : ''}`
const crossings = graph.scopeEdges((road) => road.properties.name !== '清豐路', 0, 0)
const outer = crossings.filter((edge) =>
  sideNodes.has(edge.toNode) && !corridorNodes.has(edge.fromNode))
const inner = crossings.filter((edge) =>
  corridorNodes.has(edge.toNode) && corridorNodes.has(edge.fromNode))
const missing = outer.filter((edge) => !stopKeys.has(owner(edge)))
const misplaced = inner.filter((edge) => stopKeys.has(owner(edge)))

const connector = view.routingRoads.find((road) => {
  const p = road.properties
  return p.osm_id === 799032593 && p.blockNode === 7472962175 && !p.deleted
})

let failed = false
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? '✅' : '❌'} ${label}：${detail}`)
  if (!ok) failed = true
}
check('清豐路兩側外緣進口都有停止線', missing.length === 0,
  `${outer.length - missing.length}/${outer.length}`
  + (missing.length ? `；缺少 ${missing.map(owner).join(', ')}` : ''))
check('清豐路廊帶內部沒有交叉道路停止線', misplaced.length === 0,
  misplaced.length ? `錯置 ${misplaced.map(owner).join(', ')}` : `${inner.length} 個內部行向皆排除`)
check('寶溪南街保留段已接回清豐路尾段', !!connector,
  connector ? 'way/799032593@b/7472962175 已啟用並連到 node 7472962174' : '連接區塊仍停用')

process.exitCode = failed ? 1 : 0
