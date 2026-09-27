// E10：路面多邊形 turf buffer（JSTS）vs strokePolygons（重疊凸片）的 A/B。
//   node scripts/run_offline.mjs scripts/surface_ab_probe.ts [--sample=0]
//
// 量兩件事：
//   1. 耗時比（同程序交錯，只取比值）
//   2. 幾何差異：兩者各自與精確 buffer（距離 ≤ r）做蒙地卡羅比對
// --sample=N 只比對前 N 條路；0 = 全部。--points=N 每個多邊形取樣點數。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { booleanPointInPolygon, buffer, lineOffset, point } from '@turf/turf'
import type { Feature, LineString, MultiPolygon, Polygon } from 'geojson'
import { parseImportedRecords } from '../src/core/importmap'
import { roadsFromGeoJSON, roadsForRendering, strokePolygons, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const SAMPLE = Number(arg('sample', '0'))

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImportedRecords(db.segments as Record<string, unknown>[])
if (parsed.kind !== 'map') throw new Error('bad')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor.journal))
const rr = roadsForRendering(buildRoadMergeViews(roads, db.editor.journal).renderRoads)

// 與 buildRoadSurfaces 相同的軸線與半徑
const jobs: { road: RoadFeature; axis: Feature<LineString>; r: number }[] = []
for (const road of rr) {
  if (road.properties.elevated || road.geometry.coordinates.length < 2) continue
  let axis: Feature<LineString> = road
  if (road.properties.oneway === 'no' && Math.abs(road.properties.divOffM || 0) > 0.01) {
    try { axis = lineOffset(road, -(road.properties.divOffM || 0), { units: 'meters' }) } catch { axis = road }
  }
  for (const extra of [2.4, 0.8]) jobs.push({ road, axis, r: (road.properties.width_m + extra) / 2 })
}
console.log(`jobs ${jobs.length}`)

// ── 1. 耗時（A/B 交錯 3 輪）──
const ms = () => performance.now()
const tA: number[] = []; const tB: number[] = []
for (let round = 0; round < 3; round++) {
  let t = ms()
  for (const j of jobs) buffer(j.axis, j.r, { units: 'meters', steps: 4 })
  tA.push(ms() - t)
  t = ms()
  for (const j of jobs) strokePolygons(j.axis.geometry.coordinates as [number, number][], j.r)
  tB.push(ms() - t)
}
console.log(`turf buffer      ${tA.map((v) => v.toFixed(0)).join(' / ')} ms`)
console.log(`strokePolygons   ${tB.map((v) => v.toFixed(0)).join(' / ')} ms`)
console.log(`比值（中位）      ${([...tA].sort((a, b) => a - b)[1] / [...tB].sort((a, b) => a - b)[1]).toFixed(1)}×`)

// ── 2. 幾何差異：對「精確 buffer」做蒙地卡羅取樣 ──
// 精確定義：點到折線距離 ≤ r。兩種多邊形都拿去跟它比，才分得出誰的誤差。
// （先前用 turf union 求對稱差，polyclip 在全圖規模會吃光 4 GB heap。）
let seed = 20260927
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const N = Number(arg('points', '200'))
let exactArea = 0; let errA = 0; let errB = 0; let disagree = 0
let vertsA = 0; let vertsB = 0
const worst: { key: string; errB: number; errA: number; area: number }[] = []
const count = (g: Polygon | MultiPolygon) =>
  (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).reduce((s, poly) => s + poly.reduce((t, r) => t + r.length, 0), 0)
const list = SAMPLE > 0 ? jobs.slice(0, SAMPLE) : jobs
for (const j of list) {
  const coords = j.axis.geometry.coordinates as [number, number][]
  const a = buffer(j.axis, j.r, { units: 'meters', steps: 4 }) as Feature<Polygon | MultiPolygon> | undefined
  const b = strokePolygons(coords, j.r)
  if (!a || !b) continue
  vertsA += count(a.geometry); vertsB += count(b)
  const [lon0, lat0] = coords[0]
  const kx = (Math.PI / 180) * 6371008.8 * Math.cos((lat0 * Math.PI) / 180)
  const ky = (Math.PI / 180) * 6371008.8
  const xy = coords.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky])
  const xs = xy.map((p) => p[0]); const ys = xy.map((p) => p[1])
  const x0 = Math.min(...xs) - j.r; const x1 = Math.max(...xs) + j.r
  const y0 = Math.min(...ys) - j.r; const y1 = Math.max(...ys) + j.r
  const boxArea = (x1 - x0) * (y1 - y0)
  let inE = 0; let eA = 0; let eB = 0; let dAB = 0
  for (let k = 0; k < N; k++) {
    const px = x0 + rand() * (x1 - x0); const py = y0 + rand() * (y1 - y0)
    let d = Infinity
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i]; const [bx, by] = xy[i + 1]
      const vx = bx - ax; const vy = by - ay; const len2 = vx * vx + vy * vy
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
      d = Math.min(d, Math.hypot(px - ax - t * vx, py - ay - t * vy))
    }
    if (xy.length === 1) d = Math.hypot(px - xy[0][0], py - xy[0][1])
    const exact = d <= j.r
    const pt = point([lon0 + px / kx, lat0 + py / ky])
    const inA = booleanPointInPolygon(pt, a); const inB = booleanPointInPolygon(pt, b)
    if (exact) inE++
    if (inA !== exact) eA++
    if (inB !== exact) eB++
    if (inA !== inB) dAB++
  }
  const unit = boxArea / N
  exactArea += inE * unit; errA += eA * unit; errB += eB * unit; disagree += dAB * unit
  worst.push({ key: `way/${j.road.properties.osm_id}@b/${j.road.properties.blockNode} r=${j.r.toFixed(1)}`,
    errA: eA / Math.max(1, inE), errB: eB / Math.max(1, inE), area: inE * unit })
}
worst.sort((x, y) => y.errB - x.errB)
console.log(`
取樣 ${list.length} 個多邊形 × ${N} 點`)
console.log(`精確 buffer 面積（估）   ${(exactArea / 1e6).toFixed(3)} km²`)
console.log(`turf buffer 誤差面積     ${(errA / exactArea * 100).toFixed(3)}%`)
console.log(`strokePolygons 誤差面積  ${(errB / exactArea * 100).toFixed(3)}%`)
console.log(`兩者互相不一致          ${(disagree / exactArea * 100).toFixed(3)}%`)
console.log(`頂點數：buffer ${vertsA.toLocaleString()} / 凸片 ${vertsB.toLocaleString()}`)
console.log('strokePolygons 相對誤差最大的 5 個：')
for (const w of worst.slice(0, 5)) {
  console.log(`  ${w.key}  凸片 ${(w.errB * 100).toFixed(1)}%  turf ${(w.errA * 100).toFixed(1)}%  (${w.area.toFixed(0)} m²)`)
}
