import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLaneBaseIndex,
  extractLaneBase,
  remapLaneBase,
  resolveLaneBase,
} from './laneBase.ts'

const record = (overrides = {}) => ({
  sourceKey: 'way/10#0',
  wayId: 10,
  direction: 'forward',
  scope: 'segment_direction',
  movementRules: [],
  ...overrides,
})

const annotation = (identity, detail = {}, motorcycle = {}) => ({
  object_identity: {
    object_type: 'nav_context_annotation',
    nav_segment_key: 'way/10',
    source_osm: { osm_id: 10 },
    split_index: 0,
    ...identity,
  },
  lane_nav_tags: {
    lane_detail_tags: detail,
    taiwan_motorcycle_tags: motorcycle,
  },
})

test('extracts schema-v2 lane fields and movement rules', () => {
  const result = extractLaneBase([annotation({
    context_scope: 'intersection_approach',
    applies_to_intersection_key: 'node/99',
    approach_direction: 'forward',
  }, {
    lane_profiles: [{
      lane_count: 3,
      lane_movements: ['left', 'through', 'right'],
      motorcycle_access_by_lane: ['yes', 'yes', 'designated'],
    }],
  }, {
    movement_rules: [{
      applies_to_intersection_key: 'node/99',
      approach_direction: 'forward',
      movement: 'left',
    }],
  })])

  assert.equal(result.sourceRecords, 1)
  assert.deepEqual([...result.accountedSourceKeys], ['way/10#0'])
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.records, [record({
    scope: 'intersection_approach',
    intersectionNodeId: 99,
    laneCount: 3,
    laneMovements: ['left', 'through', 'right'],
    motorcycleAccessByLane: ['yes', 'yes', 'designated'],
    movementRules: [{
      applies_to_intersection_key: 'node/99',
      approach_direction: 'forward',
      movement: 'left',
    }],
  })])
})

test('extracts legacy profile direction and accounts for a movement-only annotation', () => {
  const result = extractLaneBase([
    annotation({ object_type: 'nav_segment_annotation' }, {
      lane_profiles: [{ direction: 'backward', lane_movements: ['left', 'through'] }],
    }),
    annotation({
      nav_segment_key: 'way/11', source_osm: { osm_id: 11 }, split_index: 1,
    }, {}, {
      movement_rules: [{
        approach_direction: 'backward',
        movement: 'left',
        motorcycle_turn_rule: 'two_stage_required',
      }],
    }),
  ])

  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].scope, 'legacy')
  assert.equal(result.records[0].direction, 'backward')
  assert.deepEqual(result.records[1], record({
    sourceKey: 'way/11#1', wayId: 11, direction: 'backward', scope: 'legacy',
    movementRules: [{
      approach_direction: 'backward',
      movement: 'left',
      motorcycle_turn_rule: 'two_stage_required',
    }],
  }))
  assert.deepEqual(result.errors, [])
  assert.deepEqual([...result.accountedSourceKeys], ['way/10#0', 'way/11#1'])
})

test('rejects conflicting valid directions in movement-only rules', () => {
  const result = extractLaneBase([annotation({}, {}, {
    movement_rules: [
      { approach_direction: 'forward', movement: 'through' },
      { approach_direction: 'backward', movement: 'left' },
    ],
  })])

  assert.deepEqual(result.records, [])
  assert.deepEqual([...result.accountedSourceKeys], ['way/10#0'])
  assert.match(result.errors.join('\n'), /conflicting movement-rule directions/)
})

test('reports an invalid profile direction even when another profile is valid', () => {
  const result = extractLaneBase([annotation({}, {
    lane_profiles: [
      { direction: 'forward', lane_count: 2 },
      { direction: 'sideways', lane_movements: ['left'] },
    ],
  })])

  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].direction, 'forward')
  assert.deepEqual([...result.accountedSourceKeys], ['way/10#0'])
  assert.match(result.errors.join('\n'), /profile 2: invalid direction/)
})

