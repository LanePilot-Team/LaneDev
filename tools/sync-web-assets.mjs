import { readFile, writeFile, readdir, cp, rm, mkdir, mkdtemp, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// With no argument, this is the macOS equivalent of import-web-assets.ps1.
const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2] ?? 'android'
if (!['android', 'ios'].includes(mode)) throw new Error(`Unknown asset destination: ${mode}`)
const ios = mode !== 'android'
const source = path.join(root, ios ? 'web-source/.ios-dist' : 'web-source/dist')
const androidAssets = path.join(root, 'app/src/main/assets/public')
const target = ios ? path.join(root, 'ios/.web/public') : androidAssets
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const policy = JSON.parse(await readFile(path.join(source, 'client-policy.json')))
const format = ios ? 'lanedev-ios-client-v2' : 'lanedev-android-client-v1'
if (policy.format !== format || policy.editor !== false
  || policy.simulation !== false || policy.transit !== false) throw new Error('Invalid client policy')
await readFile(path.join(source, 'index.html'))
const scripts = (await readdir(path.join(source, 'assets'))).filter(n => n.endsWith('.js'))
if (!scripts.length || scripts.length !== Object.keys(policy.scripts).length) throw new Error('Invalid script list')
for (const script of scripts) {
  const bytes = await readFile(path.join(source, 'assets', script))
  if (hash(bytes) !== policy.scripts[script]) throw new Error('Invalid script checksum: ' + script)
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
    const previous = await readFile(path.join(androidAssets, 'data', name))
    const next = await readFile(path.join(source, 'data', name))
    if (!previous.equals(next) && normalize(previous) === normalize(next)) preserved.push([name, previous])
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
await mkdir(path.dirname(target), { recursive: true })
// Keep the previous bundle available until the entire new copy is ready.
const scratch = await mkdtemp(path.join(path.dirname(target), '.assets-'))
const staged = path.join(scratch, 'staged')
const backup = path.join(scratch, 'previous')
let keepBackup = false
try {
  await cp(source, staged, { recursive: true })
  for (const [name, bytes] of preserved) await writeFile(path.join(staged, 'data', name), bytes)
  try { await rename(target, backup) } catch (error) { if (error.code !== 'ENOENT') throw error }
  try {
    await rename(staged, target)
  } catch (error) {
    try { await rename(backup, target) } catch (restoreError) {
      if (restoreError.code !== 'ENOENT') {
        keepBackup = true
        throw new Error(`Failed to restore previous assets. Backup: ${backup}`, { cause: restoreError })
      }
    }
    throw error
  }
} finally {
  if (!keepBackup) await rm(scratch, { recursive: true, force: true })
}
console.log(`Verified ${mode} web assets: ${target}`)
