import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'
import { buildLaneGuidanceIndex } from './laneGuidance.ts'

const P = {
  start: [120.0001, 22],
  split: [120.001, 22],
  junction: [120.002, 22],
  detour: [120.001, 22.001],
  goal: [120.0029, 22],
}

const road = (osmId, nodes, coordinates, access = undefined) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId,
    name: `road-${osmId}`,
    highway: 'residential',
    lanes: 1,
    lanesForward: 1,
    lanesBackward: 0,
    laneFieldSourcesF: {
      laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred',
    },
    laneFieldSourcesB: {
      laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred',
    },
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
    oneSideEntryNodes: access?.map((entry) => entry.nodeId),
    oneSideEntryAccess: access,
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
  },
})

test('終點位於側路中段時仍須檢查進入該側路的轉向限制', () => {
  const graph = new RoadGraph([
    road(10, [0, 1], [[120, 22], P.split]),
    road(20, [1, 2], [P.split, P.junction], [{ nodeId: 2, allowedBack: true }]),
    road(50, [2, 4], [P.junction, [120.003, 22]]),
  ])

  const route = graph.route(P.start, P.goal, 'car')

  assert.equal(route, null, 'goal partial edge 不得略過接縫轉向限制')
})

test('同節點不同進入邊保留獨立狀態，合法路徑不被較便宜的受限抵達壓掉', () => {
  const roads = [
    road(10, [0, 1], [[120, 22], P.split]),
    // 直接抵達接縫較短，但此方向不是側路相鄰方向，不能轉入 road 50。
    road(20, [1, 2], [P.split, P.junction], [{ nodeId: 2, allowedBack: true }]),
    road(30, [1, 3], [P.split, P.detour]),
    road(40, [3, 2], [P.detour, P.junction]),
    road(50, [2, 4], [P.junction, [120.003, 22]]),
  ]
  const graph = new RoadGraph(roads)

  const route = graph.route(P.start, P.goal, 'car')

  assert.ok(route, '合法的第二種抵達狀態必須仍能找到路徑')
  assert.ok(route.lengthM < 500, `不應異常繞行 ${route.lengthM.toFixed(0)}m`)
  assert.deepEqual(route.spans.map((span) => span.road?.properties.osm_id),
    [10, 30, 40, 50])
})

const twoWayRoad = (osmId, nodes, coordinates, access = undefined) => {
  const result = road(osmId, nodes, coordinates, access)
  result.properties.oneway = 'no'
  result.properties.lanes = 2
  result.properties.lanesBackward = 1
  return result
}

test('同一道路點在相反車道時不得悄悄改用另一方向', () => {
  const eastWest = twoWayRoad(100, [1, 2], [[120, 22], [120.002, 22]])
  const graph = new RoadGraph([eastWest])
  const laneOffsetLat = 1.6 / 110540
  const eastboundStart = [120.0002, 22 - laneOffsetLat]
  const westboundGoal = [120.0018, 22 + laneOffsetLat]

  const route = graph.route(eastboundStart, westboundGoal, 'car')

  assert.ok(route, '可在道路端點迴轉後抵達對向終點')
  assert.deepEqual(route.spans.map((span) => span.back), [false, true])
  assert.ok(route.lengthM > 190, '不得用順向 edge 直接抵達對向車道')
})

test('任何捏合接點都不得作為迴轉點，即使沒有側路方向資訊', () => {
  const main = twoWayRoad(100, [1, 2], [[120, 22], [120.002, 22]])
  main.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([main])
  const laneOffsetLat = 1.6 / 110540
  const forwardStart = [120.0018, 22 - laneOffsetLat]
  const oppositeGoal = [120.0016, 22 + laneOffsetLat]

  const route = graph.route(forwardStart, oppositeGoal, 'car')

  assert.equal(route, null, '連續中央島的捏合接點不可用來切換主路方向')
})

test('側路不得從捏合節點跨越中央島接到主路另一側', () => {
  const junction = [120, 22]
  const access = [{ nodeId: 2, allowedBack: false }]
  const mainSouth = twoWayRoad(100, [1, 2], [[120, 21.999], junction], access)
  const mainNorth = twoWayRoad(100, [2, 3], [junction, [120, 22.001]], access)
  const side = road(200, [4, 2], [[120.001, 22], junction])
  const graph = new RoadGraph([mainSouth, mainNorth, side])
  const mainLaneOffsetLng = 1.6 / (111320 * Math.cos(22 * Math.PI / 180))
  const sideLaneOffsetLat = 1.6 / 110540
  const sideStart = [120.0008, 22 + sideLaneOffsetLat]
  const sameSideGoal = [120 + mainLaneOffsetLng, 22.0008]
  const acrossMedianGoal = [120 - mainLaneOffsetLng, 22.0008]

  const legal = graph.route(sideStart, sameSideGoal, 'car')
  const acrossMedian = graph.route(sideStart, acrossMedianGoal, 'car')

  assert.ok(legal, '側路應可右轉進入中央島同側的主路方向')
  assert.deepEqual(legal.spans.map((span) => [span.road?.properties.osm_id, span.back]),
    [[200, false], [100, false]])
  assert.ok(acrossMedian, '可先沿合法方向行駛，再於其他位置迴轉抵達')
  assert.deepEqual(
    acrossMedian.spans.map((span) => [span.road?.properties.osm_id, span.back]),
    [[200, false], [100, false], [100, true]],
    '捏合節點只能先右轉進同側，不得直接接到跨中央島方向',
  )
  assert.ok(acrossMedian.lengthM > legal.lengthM,
    '中央島另一側終點必須包含合法繞行，不得與同側終點同長')
})

