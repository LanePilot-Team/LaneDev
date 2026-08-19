import test from 'node:test'
import assert from 'node:assert/strict'
import {
  destinationLabel,
  googleDestination,
  localDestination,
} from './destination.ts'

const localPlace = {
  id: 'osm:node:1',
  source: 'osm',
  sourceId: 'node:1',
  name: '楠梓車站',
  aliases: [],
  category: 'transport',
  position: [120.3248, 22.7287],
  fetchedAt: '2026-08-19T00:00:00.000Z',
}

test('本地地標會保留完整資料並提供原始名稱', () => {
  const destination = localDestination(localPlace)

  assert.deepEqual(destination, {
    provider: 'local',
    id: localPlace.id,
    position: localPlace.position,
    place: localPlace,
  })
  assert.equal(destinationLabel(destination), '楠梓車站')
})

test('Google 地點只轉成導航需要的 ID、座標與使用者查詢文字', () => {
  const googlePlace = {
    id: '  ChIJ-test-place  ',
    location: {
      lng: () => 120.3012,
      lat: () => 22.6273,
    },
    displayName: '不應儲存的 Google 顯示名稱',
    formattedAddress: '不應儲存的 Google 地址',
  }

  const destination = googleDestination(googlePlace, '  高雄咖啡廳  ')

  assert.deepEqual(destination, {
    provider: 'google-ui-kit',
    id: 'ChIJ-test-place',
    position: [120.3012, 22.6273],
    queryLabel: '高雄咖啡廳',
  })
  assert.equal(destinationLabel(destination), 'Google：高雄咖啡廳')
})

test('Google 結果缺少導航必要欄位時不建立目的地', () => {
  const validLocation = { lng: () => 120.3, lat: () => 22.6 }

  assert.equal(googleDestination({ id: '  ', location: validLocation }, '咖啡廳'), null)
  assert.equal(googleDestination({ id: 'place-1' }, '咖啡廳'), null)
  assert.equal(googleDestination({ id: 'place-1', location: validLocation }, '  '), null)
  assert.equal(googleDestination({
    id: 'place-1',
    location: { lng: () => Number.NaN, lat: () => 22.6 },
  }, '咖啡廳'), null)
  assert.equal(googleDestination({
    id: 'place-1',
    location: { lng: () => 120.3, lat: () => Number.POSITIVE_INFINITY },
  }, '咖啡廳'), null)
})
