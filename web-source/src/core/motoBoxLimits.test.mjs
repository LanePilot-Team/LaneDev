// 機車停等格的合法涵蓋範圍（turnbays.motoBoxLaneLimits）。
//
// 這條規則同時決定自動配置與編輯面板 stepper 的上下限。面板以前把它快照進
// state，所以勾了「禁行機車」之後上限還停在舊值、停等格照樣可以延伸過去；
// 現在面板每次 render 都呼叫這支重算，規則本身因此需要獨立的測試守著。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMotoBoxSlot, motoBoxLaneLimits } from './turnbays.ts'
import { RoadGraph } from './graph.ts'
import { buildRoadMergeViews, previewRoadMerge } from './roadMerge.ts'

test('all-unknown access preserves legacy motorcycle=no and manual lane fallback', () => {
  const legacy = motoBoxLaneLimits(
    2, true, undefined, true, ['unknown', 'unknown'],
  )
  assert.equal(legacy.motoOnly, true)
  assert.equal(legacy.maxLanes, 1)

  const manual = motoBoxLaneLimits(
    2, true, [null, { text: 'manual designated', color: '#fff' }], true,
    ['unknown', 'unknown'],
  )
  assert.equal(manual.firstLegalLane, 1)
  assert.equal(manual.maxLanes, 2)
})

const mergeRoad = (osmId, blockNode, nodes, coords, access) => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
  properties: {
    osm_id: osmId, blockNode, nodes, name: 'merge road', highway: 'tertiary',
    oneway: 'no', lanes: 4, lanesForward: 2, lanesBackward: 2,
    motoF: false, motoB: false, motoCountF: 0, motoCountB: 0,
    motoSepF: 0, motoSepB: 0, motorcycleAccessByLaneF: access,
    motorcycleAccessByLaneB: ['yes', 'yes'], roadMarkingMode: 'all',
    centerM: 0, centerKind: 'hatch', islandBayMode: false,
    centerExtendStart: false, centerExtendEnd: false, extraM: 0, divOffM: 0,
    width_m: 14, layer: 0, navSegmentKey: `way/${osmId}`, splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: nodes }],
  },
})

test('visual merge secondary endpoint uses the secondary approach motorcycle access', () => {
  const primary = mergeRoad(100, 10, [10, 20], [[120, 22], [120, 22.001]], ['yes', 'yes'])
  const secondary = mergeRoad(200, 20, [20, 30], [[120, 22.001], [120, 22.002]], ['no', 'yes'])
  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)
  assert.equal(preview.ok, true)
  const record = { ...preview.record, seq: 1, ts: '2026-01-01T00:00:00.000Z', author: 'test' }
  const view = buildRoadMergeViews([primary, secondary], [record], [])
  const carrier = view.renderRoads[0]
  const graph = new RoadGraph(view.renderRoads)
  const slot = makeMotoBoxSlot(graph)({
    road: carrier, back: false, fromNode: 10, toNode: 30,
    coords: carrier.geometry.coordinates, startSetbackM: 0, endSetbackM: 5,
  })

  assert.equal(slot.firstLegalLane, 1)
  assert.equal(slot.maxLanes, 1)
})

const noMoto = { text: '禁行機車', color: '#facc15' }

test('沒有禁行機車時整個斷面都可涵蓋', () => {
  const limits = motoBoxLaneLimits(3, true, [null, null, null, null], false)
  assert.equal(limits.maxLanes, 4, '3 汽車道 + 1 機車道')
  assert.equal(limits.firstLegalLane, 0)
  assert.equal(limits.motoOnly, false)
})

test('Lane Base 禁行機車陣列會限制停等格可涵蓋車道', () => {
  const limits = motoBoxLaneLimits(
    3, false, [null, null, null], false, ['no', 'yes', 'designated'],
  )
  assert.equal(limits.firstLegalLane, 1)
  assert.equal(limits.maxLanes, 2)
})

test('最內側禁行機車時，格子只能從第 2 道起算', () => {
  const limits = motoBoxLaneLimits(3, true, [noMoto, null, null, null], false)
  assert.equal(limits.firstLegalLane, 1, '禁行機車車道不可跨越')
  assert.equal(limits.maxLanes, 3, '2 合法汽車道 + 1 機車道')
})

test('掃描自最外側往內，遇第一條禁行即停', () => {
  // 內、外都禁行，中間合法：騎士無法穿越最外側那條進來
  const limits = motoBoxLaneLimits(3, false, [noMoto, null, noMoto], false)
  assert.equal(limits.firstLegalLane, 3, '最外側就禁行 → 沒有可進入的汽車道')
  assert.equal(limits.maxLanes, 0)
})

test('汽車道全禁行但有機車道：只涵蓋機車道', () => {
  const limits = motoBoxLaneLimits(2, true, [noMoto, noMoto, null], false)
  assert.equal(limits.motoOnly, true)
  assert.equal(limits.firstLegalLane, 2, '起點 = 機車道的格位')
  assert.equal(limits.maxLanes, 1, '只有機車道那一格')
})

test('沒有逐車道標記時沿用舊制 motorcycle=no（全車道禁行）', () => {
  const legacy = motoBoxLaneLimits(2, true, undefined, true)
  assert.equal(legacy.motoOnly, true)
  assert.equal(legacy.maxLanes, 1)
  const open = motoBoxLaneLimits(2, true, undefined, false)
  assert.equal(open.maxLanes, 3)
  assert.equal(open.firstLegalLane, 0)
})

test('純機車道（汽車道 0）沒有停等格空間', () => {
  const limits = motoBoxLaneLimits(0, true, [null], false)
  assert.equal(limits.maxLanes, 0, 'buildMotoBoxes 的 maxLanes < 1 會直接跳過')
})
