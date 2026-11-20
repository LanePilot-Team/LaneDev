import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Run from any directory. No dev server. Only the simulator's OS location is injected.
const root = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.argv[2] ?? 'debug'
if (!['debug', 'release', 'denied', 'map', 'release-map'].includes(mode)) {
  throw new Error('Usage: node ios/tools/test-simulator.mjs [debug|release|denied|map|release-map]')
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])).devices
const device = process.env.LANE_SIMULATOR_UDID ?? Object.values(devices).flat().find(d => d.state === 'Booted' && d.isAvailable)?.udid
if (!device) throw new Error('Boot an iPhone Simulator first, or set LANE_SIMULATOR_UDID')
const mapOnly = mode === 'map' || mode === 'release-map'
const config = mode.startsWith('release') ? 'Release' : 'Debug'
const scheme = config === 'Release' ? 'LaneDevRelease' : 'LaneDev'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.join(root, 'ios/.build/test-results', `${mode}-${stamp}`)
await mkdir(output, { recursive: true })
const log = path.join(output, 'xcodebuild.log')
await writeFile(log, '')
const base = ['-project', 'ios/LaneDev.xcodeproj', '-scheme', scheme, '-configuration', config,
  '-destination', `id=${device}`, '-derivedDataPath', 'ios/.build', '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO']
const inject = () => run('xcrun', ['simctl', 'location', device, 'start', '--speed=1', '--interval=1',
  '22.7327,120.2758', '22.7347,120.2758', '22.7327,120.2758'])
async function xcode(args, watchLaunch = false) {
  console.log(`xcodebuild ${args.includes('build-for-testing') ? 'build-for-testing' : 'test-without-building'} (${config}, ${device})`)
  const child = spawn('xcodebuild', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = '', chain = Promise.resolve(), injectionError
  const consume = bytes => {
    const text = bytes.toString()
    chain = chain.then(() => appendFile(log, text))
    buffer += text
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) {
      if (/^Test Case|\*\*|IOS_|error:|Executed \d+ test/.test(line)) console.log(line.trim())
      // XCTest UI runner can reset the device's simulation at launch. Reapply after app launch.
      if (watchLaunch && /Launch tw\.lanepilot\.lanedev\.ios/.test(line)) {
        try { inject(); console.log('Reapplied OS location fixture after UI app launch (not real GPS).') }
        catch (error) { injectionError = error; child.kill('SIGINT') }
      }
    }
  }
  child.stdout.on('data', consume); child.stderr.on('data', consume)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  await chain
  if (injectionError) throw injectionError
  if (code !== 0) throw new Error(`xcodebuild failed (${code}); see ${log}`)
}
await xcode([...base, 'build-for-testing'])
run('xcrun', ['simctl', 'install', device, `ios/.build/Build/Products/${config}-iphonesimulator/LaneDev.app`])
if (!mapOnly) {
  run('xcrun', ['simctl', 'privacy', device, mode === 'denied' ? 'revoke' : 'grant', 'location', 'tw.lanepilot.lanedev.ios'])
  if (mode !== 'denied') inject()
}
try {
  let selected = mode === 'denied'
    ? ['-only-testing:LaneDevTests/ForegroundNavigationTests/testDeniedLocationPermission']
    : mode === 'debug' ? ['-skip-testing:LaneDevTests/ForegroundNavigationTests/testDeniedLocationPermission'] : []
  if (mapOnly) {
    selected = ['-only-testing:LaneDevUITests/ForegroundUITests/testOfflineMapGesturesAndPreferenceAfterRelaunch']
    if (mode === 'map') selected.push(
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testWebKitLoadsPackagedModulesWorkerAndWebGL',
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testInvalidRoadVersionShowsProgressErrorAndRetry',
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testReadOnlyBundleAndIntegrity',
    )
  }
  await xcode([...base, '-resultBundlePath', path.join(output, 'results.xcresult'), ...selected, 'test-without-building'], !mapOnly && mode !== 'denied')
  console.log(`PASS ${mode}; log: ${log}; result: ${path.join(output, 'results.xcresult')}`)
} finally {
  if (!mapOnly) run('xcrun', ['simctl', 'location', device, 'clear'])
  if (mode === 'denied') run('xcrun', ['simctl', 'privacy', device, 'grant', 'location', 'tw.lanepilot.lanedev.ios'])
}
