import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpeechAnnouncement,
  formatDistanceText,
  getGuidancePhase,
  speechStage,
} from './speechGuidance.ts'

const maneuver = (overrides = {}) => ({
  distM: 250,
  kind: 'right',
  lanesForward: 3,
  ...overrides,
})

test('keeps exact HUD phase boundaries', () => {
  assert.equal(getGuidancePhase(251), 'ahead')
  assert.equal(getGuidancePhase(250), 'far')
  assert.equal(getGuidancePhase(60), 'far')
  assert.equal(getGuidancePhase(25), 'near')
  assert.equal(formatDistanceText(25), '前方 30 公尺')
  assert.equal(formatDistanceText(1000), '前方 1000 公尺')
})

test('emits threshold stages only at or below 250m', () => {
  assert.equal(speechStage(251), null)
  assert.equal(speechStage(250), 'far')
  assert.equal(speechStage(60), 'near')
  assert.equal(speechStage(25), 'now')
})

test('builds far lane preparation wording', () => {
  assert.equal(buildSpeechAnnouncement({
    distanceM: 250,
    maneuver: maneuver(),
    profile: 'car',
    twoStage: false,
    stage: 'far',
  }), '前方 250 公尺後前往右側車道，準備右轉，請提早變換車道')
})

test('builds near and now two-stage wording', () => {
  const m = maneuver({ kind: 'left', twoStage: true })
  assert.match(buildSpeechAnnouncement({
    distanceM: 60, maneuver: m, profile: 'moto', twoStage: true, stage: 'near',
  }), /^前方 60 公尺靠右進入待轉區/)
  assert.match(buildSpeechAnnouncement({
    distanceM: 25, maneuver: m, profile: 'moto', twoStage: true, stage: 'now',
  }), /^現在靠右進入待轉區/)
})

test('keeps road name and a close subsequent maneuver', () => {
  const text = buildSpeechAnnouncement({
    distanceM: 55,
    maneuver: maneuver({ roadName: '德民路' }),
    next2: maneuver({ distM: 300, kind: 'left' }),
    profile: 'car',
    twoStage: false,
    stage: 'near',
  })
  assert.match(text, /進入德民路/)
  assert.match(text, /隨後左轉/)
})

test('uses arrival wording without lane preparation', () => {
  assert.equal(buildSpeechAnnouncement({
    distanceM: 250,
    maneuver: maneuver({ kind: 'arrive' }),
    profile: 'car',
    twoStage: false,
    stage: 'far',
  }), '前方 250 公尺後即將抵達目的地')
})
