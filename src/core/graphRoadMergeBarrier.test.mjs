import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'

const road = (osmId, nodes, coordinates) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId,
    name: `road-${osmId}`,
    highway: 'residential',
    lanes: 1,
    lanesForward: 1,
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
  },
})

test('連續中央島接點禁止側路左轉進入主路對向', () => {
  const junction = [120, 22]
  const side = road(200, [4, 2], [[120.001, 22], junction])
  const northbound = road(100, [2, 3], [junction, [120, 22.001]])
  const southbound = road(101, [2, 1], [junction, [120, 21.999]])
  northbound.properties.roadMergeBarrierNodes = [2]
  southbound.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([side, northbound, southbound])

  const legalRightTurn = graph.route([120.0008, 22], [120, 22.0008], 'car')
  const acrossMedianLeftTurn = graph.route([120.0008, 22], [120, 21.9992], 'car')

  assert.ok(legalRightTurn, '側路仍應能右轉進入同側主路')
  assert.deepEqual(
    legalRightTurn.spans.map((span) => span.road?.properties.osm_id),
    [200, 100],
  )
  assert.equal(acrossMedianLeftTurn, null, '側路不得跨越連續中央島左轉進入對向')
})

test('連續中央島接點禁止兩側側路互相直穿', () => {
  const junction = [120, 22]
  const eastSide = road(200, [4, 2], [[120.001, 22], junction])
  const westSide = road(201, [2, 5], [junction, [119.999, 22]])
  const northbound = road(100, [2, 3], [junction, [120, 22.001]])
  const southbound = road(101, [1, 2], [[120, 21.999], junction])
  northbound.properties.roadMergeBarrierNodes = [2]
  southbound.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([eastSide, westSide, northbound, southbound])

  const acrossMedian = graph.route([120.0008, 22], [119.9992, 22], 'car')

  assert.equal(acrossMedian, null, '兩側側路不得穿越連續中央島互通')
})

test('連鎖捏合只標記其中一段時同一主路仍可直行通過', () => {
  const junction = [120, 22]
  const incomingMain = road(100, [1, 2], [[119.999, 22], junction])
  const outgoingMain = road(100, [2, 3], [junction, [120.001, 22]])
  outgoingMain.properties.roadMergeBarrierNodes = [2]
  const graph = new RoadGraph([incomingMain, outgoingMain])

  const route = graph.route([119.9992, 22], [120.0008, 22], 'car')

  assert.ok(route, '同一條主路不可因連鎖捏合標記分布不完整而中斷')
  assert.deepEqual(route.spans.map((span) => span.road?.properties.osm_id), [100, 100])
})

test('十字型捏合依側路限制方向且主路仍可直行', () => {
  const junction = [120, 22]
  const southMain = road(100, [1, 2], [[120, 21.999], junction])
  const northMain = road(100, [2, 3], [junction, [120, 22.001]])
  const eastSide = road(200, [4, 2], [[120.001, 22], junction])
  const westSide = road(201, [5, 2], [[119.999, 22], junction])
  const eastKey = 'way/200@b/4'
  const westKey = 'way/201@b/5'
  for (const main of [southMain, northMain]) {
    main.properties.oneway = 'no'
    main.properties.lanesBackward = 1
    main.properties.roadMergeBarrierNodes = [2]
    main.properties.oneSideEntryNodes = [2]
    main.properties.oneSideEntryAccess = [
      { nodeId: 2, allowedBack: false, sideRoadKey: eastKey },
      { nodeId: 2, allowedBack: true, sideRoadKey: westKey },
    ]
  }
  const graph = new RoadGraph([southMain, northMain, eastSide, westSide])

  const eastToNorth = graph.route([120.0008, 22], [120, 22.0008], 'car')
  const eastToSouth = graph.route([120.0008, 22], [120, 21.9992], 'car')
  const westToSouth = graph.route([119.9992, 22], [120, 21.9992], 'car')
  const westToNorth = graph.route([119.9992, 22], [120, 22.0008], 'car')
  const eastToWest = graph.route([120.0008, 22], [119.9992, 22], 'car')
  const mainThrough = graph.route([120, 21.9992], [120, 22.0008], 'car')

  assert.ok(eastToNorth, '東側路應可右轉進入北向主路')
  assert.ok(eastToSouth, '對向目的地仍可經較遠處迴轉抵達')
  assert.deepEqual(
    eastToSouth.spans.slice(0, 2).map((span) => [
      span.road?.properties.osm_id,
      span.road?.properties.blockNode,
      span.back,
    ]),
    [[200, 4, false], [100, 2, false]],
    '東側路必須先右轉北向，不得在捏合接點直接跨帶',
  )
  assert.ok(eastToSouth.coords.some((coord) => coord[1] > 22),
    '前往南向目的地前必須先離開接點到北側折返')
  assert.ok(westToSouth, '西側路應可右轉進入南向主路')
  assert.ok(westToNorth, '對向目的地仍可經較遠處迴轉抵達')
  assert.deepEqual(
    westToNorth.spans.slice(0, 2).map((span) => [
      span.road?.properties.osm_id,
      span.road?.properties.blockNode,
      span.back,
    ]),
    [[201, 5, false], [100, 1, true]],
    '西側路必須先右轉南向，不得在捏合接點直接跨帶',
  )
  assert.ok(westToNorth.coords.some((coord) => coord[1] < 22),
    '前往北向目的地前必須先離開接點到南側折返')
  assert.equal(eastToWest, null, '兩側側路不得直穿中央帶')
  assert.ok(mainThrough, '主路直行不得被捏合屏障中斷')
})