test('rejects a structurally similar non-annotation object type', () => {
  const result = extractLaneBase([annotation({ object_type: 'nav_segment' }, {
    lane_profiles: [{ direction: 'forward', lane_count: 2 }],
  })])

  assert.deepEqual(result.records, [])
  assert.deepEqual([...result.accountedSourceKeys], ['way/10#0'])
  assert.match(result.errors.join('\n'), /unsupported object type nav_segment/)
})

test('reports every unusable source instead of silently dropping it', () => {
  const result = extractLaneBase([
    annotation({}, {}),
    annotation({ nav_segment_key: 'bad', source_osm: { osm_id: 0 } }, {
      lane_profiles: [{ direction: 'forward', lane_movements: ['through'] }],
    }),
    annotation({ context_scope: 'intersection_approach', approach_direction: 'forward' }, {
      lane_profiles: [{ lane_movements: ['through'] }],
    }),
    annotation({ approach_direction: 'sideways' }, {
      lane_profiles: [{ lane_movements: ['through'] }],
    }),
  ])

  assert.equal(result.sourceRecords, 4)
  assert.equal(result.records.length, 0)
  assert.equal(result.accountedSourceKeys.size, 4)
  assert.match(result.errors.join('\n'), /no consumable lane profile or movement rules/)
  assert.match(result.errors.join('\n'), /invalid way identity/)
  assert.match(result.errors.join('\n'), /intersection node missing/)
  assert.match(result.errors.join('\n'), /invalid direction/)
})

test('rejects conflicting canonical records', () => {
  assert.throws(() => buildLaneBaseIndex([
    record({ laneCount: 2 }),
    record({ sourceKey: 'way/10#1', laneCount: 3 }),
  ]), /duplicate lane-base record/)
})

test('resolves each field from its highest-priority non-absent source', () => {
  const index = buildLaneBaseIndex([
    record({ laneCount: 3, laneMovements: ['through', 'through', 'right'],
      motorcycleAccessByLane: ['yes', 'yes', 'yes'] }),
    record({ scope: 'intersection_approach', intersectionNodeId: 99,
      laneMovements: ['left', 'through', 'right'] }),
  ])

  assert.deepEqual(resolveLaneBase(index, {
    wayId: 10, intersectionNodeId: 99, direction: 'forward',
  }), {
    laneCount: 3,
    laneMovements: ['left', 'through', 'right'],
    motorcycleAccessByLane: ['yes', 'yes', 'yes'],
    fieldSources: {
      laneCount: 'lanepilot-segment',
      laneMovements: 'lanepilot-approach',
      motorcycleAccessByLane: 'lanepilot-segment',
    },
  })

  assert.deepEqual(resolveLaneBase(index, {
    wayId: 10, intersectionNodeId: 99, direction: 'forward',
    humanWay: { laneCount: 4 },
    humanBlock: { laneMovements: ['left', 'left', 'through', 'right'] },
    osm: { motorcycleAccessByLane: ['no'] },
  }), {
    laneCount: 4,
    laneMovements: ['left', 'left', 'through', 'right'],
    motorcycleAccessByLane: ['yes', 'yes', 'yes'],
    fieldSources: {
      laneCount: 'human-way',
      laneMovements: 'human-block',
      motorcycleAccessByLane: 'lanepilot-segment',
    },
  })
})

test('remaps dropped records with lane-guidance alignment and reports unmapped sources', () => {
  const result = remapLaneBase([
    record({ sourceKey: 'way/10#0', wayId: 10, scope: 'intersection_approach',
      intersectionNodeId: 90, laneMovements: ['left'] }),
    record({ sourceKey: 'way/11#0', wayId: 11, laneMovements: ['right'] }),
  ], {
    existingWayIds: new Set([20, 30]),
    nodeRemap: new Map([[90, 99]]),
    wayRemap: new Map([[10, {
      keepIds: [20, 30], dropReversed: false, sameDir: false,
    }]]),
  })

  assert.deepEqual(result.records.map((item) => [
    item.sourceKey, item.wayId, item.intersectionNodeId, item.direction,
  ]), [
    ['way/10#0', 20, 99, 'backward'],
    ['way/10#0', 30, 99, 'backward'],
  ])
  assert.deepEqual(result.unmappedSourceKeys, ['way/11#0'])
  assert.match(result.errors.join('\n'), /way\/11#0/)
})
