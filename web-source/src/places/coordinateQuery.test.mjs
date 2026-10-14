import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCoordinateQuery } from './coordinateQuery.ts'

test('解析緯度、經度文字為導航座標 [經度, 緯度]', () => {
  assert.deepEqual(parseCoordinateQuery('22.62730, 120.30120'), [120.3012, 22.6273])
})

test('也接受經度、緯度順序', () => {
  assert.deepEqual(parseCoordinateQuery('120.30120, 22.62730'), [120.3012, 22.6273])
})

test('一般地點名稱不會被誤判為座標', () => {
  assert.equal(parseCoordinateQuery('高雄大學'), null)
})
