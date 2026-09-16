import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROAD_MERGE_RELOAD_STATE_KEY,
  consumeRoadMergeReloadState,
  saveRoadMergeReloadState,
} from './roadMergeReload.ts'
import { appendJournalRecords } from './journalBatch.ts'

const memoryStorage = () => {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key),
  }
}

test('道路捏合重載狀態只恢復一次', () => {
  const storage = memoryStorage()
  const state = {
    camera: {
      center: [120.301, 22.701], zoom: 17.2, bearing: 28, pitch: 45,
    },
    mode: 'edit',
    editTool: 'lane',
    editRoad: { osmId: 100, blockNode: 2, name: '測試路' },
  }

  saveRoadMergeReloadState(storage, state)

  assert.equal(storage.has(ROAD_MERGE_RELOAD_STATE_KEY), true)
  assert.deepEqual(consumeRoadMergeReloadState(storage), state)
  assert.equal(storage.has(ROAD_MERGE_RELOAD_STATE_KEY), false)
  assert.equal(consumeRoadMergeReloadState(storage), null)
})

test('損壞或不完整的重載狀態會被清除', () => {
  const storage = memoryStorage()
  storage.setItem(ROAD_MERGE_RELOAD_STATE_KEY, '{broken')

  assert.equal(consumeRoadMergeReloadState(storage), null)
  assert.equal(storage.has(ROAD_MERGE_RELOAD_STATE_KEY), false)

  storage.setItem(ROAD_MERGE_RELOAD_STATE_KEY, JSON.stringify({ mode: 'edit' }))
  assert.equal(consumeRoadMergeReloadState(storage), null)
  assert.equal(storage.has(ROAD_MERGE_RELOAD_STATE_KEY), false)
})

test('接縫撤銷交易一次追加連續 seq 並共用時間與作者', () => {
  const writes = []
  const existing = [{
    seq: 7,
    ts: '2026-08-01T00:00:00.000Z',
    author: 'anna',
    op: 'set',
    target: { type: 'road_merge', key: 'merge/A+B' },
  }]
  const drafts = [
    { op: 'delete', target: { type: 'road_merge', key: 'merge/A+B' } },
    { op: 'delete', target: { type: 'road_merge', key: 'merge/A+C' } },
    { op: 'set', target: { type: 'road_merge', key: 'merge/B+C' }, fields: { schema_version: 2 } },
  ]

  const next = appendJournalRecords(
    existing,
    drafts,
    'anna',
    () => new Date('2026-08-01T12:34:56.000Z'),
    (journal) => writes.push(journal),
  )

  assert.deepEqual(next.slice(-3).map((record) => record.seq), [8, 9, 10])
  assert.deepEqual(new Set(next.slice(-3).map((record) => record.ts)),
    new Set(['2026-08-01T12:34:56.000Z']))
  assert.deepEqual(new Set(next.slice(-3).map((record) => record.author)), new Set(['anna']))
  assert.equal(writes.length, 1, '同一交易只持久化最後的完整 journal')
  assert.equal(writes[0], next)
})
