import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROAD_MERGE_RELOAD_STATE_KEY,
  consumeRoadMergeReloadState,
  saveRoadMergeReloadState,
} from './roadMergeReload.ts'

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

