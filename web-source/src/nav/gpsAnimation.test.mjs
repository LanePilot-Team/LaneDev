import test from 'node:test'
import assert from 'node:assert/strict'
import { GpsAnimation } from './gpsAnimation.ts'
import { cumulative } from '../core/geo.ts'

const coords = [[120.3, 22.7], [120.3001, 22.7], [120.3001, 22.7001]]
const cum = cumulative(coords)
const fix = (distanceM, timestamp, bearing = 0, elevM = 0) => ({ distanceM, timestamp, bearing, elevM })

test('interpolates real fixes along a corner, independent of speed and frame frequency', () => {
  const animation = new GpsAnimation(coords, cum)
  animation.push(fix(0, 1000), 0)
  animation.push(fix(cum.at(-1), 2000), 1000)
  const mid = animation.sample(1500)
  assert.equal(mid.fix.distanceM, cum.at(-1) / 2)
  // Past the corner: longitude equals the vertical segment, not a diagonal shortcut.
  assert.equal(mid.pos[0], coords[1][0])
  assert.ok(mid.pos[1] > coords[1][1])
  for (let i = 1000; i < 1500; i += 16) animation.sample(i)
  assert.deepEqual(animation.sample(1500), mid)
  assert.equal(animation.sample(100000).fix.distanceM, cum.at(-1))
  assert.equal(animation.sample(100000).moving, false)
})

test('takes shortest rotation across north and interpolates bridge height', () => {
  const a = new GpsAnimation(coords, cum)
  a.push(fix(0, 1000, 359, 0), 0)
  a.push(fix(5, 2000, 1, 12), 1000)
  assert.equal(a.sample(1500).fix.bearing, 0)
  assert.equal(a.sample(1500).fix.elevM, 6)
})

test('rejects duplicate/out-of-order fixes and rebases without positional discontinuity', () => {
  const a = new GpsAnimation(coords, cum)
  a.push(fix(0, 1000), 0)
  a.push(fix(10, 2000), 1000)
  assert.equal(a.push(fix(12, 2000), 1200), false)
  assert.equal(a.push(fix(12, 1900), 1200), false)
  const before = a.sample(1400)
  a.push(fix(15, 2400), 1400)
  assert.equal(a.sample(1400).fix.distanceM, before.fix.distanceM)
})

test('long GPS gap, invalid coordinates and lifecycle reset do not extrapolate', () => {
  const a = new GpsAnimation(coords, cum)
  a.push(fix(0, 1000), 0)
  assert.equal(a.push(fix(NaN, 2000), 1000), false)
  a.push(fix(15, 6000), 5000)
  assert.equal(a.sample(5000).fix.distanceM, 15)
  assert.equal(a.sample(5000).moving, false)
  a.reset()
  assert.equal(a.sample(6000), null)
  a.push(fix(5, 7000), 6000)
  assert.equal(a.sample(6000).fix.distanceM, 5)
})

test('stationary fixes do not create a perpetual render loop', () => {
  const a = new GpsAnimation(coords, cum)
  a.push(fix(5, 1000), 0)
  a.push(fix(5, 2000), 1000)
  assert.equal(a.sample(1016).moving, false)
})

test('off-route fixes interpolate straight between real positions, not along the route', () => {
  const a = new GpsAnimation(coords, cum)
  a.push(fix(0, 1000), 0)
  const off = [120.3, 22.70005]
  a.push({ ...fix(0, 2000), pos: off }, 1000)
  const mid = a.sample(1500)
  assert.ok(Math.abs(mid.pos[1] - 22.700025) < 1e-9)
  assert.equal(mid.moving, true)
  assert.deepEqual(a.sample(5000).pos, off)
  // 停在路線外不會一直重畫
  a.push({ ...fix(0, 3000), pos: off }, 5000)
  assert.equal(a.sample(5016).moving, false)
})

test('rejoining the route blends from the off-route position instead of jumping', () => {
  const a = new GpsAnimation(coords, cum)
  const off = [120.30005, 22.70004]
  a.push({ ...fix(0, 1000), pos: off }, 0)
  a.push(fix(5, 2000), 1000)
  assert.deepEqual(a.sample(1000).pos, off)
  assert.ok(a.sample(1500).pos[1] > coords[0][1])
})

test('seed blends from the previous route display position on reroute', () => {
  const a = new GpsAnimation(coords, cum)
  const last = [120.29995, 22.70002]
  a.seed(last, 90, 0)
  a.push(fix(0, 5000), 100)
  assert.deepEqual(a.sample(100).pos, last)
  assert.equal(a.sample(400).moving, true)
  assert.deepEqual(a.sample(800).pos, coords[0])
})

test('off-route jump beyond 120 m snaps instead of animating across the city', () => {
  const a = new GpsAnimation(coords, cum)
  a.push({ ...fix(0, 1000), pos: [120.3, 22.7] }, 0)
  a.push({ ...fix(0, 2000), pos: [120.31, 22.7] }, 1000)
  assert.deepEqual(a.sample(1000).pos, [120.31, 22.7])
})
