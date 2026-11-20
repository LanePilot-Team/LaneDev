import test from 'node:test'
import assert from 'node:assert/strict'
import { passedAllViaStops, pendingRouteTargets } from './routeTargets.ts'

test('successive reroutes compare progress to the targets of the installed route', () => {
  const targets = [3, 4, 5].map(id => ({ id, pos: [120, 22] }))
  const firstReroute = pendingRouteTargets(targets, [100, 220], 115)
  assert.deepEqual(firstReroute.map(stop => stop.id), [4, 5])
  assert.deepEqual(pendingRouteTargets(firstReroute, [90], 35).map(stop => stop.id), [4, 5])
  assert.deepEqual(pendingRouteTargets(firstReroute, [90], 95).map(stop => stop.id), [5])
})

test('passing the destination coordinate early does not complete a route with pending stops', () => {
  assert.equal(passedAllViaStops([100, 250], 101), false)
  assert.equal(passedAllViaStops([100, 250], 250), true)
  assert.equal(passedAllViaStops(undefined, 0), true)
})
