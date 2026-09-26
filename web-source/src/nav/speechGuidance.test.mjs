import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpeechAnnouncement, arrivalAnnouncement, arrivingAnnouncement,
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
  }), '前方 250 公尺，靠右準備右轉')
})

test('builds near and now two-stage wording', () => {
  const m = maneuver({ kind: 'left', twoStage: true })
  assert.match(buildSpeechAnnouncement({
    distanceM: 60, maneuver: m, profile: 'moto', twoStage: true, stage: 'near',
  }), /^前方 60 公尺，靠右進入待轉區/)
  assert.match(buildSpeechAnnouncement({
    distanceM: 25, maneuver: m, profile: 'moto', twoStage: true, stage: 'now',
  }), /^現在，靠右進入待轉區/)
})

test('omits road-name narration but keeps a close subsequent maneuver', () => {
  const text = buildSpeechAnnouncement({
    distanceM: 55,
    maneuver: maneuver({ roadName: '德民路' }),
    next2: maneuver({ distM: 300, kind: 'left' }),
    profile: 'car',
    twoStage: false,
    stage: 'near',
  })
  assert.doesNotMatch(text, /德民路|進入/)
  assert.equal(text, '前方 60 公尺，右轉，隨後左轉')
  assert.match(text, /隨後左轉/)
})

test('uses arrival wording without lane preparation', () => {
  assert.equal(buildSpeechAnnouncement({
    distanceM: 250,
    maneuver: maneuver({ kind: 'arrive' }),
    profile: 'car',
    twoStage: false,
    stage: 'far',
  }), '前方 250 公尺，抵達目的地')
})

test('short safety cue is spoken once at near stage, not a repeated paragraph', () => {
  const m = maneuver({ laneDecision: { shortPreparation: true } })
  const say = stage => buildSpeechAnnouncement({ distanceM: 50, maneuver: m, profile: 'car', twoStage: false, stage })
  assert.equal(say('near'), '前方 50 公尺，右轉，勿勉強變道')
  assert.doesNotMatch(say('far'), /勿勉強|系統將|請注意安全/)
  assert.equal(say('now'), '現在，右轉')
})

test('retains essential two-stage and dedicated motorcycle lane instructions', () => {
  const say = (m, stage = 'far', twoStage = false) => buildSpeechAnnouncement({
    distanceM: 200, maneuver: m, profile: 'moto', twoStage, stage,
  })
  assert.equal(say(maneuver({ kind: 'left' }), 'far', true), '前方 200 公尺，靠右準備兩段式左轉')
  assert.equal(say(maneuver({ kind: 'left', motoLeftTurnLane: true }), 'now'), '現在，靠右進入機車左轉道')
  assert.match(say(maneuver({ kind: 'uturn', motoLeftTurnLane: true }), 'near'), /機車左轉道，準備迴轉/)
  assert.equal(say(maneuver({ kind: 'left', bayOffM: 3 })), '前方 200 公尺，進入左轉道準備左轉')
})

test('keeps only the next actionable turn and avoids unsafe two-stage shorthand', () => {
  const say = (twoStage, next2) => buildSpeechAnnouncement({
    distanceM: 50, maneuver: maneuver({ kind: 'left' }), profile: 'moto', twoStage, next2, stage: 'near',
  })
  assert.equal(say(true, maneuver({ distM: 280, kind: 'right' })), '前方 50 公尺，靠右進入待轉區')
  assert.match(say(false, maneuver({ distM: 280, kind: 'left', twoStage: true })), /隨後兩段式左轉/)
  assert.doesNotMatch(say(false, maneuver({ distM: 200, kind: 'right' })), /隨後/)
})

test('arrival phrases are short even with very long destination names', () => {
  assert.equal(arrivingAnnouncement('國立高雄大學'), '即將抵達目的地')
  assert.equal(arrivalAnnouncement('國立高雄大學'), '已抵達國立高雄大學，導航結束')
  assert.equal(arrivalAnnouncement('很長的目的地名稱'.repeat(8)), '已抵達目的地，導航結束')
})

test('turn announcements remain concise across stages and maneuver types', () => {
  for (const kind of ['left', 'right', 'uturn', 'slight-left', 'slight-right', 'arrive']) {
    for (const stage of ['far', 'near', 'now']) {
      const text = buildSpeechAnnouncement({
        distanceM: 50, maneuver: maneuver({ kind, roadName: '很長的道路名稱'.repeat(8) }),
        profile: 'car', twoStage: false, stage,
      })
      assert.ok(text.length <= 30, text)
      assert.doesNotMatch(text, /很長|undefined/)
    }
  }
})
