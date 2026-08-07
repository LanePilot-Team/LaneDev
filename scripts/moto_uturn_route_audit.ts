// 楠梓路指定機車迴轉動線稽核。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'

const here = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(here, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads.filter((road) => !road.properties.deleted), journal)
const graph = new RoadGraph(view.routingRoads)
const start: [number, number] = [120.3258, 22.7364]
const goal: [number, number] = [120.3259, 22.7361]

let failed = false
for (const profile of ['moto', 'car'] as const) {
  const route = graph.route(start, goal, profile)
  console.log(`\n${profile}：${route ? `${route.lengthM.toFixed(1)}m` : '無路線'}`)
  for (const span of route?.spans ?? []) {
    const p = span.road?.properties
    console.log(`  way/${p?.osm_id}@b/${p?.blockNode}${span.back ? '~b' : ''} ${p?.name ?? ''}`)
  }
  const ways = route?.spans.map((span) => span.road?.properties.osm_id) ?? []
  if (profile === 'moto') {
    const expected = [230071783, 230071784, 230071785]
    const indices = expected.map((way) => ways.indexOf(way))
    const ok = indices.every((index) => index >= 0)
      && indices[0] < indices[1] && indices[1] < indices[2]
      && !ways.includes(1464614119)
    console.log(`${ok ? '✅' : '❌'} 機車依序使用指定迴轉道且未在 1464614119 左轉`)
    if (!ok) failed = true
  } else {
    const ok = ways.includes(1464614119) && !ways.includes(230071783)
    console.log(`${ok ? '✅' : '❌'} 汽車維持原直接左轉路線`)
    if (!ok) failed = true
  }
}

process.exitCode = failed ? 1 : 0
