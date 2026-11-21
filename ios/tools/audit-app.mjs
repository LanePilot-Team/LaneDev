import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = process.argv[2]
if (!bundle || process.argv.length !== 3) throw new Error('Usage: node ios/tools/audit-app.mjs PATH_TO_LANEDEV.app')
const root = fileURLToPath(new URL('../', import.meta.url))
const staged = path.join(root, '.web/public')
const packaged = path.join(bundle, 'public')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function files(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => !entry.isDirectory())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort()
}

// Match retired app capabilities only. This audit script is never bundled in LaneDev.
const retired = [
  'LaneSimulator', 'SimulatorLocationSource', 'SimulatorNavigationPanel',
  'LANE_SIMULATOR_NAVIGATION', 'simulatorPrepare', 'simulatorControl', 'simulatorPlanStatus',
  'simulatorRouteChanged', 'simulatorArrived', 'motionTimestamp', 'playbackRate',
  'simulatorTools', '?sim', 'sim-choose', 'sim-playback',
  'sim-scenarios', 'location-source', '虛擬定位', '模擬駕駛',
]
function check(bytes, file) {
  // Match app mode names without matching Swift SDK paths such as arm64-apple-ios-simulator.
  const retiredMode = /(?:^|[^\w-])(ios-simulator|ios-release)(?=$|[^\w-])/
  const marker = retired.find(term => bytes.includes(term)) ?? bytes.toString('latin1').match(retiredMode)?.[1]
  assert.equal(marker, undefined, `${file} contains retired marker: ${marker}`)
}

const expected = await files(staged)
assert.deepEqual(await files(packaged), expected, 'Packaged web inventory must equal the newly staged copy')
const policyBytes = await readFile(path.join(packaged, 'client-policy.json'))
check(policyBytes, 'client-policy.json')
const policy = JSON.parse(policyBytes)
assert.equal(policy.format, 'lanedev-ios-client-v2')
for (const key of ['editor', 'simulation', 'transit']) assert.equal(policy[key], false)
for (const file of expected) {
  const bytes = await readFile(path.join(packaged, file))
  assert.equal(hash(bytes), hash(await readFile(path.join(staged, file))), `Stale or altered web asset: ${file}`)
  if (/\.(html|[cm]?js|css)$/.test(file)) check(bytes, file)
}
const bridge = await readFile(path.join(bundle, 'Bridge.js'))
assert.deepEqual(bridge, await readFile(path.join(root, 'LaneDev/Bridge.js')))
check(bridge, 'Bridge.js')
check(await readFile(path.join(bundle, 'LaneDev')), 'LaneDev executable')
const bundleEntries = await readdir(bundle, { recursive: true })
assert.ok(!bundleEntries.some(file => /\.(gpx|xctest)(\/|$)|test-simulator\.mjs$/.test(file)), 'Test fixtures shipped in LaneDev')
console.log(`Audited ${bundle}: ${expected.length} web files match staging, retired markers absent, test fixtures excluded.`)
