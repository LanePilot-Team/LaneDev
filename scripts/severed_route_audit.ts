import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { carAllowed, oneSideEntryTransitionAllowed } from '../src/core/graph'

const HERE = dirname(fileURLToPath(import.meta.url))
const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback
const databasePath = argument('db', join(HERE, '../public/data/road_database.json'))

const db = JSON.parse(readFileSync(databasePath, 'utf8'))
const parsed = parseImported(db.segments.map((record: unknown) => JSON.stringify(record)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads.filter((road) => !road.properties.deleted), journal)
const active = view.routingRoads
const routableMerges = view.resolved.filter((merge) => active.some((road) =>
  road.properties.nodes.includes(merge.junctionNodeId)))
const absorbedMerges = view.resolved.filter((merge) => !routableMerges.includes(merge))
const missingBarriers = routableMerges.filter((merge) => !active.some((road) =>
  road.properties.nodes.includes(merge.junctionNodeId)
  && road.properties.roadMergeBarrierNodes?.includes(merge.junctionNodeId)))

console.log(`可路由的捏合屏障：${routableMerges.length - missingBarriers.length}/${routableMerges.length}`)
console.log(`已由舊版吸收、無導航節點：${absorbedMerges.length}`)
for (const merge of missingBarriers) {
  console.log(`❌ node=${merge.junctionNodeId} 未建立中央島屏障`)
}
console.log('')

interface Direction { road: RoadFeature; back: boolean }

const directionsAt = (road: RoadFeature, node: number) => {
  const index = road.properties.nodes.indexOf(node)
  const last = road.properties.nodes.length - 1
  const incoming: Direction[] = []
  const outgoing: Direction[] = []
  if (index > 0 && carAllowed(road, false)) incoming.push({ road, back: false })
  if (index < last && carAllowed(road, false)) outgoing.push({ road, back: false })
  if (road.properties.oneway === 'no' && carAllowed(road, true)) {
    if (index < last) incoming.push({ road, back: true })
    if (index > 0) outgoing.push({ road, back: true })
  }
  return { incoming, outgoing }
}

const hasMergeAccess = (road: RoadFeature, node: number) =>
  road.properties.oneSideEntryAccess?.some((entry) => entry.nodeId === node)
  || road.properties.oneSideEntryNodes?.includes(node)

interface JunctionAudit { node: number; main: RoadFeature[]; side: RoadFeature }
const audits: JunctionAudit[] = []
const seen = new Set<string>()
for (const merge of view.resolved) {
  const node = merge.junctionNodeId
  const atNode = active.filter((road) => road.properties.nodes.includes(node))
  const mainName = merge.primary.properties.name?.replace(/\s+/g, '')
  const isMain = (road: RoadFeature) => hasMergeAccess(road, node)
    || (!!mainName && road.properties.name?.replace(/\s+/g, '') === mainName)
  const main = atNode.filter(isMain)
  for (const side of atNode.filter((road) => !isMain(road))) {
    const key = `${node}|${side.properties.osm_id}|${side.properties.blockNode}`
    if (seen.has(key)) continue
    seen.add(key)
    audits.push({ node, main, side })
  }
}

let orphans = 0
console.log(`捏合側路接點：${audits.length}\n`)
for (const audit of audits) {
  const mainDirections = audit.main.map((road) => directionsAt(road, audit.node))
  const sideDirections = directionsAt(audit.side, audit.node)
  const canEnter = mainDirections.some((main) => main.incoming.some((incoming) =>
    sideDirections.outgoing.some((outgoing) => oneSideEntryTransitionAllowed(
      incoming.road, incoming.back, outgoing.road, outgoing.back, audit.node))))
  const canExit = sideDirections.incoming.some((incoming) => mainDirections.some((main) =>
    main.outgoing.some((outgoing) => oneSideEntryTransitionAllowed(
      incoming.road, incoming.back, outgoing.road, outgoing.back, audit.node))))
  const sideHasEnterDirection = sideDirections.outgoing.length > 0
  const sideHasExitDirection = sideDirections.incoming.length > 0
  const orphan = (sideHasEnterDirection && !canEnter) || (sideHasExitDirection && !canExit)
  if (orphan) orphans++
  console.log(`${orphan ? '❌' : '✅'} node=${audit.node} `
    + `${audit.side.properties.name ?? '未命名'}（way/${audit.side.properties.osm_id}）`
    + `｜進入=${sideHasEnterDirection ? (canEnter ? '可' : '不可') : 'OSM 不允許'}`
    + `｜駛出=${sideHasExitDirection ? (canExit ? '可' : '不可') : 'OSM 不允許'}`)
  if (orphan) {
    console.log(`   主路=${audit.main.map((road) =>
      `way/${road.properties.osm_id}@b/${road.properties.blockNode}`
      + ` nodes=${road.properties.nodes.join('>')}`
      + ` access=${JSON.stringify(road.properties.oneSideEntryAccess ?? [])}`).join('；')}`)
    console.log(`   側路 nodes=${audit.side.properties.nodes.join('>')}`
      + ` oneway=${audit.side.properties.oneway}`)
  }
}

console.log(`\n失去合法轉向的側路：${orphans}/${audits.length}`)
console.log(orphans === 0
  ? '✅ 側路仍連到相鄰方向；跨中央島轉向由 oneSideEntry 限制'
  : `❌ ${orphans} 條側路雖保留節點，但合法進出轉向仍被切斷`)
process.exitCode = orphans === 0 && missingBarriers.length === 0 ? 0 : 1
