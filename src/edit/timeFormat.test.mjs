import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTaiwanHistoryTime } from './timeFormat.ts'

test('修改歷程將 UTC 時間顯示為台灣 UTC+8', () => {
  assert.equal(
    formatTaiwanHistoryTime('2026-08-01T12:34:56.000Z'),
    '2026/08/01 20:34:56（台灣時間 UTC+8）',
  )
})

test('缺少或無效的修改歷程時間顯示未知', () => {
  assert.equal(formatTaiwanHistoryTime(undefined), '未知')
  assert.equal(formatTaiwanHistoryTime('not-a-date'), '未知')
})
