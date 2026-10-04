import test from 'node:test'
import assert from 'node:assert/strict'
import { remainingRouteSeconds, arrivalTimestamp } from './arrivalEstimate.ts'

test('starting/stopped navigation keeps the planned duration instead of zero', () => {
  assert.equal(remainingRouteSeconds(2000, 300, 2000), 300)
  assert.equal(remainingRouteSeconds(2000, 300, 1000), 150)
  assert.equal(remainingRouteSeconds(2000, 300, 15, true), 0)
  assert.ok(remainingRouteSeconds(2000, 0, 1000) > 0)
})
test('ETA adds duration to wall clock and rolls over midnight', () => {
  const now = Date.parse('2026-10-04T10:00:00+08:00')
  assert.equal(arrivalTimestamp(now, 300), Date.parse('2026-10-04T10:05:00+08:00'))
  assert.equal(arrivalTimestamp(Date.parse('2026-10-04T23:59:00+08:00'), 120), Date.parse('2026-10-05T00:01:00+08:00'))
})
