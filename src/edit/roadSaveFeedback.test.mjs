import test from 'node:test'
import assert from 'node:assert/strict'
import { reportRoadEditSave } from './roadSaveFeedback.ts'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('道路設定先提示正在儲存，落盤後再提示成功', async () => {
  const messages = []
  const pending = deferred()

  const result = reportRoadEditSave(
    () => pending.promise,
    (message) => messages.push(message),
    [],
  )

  assert.deepEqual(messages, ['道路設定已套用，正在儲存…'])
  pending.resolve()
  await result
  assert.equal(messages.at(-1), '道路設定已儲存並套用')
})

test('資料庫寫入失敗時說明本機仍保留並顯示實際原因', async () => {
  const messages = []

  await reportRoadEditSave(
    () => Promise.reject(new Error('server offline')),
    (message) => messages.push(message),
    [],
  )

  assert.match(messages.at(-1), /設定仍保留在此瀏覽器，但尚未寫入資料庫/)
  assert.match(messages.at(-1), /server offline/)
})

test('生成警告在儲存中與完成後都不會被蓋掉', async () => {
  const messages = []
  const warning = '東向偏心道未生成：此區塊太短'

  await reportRoadEditSave(
    () => Promise.resolve(),
    (message) => messages.push(message),
    [warning],
  )

  assert.match(messages[0], /正在儲存/)
  assert.match(messages[0], /東向偏心道未生成/)
  assert.match(messages.at(-1), /道路設定已儲存/)
  assert.match(messages.at(-1), /東向偏心道未生成/)
})
