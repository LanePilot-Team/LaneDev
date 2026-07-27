import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLaneGuidanceIndex,
  remapLaneGuidanceRecords,
  resolveLaneGuidance,
} from './laneGuidance.ts'

const record = (overrides = {}) => ({
  wayId: 10,
  direction: 'forward',
  scope: 'segment_direction',
  laneCount: 2,
  laneMovements: ['through', 'right'],
  ...overrides,
})

const input = (overrides = {}) => ({
  wayId: 10,
  intersectionNodeId: 99,
  direction: 'forward',
  roadLaneCount: 2,
  osmMovements: undefined,
  ...overrides,
})

test('approach annotation wins only at its matching node', () => {
  const index = buildLaneGuidanceIndex([
    record({ scope: 'segment_direction', laneMovements: ['through', 'right'] }),
    record({
      scope: 'intersection_approach',
      intersectionNodeId: 99,
      laneMovements: ['left', 'through'],
    }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input({ intersectionNodeId: 99 })), {
    laneCount: 2,
    laneMovements: ['left', 'through'],
    source: 'annotation',
  })
  assert.deepEqual(
    resolveLaneGuidance(index, input({ intersectionNodeId: 100 })).laneMovements,
    ['through', 'right'],
  )
})

test('segment direction annotation wins over legacy fallback', () => {
  const index = buildLaneGuidanceIndex([
    record({ scope: 'legacy', laneMovements: ['left', 'through'] }),
    record({ scope: 'segment_direction', laneMovements: ['through', 'right'] }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input()).laneMovements, ['through', 'right'])
})

test('manual unknown uses OSM in the same lane', () => {
  const index = buildLaneGuidanceIndex([
    record({
      laneCount: 3,
      laneMovements: ['left', 'unknown', ''],
    }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input({
    roadLaneCount: 3,
    osmMovements: ['through', 'through', 'right'],
  })), {
    laneCount: 3,
    laneMovements: ['left', 'through', 'right'],
    source: 'annotation+osm',
  })
})

test('partial arrays retain manual values and fill the rest from OSM', () => {
  const index = buildLaneGuidanceIndex([
    record({ laneCount: 3, laneMovements: ['left'] }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input({
    roadLaneCount: 3,
    osmMovements: ['through', 'through', 'right'],
  })).laneMovements, ['left', 'through', 'right'])
})

test('reverse direction does not reuse forward annotation', () => {
  const index = buildLaneGuidanceIndex([
    record({ direction: 'forward' }),
  ])

  assert.deepEqual(resolveLaneGuidance(index, input({
    direction: 'backward',
    osmMovements: undefined,
  })), {
    laneCount: 2,
    laneMovements: undefined,
    source: 'inferred',
  })
})

test('uses OSM without inference when no annotation matches', () => {
  const index = buildLaneGuidanceIndex([])

  assert.deepEqual(resolveLaneGuidance(index, input({
    osmMovements: ['through', 'right'],
  })), {
    laneCount: 2,
    laneMovements: ['through', 'right'],
    source: 'osm',
  })
})

test('remaps a dropped couplet way and reverses direction when required', () => {
  const records = [record({
    wayId: 10,
    direction: 'forward',
    scope: 'intersection_approach',
    intersectionNodeId: 90,
  })]

  const remapped = remapLaneGuidanceRecords(records, {
    existingWayIds: new Set([20]),
    nodeRemap: new Map([[90, 99]]),
    wayRemap: new Map([[10, {
      keepIds: [20],
      dropReversed: false,
      sameDir: false,
    }]]),
  })

  assert.deepEqual(remapped[0], {
    ...records[0],
    wayId: 20,
    direction: 'backward',
    intersectionNodeId: 99,
  })
})

test('clones a dropped annotation to every surviving way', () => {
  const records = [record({ wayId: 10 })]
  const remapped = remapLaneGuidanceRecords(records, {
    existingWayIds: new Set([20, 30]),
    nodeRemap: new Map(),
    wayRemap: new Map([[10, {
      keepIds: [20, 30],
      dropReversed: true,
      sameDir: false,
    }]]),
  })

  assert.deepEqual(remapped.map((item) => [item.wayId, item.direction]), [
    [20, 'forward'],
    [30, 'forward'],
  ])
})
