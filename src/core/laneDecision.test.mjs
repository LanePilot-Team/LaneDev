import test from 'node:test'
import assert from 'node:assert/strict'
import {
  preparationDistanceM,
  resolveLaneDecision,
} from './laneDecision.ts'

const decide = (overrides = {}) => resolveLaneDecision({
  action: 'right',
  profile: 'car',
  laneCount: 3,
  laneMovements: ['through', 'through;right', 'right'],
  guidanceSource: 'annotation',
  currentLaneIndex: 0,
  availableM: 300,
  speedKmh: 50,
  twoStage: false,
  ...overrides,
})

test('純右轉道優先，複合右轉道保留為次要合法車道', () => {
  const result = decide()

  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 2)
  assert.deepEqual(result.secondaryLaneIndices, [1])
  assert.deepEqual(result.incompatibleLaneIndices, [0])
  assert.equal(result.inferred, false)
})

test('所有可靠車道都只允許直行時拒絕右轉', () => {
  const result = decide({
    laneCount: 2,
    laneMovements: ['through', 'through'],
  })

  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'explicitly-incompatible')
  assert.equal(result.primaryLaneIndex, undefined)
})

test('部分缺失時避開已知直行道並選最外側未知車道', () => {
  const result = decide({ laneMovements: ['through', '', ''] })

  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 2)
  assert.deepEqual(result.secondaryLaneIndices, [1])
  assert.deepEqual(result.incompatibleLaneIndices, [0])
  assert.equal(result.inferred, true)
})

test('完全缺失時保留導航並標記系統推測', () => {
  const result = decide({ laneMovements: undefined, guidanceSource: 'inferred' })

  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 2)
  assert.equal(result.inferred, true)
})

test('機車兩段式左轉選最外側可直行車道而不選純右轉道', () => {
  const result = decide({
    profile: 'moto',
    action: 'left',
    twoStage: true,
    laneMovements: ['through', 'through;right', 'right'],
  })

  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 1)
  assert.deepEqual(result.secondaryLaneIndices, [0])
  assert.deepEqual(result.incompatibleLaneIndices, [2])
})

test('機車兩段式左轉沒有任何可直行車道時拒絕路徑', () => {
  const result = decide({
    profile: 'moto',
    action: 'left',
    twoStage: true,
    laneCount: 2,
    laneMovements: ['right', 'right'],
  })

  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'explicitly-incompatible')
})

test('多條純右轉道先選換道數較少者', () => {
  const result = decide({
    laneMovements: ['through', 'right', 'right'],
    currentLaneIndex: 1,
  })

  assert.equal(result.primaryLaneIndex, 1)
  assert.deepEqual(result.secondaryLaneIndices, [2])
})

test('多條純右轉道同距離時選最外側', () => {
  const result = decide({
    laneCount: 4,
    laneMovements: ['through', 'right', 'right', 'through'],
    currentLaneIndex: undefined,
  })

  assert.equal(result.primaryLaneIndex, 2)
  assert.deepEqual(result.secondaryLaneIndices, [1])
})

test('迴轉優先明確 reverse 車道', () => {
  const result = decide({
    action: 'uturn',
    laneMovements: ['reverse', 'left', 'through'],
  })

  assert.equal(result.primaryLaneIndex, 0)
  assert.equal(result.inferred, false)
})

test('迴轉缺少 reverse 時使用最內側左轉道並標記推測', () => {
  const result = decide({
    action: 'uturn',
    laneMovements: ['left', 'through', 'right'],
  })

  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 0)
  assert.equal(result.inferred, true)
})

test('迴轉遇到全部明確直行或右轉車道時拒絕路徑', () => {
  const result = decide({
    action: 'uturn',
    laneMovements: ['through', 'through;right', 'right'],
  })

  assert.equal(result.allowed, false)
})

test('高速跨多車道會延長準備距離', () => {
  assert.equal(preparationDistanceM(50, 1), 250)
  assert.ok(preparationDistanceM(90, 4) > 250)

  const result = decide({
    laneCount: 5,
    laneMovements: ['through', 'through', 'through', 'through', 'right'],
    speedKmh: 90,
    currentLaneIndex: 0,
    availableM: 200,
  })

  assert.equal(result.laneChanges, 4)
  assert.equal(result.shortPreparation, true)
  assert.ok(result.difficultyS > 0)
})
