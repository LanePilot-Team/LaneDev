import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'
import { angleDelta, bearing } from '../src/core/geo'
import { annotateRightLanes, buildRightLanes } from '../src/core/turnbays'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const journal: EnhancementRecord[] = db.editor?.journal ?? []
const parsed = parseImported(db.segments.map((record: unknown) => JSON.stringify(record)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database is not a map')

const { roads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads.filter((road) => !road.properties.deleted), journal)
const graph = new RoadGraph(view.renderRoads)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `：${detail}` : ''}`)
  if (!ok) failures++
}

check('路口假節點收斂到既有 block 節點', nodeRemap.get(1451069485) === 1451069052)
const north = view.renderRoads.find((road) =>
  road.properties.osm_id === 362686118 && road.properties.blockNode === 2264426745)
const south = view.renderRoads.find((road) =>
  road.properties.osm_id === 362686118 && road.properties.blockNode === 1451069052)
check('興西路兩段存在', !!north && !!south)
if (north && south) {
  const a = north.geometry.coordinates as [number, number][]
  const b = south.geometry.coordinates as [number, number][]
  check('興西路兩段共用同一座標與節點',
    north.properties.nodes.at(-1) === 1451069052
    && south.properties.nodes[0] === 1451069052
    && a.at(-1)![0] === b[0][0] && a.at(-1)![1] === b[0][1])
  const delta = Math.abs(angleDelta(bearing(a.at(-2)!, a.at(-1)!), bearing(b[0], b[1])))
  check('興西路跨路口保持同軸', delta < 5, `方向差 ${delta.toFixed(2)}°`)
}

const rightLanes = buildRightLanes(graph, journal)
const fixedLane = rightLanes.find((lane) =>
  lane.key === 'way/362686116@node/1451069052~b~r')
check('經建路西往東有獨立右轉專用道', !!fixedLane,
  fixedLane ? `外移 ${fixedLane.offM.toFixed(1)}m` : '')

const straightRoute = graph.route([120.33264, 22.72350], [120.33220, 22.72203], 'car')
check('興西路可連續直行跨越路口', !!straightRoute
  && !straightRoute.maneuvers.some((maneuver) => maneuver.kind !== 'arrive'))

const rightRoute = graph.route([120.33175, 22.72261], [120.33224, 22.72212], 'car')
if (rightRoute) annotateRightLanes(rightRoute, rightLanes)
const right = rightRoute?.maneuvers.find((maneuver) => maneuver.kind === 'right')
check('經建路右轉導航會提前切入專用道', !!right?.rightOffM && right.rightOffM > 0)
check('經建路兩條主線維持只能直行',
  right?.turnLanes?.length === 2 && right.turnLanes.every((turn) => turn === 'through'))

process.exit(failures ? 1 : 0)
