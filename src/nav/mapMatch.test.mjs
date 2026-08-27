import test from 'node:test'
import assert from 'node:assert/strict'
import { ACCURACY_REJECT_M, matchToRoute, smoothBearing } from './mapMatch.ts'

const M_PER_DEG_LAT = 110540
const M_PER_DEG_LON = 111320 * Math.cos((22.73 * Math.PI) / 180)

/** 以楠梓緯度為原點，用公尺造測試座標（東 x、北 y） */
const at = (x, y) => [120.3 + x / M_PER_DEG_LON, 22.73 + y / M_PER_DEG_LAT]

/** 一條正北的直線，每 10m 一個點，共 500m */
function straightRoute(lengthM = 500, stepM = 10) {
  const coords = []
  for (let d = 0; d <= lengthM; d += stepM) coords.push(at(0, d))
  const cum = coords.map((_, i) => i * stepM)
  return { coords, cum }
}

const match = (route, here, extra = {}) => matchToRoute({
  coords: route.coords, cum: route.cum, here,
  accuracyM: 8, prev: null, elapsedS: 1, speedMps: 10, ...extra,
})

test('把定位貼回路線上，不再輸出原始座標', () => {
  const route = straightRoute()
  // 站在路線東側 12m（等同被 GPS 誤差推到對向車道）
  const r = match(route, at(12, 100))
  assert.ok(Math.abs(r.offRouteM - 12) < 0.5, `offRouteM=${r.offRouteM}`)
  assert.ok(Math.abs(r.distM - 100) < 0.5, `distM=${r.distM}`)
  // 貼合後的經度回到路線上（東向偏移被吃掉）
  assert.ok(Math.abs(r.pos[0] - route.coords[0][0]) < 1e-9)
  assert.equal(r.quality, 'good')
})

test('往前抖動不會永久推進里程——誤差不累積', () => {
  const route = straightRoute()
  // 車停在 100m 不動，GPS 每筆在 ±8m 之間抖
  let prev = match(route, at(0, 100))
  const jitter = [8, -8, 7, -6, 8, -7, 6, -8, 8, -5]
  for (const dy of jitter) {
    prev = matchToRoute({
      coords: route.coords, cum: route.cum, here: at(0, 100 + dy),
      accuracyM: 8, prev, elapsedS: 1, speedMps: 0,
    })
  }
  // 舊版的單調 max 會把里程推到 108 並永遠留在那；視窗版要跟著最後一筆回到 95
  assert.ok(Math.abs(prev.distM - 95) < 1, `distM=${prev.distM}`)
})

test('視窗把貼合鎖在目前位置附近，不會跳到路線的另一段', () => {
  // U 形路線：去程往北 200m，折返往南 200m，兩段只差 15m（模擬對向車道）
  const up = []
  for (let d = 0; d <= 200; d += 10) up.push(at(0, d))
  const down = []
  for (let d = 200; d >= 0; d -= 10) down.push(at(15, d))
  const coords = [...up, ...down]
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * M_PER_DEG_LON
    const dy = (coords[i][1] - coords[i - 1][1]) * M_PER_DEG_LAT
    cum.push(cum[i - 1] + Math.hypot(dx, dy))
  }
  const route = { coords, cum }

  // 人在去程 100m 處，但偏東 10m——離「回程」那半只剩 5m，全線最近點會選回程
  const prev = { distM: 100, pos: at(0, 100), bearing: 0, offRouteM: 2, quality: 'good' }
  const r = matchToRoute({
    coords, cum, here: at(10, 100), accuracyM: 10, prev, elapsedS: 1, speedMps: 10,
  })
  assert.ok(r.distM < 200, `貼到回程了：distM=${r.distM}`)
  assert.ok(Math.abs(r.bearing) < 1 || Math.abs(r.bearing - 360) < 1, `bearing=${r.bearing}`)
})

test('精度爛掉的定位整筆丟掉，沿用上一筆狀態', () => {
  const route = straightRoute()
  const prev = match(route, at(0, 100))
  const r = matchToRoute({
    coords: route.coords, cum: route.cum, here: at(300, 400),
    accuracyM: ACCURACY_REJECT_M + 1, prev, elapsedS: 1, speedMps: 10,
  })
  assert.equal(r.quality, 'lost')
  assert.equal(r.distM, prev.distM)
})

test('精度尚可但離路線偏遠時標成 weak，方位沿用上一筆', () => {
  const route = straightRoute()
  const prev = { distM: 100, pos: at(0, 100), bearing: 37, offRouteM: 3, quality: 'good' }
  const r = matchToRoute({
    coords: route.coords, cum: route.cum, here: at(50, 105),
    accuracyM: 60, prev, elapsedS: 1, speedMps: 10,
  })
  assert.equal(r.quality, 'weak')
  assert.equal(r.bearing, 37)
})

test('第一筆定位走全線搜尋（還沒有里程可當錨點）', () => {
  const route = straightRoute()
  const r = match(route, at(3, 420), { prev: null })
  assert.ok(Math.abs(r.distM - 420) < 1, `distM=${r.distM}`)
})

test('方位平滑跨 0/360 不會繞遠路', () => {
  assert.ok(Math.abs(smoothBearing(350, 10, 0.5) - 0) < 1e-6)
  assert.equal(smoothBearing(null, 123), 123)
})
