import test from 'node:test'
import assert from 'node:assert/strict'
import * as laneBase from './laneBase.ts'
import { applyToRoads, foldJournal } from './enhancements.ts'
import { roadsFromGeoJSON } from './roads.ts'

const road = (osmId, nodes, overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: nodes.map((_, i) => [120, 22 + i / 1000]) },
  properties: {
    osm_id: osmId, name: 'test road', highway: 'tertiary',
    lanes: 2, lanesForward: 1, lanesBackward: 1,
    motoF: false, motoB: false, motoCountF: 0, motoCountB: 0, motoSepF: 0, motoSepB: 0,
    motoEntryIconF: false, motoEntryIconB: false, motoTextDiamondF: false, motoTextDiamondB: false,
    stopLineF: false, stopLineB: false, arrowDisplayF: false, arrowDisplayB: false,
    startArrowDisplayF: false, startArrowDisplayB: false, leftWaitAreaF: false, leftWaitAreaB: false,
    roadMarkingMode: 'all', centerM: 0, centerKind: 'hatch', islandBayMode: false,
    centerExtendStart: false, centerExtendEnd: false, extraM: 0, divOffM: 0, width_m: 7,
    oneway: 'no', layer: 0, blockNode: nodes[0], navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: nodes }],
    nodes,
    laneFieldSourcesF: { laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred' },
    laneFieldSourcesB: { laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred' },
    ...overrides,
  },
})

const base = (overrides = {}) => ({
  sourceKey: 'way/10#0', wayId: 10, direction: 'forward', scope: 'segment_direction',
  movementRules: [], ...overrides,
})

const humanSet = (key, fields) => ({
  seq: 1, ts: '2026-08-08T00:00:00.000Z', author: 'test', op: 'set',
  target: { type: 'road', key }, fields,
})

test('applies segment base then records a block-only human movement override', () => {
  assert.equal(typeof laneBase.applyLaneBaseToRoads, 'function')
  assert.equal(typeof laneBase.guidanceForRoadDirection, 'function')
  const r = road(10, [1, 2])
  const index = laneBase.buildLaneBaseIndex([base({
    laneCount: 3, laneMovements: ['through', 'through', 'right'],
    motorcycleAccessByLane: ['yes', 'yes', 'designated'],
  })])

  const report = laneBase.applyLaneBaseToRoads([r], index)
  applyToRoads([r], foldJournal([
    humanSet('way/10@b/1', { turn_lanes: 'left|through|right' }),
  ]))

  assert.equal(report.appliedRoadDirections, 1)
  assert.deepEqual(report.unresolvedSourceKeys, [])
  assert.equal(r.properties.lanesForward, 3)
  assert.deepEqual(r.properties.turnLanes, ['left', 'through', 'right'])
  assert.deepEqual(r.properties.motorcycleAccessByLaneF, ['yes', 'yes', 'designated'])
  assert.equal(r.properties.laneFieldSourcesF.laneCount, 'lanepilot-segment')
  assert.equal(r.properties.laneFieldSourcesF.laneMovements, 'human-block')
  assert.equal(r.properties.laneFieldSourcesF.motorcycleAccess, 'lanepilot-segment')
})

test('uses each forward block final node for distinct approach movements and segment fallback count', () => {
  const first = road(10, [1, 2])
  const second = road(10, [2, 3])
  const index = laneBase.buildLaneBaseIndex([
    base({ laneCount: 3 }),
    base({ sourceKey: 'way/10#1', scope: 'intersection_approach', intersectionNodeId: 2,
      laneMovements: ['left', 'through', 'right'] }),
    base({ sourceKey: 'way/10#2', scope: 'intersection_approach', intersectionNodeId: 3,
      laneMovements: ['left', 'left', 'through'] }),
  ])

  laneBase.applyLaneBaseToRoads([first, second], index)

  assert.equal(first.properties.lanesForward, 3)
  assert.equal(second.properties.lanesForward, 3)
  assert.deepEqual(first.properties.turnLanes, ['left', 'through', 'right'])
  assert.deepEqual(second.properties.turnLanes, ['left', 'left', 'through'])
  assert.equal(first.properties.laneFieldSourcesF.laneCount, 'lanepilot-segment')
  assert.equal(first.properties.laneFieldSourcesF.laneMovements, 'lanepilot-approach')
})

