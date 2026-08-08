import test from 'node:test'
import assert from 'node:assert/strict'
import * as laneBase from './laneBase.ts'
import * as zoneimport from './zoneimport.ts'

const annotation = (rule, identity = {}) => ({
  object_identity: {
    schema_version: 2,
    object_type: 'nav_context_annotation',
    nav_context_key: 'way/10@node/99/forward',
    nav_segment_key: 'way/10',
    source_osm: { osm_id: 10 },
    split_index: 0,
    context_scope: 'intersection_approach',
    applies_to_intersection_key: 'node/99',
    approach_direction: 'forward',
    ...identity,
  },
  lane_nav_tags: {
    lane_detail_tags: { lane_profiles: [] },
    taiwan_motorcycle_tags: { movement_rules: [rule] },
  },
})

const zone = (id, intersectionId = 99, bearing = 12, extra = {}) => ({
  id, intersectionId, center: [120, 22], bearing: 90, w: 5, d: 2.5,
  from: { name: 'from', bearing }, to: { name: 'to', bearing: 280 }, ...extra,
})

test('movement-only canonical rule becomes an accounted stable waiting-zone candidate', () => {
  assert.equal(typeof laneBase.laneBaseZoneCandidates, 'function')
  const result = laneBase.extractLaneBase([annotation({
    movement_key: 'way/10@node/99/forward->way/20/left',
    applies_to_intersection_key: 'node/99', approach_segment_key: 'way/10',
    approach_direction: 'forward', movement: 'left',
    motorcycle_turn_rule: 'two_stage_required', waiting_zone_exists: 'yes',
  })])
  const candidates = laneBase.laneBaseZoneCandidates(
    laneBase.buildLaneBaseIndex(result.records),
  )

  assert.deepEqual(result.errors, [])
  assert.deepEqual([...result.accountedSourceKeys], ['way/10@node/99/forward'])
  assert.deepEqual(candidates, [{
    id: 'zone-lp-way%2F10%40node%2F99%2Fforward-%3Eway%2F20%2Fleft',
    sourceKey: 'way/10@node/99/forward',
    movementKey: 'way/10@node/99/forward->way/20/left',
    approachWayId: 10, intersectionNodeId: 99, direction: 'forward',
    movement: 'left', twoStage: true,
  }])
})

test('candidate identity is independent of annotation array order', () => {
  const first = annotation({
    movement_key: 'way/10@node/99/forward->way/20/left',
    applies_to_intersection_key: 'node/99', approach_segment_key: 'way/10',
    approach_direction: 'forward', movement: 'left',
    motorcycle_turn_rule: 'two_stage_required', waiting_zone_exists: 'yes',
  })
  const second = annotation({
    movement_key: 'way/11@node/100/backward->way/21/left',
    applies_to_intersection_key: 'node/100', approach_segment_key: 'way/11',
    approach_direction: 'backward', movement: 'left',
    motorcycle_turn_rule: 'two_stage_optional', waiting_zone_exists: 'yes',
  }, {
    nav_context_key: 'way/11@node/100/backward', nav_segment_key: 'way/11',
    source_osm: { osm_id: 11 }, applies_to_intersection_key: 'node/100',
    approach_direction: 'backward',
  })
  const ids = (raw) => laneBase.laneBaseZoneCandidates(
    laneBase.buildLaneBaseIndex(laneBase.extractLaneBase(raw).records),
  ).map((item) => item.id).sort()

  assert.deepEqual(ids([first, second]), ids([second, first]))
})

test('way and node remap change policy lookup identity without changing stable zone id', () => {
  const extraction = laneBase.extractLaneBase([annotation({
    movement_key: 'stable-movement', applies_to_intersection_key: 'node/99',
    approach_segment_key: 'way/10', approach_direction: 'forward', movement: 'left',
    motorcycle_turn_rule: 'two_stage_required', waiting_zone_exists: 'yes',
  })])
  const remapped = laneBase.remapLaneBase(extraction.records, {
    existingWayIds: new Set([20]),
    nodeRemap: new Map([[99, 199]]),
    wayRemap: new Map([[10, {
      keepIds: [20], dropReversed: false, sameDir: false,
    }]]),
  })
  const index = laneBase.buildLaneBaseIndex(remapped.records)

  assert.deepEqual(laneBase.laneBaseZoneCandidates(index).map((candidate) => ({
    id: candidate.id,
    wayId: candidate.approachWayId,
    nodeId: candidate.intersectionNodeId,
    direction: candidate.direction,
  })), [{
    id: 'zone-lp-stable-movement', wayId: 20, nodeId: 199, direction: 'backward',
  }])
  assert.equal(laneBase.twoStageForLaneBaseApproach(index,
    { wayId: 20, intersectionNodeId: 199, direction: 'backward' }), true)
  assert.equal(laneBase.twoStageForLaneBaseApproach(index,
    { wayId: 10, intersectionNodeId: 99, direction: 'forward' }), false)
})

test('two-stage policy requires the normalized approach rule and never infers from a left turn', () => {
  const extract = (turnRule) => laneBase.buildLaneBaseIndex(laneBase.extractLaneBase([
    annotation({
      movement_key: turnRule, applies_to_intersection_key: 'node/99',
      approach_segment_key: 'way/10', approach_direction: 'forward', movement: 'left',
      motorcycle_turn_rule: turnRule, waiting_zone_exists: 'yes',
    }),
  ]).records)

  assert.equal(laneBase.twoStageForLaneBaseApproach(extract('two_stage_required'),
    { wayId: 10, intersectionNodeId: 99, direction: 'forward' }), true)
  assert.equal(laneBase.twoStageForLaneBaseApproach(extract('normal'),
    { wayId: 10, intersectionNodeId: 99, direction: 'forward' }), false)
  assert.equal(laneBase.twoStageForLaneBaseApproach(extract('two_stage_required'),
    { wayId: 10, intersectionNodeId: 100, direction: 'forward' }), false)
})

test('visible overlay applies base, human replacement/addition, then tombstones', () => {
  assert.equal(typeof zoneimport.overlayWaitingZones, 'function')
  const baseA = zone('zone-lp-a')
  const baseB = zone('zone-lp-b', 100)
  const replacement = zone('zone-lp-a', 99, 25, { center: [120.1, 22.1] })
  const human = zone('zone-human', 99, 12, { center: [120.2, 22.2] })

  assert.deepEqual(zoneimport.overlayWaitingZones(
    [baseA, baseB], [replacement, human], new Set(['zone-lp-b']),
  ), [replacement, human])
  assert.deepEqual(zoneimport.humanWaitingZones(
    [baseA, baseB], [replacement, human],
  ), [replacement, human])
})

test('a tombstoned base zone does not remove a distinct human zone at the same intersection', () => {
  const base = zone('zone-lp-a')
  const human = zone('zone-human')
  assert.deepEqual(
    zoneimport.overlayWaitingZones([base], [human], new Set(['zone-lp-a'])),
    [human],
  )
})

test('legacy derived zone rows are not reclassified as human editor additions', () => {
  const current = zone('zone-lp-current')
  const legacyDerived = zone('zone-lp-99-12')
  assert.deepEqual(
    zoneimport.overlayWaitingZones([current], [legacyDerived], new Set()),
    [current],
  )
})
