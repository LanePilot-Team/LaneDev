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
