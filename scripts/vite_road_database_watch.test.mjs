import test from 'node:test'
import assert from 'node:assert/strict'
import configFactory from '../vite.config.ts'

test('本機編輯器寫入 road_database 時不得觸發 Vite 整頁重載', () => {
  const config = configFactory({ command: 'serve', mode: 'test' })
  const ignored = config.server?.watch?.ignored ?? []

  assert.equal(
    Array.isArray(ignored) && ignored.includes('**/public/data/road_database.json'),
    true,
  )
})
