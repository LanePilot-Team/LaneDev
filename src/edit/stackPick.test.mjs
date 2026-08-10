import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStackIndex, EMPTY_CURSOR, describeStackRoad, highwayLabel } from './stackPick.ts'

const KEYS = 'way/1@b/10|way/2@b/20|way/3@b/30'
const at = (x, y, index, keys = KEYS) => ({ x, y, keys, index })

test('第一下選最上面那條', () => {
  assert.equal(nextStackIndex(EMPTY_CURSOR, 100, 100, KEYS, 3, false), 0)
})

test('同一處再次點擊會輪選，繞完回到最上面', () => {
  assert.equal(nextStackIndex(at(100, 100, 0), 100, 100, KEYS, 3, false), 1)
  assert.equal(nextStackIndex(at(100, 100, 1), 102, 98, KEYS, 3, false), 2)
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, KEYS, 3, false), 0)
})

test('位置或疊層組成改變時從最上面重新開始', () => {
  assert.equal(nextStackIndex(at(100, 100, 1), 140, 100, KEYS, 3, false), 0)
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, 'way/9@b/90', 1, false), 0)
})

test('Ctrl 捏合會保持使用者已選取的疊層道路', () => {
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, KEYS, 3, true), 2)
  assert.equal(nextStackIndex(at(100, 100, 5), 100, 100, KEYS, 3, true), 2)
})

test('沒有道路命中時回到索引 0', () => {
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, '', 0, false), 0)
})

test('說明文字可分辨同名主線與側車道', () => {
  const road = (highway, lanesForward, lanesBackward, oneway) => ({
    type: 'Feature',
    properties: {
      osm_id: 1, blockNode: 10, name: '高楠公路', highway, lanesForward, lanesBackward, oneway,
    },
    geometry: { type: 'LineString', coordinates: [[120.3, 22.73], [120.3, 22.7309]] },
  })
  const main = describeStackRoad(road('primary', 3, 0, 'yes'))
  const side = describeStackRoad(road('service', 1, 0, 'yes'))
  assert.equal(main.key, 'way/1@b/10')
  assert.equal(main.name, '高楠公路')
  assert.match(main.detail, /^主要·3車道單行·\d+m$/)
  assert.match(side.detail, /^服務／側車道·1車道單行·\d+m$/)
  assert.notEqual(main.detail, side.detail)
})

test('匝道與未知道路分級都有可讀標籤', () => {
  assert.equal(highwayLabel('primary_link'), '主要匝道')
  assert.equal(highwayLabel('raceway'), 'raceway')
})
