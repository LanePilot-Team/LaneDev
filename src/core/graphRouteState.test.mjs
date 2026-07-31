import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'

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
