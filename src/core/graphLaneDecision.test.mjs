import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'

const road = (osmId, nodes, coordinates, turnLanes) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId,
    name: `road-${osmId}`,
    highway: 'residential',
    lanes: turnLanes?.length ?? 1,
    lanesForward: turnLanes?.length ?? 1,
    lanesBackward: 0,
    motoF: false,
    motoB: false,
    motoCountF: 0,
    motoCountB: 0,
    motoSepF: 0,
    motoSepB: 0,
    motoEntryIconF: false,
    motoEntryIconB: false,
    motoTextDiamondF: false,
    motoTextDiamondB: false,
    stopLineF: false,
    stopLineB: false,
    arrowDisplayF: false,
    arrowDisplayB: false,
    startArrowDisplayF: false,
    startArrowDisplayB: false,
    leftWaitAreaF: false,
    leftWaitAreaB: false,
    roadMarkingMode: 'all',
    centerM: 0,
    centerKind: 'hatch',
    islandBayMode: false,
    centerExtendStart: false,
    centerExtendEnd: false,
    extraM: 0,
    divOffM: 0,
    width_m: 3.2,
    oneway: 'yes',
    layer: 0,
    blockNode: nodes[0],
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    sourceSegments: [{
      osmId,
      navSegmentKey: `way/${osmId}`,
      splitIndex: 0,
      nodeRefs: [...nodes],
    }],
    nodes: [...nodes],
    turnLanes,
  },
})

const start = [120.0001, 22]
const junction = [120.001, 22]
const southGoal = [120.001, 21.9991]
const northGoal = [120.001, 22.0009]

test('可靠車道全部不允許右轉時回報 lane-direction', () => {
  const graph = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], ['through', 'through']),
    road(20, [2, 3], [junction, [120.001, 21.999]], ['through']),
  ])

  const result = graph.routeDetailed(start, southGoal, 'car')

  assert.equal(result.route, null)
  assert.equal(result.failure, 'lane-direction')
})

test('較短路徑的轉向不合法時改走車道方向合法的繞路', () => {
  const merge = [120.001, 21.999]
  const graph = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], ['through']),
    road(20, [2, 5], [junction, merge], ['through']),
    road(30, [2, 3], [junction, [120.002, 22]], ['right']),
    road(31, [3, 4], [[120.002, 22], [120.002, 21.999]], ['right']),
    road(32, [4, 5], [[120.002, 21.999], merge], ['left']),
    road(40, [5, 6], [merge, [120.001, 21.998]], ['through']),
  ])

  const result = graph.routeDetailed(start, [120.001, 21.9981], 'car')

  assert.ok(result.route)
  assert.deepEqual(
    result.route.spans.map((span) => span.road?.properties.osm_id),
    [10, 30, 31, 32, 40],
  )
})

test('車道方向完全缺失時保留導航路徑', () => {
  const graph = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], undefined),
    road(20, [2, 3], [junction, [120.001, 21.999]], ['through']),
  ])

  const result = graph.routeDetailed(start, southGoal, 'car')

  assert.ok(result.route)
  assert.equal(result.failure, undefined)
})

test('機車兩段式左轉只能由可直行車道進入待轉區', () => {
  const twoStagePolicy = {
    isTwoStage: () => true,
  }
  const blocked = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], ['right']),
    road(30, [2, 4], [junction, [120.001, 22.001]], ['through']),
  ])
  const allowed = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], ['through', 'right']),
    road(30, [2, 4], [junction, [120.001, 22.001]], ['through']),
  ])

  const blockedResult = blocked.routeDetailed(start, northGoal, 'moto', twoStagePolicy)
  const allowedResult = allowed.routeDetailed(start, northGoal, 'moto', twoStagePolicy)

  assert.equal(blockedResult.route, null)
  assert.equal(blockedResult.failure, 'lane-direction')
  assert.ok(allowedResult.route)
})

test('已接受的轉向保存主要、次要與不相容車道', () => {
  const graph = new RoadGraph([
    road(10, [1, 2], [[120, 22], junction], ['through', 'through;right', 'right']),
    road(20, [2, 3], [junction, [120.001, 21.999]], ['through']),
  ])

  const route = graph.route(start, southGoal, 'car')

  assert.ok(route)
  assert.equal(route.maneuvers[0].laneDecision.primaryLaneIndex, 2)
  assert.deepEqual(route.maneuvers[0].laneDecision.secondaryLaneIndices, [1])
  assert.deepEqual(route.maneuvers[0].laneDecision.incompatibleLaneIndices, [0])
})

test('A* 保留進入車道狀態並避開短距離跨兩車道方案', () => {
  const split = [120, 22]
  const final = [120.001, 22]
  const graph = new RoadGraph([
    road(100, [0, 1], [[120, 21.999], split], ['left', 'right']),
    road(110, [1, 11, 12, 2], [split, [119.9999, 22], [120.0005, 22], final],
      ['through', 'through', 'right']),
    road(120, [1, 21, 22, 23, 2], [split, [120.0001, 22], [120.0001, 22.0009], [120.0005, 22], final],
      ['through', 'through', 'right']),
    road(130, [2, 3], [final, [120.001, 21.999]], ['through']),
  ])

  const result = graph.routeDetailed([120, 21.9991], [120.001, 21.9991], 'car')
  const route = result.route

  assert.ok(route, result.failure)
  assert.equal(route.spans[1].road?.properties.osm_id, 120)
  assert.equal(route.maneuvers.at(-2).laneDecision.shortPreparation, false)
})

test('相近的右轉接左轉會以前瞻車道作為轉彎後落點', () => {
  const first = [120.001, 22]
  const second = [120.001, 21.9995]
  const graph = new RoadGraph([
    road(200, [1, 2], [[120, 22], first], ['through', 'through;right', 'right']),
    road(210, [2, 3], [first, second], ['left', 'left;through', 'through']),
    road(220, [3, 4], [second, [120.002, 21.9995]], ['through']),
  ])

  const route = graph.route([120.0001, 22], [120.0019, 21.9995], 'car')

  assert.ok(route)
  assert.equal(route.maneuvers.length, 3)
  assert.equal(route.maneuvers[0].laneDecision.postTurnLaneIndex, 0)
  assert.equal(route.maneuvers[1].laneDecision.primaryLaneIndex, 0)
})
