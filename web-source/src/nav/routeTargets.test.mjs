import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceViaStops, pendingRouteTargets } from './routeTargets.ts'

test('successive reroutes compare progress to the targets of the installed route', () => {
  const targets = [3, 4, 5].map(id => ({ id, pos: [120, 22] }))
  const firstReroute = pendingRouteTargets(targets, 1)
  assert.deepEqual(firstReroute.map(stop => stop.id), [4, 5])
  assert.deepEqual(pendingRouteTargets(firstReroute, 0).map(stop => stop.id), [4, 5])
  assert.deepEqual(pendingRouteTargets(firstReroute, 1).map(stop => stop.id), [5])
})

test('route matching cannot confirm a distant or out-of-order stop', () => {
  const first = [120.001, 22]
  const second = [120.0025, 22]
  const route = { coords: [[120, 22], first, second, [120.004, 22]], cum: [0, 100, 250, 400], viaDistM: [100, 250] }
  assert.equal(advanceViaStops(route, 0, 105, [120.002, 22]), 0)
  assert.equal(advanceViaStops(route, 0, 250, second), 0)
  assert.equal(advanceViaStops(route, 0, 20, first), 0)
  assert.equal(advanceViaStops(route, 0, 101, first), 1)
  assert.equal(advanceViaStops(route, 1, 250, second), 2)
  assert.equal(advanceViaStops({ ...route, viaDistM: undefined }, 0, 101, first), 0)
})
