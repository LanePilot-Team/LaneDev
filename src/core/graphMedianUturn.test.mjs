// 中央分隔島／橋面禁止迴轉（graph.ts transitionAllowed）。
// 起因：高楠陸橋被 couplet 合併成雙向後，A* 可以在橋面上原地折返，
// 短距離對向終點就規劃出「上橋→迴轉→下橋」的幽靈路線。
import test from 'node:test'
import assert from 'node:assert/strict'
import { RoadGraph } from './graph.ts'

const road = (osmId, nodes, coordinates, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId,
    name: `road-${osmId}`,
    highway: 'primary',
    lanes: 2,
    lanesForward: 1,
    lanesBackward: 1,
    motoF: false, motoB: false,
    motoCountF: 0, motoCountB: 0,
    motoSepF: 0, motoSepB: 0,
    motoEntryIconF: false, motoEntryIconB: false,
    motoTextDiamondF: false, motoTextDiamondB: false,
    stopLineF: false, stopLineB: false,
    arrowDisplayF: false, arrowDisplayB: false,
    startArrowDisplayF: false, startArrowDisplayB: false,
    leftWaitAreaF: false, leftWaitAreaB: false,
    roadMarkingMode: 'all',
    centerM: 0,
    centerKind: 'hatch',
    islandBayMode: false,
    centerExtendStart: false, centerExtendEnd: false,
    extraM: 0, divOffM: 0,
    width_m: 6.4,
    oneway: 'no',
    layer: 0,
    blockNode: nodes[0],
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    sourceSegments: [{
      osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: [...nodes],
    }],
    nodes: [...nodes],
    ...extra,
  },
})

/** 南北向雙向道；起訖點落在同一段的兩個方向 */
const straight = (extra) => road(100, [1, 2, 3], [
  [120, 22], [120, 22.002], [120, 22.004],
], extra)

const uturnCount = (route) => route.maneuvers.filter((m) => m.kind === 'uturn').length

test('一般雙向道：起訖在同段對向仍可直接折返', () => {
  const graph = new RoadGraph([straight()])
  assert.ok(graph.route([120.00002, 22.003], [119.99998, 22.001], 'car'))
})

test('實體中央島路段不得就地折返', () => {
  const graph = new RoadGraph([straight({ centerM: 0.6, centerKind: 'island' })])
  assert.equal(graph.route([120.00002, 22.003], [119.99998, 22.001], 'car'), null)
})

test('高架橋面不得就地折返', () => {
  const graph = new RoadGraph([straight({ elevated: true })])
  assert.equal(graph.route([120.00002, 22.003], [119.99998, 22.001], 'car'), null)
})

/** 中間節點 2 有側巷 → 主路切成兩段邊，端點 3 才是真正的迴轉節點 */
const dividedWithSideStreet = (extra) => {
  const main = road(100, [1, 2, 3], [[120, 22], [120, 22.002], [120, 22.004]], {
    centerM: 0.6, centerKind: 'island', ...extra,
  })
  const side = road(200, [2, 4], [[120, 22.002], [120.002, 22.002]])
  return [main, side]
}

test('分隔島路段在路口節點也不得迴轉', () => {
  const graph = new RoadGraph(dividedWithSideStreet())
  assert.equal(graph.route([120.00002, 22.003], [119.99998, 22.001], 'car'), null)
})

test('迴轉開口（medianOpeningNodes）放行該節點', () => {
  const graph = new RoadGraph(dividedWithSideStreet({ medianOpeningNodes: [3] }))
  const route = graph.route([120.00002, 22.003], [119.99998, 22.001], 'car')
  assert.ok(route, '標了開口的節點應該還能迴轉')
  assert.equal(uturnCount(route), 1)
})

test('分隔島節點也擋掉「兩條單行 way 折返」', () => {
  // 高楠陸橋橋頭：折返走的是橋下兩條各自單行的地面 way，邊本身看不出中央島，
  // 但該節點屬於中央有護欄的橋體區塊——實地折不回去。
  const portal = [120, 22]
  const bridge = road(100, [1, 2], [portal, [120, 22.004]], {
    centerM: 0.6, centerKind: 'island', elevated: true,
  })
  const inbound = road(200, [3, 1], [[120, 21.996], portal], { oneway: 'yes', lanesBackward: 0 })
  const outbound = road(201, [1, 4], [portal, [120.0002, 21.996]], { oneway: 'yes', lanesBackward: 0 })
  const graph = new RoadGraph([bridge, inbound, outbound])
  assert.equal(graph.route([120, 21.998], [120.0001, 21.998], 'car'), null)
})
