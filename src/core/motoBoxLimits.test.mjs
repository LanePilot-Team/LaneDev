// 機車停等格的合法涵蓋範圍（turnbays.motoBoxLaneLimits）。
//
// 這條規則同時決定自動配置與編輯面板 stepper 的上下限。面板以前把它快照進
// state，所以勾了「禁行機車」之後上限還停在舊值、停等格照樣可以延伸過去；
// 現在面板每次 render 都呼叫這支重算，規則本身因此需要獨立的測試守著。
import test from 'node:test'
import assert from 'node:assert/strict'
import { motoBoxLaneLimits } from './turnbays.ts'

const noMoto = { text: '禁行機車', color: '#facc15' }

test('沒有禁行機車時整個斷面都可涵蓋', () => {
  const limits = motoBoxLaneLimits(3, true, [null, null, null, null], false)
  assert.equal(limits.maxLanes, 4, '3 汽車道 + 1 機車道')
  assert.equal(limits.firstLegalLane, 0)
  assert.equal(limits.motoOnly, false)
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
