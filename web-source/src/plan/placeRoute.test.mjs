import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlaceRouteStops, withCurrentStart,
  firstUnsetStopId,
} from './placeRoute.ts'

const destination = {
  id: 'osm:node:1',
  label: '高雄大學',
  position: [120.2847, 22.7339],
  provider: 'local',
}

const snappedDestination = [120.2846, 22.7338]

test('手動選起點時只預先建立目的地', () => {
  const stops = createPlaceRouteStops(destination, snappedDestination)

  assert.deepEqual(stops, [
    { id: 1, pos: null },
    {
      id: 2,
      pos: snappedDestination,
      label: '高雄大學',
      placeId: 'osm:node:1',
      placePosition: destination.position,
      placeProvider: 'local',
    },
  ])
  assert.equal(firstUnsetStopId(stops), 1)
})

test('目前位置吸附成功時會建立具名起點且無待選停靠點', () => {
  const snappedStart = {
    label: '我的位置',
    position: [120.2758, 22.7327],
  }

  const stops = createPlaceRouteStops(destination, snappedDestination, snappedStart)

  assert.deepEqual(stops[0], {
    id: 1,
    pos: snappedStart.position,
    label: '我的位置',
  })
  assert.equal(firstUnsetStopId(stops), null)
})

test('目前位置吸附失敗時保留目的地並回到手動選起點', () => {
  const stops = createPlaceRouteStops(destination, snappedDestination, null)

  assert.deepEqual(stops[0], { id: 1, pos: null })
  assert.equal(stops[1].placeId, destination.id)
  assert.equal(firstUnsetStopId(stops), 1)
})

test('目前位置可用但目的地吸附失敗時改為等待設定目的地', () => {
  const stops = createPlaceRouteStops(destination, null, {
    label: '我的位置',
    position: [120.2758, 22.7327],
  })

  assert.equal(firstUnsetStopId(stops), 2)
})

test('地點完整地址隨路線端點保存，不以類型取代', () => {
  const address = '高雄市楠梓區高雄大學路700號'
  const stops = createPlaceRouteStops({ ...destination, address }, snappedDestination)
  assert.equal(stops[1].address, address)
  assert.equal(stops[1].placeId, destination.id)
})

test('搜尋起點改回目前位置，清掉舊地址但保留終點與停靠點', () => {
  const stops = [
    { id: 1, pos: [120, 22], label: '舊起點', address: '舊地址', placeId: 'old', placePosition: [120, 22] },
    { id: 3, pos: [120.1, 22.1], label: '停靠點' },
    { id: 2, pos: [120.2, 22.2], label: '終點' },
  ]
  const changed = withCurrentStart(stops, [120.3, 22.3])
  assert.deepEqual(changed[0], { id: 1, pos: [120.3, 22.3], label: '我的位置' })
  assert.equal(changed[1], stops[1])
  assert.equal(changed[2], stops[2])
  assert.equal(stops[0].label, '舊起點')
})
