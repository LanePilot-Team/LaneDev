import test from 'node:test'
import assert from 'node:assert/strict'
import { oneSideEntryTransitionAllowed } from './graph.ts'

const road = (osmId, restricted = []) => ({
  properties: {
    osm_id: osmId,
    oneSideEntryNodes: restricted,
  },
})

test('one-side entry keeps the intersection but blocks only the opposing left turn', () => {
  const main = road(100, [20])
  const side = road(200)

  assert.equal(oneSideEntryTransitionAllowed(main, false, side, 20), true)
  assert.equal(oneSideEntryTransitionAllowed(main, true, side, 20), false)
  assert.equal(oneSideEntryTransitionAllowed(main, true, main, 20), true)
  assert.equal(oneSideEntryTransitionAllowed(side, false, main, 20), true)
})

test('ordinary intersections remain unrestricted', () => {
  const main = road(100, [20])
  const side = road(200)

  assert.equal(oneSideEntryTransitionAllowed(main, true, side, 30), true)
})
