import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, mergeMaps } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildElevation } from '../src/core/elevation'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { COS_LAT } from '../src/core/geo'

const here = dirname(fileURLToPath(import.meta.url))
const data = join(here, '../public/data')
const shards = ['lanepilot/area_4212599.segments.jsonl', 'lanepilot/area_4212683.segments.jsonl']
  .map((f) => parseImported(readFileSync(join(data, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: never }[]
const { roads } = prepareBaseRoads(roadsFromGeoJSON(mergeMaps(shards).fc))
const seed: EnhancementRecord[] = JSON.parse(readFileSync(join(data, 'seed_journal.json'), 'utf8'))
applyToRoads(roads, foldJournal(seed))
const model = buildElevation(roads)
const elevated = [...model.entries()].map((e) => e.road)
const kx = 111320 * COS_LAT, ky = 110540
const nearNames = ['楠興東路', '德楠路38巷', '德楠路', '楠梓交流道', '中山高速公路']

for (const r of elevated) {
  const cs = r.geometry.coordinates as [number, number][]
  for (const atStart of [true, false]) {
    const p = atStart ? cs[0] : cs[cs.length - 1]
    let best: { d: number; road: typeof r; segment: number } | null = null
    for (const o of elevated) {
      if (o === r) continue
      const oc = o.geometry.coordinates as [number, number][]
      for (let i = 1; i < oc.length; i++) {
        const ax = (p[0] - oc[i - 1][0]) * kx, ay = (p[1] - oc[i - 1][1]) * ky
        const vx = (oc[i][0] - oc[i - 1][0]) * kx, vy = (oc[i][1] - oc[i - 1][1]) * ky
        const l2 = vx * vx + vy * vy
        const t = l2 ? Math.max(0, Math.min(1, (ax * vx + ay * vy) / l2)) : 0
        const d = Math.hypot(ax - vx * t, ay - vy * t)
        if (!best || d < best.d) best = { d, road: o, segment: i - 1 }
      }
    }
    if (!best || best.d > 2.5) continue
    const named = nearNames.some((n) =>
      String(r.properties.name ?? '').includes(n) || String(best!.road.properties.name ?? '').includes(n))
    if (named || best.d > 0.15) {
      console.log(JSON.stringify({
        way: r.properties.osm_id, name: r.properties.name, atStart,
        lng: p[0], lat: p[1], nearWay: best.road.properties.osm_id,
        nearName: best.road.properties.name, distanceM: +best.d.toFixed(2),
        nearSegment: best.segment,
      }))
    }
  }
}
