import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanePreview } from './lanePreview.ts'

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
