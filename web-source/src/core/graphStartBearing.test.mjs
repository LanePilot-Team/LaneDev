import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'
import { bearing, angleDelta } from './geo.ts'

// 東西向雙向道（各一車道），右駕：東行車道在南側、西行車道在北側。
const road = (osmId, nodes, coordinates) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId, name: `road-${osmId}`, highway: 'residential',
    lanes: 2, lanesForward: 1, lanesBackward: 1,
    motoF: false, motoB: false, motoCountF: 0, motoCountB: 0, motoSepF: 0, motoSepB: 0,
    roadMarkingMode: 'all', centerM: 0, centerKind: 'hatch', extraM: 0, divOffM: 0,
    width_m: 6.4, oneway: 'no', layer: 0, blockNode: nodes[0],
    navSegmentKey: `way/${osmId}`, splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: [...nodes] }],
    nodes: [...nodes],
  },
})

const graph = new RoadGraph([
  road(1, [1, 2, 3], [[120.000, 22], [120.002, 22], [120.004, 22]]),
])
// GPS 定位落在北側（西行車道）約 3 m，但車其實朝東開
const gpsFix = [120.003, 22.00003]
const goal = [120.0039, 22]

const firstBearing = (route) => bearing(route.coords[0], route.coords[1])

test('不給起點方位時沿用最近車道（GPS 偏北 → 西行）', () => {
  const { route } = graph.routeDetailed(gpsFix, goal, 'car')
  assert.ok(route)
  assert.ok(Math.abs(angleDelta(firstBearing(route), 270)) < 45)
})

test('給起點方位時依車頭方向選行向，不被 GPS 誤差帶到對向', () => {
  const { route } = graph.routeDetailed(gpsFix, goal, 'car', {}, 90)
  assert.ok(route)
  assert.ok(Math.abs(angleDelta(firstBearing(route), 90)) < 45)
  assert.ok(route.lengthM < 120, `直接東行約 92 m，實得 ${route.lengthM}`)
})
