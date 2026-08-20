// 收邊探針：指定 way/node，列出該節點所有相鄰道路、是否被 crossW 採計、以及最終 endSetbackM。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { stopLineEdges } from '../src/core/turnbays'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('bad db')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor.journal))
const view = buildRoadMergeViews(roads, db.editor.journal)
const graph = new RoadGraph(view.renderRoads)

const targets = (process.argv.find((a) => a.startsWith('--ways='))?.slice(7) ?? '')
  .split(',').map(Number).filter(Boolean)

const edges = stopLineEdges(graph, (r) => targets.includes(r.properties.osm_id))
console.log(`目標 way ${targets.join(',')} 的方向邊 ${edges.length} 條\n`)
for (const e of edges) {
  const sp = e.road.properties
  console.log(`── way/${sp.osm_id} (${sp.name}) ${sp.highway} 寬 ${sp.width_m?.toFixed(1)}m ${e.back ? '逆向' : '正向'} → 終點節點 ${e.toNode}`)
  console.log(`   endSetbackM = ${e.endSetbackM.toFixed(2)} m`)
  type AdjEdge = { road: { properties: Record<string, unknown> } }
  type GraphAdj = { adj: Map<number, AdjEdge[]> }
  const adj = (graph as unknown as GraphAdj).adj.get(e.toNode) ?? []
  const seen = new Set<number>()
  for (const o of adj) {
    const q = o.road.properties
    const oid = Number(q.osm_id)
    if (seen.has(oid)) continue
    seen.add(oid)
    if (oid === sp.osm_id) { console.log(`     － way/${oid} (${q.name}) 自己`); continue }
    const sameName = !!(sp.name && q.name === sp.name && q.highway === sp.highway)
    const w = Number(q.width_m)
    const narrow = w < 7
    const skip = sameName || narrow
    console.log(`     ${skip ? '✗跳過' : '✓採計'} way/${oid} (${q.name}) ${q.highway} 寬 ${w.toFixed(1)}m` +
      `${sameName ? '  ← 同名同等級(續接)被跳過' : ''}${!sameName && narrow ? '  ← 寬度<7m 被跳過' : ''}`)
  }
  console.log()
}
