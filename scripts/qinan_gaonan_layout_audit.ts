import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { prepareBaseRoads } from '../src/core/pipeline'
import { roadsFromGeoJSON } from '../src/core/roads'
import { buildMedians } from '../src/core/medians'
import { RoadGraph } from '../src/core/graph'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database did not parse as a map')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const graph = new RoadGraph(roads)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `｜${detail}` : ''}`)
  if (!ok) failures++
}

const qinan = roads.filter((road) => road.properties.name === '旗楠路')
const qinanPrimary = qinan.filter((road) => road.properties.highway === 'primary')
const qinanSide = qinan.filter((road) => road.properties.highway !== 'primary')
check('旗楠路 primary 全部成為雙向合體樣式', qinanPrimary.length > 0
  && qinanPrimary.every((road) => road.properties.oneway === 'no'
    && road.properties.coupletMerged === true
    && road.properties.centerKind !== 'island'),
`主線區塊=${qinanPrimary.length}`)
check('旗楠路住宅側線保留獨立', qinanSide.length > 0
  && qinanSide.every((road) => !road.properties.coupletMerged),
`側線區塊=${qinanSide.length}`)

const gaonan = roads.filter((road) => road.properties.name === '高楠公路')
const gaonanGroundOneWays = gaonan.filter((road) => road.properties.oneway === 'yes'
  && !road.properties.elevated)
check('高楠公路地面多線道路保留分開導航', gaonanGroundOneWays.length >= 4,
  `單向區塊=${gaonanGroundOneWays.length}`)
const medians = buildMedians(roads).filter((island) =>
  gaonan.some((road) => island.key.includes(`/way/${road.properties.osm_id}/`)))
check('高楠公路不生成中央島填充', medians.length === 0,
  `島面=${medians.length}`)

// 取每條直接接到旗楠／高楠主線的異名道路，確認共同節點在路網中仍是路口。
for (const [name, main] of [['旗楠路', qinan], ['高楠公路', gaonan]] as const) {
  const nodes = new Set(main.flatMap((road) => road.properties.nodes))
  const connected = roads.filter((road) => road.properties.name !== name
    && road.properties.nodes.some((node) => nodes.has(node)))
  check(`${name}相接道路仍保有導航路口`, connected.length > 0
    && connected.every((road) => road.properties.nodes.some((node) =>
      nodes.has(node) && graph.hasDistinctRoadAt(node, road))), `相接區塊=${connected.length}`)
}

if (failures) process.exitCode = 1
