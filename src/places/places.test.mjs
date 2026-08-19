import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePlaceText,
  placeFromPoiFeature,
  searchPlaces,
} from './places.ts'

function place(id, name, fields = {}) {
  return {
    id,
    source: 'osm',
    sourceId: id,
    name,
    aliases: [],
    category: 'other',
    position: [120.3, 22.6],
    fetchedAt: '2026-08-19T00:00:00.000Z',
    ...fields,
  }
}

test('搜尋文字會統一全半形、臺台、大小寫及標點空白', () => {
  assert.equal(normalizePlaceText(' ＴＡＩＷＡＮ・臺 鐵！ '), 'taiwan台鐵')
})

test('本地搜尋依名稱、別名與地址的相關程度排序', () => {
  const places = [
    place('address', '北高雄服務處', { address: '左營區博愛路' }),
    place('contains', '高鐵左營站'),
    place('alias', '蓮池潭', { aliases: ['左營舊城'] }),
    place('exact', '左營'),
    place('starts', '左營高鐵站'),
    place('raw-category', '測試地標', { rawCategory: '左營特色地標' }),
    place('hidden', '左營', { hidden: true }),
  ]

  assert.deepEqual(
    searchPlaces(places, ' 左營 ').map((item) => item.id),
    ['exact', 'starts', 'contains', 'alias', 'address', 'raw-category'],
  )
  assert.deepEqual(
    searchPlaces(places, '左營', 3).map((item) => item.id),
    ['exact', 'starts', 'contains'],
  )
  assert.deepEqual(searchPlaces(places, '　'), [])
})

test('搜尋可用正規化後的臺台差異找到本地資料', () => {
  const places = [place('station', '台鐵楠梓車站', { category: 'transport' })]

  assert.deepEqual(searchPlaces(places, '臺鐵').map((item) => item.id), ['station'])
})

test('地圖 POI 可還原座標、分類與 OSM＋TDX 來源', () => {
  const result = placeFromPoiFeature({
    id: 99,
    properties: {
      id: 'place:station',
      name: '楠梓車站',
      category: 'transport',
      sources: 'osm+tdx',
      mergedCount: 2,
      tier: 'major',
      icon: 'railway',
    },
    geometry: { type: 'Point', coordinates: [120.3248, 22.7287] },
  })

  assert.equal(result?.id, 'place:station')
  assert.equal(result?.source, 'osm')
  assert.deepEqual(result?.position, [120.3248, 22.7287])
  assert.deepEqual(result?.sourceRefs?.map((item) => item.source), ['osm', 'tdx'])
  assert.equal(result?.category, 'transport')
  assert.equal(result?.mergedCount, 2)
  assert.equal(result?.tier, 'major')
  assert.equal(result?.icon, 'railway')
})

test('缺少有效名稱或點座標的地圖圖徵不會成為目的地', () => {
  assert.equal(placeFromPoiFeature({
    properties: { id: 'place:1', name: '' },
    geometry: { type: 'Point', coordinates: [120.3, 22.6] },
  }), null)
  assert.equal(placeFromPoiFeature({
    properties: { id: 'place:1', name: '測試地標' },
    geometry: { type: 'LineString', coordinates: [[120.3, 22.6]] },
  }), null)
  assert.equal(placeFromPoiFeature({
    properties: { id: 'place:1', name: '測試地標' },
    geometry: { type: 'Point', coordinates: [Number.NaN, 22.6] },
  }), null)
})
