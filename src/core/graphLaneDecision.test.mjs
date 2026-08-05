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
