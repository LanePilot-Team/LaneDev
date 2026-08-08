import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLanePreview,
  INFERENCE_NOTE,
  selectLanePreviewGuidance,
} from './lanePreview.ts'

const ready = (overrides = {}) => buildLanePreview({
  laneCount: 3,
  turnLanes: ['through', 'through;right', 'right'],
  maneuverKind: 'right',
  distanceM: 200,
  twoStage: false,
  ...overrides,
})

test('highlights every lane compatible with a near right turn', () => {
  const model = ready()
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, true, true])
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through-right', 'right'])
})

test('uses through as the immediate action beyond 250 metres', () => {
  const model = ready({ distanceM: 251 })
  assert.equal(model.immediateAction, 'through')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, true, false])
})

test('switches to the maneuver at exactly 250 metres', () => {
  const model = ready({ distanceM: 250 })
  assert.equal(model.immediateAction, 'right')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, true, true])
})

test('uses current span beyond 250m and maneuver guidance at 250m', () => {
  const current = {
    laneCount: 2,
    laneMovements: ['through', 'through'],
    source: 'osm',
  }
  const maneuver = {
    laneCount: 3,
    laneMovements: ['left', 'through', 'through'],
    source: 'annotation',
  }

  assert.equal(selectLanePreviewGuidance({
    distanceM: 251,
    current,
    maneuver,
  }), current)
  assert.equal(selectLanePreviewGuidance({
    distanceM: 250,
    current,
    maneuver,
  }), maneuver)
})

test('keeps annotation source out of the inference note', () => {
  const model = ready({
    turnLanes: ['left'],
    laneCount: 3,
    maneuverKind: 'left',
    guidanceSource: 'annotation',
  })
  assert.equal(model.inferred, false)
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, false, false])
})

test('infers a rightmost combined lane and marks the result inferred', () => {
  const model = ready({ turnLanes: undefined })
  assert.equal(model.inferred, true)
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through', 'through-right'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, false, true])
})

test('infers through guidance beyond 250 metres', () => {
  const model = ready({ turnLanes: undefined, distanceM: 600 })
  assert.equal(model.immediateAction, 'through')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, true, true])
})

test('returns no-data when lane count is invalid', () => {
  const model = ready({ laneCount: undefined })
  assert.equal(model.status, 'no-data')
  assert.deepEqual(model.lanes, [])
})

test('shows two-stage guidance only within 250 metres', () => {
  const near = ready({ twoStage: true, maneuverKind: 'left', distanceM: 250 })
  assert.equal(near.showTwoStageSign, true)
  assert.deepEqual(near.lanes.map((lane) => lane.active), [false, false, true])
  assert.deepEqual(near.lanes.map((lane) => lane.arrow), ['through', 'through-right', 'through'])

  const far = ready({ twoStage: true, maneuverKind: 'left', distanceM: 251 })
  assert.equal(far.showTwoStageSign, false)
  assert.equal(far.immediateAction, 'through')
})

test('uses left artwork for a u-turn and prefers a reverse lane', () => {
  const model = ready({
    turnLanes: ['reverse', 'left;through', 'through'],
    maneuverKind: 'uturn',
  })
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['left', 'through-left', 'through'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, false, false])
})

test('falls back from u-turn to a left-compatible lane', () => {
  const model = ready({
    turnLanes: ['left', 'through', 'right'],
    maneuverKind: 'uturn',
  })
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, false, false])
})

test('renders one, six, and ten lanes without truncating', () => {
  for (const count of [1, 6, 10]) {
    const model = ready({ laneCount: count, turnLanes: undefined })
    assert.equal(model.lanes.length, count)
    assert.equal(model.truncated, false)
  }
})

test('truncates abnormal lane counts above ten', () => {
  const model = ready({ laneCount: 12, turnLanes: undefined })
  assert.equal(model.lanes.length, 10)
  assert.equal(model.truncated, true)
})

test('unknown and incomplete movement strings do not throw or activate turn lanes', () => {
  const model = ready({ turnLanes: ['unknown-token', '', 'right'] })
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through', 'right'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, false, true])
})

const savedDecision = (overrides = {}) => ({
  allowed: true,
  reason: 'compatible',
  primaryLaneIndex: 2,
  secondaryLaneIndices: [1],
  incompatibleLaneIndices: [0],
  inferred: false,
  preparationM: 280,
  laneChanges: 1,
  difficultyS: 2,
  shortPreparation: false,
  ...overrides,
})

test('保存決策區分主要、次要與不相容車道', () => {
  const model = ready({ laneDecision: savedDecision() })

  assert.deepEqual(model.lanes.map((lane) => lane.state),
    ['inactive', 'secondary', 'primary'])
})

test('HUD 使用保存的準備距離而不是固定 250 公尺', () => {
  const model = ready({
    distanceM: 275,
    laneDecision: savedDecision({ preparationM: 280 }),
  })

  assert.equal(model.immediateAction, 'right')
})

test('系統推測與短距離換道警告可同時顯示', () => {
  const model = ready({
    laneDecision: savedDecision({ inferred: true, shortPreparation: true }),
  })

  assert.equal(model.inferenceNote, INFERENCE_NOTE)
  assert.equal(model.warningNote,
    '前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。')
})

test('only shows the exact inference note from inferred effective guidance', () => {
  const inferred = ready({
    guidanceSource: 'inferred',
    laneDecision: savedDecision({ inferred: false }),
  })

  assert.equal(INFERENCE_NOTE, '蝟餌絞?冽葫鞈?嚗?靘?湔?蝺?擏.')
  assert.equal(inferred.inferenceNote, INFERENCE_NOTE)
  assert.equal(inferred.inferred, true)
})

test('does not reclassify explicit effective guidance from an inferred decision', () => {
  for (const guidanceSource of ['annotation', 'annotation+osm', 'osm']) {
    const model = ready({
      guidanceSource,
      laneDecision: savedDecision({ inferred: true }),
    })

    assert.equal(model.inferred, false, guidanceSource)
    assert.equal(model.inferenceNote, undefined, guidanceSource)
  }
})

test('uses the route LaneDecision primary lane index for a right-turn preview', () => {
  const model = ready({
    laneDecision: savedDecision({
      primaryLaneIndex: 1,
      secondaryLaneIndices: [2],
    }),
  })

  assert.deepEqual(model.lanes.map((lane) => lane.state),
    ['inactive', 'primary', 'secondary'])
})