test('未分隔雙向終點的點選方向不可達時改由另一方向合法繞行', () => {
  const split = [120.001, 22]
  const blockedEnd = [120.002, 22]
  const detour = [120.002, 22.001]
  const openEnd = [120.003, 22]
  const destination = twoWayRoad(50, [2, 4], [blockedEnd, openEnd])
  const barrierCarrier = road(60, [2, 5], [blockedEnd, [120.002, 21.999]])
  barrierCarrier.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([
    road(10, [0, 1], [[120, 22], split]),
    road(30, [1, 3], [split, detour]),
    road(40, [3, 4], [detour, openEnd]),
    destination,
    barrierCarrier,
  ])
  const laneOffsetLat = 1.6 / 110540
  const clickedForwardGoal = [120.0028, 22 - laneOffsetLat]

  const route = graph.route([120.0001, 22], clickedForwardGoal, 'car')

  assert.ok(route, '點選方向不可達時應保留從另一方向抵達的合法繞行路線')
  assert.equal(route.spans.at(-1)?.road?.properties.osm_id, 50)
  assert.equal(route.spans.at(-1)?.back, true)
  assert.deepEqual(route.spans.map((span) => span.road?.properties.osm_id), [10, 30, 40, 50])
})

test('有實體中央分隔的終點不可退回另一方向', () => {
  const split = [120.001, 22]
  const blockedEnd = [120.002, 22]
  const detour = [120.002, 22.001]
  const openEnd = [120.003, 22]
  const destination = twoWayRoad(50, [2, 4], [blockedEnd, openEnd])
  destination.properties.centerM = 2
  const barrierCarrier = road(60, [2, 5], [blockedEnd, [120.002, 21.999]])
  barrierCarrier.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([
    road(10, [0, 1], [[120, 22], split]),
    road(30, [1, 3], [split, detour]),
    road(40, [3, 4], [detour, openEnd]),
    destination,
    barrierCarrier,
  ])
  const clickedForwardGoal = [120.0028, 22 - 2.6 / 110540]

  const route = graph.route([120.0001, 22], clickedForwardGoal, 'car')

  assert.equal(route, null, '有中央分隔時不得把對向車道視為相同終點')
})

test('點選的終點方向可達時仍優先使用該方向', () => {
  const destination = twoWayRoad(100, [1, 2], [[120, 22], [120.002, 22]])
  const graph = new RoadGraph([destination])
  const laneOffsetLat = 1.6 / 110540
  const start = [120.0002, 22 - laneOffsetLat]
  const goal = [120.0018, 22 - laneOffsetLat]

  const route = graph.route(start, goal, 'car')

  assert.ok(route)
  assert.deepEqual(route.spans.map((span) => span.back), [false])
})

test('逆向 span guidance 讀取有效道路屬性而不讀舊索引', () => {
  const destination = twoWayRoad(500, [1, 2], [[120, 22], [120.002, 22]])
  destination.properties.lanesBackward = 2
  destination.properties.turnLanesB = ['left', 'through']
  destination.properties.laneFieldSourcesB = {
    laneCount: 'lanepilot-segment',
    laneMovements: 'human-way',
    motorcycleAccess: 'inferred',
  }
  const legacyIndex = buildLaneGuidanceIndex([{
    wayId: 500,
    direction: 'backward',
    scope: 'segment_direction',
    laneCount: 1,
    laneMovements: ['right'],
  }])
  const graph = new RoadGraph([destination], legacyIndex)
  const laneOffsetLat = 1.6 / 110540

  const route = graph.route(
    [120.0018, 22 + laneOffsetLat],
    [120.0002, 22 + laneOffsetLat],
    'car',
  )

  assert.ok(route)
  assert.equal(route.spans[0].back, true)
  assert.deepEqual(route.spans[0].laneGuidance, {
    laneCount: 2,
    laneMovements: ['left', 'through'],
    source: 'annotation',
  })
})
