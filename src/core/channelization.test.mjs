import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOffsetTurnBayMarkings, channelizationKey, reviewKey,
} from './channelization.ts'

const parent = 'way/7@node/9'
const bay = {
  key: parent,
  turns: 'left',
  bayLenM: 30,
  taperLenM: 15,
  widthM: 3,
  source: 'manual',
  singleMode: 'capped',
  back: false,
}

const record = (type, key, fields, seq) => ({
  seq,
  ts: '2026-07-29T00:00:00.000Z',
  author: 'test',
  op: 'set',
  target: { type, key },
  fields,
})

test('one offset bay creates one review index record even without channelization', () => {
  assert.deepEqual(buildOffsetTurnBayMarkings([], [bay]), [{
    key: parent,
    offset_bay: {
      state: 'active', turns: 'left', source: 'manual', bay_len_m: 30,
      taper_len_m: 15, width_m: 3,
    },
    channelization: { state: 'none' },
    review: { status: 'unreviewed' },
  }])
})

test('channelization and review child records do not overwrite each other', () => {
  const records = [
    record('channelization', channelizationKey(parent), {
      mode: 'override', closure: 'unused-side', s_start_m: 8, s_end_m: 34,
      width_start_m: 0.2, width_end_m: 3,
    }, 1),
    record('approach_marking_review', reviewKey(parent), {
      status: 'verified', evidence_url: 'https://example.test/pano', note: '現地封閉',
    }, 2),
  ]
  const [actual] = buildOffsetTurnBayMarkings(records, [bay])
  assert.equal(actual.channelization.state, 'override')
  assert.equal(actual.channelization.closure, 'unused-side')
  assert.equal(actual.review.status, 'verified')
  assert.equal(actual.review.note, '現地封閉')
})

test('disabled channelization stays reviewable and produces no active geometry', () => {
  const [actual] = buildOffsetTurnBayMarkings([
    record('channelization', channelizationKey(parent), { mode: 'disabled' }, 1),
  ], [bay])
  assert.deepEqual(actual.channelization, { state: 'disabled' })
})
