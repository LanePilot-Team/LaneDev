import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bikeStationLabel,
  buildPolylineIndex,
  compassToBearing,
  resolveBusStopPlacement,
  snapToPolylines,
  transitToGeoJson,
} from './transit.ts'
import { offsetMeters } from './geo.ts'

const ORIGIN = [120.30, 22.70]

/** 沿正北的直線道路（數位化方向＝由南往北） */
function northRoad(lengthM = 400, step = 50) {
  const cs = []
  for (let d = 0; d <= lengthM; d += step) cs.push(offsetMeters(ORIGIN, 0, d))
  return cs
}

const stop = (overrides = {}) => ({
  id: 'KHH-test',
  name: '測試站',
  pos: offsetMeters(ORIGIN, 8, 200), // 東側 8m
  bearingDeg: 0,
  routeIds: [],
  ...overrides,
})

test('八方位解析', () => {
  assert.equal(compassToBearing('N'), 0)
  assert.equal(compassToBearing('NE'), 45)
  assert.equal(compassToBearing('s'), 180)
  assert.equal(compassToBearing(' NW '), 315)
  assert.equal(compassToBearing('北'), undefined)
  assert.equal(compassToBearing(undefined), undefined)
})

test('點投影到折線：距離與命中', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  const hit = snapToPolylines(offsetMeters(ORIGIN, 8, 200), roads, index, 25)
  assert.ok(hit)
  assert.equal(hit.polylineIndex, 0)
  assert.ok(Math.abs(hit.distM - 8) < 1, `垂距應約 8m，實際 ${hit.distM}`)
  assert.ok(Math.abs(hit.segBearing) < 1 || Math.abs(hit.segBearing - 360) < 1)
})

test('超過 maxM 就不算命中', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  assert.equal(snapToPolylines(offsetMeters(ORIGIN, 60, 200), roads, index, 25), null)
})

test('多條折線取最近的那條', () => {
  const far = northRoad().map((c) => offsetMeters(c, 40, 0))
  const roads = [far, northRoad()]
  const index = buildPolylineIndex(roads)
  const hit = snapToPolylines(offsetMeters(ORIGIN, 8, 200), roads, index, 50)
  assert.equal(hit.polylineIndex, 1, '應命中較近的第二條')
})

test('站牌落點：行車方向與數位化方向相同時，東側＝右側', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  const p = resolveBusStopPlacement(stop(), roads, index, 25)
  assert.ok(p)
  assert.ok(Math.abs(p.travelBearing) < 1 || Math.abs(p.travelBearing - 360) < 1)
  assert.equal(p.side, 'right')
  assert.ok(Math.abs(p.offsetM - 8) < 1)
})

test('站牌落點：行車方向與數位化方向相反時，同一個站牌變成左側', () => {
  // 路的畫法沒變（由南往北），但這個站牌服務的是南向車道
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  const p = resolveBusStopPlacement(stop({ bearingDeg: 180 }), roads, index, 25)
  assert.ok(p)
  assert.ok(Math.abs(p.travelBearing - 180) < 1, '行車方向應翻成南向')
  assert.equal(p.side, 'left', '南向行駛時，位於東側的站牌在左手邊')
})

test('沒有 Bearing 就不判行向，也不判側別（不猜）', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  const p = resolveBusStopPlacement(stop({ bearingDeg: undefined }), roads, index, 25)
  assert.ok(p)
  assert.equal(p.travelBearing, undefined)
  assert.equal(p.side, 'unknown')
})

test('Bearing 與道路走向差太多（>45°）就不判行向', () => {
  const roads = [northRoad()] // 南北向
  const index = buildPolylineIndex(roads)
  const p = resolveBusStopPlacement(stop({ bearingDeg: 90 }), roads, index, 25) // 東向
  assert.equal(p.travelBearing, undefined)
  assert.equal(p.side, 'unknown')
})

test('站牌壓在路中心線上時側別判不出來', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  const p = resolveBusStopPlacement(
    stop({ pos: offsetMeters(ORIGIN, 0.5, 200) }), roads, index, 25,
  )
  assert.ok(p.travelBearing !== undefined, '行向仍判得出來')
  assert.equal(p.side, 'unknown', '但左右分不出來')
})

test('離路太遠的站牌沒有落點', () => {
  const roads = [northRoad()]
  const index = buildPolylineIndex(roads)
  assert.equal(resolveBusStopPlacement(
    stop({ pos: offsetMeters(ORIGIN, 200, 200) }), roads, index, 25,
  ), null)
})

test('YouBike 站名去掉系統別前綴', () => {
  assert.equal(bikeStationLabel('YouBike2.0_捷運左營站'), '捷運左營站')
  assert.equal(bikeStationLabel('YouBike1.0_中華藝校'), '中華藝校')
  assert.equal(bikeStationLabel('楠梓加工區'), '楠梓加工區')
})

test('圖層 GeoJSON 三種站點都帶 kind', () => {
  const fc = transitToGeoJson({
    version: 1, generatedAt: '', source: {}, scope: {},
    bikeStations: [{ id: 'b1', name: 'YouBike2.0_甲', pos: [120.3, 22.7], capacity: 20 }],
    busStops: [{ id: 's1', name: '乙', pos: [120.31, 22.71], routeIds: ['r1'] }],
    railStations: [{ id: 'r1', name: '丙', pos: [120.32, 22.72], system: 'KRTC', code: 'R16' }],
    busRoutes: [], railLines: [],
  })
  assert.deepEqual(fc.features.map((f) => f.properties.kind), ['bike', 'bus', 'rail'])
  assert.equal(fc.features[0].properties.name, '甲', '站名前綴要在圖層就處理掉')
  assert.equal(fc.features[2].properties.systemLabel, '高雄捷運')
})
