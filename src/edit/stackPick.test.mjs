// 疊合路段的輪選規則（node --test src/edit/stackPick.test.mjs）
//
// 回歸來源：編輯器的 lane 工具只取 queryRenderedFeatures 的 hit[0]。高楠公路這類
// 「主線 + 側車道」在 OSM 是兩條中心線完全重合的 way（stack_probe 實測中位距 0.0m），
// 所以下層那條不論點哪裡都選不到。改成整疊收下來後，索引由 nextStackIndex 決定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStackIndex, EMPTY_CURSOR, describeStackRoad, highwayLabel } from './stackPick.ts'

const KEYS = 'way/1@b/10|way/2@b/20|way/3@b/30'
const at = (x, y, index, keys = KEYS) => ({ x, y, keys, index })

test('第一下選最上面那條（維持原本 hit[0] 的行為）', () => {
  assert.equal(nextStackIndex(EMPTY_CURSOR, 100, 100, KEYS, 3, false), 0)
})

test('同一處再點一下往下輪，繞完回到最上面', () => {
  assert.equal(nextStackIndex(at(100, 100, 0), 100, 100, KEYS, 3, false), 1)
  assert.equal(nextStackIndex(at(100, 100, 1), 102, 98, KEYS, 3, false), 2)
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, KEYS, 3, false), 0)
})

test('移開超過容差就重新從最上面開始', () => {
  assert.equal(nextStackIndex(at(100, 100, 1), 140, 100, KEYS, 3, false), 0)
})

test('同一處但疊的組成不同（點到另一段）也重新開始', () => {
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, 'way/9@b/90', 1, false), 0)
})

test('Ctrl（捏合）不輪選：停在使用者已經選好的那一條', () => {
  // 先普通點兩下選到第 3 條，再按住 Ctrl 點同一處要拿到的仍是第 3 條——
  // 若這裡也輪選，被壓在下面的路段就永遠無法作為捏合的來源。
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, KEYS, 3, true), 2)
})

test('整疊變短時索引不會越界', () => {
  assert.equal(nextStackIndex(at(100, 100, 5), 100, 100, KEYS, 3, true), 2)
})

test('沒命中任何路段時回 0', () => {
  assert.equal(nextStackIndex(at(100, 100, 2), 100, 100, '', 0, false), 0)
})

test('副標分得出同名的主線與側車道', () => {
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

test('匝道與未知分級都有可讀標籤', () => {
  assert.equal(highwayLabel('primary_link'), '主要匝道')
  assert.equal(highwayLabel('raceway'), 'raceway')
})
