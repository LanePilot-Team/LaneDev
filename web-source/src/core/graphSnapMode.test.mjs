import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'

// 2026-11-07：起終點吸附依來源區分。
// 'lane'（地圖上點車道，預設）照點的那一側；'area'（搜尋地點／地址／目前位置）附近各候選由 A* 挑。
const road = (osmId, nodes, coordinates, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId, name: `road-${osmId}`, highway: 'primary',
    lanes: 1, lanesForward: 1, lanesBackward: 0,
    motoF: false, motoB: false, motoCountF: 0, motoCountB: 0, motoSepF: 0, motoSepB: 0,
    roadMarkingMode: 'all', centerM: 0, centerKind: 'hatch', extraM: 0, divOffM: 0,
    width_m: 3.2, oneway: 'yes', layer: 0, blockNode: nodes[0],
    navSegmentKey: `way/${osmId}`, splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: [...nodes] }],
    nodes: [...nodes],
    ...extra,
  },
})

// 南北向分隔道路，兩個方向是分開的單行 way（相距約 30 m，像高楠公路）：
// 西側南下（10）、東側北上（20），南北兩端各有一條東西向連絡道可迴轉。
// 南端迴轉點在起點南方約 600 m（實地案例的繞路都在 0.6 km 以上）。
const W = 120.0, E = 120.0003
const graph = new RoadGraph([
  road(10, [1, 2], [[W, 22.002], [W, 21.996]]), // 南下
  road(20, [3, 4], [[E, 21.996], [E, 22.002]]), // 北上
  road(30, [2, 3], [[W, 21.996], [E, 21.996]]), // 南端連絡道（西→東）
  road(40, [4, 1], [[E, 22.002], [W, 22.002]]), // 北端連絡道（東→西）
])
const nearSouthbound = [W + 0.00003, 22.0015] // 離南下側約 3 m、離北上側約 28 m
const northGoal = [E + 0.00001, 22.0019]

test('地圖點車道（預設 lane）：點在南下側就從南下側出發，往北要先繞到南端迴轉', () => {
  const { route } = graph.routeDetailed(nearSouthbound, northGoal, 'car')
  assert.ok(route)
  assert.equal(route.spans[0].road?.properties.osm_id, 10)
  assert.ok(route.lengthM > 1000, `應先南下再迴轉，實得 ${route.lengthM.toFixed(0)} m`)
})

test('搜尋／目前位置（area）：附近的對向單行車道也是起點候選，直接從北上側出發', () => {
  const { route } = graph.routeDetailed(nearSouthbound, northGoal, 'car', {}, undefined, 'area')
  assert.ok(route)
  assert.equal(route.spans[0].road?.properties.osm_id, 20)
  assert.ok(route.lengthM < 150, `應直接北上，實得 ${route.lengthM.toFixed(0)} m`)
})

test('有起點方位（GPS 偏航重規劃）時不受 area 影響，仍依車頭方向', () => {
  const { route } = graph.routeDetailed(nearSouthbound, northGoal, 'car', {}, 180, 'area')
  assert.ok(route)
  assert.equal(route.spans[0].road?.properties.osm_id, 10)
})

// 東西向大路（50，雙向無分隔）旁有一條巷子（60），巷子是「往大路」的單行，要進巷子得從
// 東邊繞一圈（70 北上、80 西行）從巷尾進去——像加昌路 179 巷要從 127 巷繞進去。
// 終點點在巷口：'lane' 照點選吸到巷子；'area' 也考慮 15 m 內的大路。
const street = road(50, [11, 12, 13], [[120.0, 22.0], [120.001, 22.0], [120.002, 22.0]], {
  highway: 'tertiary', oneway: 'no', lanes: 2, lanesBackward: 1,
})
const alley = road(60, [14, 12], [[120.001, 22.0008], [120.001, 22.0]], { highway: 'residential' })
const loopNorth = road(70, [13, 15], [[120.002, 22.0], [120.002, 22.0008]], { highway: 'residential' })
const loopWest = road(80, [15, 14], [[120.002, 22.0008], [120.001, 22.0008]], { highway: 'residential' })
const streetGraph = new RoadGraph([street, alley, loopNorth, loopWest])
const alleyMouth = [120.00101, 22.0001] // 巷子中線東側 1 m、大路中線北側約 11 m

test('終點 lane：點在巷口照點選，終點落在巷子上', () => {
  const { route } = streetGraph.routeDetailed([120.0002, 22.0], alleyMouth, 'car')
  assert.ok(route)
  assert.equal(route.spans.at(-1).road?.properties.osm_id, 60)
})

test('終點 area：點在巷口時改停旁邊的大路，不必轉進巷子', () => {
  const { route } = streetGraph.routeDetailed([120.0002, 22.0], alleyMouth, 'car', {}, undefined, 'lane', 'area')
  assert.ok(route)
  assert.equal(route.spans.at(-1).road?.properties.osm_id, 50)
})
