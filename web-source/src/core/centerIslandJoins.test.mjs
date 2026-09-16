import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCenterIslandJoins } from './centerIslandJoins.ts'
import { RoadGraph } from './graph.ts'

const road = (osmId, nodes, coordinates, overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {
    osm_id: osmId,
    name: '外環西路',
    highway: 'tertiary',
    lanes: 2,
    lanesForward: 1,
    lanesBackward: 1,
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
    centerM: 3.2,
    centerKind: 'island',
    islandBayMode: false,
    centerExtendStart: false,
    centerExtendEnd: false,
    extraM: 0,
    divOffM: 0,
    width_m: 20,
    oneway: 'no',
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
    ...overrides,
  },
})

/** 實地拓撲：主路南北向、由北往南 digitize，接點南北各屬不同 way；側街自東側單行進入。 */
const junction = () => {
  const node = [120, 22]
  // 北臂：由北往南，接點是最後一個 node（離開接點 = 逆向 = 北向）
  const northArm = road(100, [1, 2], [[120, 22.002], node])
  // 南臂：同樣由北往南，接點是第一個 node（離開接點 = 正向 = 南向）
  const southArm = road(200, [2, 3], [node, [120, 21.998]])
  const side = road(300, [4, 2], [[120.002, 22], node], {
    highway: 'residential', oneway: 'yes', lanesForward: 1, lanesBackward: 0,
    centerM: 0, centerKind: 'hatch', width_m: 3.2,
  })
  return { node, northArm, southArm, side }
}

const spec = [{ nodeId: 2, label: 'test' }]

/** 路線經過的 way 序列（相鄰重複的 span 合併——span 會依車道偏移再切段）。 */
const wayIds = (route) => route.spans
  .map((span) => span.road?.properties.osm_id)
  .filter((id, index, all) => id !== all[index - 1])


test('貫通接點解析出兩段主路並登記續行對照', () => {
  const { northArm, southArm, side } = junction()
  const results = applyCenterIslandJoins([northArm, southArm, side], spec)

  assert.equal(results[0].applied, true)
  assert.deepEqual(northArm.properties.centerIslandJoinNodes, [2])
  assert.deepEqual(southArm.properties.centerIslandJoinNodes, [2])
  assert.deepEqual(northArm.properties.medianContinuityPeers, [
    { nodeId: 2, peerKey: 'way/200@b/2' },
  ])
  assert.deepEqual(southArm.properties.medianContinuityPeers, [
    { nodeId: 2, peerKey: 'way/100@b/1' },
  ])
  // 側街在東側 = 北向車道那一側：北臂離開接點是逆向、南臂進入接點是逆向，
  // 兩段的 allowedBack 都是 true
  assert.deepEqual(northArm.properties.oneSideEntryAccess, [
    { nodeId: 2, allowedBack: true, sideRoadKey: 'way/300@b/4' },
  ])
  assert.deepEqual(southArm.properties.oneSideEntryAccess, [
    { nodeId: 2, allowedBack: true, sideRoadKey: 'way/300@b/4' },
  ])
  // 側街本身不受限制（限制掛在主路上，方向由 sideRoadKey 指定）
  assert.equal(side.properties.oneSideEntryAccess, undefined)
  // 不得使用 oneSideEntryNodes：那會讓主路續行也被當成側街而擋掉反向
  assert.equal(northArm.properties.oneSideEntryNodes, undefined)
  assert.equal(southArm.properties.oneSideEntryNodes, undefined)
})

test('貫通後主路南北直行都通、但不得在接點迴轉', () => {
  const { northArm, southArm, side } = junction()
  applyCenterIslandJoins([northArm, southArm, side], spec)
  const graph = new RoadGraph([northArm, southArm, side])

  const southbound = graph.route([120, 22.0015], [120, 21.9985], 'car')
  const northbound = graph.route([120, 21.9985], [120, 22.0015], 'car')
  assert.ok(southbound, '南向直行不得被貫通接點中斷')
  assert.ok(northbound, '北向直行不得被貫通接點中斷')
  assert.deepEqual(wayIds(southbound), [100, 200])
  assert.deepEqual(wayIds(northbound), [200, 100])

  // 迴轉：南臂進來後折回南臂 —— 唯一的通路就是同一段路，貫通後應無解
  const uTurn = graph.route([120, 21.9985], [120, 21.9990], 'car')
  assert.ok(uTurn, '同向前進仍可通行')
  assert.deepEqual(wayIds(uTurn), [200], '不得繞經接點折返')
})

test('側街只能右轉進入相鄰行向，不得跨島左轉', () => {
  const { northArm, southArm, side } = junction()
  applyCenterIslandJoins([northArm, southArm, side], spec)
  const graph = new RoadGraph([northArm, southArm, side])

  const toNorth = graph.route([120.0015, 22], [120, 22.0015], 'car')
  const toSouth = graph.route([120.0015, 22], [120, 21.9985], 'car')
  assert.ok(toNorth, '側街應可右轉進入北向主路')
  assert.deepEqual(wayIds(toNorth), [300, 100])
  // 南向目的地仍到得了，但不得在接點直接跨島——必須先右轉北上再折返
  assert.ok(toSouth, '南向目的地仍應可經較遠處折返抵達')
  assert.deepEqual(wayIds(toSouth), [300, 100, 200],
    '側街不得跨越連續中央島左轉；必須先進入北向主路')
  assert.ok(toSouth.coords.some((coord) => coord[1] > 22.001),
    '前往南向目的地前必須先離開接點往北折返')
})

test('未貫通時側街可以左轉、主路可以迴轉（對照組）', () => {
  const { northArm, southArm, side } = junction()
  const graph = new RoadGraph([northArm, southArm, side])

  const toSouth = graph.route([120.0015, 22], [120, 21.9985], 'car')
  assert.ok(toSouth, '沒有貫通標記時側街本來就可以左轉——證明上面的測試有鑑別力')
  assert.deepEqual(wayIds(toSouth), [300, 200])
})

test('接點兩側不是共線的實體中央島時不套用', () => {
  const { northArm, southArm, side } = junction()
  southArm.properties.centerKind = 'hatch'
  const results = applyCenterIslandJoins([northArm, southArm, side], spec)

  assert.equal(results[0].applied, false)
  assert.equal(northArm.properties.centerIslandJoinNodes, undefined)
  assert.equal(northArm.properties.oneSideEntryAccess, undefined)
})
