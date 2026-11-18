import { readFile, writeFile, readdir, cp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Cross-platform equivalent of import-web-assets.ps1. Xcode and Gradle both bundle this directory.
const root = fileURLToPath(new URL('../', import.meta.url))
const source = path.join(root, 'web-source/dist')
const target = path.join(root, 'app/src/main/assets/public')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const policy = JSON.parse(await readFile(path.join(source, 'client-policy.json')))
if (policy.format !== 'lanedev-android-client-v1' || policy.editor !== false
  || policy.simulation !== false || policy.transit !== false) throw new Error('Invalid client policy')
await readFile(path.join(source, 'index.html'))
const scripts = (await readdir(path.join(source, 'assets'))).filter(n => n.endsWith('.js'))
if (!scripts.length || scripts.length !== Object.keys(policy.scripts).length) throw new Error('Invalid script list')
for (const script of scripts) {
  if (hash(await readFile(path.join(source, 'assets', script))) !== policy.scripts[script]) throw new Error('Invalid script checksum: ' + script)
}
const dataFiles = await readdir(path.join(source, 'data'))
if (dataFiles.some(n => /^transit.*\.json$/.test(n))) throw new Error('Transit data forbidden')
const manifestBytes = await readFile(path.join(source, 'data/runtime/manifest.json'))
if (hash(manifestBytes) !== policy.runtimeManifest) throw new Error('Invalid runtime manifest checksum')
const manifest = JSON.parse(manifestBytes)
if (manifest.format !== 'lanedev-precomputed-v1') throw new Error('Invalid runtime format')
for (const record of [manifest.navigation, ...Object.values(manifest.sources)]) {
  if (!/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\.json$/.test(record.file)) throw new Error('Invalid runtime path')
  if (hash(await readFile(path.join(source, 'data/runtime', record.file))) !== record.sha256) throw new Error('Invalid runtime checksum: ' + record.file)
}
// Only generated assets are replaced, after all checks pass. No canonical input is touched.
// Keep existing read-only data bytes when a cross-platform copy differs only in text encoding/lines.
const preserved = []
const normalize = bytes => bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
for (const name of await readdir(path.join(source, 'data'), { recursive: true })) {
  if (name.startsWith('runtime' + path.sep) || !/\.(json|geojson|jsonl|md)$/.test(name)) continue
  try {
    const previous = await readFile(path.join(target, 'data', name))
    const next = await readFile(path.join(source, 'data', name))
    if (!previous.equals(next) && normalize(previous) === normalize(next)) preserved.push([name, previous])
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true })
for (const [name, bytes] of preserved) {
  await writeFile(path.join(target, 'data', name), bytes)
}
console.log('Verified shared web assets updated for Android and iOS: ' + target)
