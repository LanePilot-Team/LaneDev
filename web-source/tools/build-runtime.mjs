import { build } from 'vite'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { compactRenderData, renderPropertyKeys } from './compact-render-data.mjs'
import { runtimeInputHash } from './runtime-inputs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'public/data/runtime')
const sha = data => createHash('sha256').update(data).digest('hex')
// Hash all core inputs: changing geometry/rules invalidates the generated dataset.
const inputHash = await runtimeInputHash(root)
await build({ configFile: false, root, logLevel: 'warn',
  define: { 'import.meta.env.BASE_URL': JSON.stringify('./'), 'import.meta.env.DEV': 'false' },
  build: { ssr: 'src/core/runtimeBuildEntry.ts', outDir: '.runtime-build', emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
})
const api = await import(pathToFileURL(path.join(root, '.runtime-build/entry.mjs')).href)
const realFetch = globalThis.fetch
globalThis.fetch = async input => {
  const relative = String(input).replace(/^\.\//, '')
  if (!['data/road_database.json', 'data/nanzih_buildings_height.geojson'].includes(relative)) {
    throw new Error('Unexpected build-time fetch: ' + input)
  }
  return new Response(await readFile(path.join(root, 'public', relative)))
}
const started = performance.now()
const result = await api.buildClientRuntime()
globalThis.fetch = realFetch
const navText = JSON.stringify(result.navigation, api.runtimeReplacer)
const restored = JSON.parse(navText, api.runtimeReviver)
const original = new api.RoadGraph(result.navigation.roads)
const hydrated = api.RoadGraph.fromSnapshot(restored.graph, restored.roads)
const normalized = value => JSON.parse(JSON.stringify(value, api.runtimeReplacer), api.runtimeReviver)
assert.deepEqual(hydrated.snapshot(restored.roads), normalized(original.snapshot(result.navigation.roads)))
assert.deepEqual(restored.laneBaseIndex, normalized(result.navigation.laneBaseIndex))
assert.deepEqual(restored.zones, normalized(result.navigation.zones))
assert.deepEqual(restored.bays, normalized(result.navigation.bays))
const elevation = api.ElevationModel.fromSnapshot(restored.elevation)
const expectedElevation = api.ElevationModel.fromSnapshot(result.navigation.elevation)
for (const { road, lenM } of elevation.entries()) {
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(elevation.heightAt(road, lenM * fraction), expectedElevation.heightAt(road, lenM * fraction))
  }
}
let routes = 0, successful = 0
// Both profiles and multiple regions/directions, including rejected routes.
const roads = result.navigation.roads
for (let i = 0; i < 12; i++) {
  const a = roads[Math.floor(i * (roads.length - 1) / 12)].geometry.coordinates[0]
  const b = roads[Math.floor((i + 1) * (roads.length - 1) / 12)].geometry.coordinates.at(-1)
  for (const profile of ['car', 'moto']) {
    const expected = original.routeDetailed(a, b, profile)
    const actual = hydrated.routeDetailed(a, b, profile)
    assert.deepEqual(normalized(actual), normalized(expected))
    if (actual.route) successful++
    routes++
  }
}
assert.ok(successful > 0, 'Route regression must include successful routes')
await mkdir(output, { recursive: true })
const manifest = { format: api.RUNTIME_FORMAT, inputHash, navigation: null, sources: {} }
async function emit(name, text) {
  const digest = sha(text)
  const file = `${name}.${digest}.json`
  await writeFile(path.join(output, file), text)
  return { file, sha256: digest }
}
manifest.navigation = await emit('navigation', navText)
const keys = renderPropertyKeys(api.buildStyle())
for (const [name, data] of Object.entries(result.sources)) {
  const compact = compactRenderData(data, keys, name === 'buildings')
  assert.equal(compact.features.length, data.features.length)
  if (name === 'buildings') {
    const ids = compact.features.map(f => f.id)
    assert.equal(ids.includes(undefined), false)
    assert.equal(new Set(ids).size, ids.length)
  }
  manifest.sources[name] = await emit(name, JSON.stringify(compact))
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
const keep = new Set(['manifest.json', manifest.navigation.file, ...Object.values(manifest.sources).map(s => s.file)])
// Delete only obsolete generated hash files within this exact output directory.
for (const file of await readdir(output)) {
  if (!keep.has(file) && /^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\.json$/.test(file)) await rm(path.join(output, file))
}
console.log(`Precomputed ${(performance.now() - started).toFixed(0)} ms; ${roads.length} roads, ${restored.zones.length} zones, ${routes} identical route results (${successful} successful).`)
console.log(`Navigation ${(Buffer.byteLength(navText) / 1048576).toFixed(2)} MiB; ${Object.keys(manifest.sources).length} worker-loaded layers; input ${inputHash}`)
