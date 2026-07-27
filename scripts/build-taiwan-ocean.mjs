import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import simplify from '@turf/simplify'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const input = process.argv[2]
if (!input) throw new Error('Usage: node scripts/build-taiwan-ocean.mjs <Natural Earth countries GeoJSON>')

const world = JSON.parse(fs.readFileSync(input, 'utf8'))
const taiwan = world.features.find((f) => {
  const p = f.properties ?? {}
  return p.ADMIN === 'Taiwan' || p.NAME === 'Taiwan' || p.SOV_A3 === 'TWN'
})
if (!taiwan) throw new Error('Taiwan feature was not found in the Natural Earth dataset')

const simplified = simplify(taiwan, { tolerance: 0.002, highQuality: true, mutate: false })
const polygons = simplified.geometry.type === 'Polygon'
  ? [simplified.geometry.coordinates]
  : simplified.geometry.coordinates
// Keep the main island only. Small offshore islands are intentionally omitted
// from this lightweight layer; the detailed project map remains focused on Nanzih.
const ringArea = (ring) => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]
  return sum + p[0] * q[1] - q[0] * p[1]
}, 0) / 2)
const main = polygons.sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0][0]
const closedMain = main[0][0] === main.at(-1)[0] && main[0][1] === main.at(-1)[1]
  ? main : [...main, main[0]]

// Clockwise outer ring, counter-clockwise island hole.
const outer = [[117.5, 19.5], [117.5, 26.8], [123.5, 26.8], [123.5, 19.5], [117.5, 19.5]]
const ocean = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'natural-earth/taiwan-ocean',
      properties: {
        feature_category: 'water_area',
        water_type: 'ocean',
        name: '台灣周邊海域',
        source: 'Natural Earth 1:10m',
      },
      geometry: { type: 'Polygon', coordinates: [outer, [...closedMain].reverse()] },
    },
    {
      type: 'Feature',
      id: 'natural-earth/taiwan-coastline',
      properties: {
        feature_category: 'coastline',
        name: '台灣本島海岸線',
        source: 'Natural Earth 1:10m',
      },
      geometry: { type: 'LineString', coordinates: closedMain },
    },
  ],
}

const outDir = path.join(root, 'public', 'data', 'environment')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'taiwan_ocean.geojson'), JSON.stringify(ocean))
fs.writeFileSync(path.join(outDir, 'taiwan_ocean_metadata.json'), JSON.stringify({
  source: 'Natural Earth',
  dataset: '1:10m Admin 0 Countries',
  source_url: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/',
  license: 'Public domain',
  generated_at: new Date().toISOString(),
  simplification_tolerance_degrees: 0.002,
  included_geometry: ['Taiwan main island coastline', 'surrounding ocean mask'],
  excluded_geometry: ['offshore islands'],
  coordinate_count: closedMain.length,
}, null, 2))
console.log(`taiwan_ocean.geojson: ${closedMain.length} coastline coordinates`)
