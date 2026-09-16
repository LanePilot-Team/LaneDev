import { readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isTransitPlace } from './client-data.mjs'

// Only generated dist files are modified. Canonical road data remains unchanged.
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
for (const name of ['transit.json', 'transit_bus_shapes.json']) {
  await rm(path.join(dist, 'data', name), { force: true })
}
const removedIds = new Set()
for (const name of ['places.json', 'raw-places.json']) {
  const target = path.join(dist, 'data/places', name)
  const data = JSON.parse(await readFile(target, 'utf8'))
  for (const place of data.places) if (isTransitPlace(place)) removedIds.add(place.id)
  data.places = data.places.filter(place => !isTransitPlace(place))
  await writeFile(target, JSON.stringify(data))
}
const target = path.join(dist, 'data/places/places.geojson')
const geo = JSON.parse(await readFile(target, 'utf8'))
geo.features = geo.features.filter(feature => !isTransitPlace(feature.properties ?? {}) && !removedIds.has(String(feature.properties?.id ?? feature.id)))
await writeFile(target, JSON.stringify(geo))

const modules = JSON.parse(await readFile(path.join(dist, 'client-modules.json'), 'utf8'))
const forbidden = modules.filter(name => /\/src\/(edit\/|app\/importFlow|core\/transit|nav\/drive\.ts)/.test(name))
if (forbidden.length) throw new Error(`Client bundle contains developer modules: ${forbidden.join(', ')}`)
const scripts = {}
for (const name of await readdir(path.join(dist, 'assets'))) {
  if (name.endsWith('.js')) scripts[name] = createHash('sha256').update(await readFile(path.join(dist, 'assets', name))).digest('hex')
}
await writeFile(path.join(dist, 'client-policy.json'), JSON.stringify({
  format: 'lanedev-android-client-v1', source: '64a1fd8',
  editor: false, simulation: false, transit: false, scripts,
}, null, 2))
await rm(path.join(dist, 'client-modules.json'))
console.log('Client package checked: no editor, simulation or transit modules; transport POIs removed.')
