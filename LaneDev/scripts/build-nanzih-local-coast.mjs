import fs from 'node:fs'
import path from 'node:path'

const [oceanPath, ...osmPaths] = process.argv.slice(2)
if (!oceanPath || osmPaths.length === 0) {
  throw new Error('Usage: node scripts/build-nanzih-local-coast.mjs <taiwan_ocean.geojson> <coast-a.osm> [...]')
}

const nodes = new Map()
const ways = new Map()
for (const osmPath of osmPaths) {
  const xml = fs.readFileSync(osmPath, 'utf8')
  for (const match of xml.matchAll(/<node\b[^>]*\bid="(\d+)"[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*\/?>/g)) {
    nodes.set(match[1], [Number(match[3]), Number(match[2])])
  }
  for (const match of xml.matchAll(/<way\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    const body = match[2]
    if (!/<tag\s+k="natural"\s+v="coastline"\s*\/>/.test(body)) continue
    ways.set(match[1], [...body.matchAll(/<nd\s+ref="(\d+)"\s*\/>/g)].map((m) => m[1]))
  }
}

const chains = [...ways.values()]
  .map((refs) => refs.filter((ref) => nodes.has(ref)))
  .filter((refs) => refs.length >= 2)

let changed = true
while (changed) {
  changed = false
  outer: for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      const a = chains[i]
      const b = chains[j]
      let joined
      if (a.at(-1) === b[0]) joined = [...a, ...b.slice(1)]
      else if (a.at(-1) === b.at(-1)) joined = [...a, ...b.slice(0, -1).reverse()]
      else if (a[0] === b.at(-1)) joined = [...b, ...a.slice(1)]
      else if (a[0] === b[0]) joined = [...b.slice(1).reverse(), ...a]
      if (!joined) continue
      chains.splice(j, 1)
      chains[i] = joined
      changed = true
      break outer
    }
  }
}

const candidates = chains
  .map((refs) => refs.map((ref) => nodes.get(ref)))
  .filter((coords) => coords.some(([lon, lat]) => lon < 120.27 && lat >= 22.68 && lat <= 22.80))
  .sort((a, b) => b.length - a.length)
if (candidates.length === 0) throw new Error('No local coastline chain found')

let local = candidates[0]
// Natural Earth 西岸環線在此區段由南往北；本地鏈也統一成相同順序。
if (local[0][1] > local.at(-1)[1]) local = [...local].reverse()
local = local.filter(([, lat]) => lat >= 22.675 && lat <= 22.805)
if (local.length < 3) throw new Error('Local coastline is too short after clipping')

const ocean = JSON.parse(fs.readFileSync(oceanPath, 'utf8'))
const coastFeature = ocean.features.find((f) => f.properties?.feature_category === 'coastline')
const oceanFeature = ocean.features.find((f) => f.properties?.water_type === 'ocean')
if (!coastFeature || !oceanFeature) throw new Error('Ocean or coastline feature missing')
const base = coastFeature.geometry.coordinates
const distance2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
const nearestIndex = (point) => base.reduce(
  (best, p, index) => distance2(p, point) < best.distance
    ? { index, distance: distance2(p, point) } : best,
  { index: -1, distance: Infinity },
).index

let startIndex = nearestIndex(local[0])
let endIndex = nearestIndex(local.at(-1))
if (startIndex > endIndex) {
  local = [...local].reverse()
  ;[startIndex, endIndex] = [endIndex, startIndex]
}
const detailed = [
  ...base.slice(0, startIndex + 1),
  ...local,
  ...base.slice(endIndex),
]
const closed = detailed[0][0] === detailed.at(-1)[0] && detailed[0][1] === detailed.at(-1)[1]
  ? detailed : [...detailed, detailed[0]]

coastFeature.geometry.coordinates = closed
coastFeature.properties.source = 'Natural Earth 1:10m + OpenStreetMap local coastline'
oceanFeature.geometry.coordinates[1] = [...closed].reverse()
oceanFeature.properties.source = 'Natural Earth 1:10m + OpenStreetMap local coastline'
fs.writeFileSync(oceanPath, JSON.stringify(ocean))

console.log(JSON.stringify({
  osmCoastWays: ways.size,
  mergedChains: chains.length,
  localCoordinates: local.length,
  replacedBaseRange: [startIndex, endIndex],
  outputCoordinates: closed.length,
  localStart: local[0],
  localEnd: local.at(-1),
}, null, 2))
