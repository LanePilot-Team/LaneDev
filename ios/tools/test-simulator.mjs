import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Run from any directory. No dev server. Only the simulator's OS location is injected.
const root = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.argv[2] ?? 'debug'
if (!['debug', 'release', 'denied', 'map', 'release-map', 'system'].includes(mode)) {
  throw new Error('Usage: node ios/tools/test-simulator.mjs [debug|release|denied|map|release-map|system]')
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
const appId = 'tw.lanepilot.lanedev.ios'
const school = '22.729232,120.277426'
const home = '22.732700,120.275800'
const systemFixtures = {
  school: ['set', school],
  jitterwest: ['set', '22.729232,120.277393'],
  jittereast: ['set', '22.729232,120.277459'],
  outside: ['set', '25.033000,121.565400'],
  home: ['set', home],
  disconnected: ['set', '22.7211639,120.2590509'],
  drive: ['start', '--speed=11', '--interval=0.8', school,
    '22.729668,120.278139', '22.730035,120.277915', '22.730378,120.278450',
    '22.730827,120.278562', '22.731292,120.278649', '22.732226,120.277925'],
  straight: ['start', '--speed=12', '--interval=0.8', school,
    '22.729680,120.278082', '22.730483,120.279291', '22.730903,120.279994'],
  rejoin: ['start', '--speed=8', '--interval=0.8',
    '22.730905,120.279994', '22.730483,120.279291', '22.729746,120.278174',
    '22.729680,120.278082', '22.730035,120.277915', '22.730378,120.278450',
    '22.730827,120.278562', '22.731302,120.278645', '22.731753,120.279381'],
}
function applySystemFixture(name) {
  if (name === 'revoke' || name === 'grant') {
    run('xcrun', ['simctl', 'privacy', device, name, 'location', appId])
  } else {
    const args = systemFixtures[name]
    if (!Array.isArray(args)) throw new Error(`Unknown system fixture: ${name}`)
    run('xcrun', ['simctl', 'location', device, ...args])
  }
  console.log(`IOS_STAGE7_OS: ${name}`)
}
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
      const fixture = mode === 'system' && line.match(/^IOS_STAGE7_FIXTURE: ([a-z]+)\s*$/)
      if (fixture) {
        try { applySystemFixture(fixture[1]) }
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
  run('xcrun', ['simctl', 'privacy', device, mode === 'denied' ? 'revoke' : 'grant', 'location', appId])
  if (mode === 'system') applySystemFixture('home')
  else if (mode !== 'denied') inject()
}
try {
  const systemCases = ['testStage7SystemDrive', 'testStage7SystemReroute', 'testStage7SystemPermissionCycle',
    'testStage7SystemPlanningFailures']
  const selection = (action, name) => `-${action}-testing:LaneDevTests/ForegroundNavigationTests/${name}`
  let selected = mode === 'denied'
    ? [selection('only', 'testDeniedLocationPermission')]
    : mode === 'debug' ? [...systemCases, 'testDeniedLocationPermission'].map(name => selection('skip', name)) : []
  if (mode === 'system') selected = systemCases.map(name => selection('only', name))
  if (mapOnly) {
    selected = ['-only-testing:LaneDevUITests/ForegroundUITests/testOfflineMapGesturesAndPreferenceAfterRelaunch']
    if (mode === 'map') selected.push(
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testWebKitLoadsPackagedModulesWorkerAndWebGL',
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testInvalidRoadVersionShowsProgressErrorAndRetry',
      '-only-testing:LaneDevTests/ForegroundNavigationTests/testReadOnlyBundleAndIntegrity',
    )
  }
  await xcode([...base, '-resultBundlePath', path.join(output, 'results.xcresult'), ...selected, 'test-without-building'],
    !mapOnly && !['denied', 'system'].includes(mode))
  console.log(`PASS ${mode}; log: ${log}; result: ${path.join(output, 'results.xcresult')}`)
} finally {
  if (!mapOnly) run('xcrun', ['simctl', 'location', device, 'clear'])
  if (mode === 'denied' || mode === 'system') run('xcrun', ['simctl', 'privacy', device, 'grant', 'location', appId])
}
