import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildRoadLabelLines } from '../src/core/roadtext'
import { roadsFromGeoJSON } from '../src/core/roads'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database did not parse as a map')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))

const key = (road: (typeof roads)[number]) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`
const hiddenKeys = new Set([
  'way/776417983@b/1196964599',
  'way/103679020@b/1196964599',
])
const targets = roads.filter((road) => hiddenKeys.has(key(road)))
const neighbor = roads.find((road) => key(road) === 'way/23787576@b/257742657')

let failures = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
check('both named motorcycle blocks are present', targets.length === 2)
check('only their floating-label flag is enabled', targets.every((road) =>
  road.properties.hideRoadLabel === true && !!road.properties.name))
check('suppressed blocks generate no floating label lines',
  buildRoadLabelLines(targets).features.length === 0)
check('adjacent motorcycle block remains label-enabled', !!neighbor
  && !neighbor.properties.hideRoadLabel
  && buildRoadLabelLines([neighbor]).features.length > 0)

if (failures) process.exitCode = 1
