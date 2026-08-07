import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { prepareBaseRoads } from '../src/core/pipeline'
import { roadsFromGeoJSON } from '../src/core/roads'
import { RoadGraph } from '../src/core/graph'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database did not parse as a map')
const { roads, wayRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const main = roads.filter((road) => road.properties.name === '建楠路')
const mainNodes = new Set(main.flatMap((road) => road.properties.nodes))
const expectedPairs = [
  [23787570, 271982142],
  [27527298, 271982144],
  [27527294, 230282047],
  [271982140, 1456608388],
]
const directSideWays = [26977345, 216735401, 216735419, 216735435, 230209120]
const graph = new RoadGraph(roads)
const mainCoords = main.flatMap((road) => road.geometry.coordinates as [number, number][])
const west = mainCoords.reduce((a, b) => a[0] < b[0] ? a : b)
const east = mainCoords.reduce((a, b) => a[0] > b[0] ? a : b)


let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `｜${detail}` : ''}`)
  if (!ok) failures++
}

check('建楠路所有繪圖區塊均為雙向合體樣式',
  main.length > 0 && main.every((road) =>
    road.properties.oneway === 'no' && road.properties.coupletMerged === true),
  `區塊=${main.length}，雙向=${main.filter((road) => road.properties.oneway === 'no').length}`)

for (const [keep, drop] of expectedPairs) {
  check(`way/${keep} 與 way/${drop} 成功配對`,
    main.some((road) => {
      const sources = new Set(road.properties.sourceSegments.map((source) => source.osmId))
      return sources.has(keep) && sources.has(drop)
    }) || wayRemap.get(keep)?.keepIds.includes(drop) === true
      || wayRemap.get(drop)?.keepIds.includes(keep) === true)
}

for (const wayId of directSideWays) {
  const side = roads.filter((road) => road.properties.osm_id === wayId)
  const connected = side.some((road) => road.properties.nodes.some((node) => mainNodes.has(node)))
  check(`側路 way/${wayId} 仍連上建楠路`, connected)
  const outerRoad = side.find((road) =>
    road.properties.nodes.some((node) => !mainNodes.has(node))) ?? side[0]
  const outerIndex = outerRoad?.properties.nodes.findIndex((node) => !mainNodes.has(node)) ?? -1
  const outer = outerIndex >= 0
    ? (outerRoad.geometry.coordinates[outerIndex] as [number, number]) : undefined
  check(`側路 way/${wayId} 可導航進入建楠路兩個方向`, !!outer
    && graph.route(outer, west, 'car') !== null
    && graph.route(outer, east, 'car') !== null)
}

if (failures) process.exitCode = 1
