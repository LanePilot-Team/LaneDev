import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizePlaces, distanceMeters, placesToGeoJSON } from './place_merge.mjs'

const fetchedAt = '2026-08-05T00:00:00.000Z'

function place(id, name, position, fields = {}) {
  const source = id.startsWith('tdx:') ? 'tdx' : 'osm'
  return {
    id,
    source,
    sourceId: id.split(':').slice(1).join('/'),
    name,
    aliases: [],
    category: 'transport',
    position,
    fetchedAt,
    rawCategory: source === 'tdx' ? 'tdx:bus-station' : 'public_transport=platform',
    ...fields,
  }
}

test('同名且鄰近的跨來源車站會合併並保留來源參照', () => {
  const result = canonicalizePlaces([
    place('osm:node:1', '高鐵左營站', [120.30879, 22.68718]),
    place('tdx:bus-station:1', '高鐵左營站', [120.30874, 22.68706]),
  ])
  assert.equal(result.places.length, 1)
  assert.equal(result.places[0].mergedCount, 2)
  assert.deepEqual(result.places[0].sourceRefs.map((item) => item.source), ['osm', 'tdx'])
})

test('同一站區內不同名稱的運輸系統不會自動合併', () => {
  const result = canonicalizePlaces([
    place('osm:relation:1', '高鐵左營站', [120.30769, 22.68704], {
      rawCategory: 'railway=station',
    }),
    place('tdx:tra-station:4340', '新左營', [120.30678, 22.68754], {
      rawCategory: 'tdx:tra-station',
    }),
  ])
  assert.equal(result.places.length, 2)
})

test('別名相同不會把同站區不同運輸系統串接合併', () => {
  const result = canonicalizePlaces([
    place('osm:relation:1', '高鐵左營站', [120.30769, 22.68704], {
      aliases: ['左營'], rawCategory: 'railway=station',
    }),
    place('tdx:krtc-station:R16', '左營', [120.30889, 22.68838], {
      aliases: ['捷運左營站'], rawCategory: 'tdx:krtc-station',
    }),
  ])
  assert.equal(result.places.length, 2)
})

test('人工 merge、keepSeparate 與 patch 優先於自動規則', () => {
  const raw = [
    place('osm:node:1', '測試站', [120.3, 22.7]),
    place('tdx:bus-station:1', '另一名稱', [120.3001, 22.7001]),
    place('osm:node:2', '測試站', [120.30015, 22.70015]),
  ]
  const result = canonicalizePlaces(raw, {
    mergeGroups: [{
      id: 'place:manual-station',
      name: '人工站名',
      members: ['osm:node:1', 'tdx:bus-station:1'],
    }],
    keepSeparate: [['osm:node:1', 'osm:node:2']],
    patches: [{ matchId: 'place:manual-station', priority: 99 }],
  })
  assert.equal(result.places.length, 2)
  const merged = result.places.find((item) => item.id === 'place:manual-station')
  assert.equal(merged.name, '人工站名')
  assert.equal(merged.priority, 99)
  assert.equal(merged.mergedCount, 2)
})

test('一般商店只合併非常接近的同名資料', () => {
  const result = canonicalizePlaces([
    place('osm:node:1', '示例商店', [120.3, 22.7], { category: 'shopping' }),
    place('tdx:shop:1', '示例商店', [120.3001, 22.7], { category: 'shopping' }),
    place('osm:node:2', '示例商店', [120.301, 22.7], { category: 'shopping' }),
  ])
  assert.ok(distanceMeters([120.3, 22.7], [120.3001, 22.7]) < 32)
  assert.equal(result.places.length, 2)
})

test('隱藏 override 不會輸出到地圖 GeoJSON', () => {
  const result = canonicalizePlaces([
    place('osm:node:1', '隱藏地標', [120.3, 22.7]),
  ], {
    patches: [{ matchId: 'osm:node:1', hidden: true }],
  })
  assert.equal(result.places.length, 1)
  assert.equal(placesToGeoJSON(result.places).features.length, 0)
})