test('uses the first node for backward approach resolution', () => {
  const r = road(10, [1, 2])
  const index = laneBase.buildLaneBaseIndex([base({
    direction: 'backward', scope: 'intersection_approach', intersectionNodeId: 1,
    laneCount: 2, laneMovements: ['left', 'through'],
  })])

  laneBase.applyLaneBaseToRoads([r], index)

  assert.equal(r.properties.lanesBackward, 2)
  assert.deepEqual(r.properties.turnLanesB, ['left', 'through'])
  assert.equal(r.properties.laneFieldSourcesB.laneMovements, 'lanepilot-approach')
})

test('reports movement-rule-only source keys as unresolved until a later task consumes them', () => {
  const r = road(10, [1, 2])
  const index = laneBase.buildLaneBaseIndex([base({
    movementRules: [{ approach_direction: 'forward', movement: 'left' }],
  })])

  const report = laneBase.applyLaneBaseToRoads([r], index)

  assert.equal(report.appliedRoadDirections, 0)
  assert.deepEqual(report.unresolvedSourceKeys, ['way/10#0'])
})

test('keeps provenance field-specific for way and block journal priority', () => {
  const r = road(10, [1, 2])
  const index = laneBase.buildLaneBaseIndex([base({ laneCount: 3, laneMovements: ['through', 'through', 'right'] })])
  laneBase.applyLaneBaseToRoads([r], index)

  applyToRoads([r], foldJournal([
    humanSet('way/10', { lanes_forward: 4, turn_lanes: 'left|through|right', road_marking_mode: 'none' }),
    humanSet('way/10@b/1', { lanes_forward: 5, motorcycle_access_by_lane: 'yes|yes|designated' }),
  ]))

  assert.equal(r.properties.lanesForward, 5)
  assert.deepEqual(r.properties.turnLanes, ['left', 'through', 'right'])
  assert.equal(r.properties.roadMarkingMode, 'none')
  assert.equal(r.properties.laneFieldSourcesF.laneCount, 'human-block')
  assert.equal(r.properties.laneFieldSourcesF.laneMovements, 'human-way')
  assert.deepEqual(r.properties.motorcycleAccessByLaneF, ['yes', 'yes', 'designated'])
  assert.equal(r.properties.laneFieldSourcesF.motorcycleAccess, 'human-block')
})

test('unrelated human journal fields preserve LanePilot and OSM lane provenance', () => {
  const [r] = roadsFromGeoJSON({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 22], [120, 22.001]] },
    properties: {
      osm_id: 10, highway: 'tertiary', nodes: [1, 2],
      lanes_forward: '3', turn_lanes_forward: 'left|through|right',
    },
  }] })
  const index = laneBase.buildLaneBaseIndex([base({
    motorcycleAccessByLane: ['yes', 'yes', 'designated'],
  })])
  laneBase.applyLaneBaseToRoads([r], index)
  const before = { ...r.properties.laneFieldSourcesF }

  applyToRoads([r], foldJournal([
    humanSet('way/10', { road_marking_mode: 'none' }),
  ]))

  assert.deepEqual(before, {
    laneCount: 'osm', laneMovements: 'osm', motorcycleAccess: 'lanepilot-segment',
  })
  assert.deepEqual(r.properties.laneFieldSourcesF, before)
})

test('initializes OSM provenance only for valid source tags and reports fully inferred guidance', () => {
  const [osmRoad] = roadsFromGeoJSON({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 22], [120, 22.001]] },
    properties: { osm_id: 10, highway: 'tertiary', nodes: [1, 2], lanes_forward: '3', lanes_backward: '2', turn_lanes_forward: 'left|through|right' },
  }] })
  const [inferredRoad] = roadsFromGeoJSON({ type: 'FeatureCollection', features: [{
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[120, 22], [120, 22.001]] },
    properties: { osm_id: 11, highway: 'tertiary', nodes: [1, 2], lanes: 'not-a-count', turn_lanes_forward: '' },
  }] })

  assert.equal(osmRoad.properties.laneFieldSourcesF.laneCount, 'osm')
  assert.equal(osmRoad.properties.laneFieldSourcesF.laneMovements, 'osm')
  assert.equal(inferredRoad.properties.laneFieldSourcesF.laneCount, 'inferred')
  assert.equal(inferredRoad.properties.laneFieldSourcesF.laneMovements, 'inferred')
  assert.deepEqual(laneBase.guidanceForRoadDirection(inferredRoad, false), {
    laneCount: inferredRoad.properties.lanesForward,
    laneMovements: undefined,
    source: 'inferred',
  })
})
