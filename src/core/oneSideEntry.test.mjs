import test from 'node:test'
import assert from 'node:assert/strict'
import { oneSideEntryTransitionAllowed } from './oneSideEntry.ts'

const road = (osmId, restricted = [], access = undefined) => ({
  properties: {
    osm_id: osmId,
    oneSideEntryNodes: restricted,
    oneSideEntryAccess: access,
  },
})

// 捏合接點 = T 字路口：只有主路正向那一側能與側街互動。
const NODE = 20
const main = (allowedBack = false) => road(100, [NODE], [{ nodeId: NODE, allowedBack }])
const side = () => road(200)
const allow = (inRoad, inBack, outRoad, outBack, node = NODE) =>
  oneSideEntryTransitionAllowed(inRoad, inBack, outRoad, outBack, node)

test('主路正向可以轉入側街', () => {
  assert.equal(allow(main(), false, side(), false), true)
})

test('主路反向不可跨線轉入側街', () => {
  assert.equal(allow(main(), true, side(), false), false)
})

test('側街可以駛出到主路正向', () => {
  assert.equal(allow(side(), false, main(), false), true)
})

test('側街不可逆向切入主路反向——要先走正向再迴轉', () => {
  assert.equal(allow(side(), false, main(), true), false)
})

test('主路反向沿自己直行不受影響', () => {
  assert.equal(allow(main(), true, main(), true), true)
  assert.equal(allow(main(), false, main(), false), true)
})

test('捏合接縫不可直接切換主路方向作為迴轉', () => {
  assert.equal(allow(main(), false, main(), true), false)
  assert.equal(allow(main(), true, main(), false), false)
})

test('相鄰方向由 allowedBack 決定，不可固定假設 forward', () => {
  const reversedMain = main(true)
  assert.equal(allow(reversedMain, true, side(), false), true)
  assert.equal(allow(side(), false, reversedMain, true), true)
  assert.equal(allow(reversedMain, false, side(), false), false)
  assert.equal(allow(side(), false, reversedMain, false), false)
})

test('兩條側街在該接點互轉不受影響', () => {
  assert.equal(allow(side(), false, road(300), false), true)
})

test('沒有登記限制的一般路口完全不受影響', () => {
  const other = 30
  assert.equal(allow(main(), true, side(), false, other), true)
  assert.equal(allow(side(), false, main(), true, other), true)
})

test('沒有進入邊時（起點）一律放行', () => {
  assert.equal(allow(undefined, false, main(), true), true)
})
