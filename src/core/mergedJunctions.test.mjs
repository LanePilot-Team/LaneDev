// 捏合接點的導航接回（node --test src/core/mergedJunctions.test.mjs）
//
// 回歸來源：舊捏合把接點換成負節點、側街仍握著正節點，導航圖整個斷開。
// collapseKnownIntersections 用「座標完全相同」比對，但 couplet 合併已把主線移到
// 中線，側街端點差 6～12m，永遠 match 不到。實測德中路 × 大學六十街直線 141m、
// 導航要走 652m。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJunctionAliases } from './mergedJunctions.ts'

// 約略換算：緯度 0.0001 度 ≈ 11.1 公尺
const road = (osmId, name, nodes, coords, extra = {}) => ({
  properties: { osm_id: osmId, name, nodes, oneway: 'no', ...extra },
  geometry: { type: 'LineString', coordinates: coords },
})

/** 主線南北向，中間有一個捏合負節點 */
const mainRoad = (negNode = -3871383230010) => road(100, '德中路',
  [10, negNode, 11],
  [[120.2740, 22.7270], [120.2740, 22.7280], [120.2740, 22.7290]])

/** 側街東西向，端點落在主線接點附近（gapDeg 控制距離） */
const sideRoad = (name, gapDeg, osmId = 200, node = 555) => road(osmId, name,
  [node, 556],
  [[120.2740 + gapDeg, 22.7280], [120.2750 + gapDeg, 22.7280]])

test('側街端點在容許距離內 → 接回並登記單向進入', () => {
  const main = mainRoad()
  const side = sideRoad('大學六十街', 0.0001) // ≈ 10m
  const { alias, reconnected } = buildJunctionAliases([main, side])
  assert.equal(reconnected, 1)
  assert.equal(alias.get(-3871383230010), 555, '負節點應別名到側街端點')
  assert.deepEqual(main.properties.oneSideEntryNodes, [555])
})

test('超出容許距離 → 不亂接', () => {
  const main = mainRoad()
  const side = sideRoad('大學六十街', 0.0005) // ≈ 51m
  const { alias, reconnected } = buildJunctionAliases([main, side])
  assert.equal(reconnected, 0)
  assert.equal(alias.size, 0)
  assert.equal(main.properties.oneSideEntryNodes, undefined)
})

test('同名續行不套 T 字路口限制——那是同一條路，兩向都該直行通過', () => {
  const main = mainRoad()
  const cont = sideRoad('德中路', 0.0001) // 同名 = 續行段
  const { alias, reconnected } = buildJunctionAliases([main, cont])
  assert.equal(reconnected, 1, '仍要接回去')
  assert.equal(alias.get(-3871383230010), 555)
  assert.equal(main.properties.oneSideEntryNodes, undefined, '同名續行不該被限制')
})

test('範圍內有兩條不同的路 → 無法安全判定，不接', () => {
  const main = mainRoad()
  const a = sideRoad('大學六十街', 0.0001, 200, 555)
  const b = sideRoad('大學六十二街', 0.00012, 300, 777)
  const { alias, reconnected } = buildJunctionAliases([main, a, b])
  assert.equal(reconnected, 0)
  assert.equal(alias.size, 0)
})

test('建置腳本補的小負數不是捏合痕跡，不處理', () => {
  const main = mainRoad(-7)
  const side = sideRoad('大學六十街', 0.0001)
  const { reconnected } = buildJunctionAliases([main, side])
  assert.equal(reconnected, 0)
})

test('主線端點上的負節點不處理——那是路的盡頭不是路口', () => {
  const main = road(100, '德中路',
    [-3871383230010, 10, 11],
    [[120.2740, 22.7270], [120.2740, 22.7280], [120.2740, 22.7290]])
  const side = road(200, '大學六十街', [555, 556],
    [[120.2741, 22.7270], [120.2751, 22.7270]])
  const { reconnected } = buildJunctionAliases([main, side])
  assert.equal(reconnected, 0)
})

test('候選必須是端點，路中間經過不算 T 字路口', () => {
  const main = mainRoad()
  // 側街從主線接點旁「經過」，但接點附近的是它的中間頂點而非端點
  const passing = road(200, '大學六十街', [555, 556, 557],
    [[120.2730, 22.7280], [120.2741, 22.7280], [120.2750, 22.7280]])
  const { reconnected } = buildJunctionAliases([main, passing])
  assert.equal(reconnected, 0)
})

test('重複呼叫不會累積重複的限制節點', () => {
  const main = mainRoad()
  const side = sideRoad('大學六十街', 0.0001)
  buildJunctionAliases([main, side])
  buildJunctionAliases([main, side])
  assert.deepEqual(main.properties.oneSideEntryNodes, [555])
})
