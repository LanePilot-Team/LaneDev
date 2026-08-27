// 迴轉限制的批次回歸（npm run audit:uturn [-- --dump]）：
// 固定亂數種子取 400 組 OD，統計成功率／平均長度／迴轉次數。
// 用途是「加嚴迴轉規則後有沒有把路網切斷」——成功數不該掉，迴轉數只該減少。
// 2026-08-19 分隔島禁止迴轉上線時的基準：成功 373／失敗 27／迴轉 245~248／平均 5.4 km。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('bad db')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads.filter((r) => !r.properties.deleted), journal)
const graph = new RoadGraph(view.routingRoads)

let seed = 20260819
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pts: [number, number][] = []
for (const r of view.routingRoads) {
  const c = r.geometry.coordinates as [number, number][]
  pts.push(c[Math.floor(c.length / 2)])
}
let ok = 0, fail = 0, uturns = 0, totalM = 0
const lines: string[] = []
for (let i = 0; i < 400; i++) {
  const a = pts[Math.floor(rnd() * pts.length)]
  const b = pts[Math.floor(rnd() * pts.length)]
  const r = graph.route(a, b, 'car')
  if (!r) { fail++; lines.push(`FAIL ${a[0].toFixed(5)},${a[1].toFixed(5)} -> ${b[0].toFixed(5)},${b[1].toFixed(5)}`); continue }
  ok++
  totalM += r.lengthM
  const u = r.maneuvers.filter((m) => m.kind === 'uturn').length
  uturns += u
  lines.push(`OK ${Math.round(r.lengthM)} u=${u} ${a[0].toFixed(5)},${a[1].toFixed(5)} -> ${b[0].toFixed(5)},${b[1].toFixed(5)}`)
}
console.log(`成功 ${ok} / 失敗 ${fail}｜迴轉總數 ${uturns}｜平均長度 ${Math.round(totalM / Math.max(1, ok))} m`)
if (process.argv.includes('--dump')) console.log(lines.join('\n'))
