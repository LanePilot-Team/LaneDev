// Phase 0 探路：用真的憑證打 TDX，量出「照計畫做下去會遇到什麼」。
//
// 這支不產生任何進版控的資料，只回答四個問題（見 docs/tdx-transit-plan.md §5）：
//   1. 哪些端點路徑是對的（TDX 各服務的路徑慣例不一致，Bus 有 /City/、Bike 沒有）
//   2. 楠梓＋左營範圍內各類資料各有幾筆、多大
//   3. 「有站牌落在兩區」的公車路線到底幾條——這個數字決定 Phase 1 的資料檔規模
//   4. 站牌座標品質：離最近道路多遠、左右側判不判得出來
//      （第 4 項是 Phase 3「公車停靠影響車道」成不成立的前提）
//
// 用法：node scripts/tdx_probe.mjs [--refetch]
//   抓下來的原始回應會快取在 scripts/.tdx-probe/，預設重跑不會重抓。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tdxGet, tdxGetAll } from './tdx_client.mjs'
import { bearing, haversine, angleDelta } from '../src/core/geo.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// 與 build_transit.mjs 共用同一份原始回應快取——TDX 限流嚴格，
// 兩支腳本各抓一次兩萬筆站牌沒有意義
const CACHE_DIR = resolve(HERE, '.tdx-cache')
const REFETCH = process.argv.includes('--refetch')
const CITY = 'Kaohsiung'
/** 站牌離道路超過這麼遠就當作座標不可用（Phase 3 的車道側別判斷會歪掉） */
const SNAP_LIMIT_M = 25

mkdirSync(CACHE_DIR, { recursive: true })

// ── 底圖範圍：用實際路網算，不寫死常數 ──
const db = JSON.parse(readFileSync(resolve(HERE, '../public/data/road_database.json'), 'utf8'))
const segments = db.segments
  .map((s) => s.geometry?.coordinates)
  .filter((cs) => Array.isArray(cs) && cs.length >= 2)
const bbox = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
for (const cs of segments) for (const [lng, lat] of cs) {
  bbox.minLng = Math.min(bbox.minLng, lng); bbox.maxLng = Math.max(bbox.maxLng, lng)
  bbox.minLat = Math.min(bbox.minLat, lat); bbox.maxLat = Math.max(bbox.maxLat, lat)
}
const inBbox = ([lng, lat]) => lng >= bbox.minLng && lng <= bbox.maxLng
  && lat >= bbox.minLat && lat <= bbox.maxLat

console.log('=== TDX Phase 0 探路 ===')
console.log(`底圖範圍：${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)}`
  + ` – ${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}（${segments.length} 段）\n`)

// ── 1. 端點探測：各服務的路徑慣例不一致，逐一試出來 ──
const CANDIDATES = {
  bikeStation: [`/Bike/Station/City/${CITY}`, `/Bike/Station/${CITY}`],
  bikeAvailability: [`/Bike/Availability/City/${CITY}`, `/Bike/Availability/${CITY}`],
  cyclingShape: [`/Cycling/Shape/${CITY}`, `/Cycling/Shape/City/${CITY}`],
  busStop: [`/Bus/Stop/City/${CITY}`],
  busRoute: [`/Bus/Route/City/${CITY}`],
  busStopOfRoute: [`/Bus/StopOfRoute/City/${CITY}`],
  busShape: [`/Bus/Shape/City/${CITY}`],
  metroStationKRTC: ['/Rail/Metro/Station/KRTC'],
  metroStationKLRT: ['/Rail/Metro/Station/KLRT'],
  metroShapeKRTC: ['/Rail/Metro/Shape/KRTC'],
  metroShapeKLRT: ['/Rail/Metro/Shape/KLRT'],
  traStation: ['/Rail/TRA/Station'],
  thsrStation: ['/Rail/THSR/Station'],
}

const resolved = {}
console.log('── 端點探測（$top=1）──')
for (const [name, paths] of Object.entries(CANDIDATES)) {
  let hit = null
  for (const path of paths) {
    const res = await tdxGet(path, { $top: 1 })
    if (res.ok) { hit = path; break }
    console.log(`   ✗ ${path} → HTTP ${res.status}${res.detail ? ` ${res.detail.slice(0, 80)}` : ''}`)
  }
  resolved[name] = hit
  console.log(`${hit ? '✅' : '❌'} ${name.padEnd(20)} ${hit ?? '（全部候選都失敗）'}`)
}

// ── 2. 取資料（翻頁取完整；帶快取，避免反覆消耗額度）──
async function grab(name) {
  const path = resolved[name]
  if (!path) return null
  const file = join(CACHE_DIR, `${name}.json`)
  if (!REFETCH && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const res = await tdxGetAll(path)
  if (!res.ok) {
    console.log(`   ⚠ ${name} 取回失敗：HTTP ${res.status} ${(res.detail ?? '').slice(0, 120)}`)
    return null
  }
  if (!res.complete) console.log(`   ⚠ ${name} 超過翻頁上限，資料可能不完整`)
  writeFileSync(file, JSON.stringify(res.rows), 'utf8')
  return res.rows
}

/** TDX 各資料表的座標欄位名稱不同，統一往下找 PositionLat/PositionLon */
function positionOf(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.PositionLat === 'number' && typeof obj.PositionLon === 'number') {
    return [obj.PositionLon, obj.PositionLat]
  }
  for (const v of Object.values(obj)) {
    const found = positionOf(v)
    if (found) return found
  }
  return null
}

const zh = (n) => (typeof n === 'string' ? n : n?.Zh_tw ?? n?.Zh_TW ?? '')

console.log('\n── 資料量（全市 → 楠梓＋左營範圍內）──')
const sizeKb = (v) => `${(Buffer.byteLength(JSON.stringify(v)) / 1024).toFixed(0)} KB`
const collected = {}
for (const name of ['bikeStation', 'busStop', 'metroStationKRTC', 'metroStationKLRT',
  'traStation', 'thsrStation']) {
  const data = await grab(name)
  if (!Array.isArray(data)) continue
  const inArea = data.filter((r) => {
    const p = positionOf(r)
    return p && inBbox(p)
  })
  collected[name] = inArea
  console.log(`${name.padEnd(20)} 全市 ${String(data.length).padStart(5)} → 範圍內`
    + ` ${String(inArea.length).padStart(4)}　（範圍內 ${sizeKb(inArea)}）`)
}

// ── 3. 公車：有幾條路線經過兩區？這是資料檔規模的關鍵未知數 ──
console.log('\n── 公車路線規模 ──')
const busStopsInArea = collected.busStop ?? []
const stopUidsInArea = new Set(busStopsInArea.map((s) => s.StopUID).filter(Boolean))
const stopOfRoute = await grab('busStopOfRoute')
if (Array.isArray(stopOfRoute)) {
  const touching = stopOfRoute.filter((r) =>
    (r.Stops ?? []).some((s) => stopUidsInArea.has(s.StopUID)))
  const routeUids = new Set(touching.map((r) => r.RouteUID))
  console.log(`全市路線方向數 ${stopOfRoute.length}（${sizeKb(stopOfRoute)}）`)
  console.log(`經過楠梓／左營的：${touching.length} 個方向 / ${routeUids.size} 條路線`
    + `（只留這些 ${sizeKb(touching)}）`)
  const names = [...new Set(touching.map((r) => zh(r.RouteName)))].sort()
  console.log(`路線：${names.slice(0, 40).join('、')}${names.length > 40 ? ` …共 ${names.length} 條` : ''}`)

  const shape = await grab('busShape')
  if (Array.isArray(shape)) {
    const kept = shape.filter((s) => routeUids.has(s.RouteUID))
    console.log(`路線線型：全市 ${shape.length}（${sizeKb(shape)}）→ 只留這些 ${kept.length}`
      + `（${sizeKb(kept)}）`)
  }
}

// ── 4. 站牌座標品質：Phase 3「公車停靠影響車道」成不成立的前提 ──
console.log('\n── 站牌座標品質（Phase 3 前提）──')
const segBoxes = segments.map((cs) => {
  const b = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
  for (const [lng, lat] of cs) {
    b.minLng = Math.min(b.minLng, lng); b.maxLng = Math.max(b.maxLng, lng)
    b.minLat = Math.min(b.minLat, lat); b.maxLat = Math.max(b.maxLat, lat)
  }
  return b
})
const PAD = 0.0012 // 約 120m

/** 站牌投影到最近路段：回傳垂距與「在路的哪一側」（右正／左負，用路段走向的法向量判） */
function snap(pos) {
  let best = null
  for (let si = 0; si < segments.length; si++) {
    const b = segBoxes[si]
    if (pos[0] < b.minLng - PAD || pos[0] > b.maxLng + PAD
      || pos[1] < b.minLat - PAD || pos[1] > b.maxLat + PAD) continue
    const cs = segments[si]
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], c = cs[i]
      const kx = Math.cos((a[1] * Math.PI) / 180)
      const vx = (c[0] - a[0]) * kx, vy = c[1] - a[1]
      const px = (pos[0] - a[0]) * kx, py = pos[1] - a[1]
      const len2 = vx * vx + vy * vy
      if (len2 === 0) continue
      const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2))
      const q = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]
      const d = haversine(q, pos)
      if (!best || d < best.distM) {
        best = { distM: d, segBearing: bearing(a, c), toStop: bearing(q, pos) }
      }
    }
  }
  if (!best) return null
  // 站牌相對行進方向的方位差：+90 附近＝右側、−90 附近＝左側
  const side = angleDelta(best.segBearing, best.toStop)
  return { ...best, side }
}

for (const [label, rows] of [['公車站牌', busStopsInArea], ['YouBike 站', collected.bikeStation ?? []]]) {
  if (!rows.length) continue
  let far = 0, right = 0, left = 0, unclear = 0
  const distances = []
  for (const r of rows) {
    const p = positionOf(r)
    const s = p && snap(p)
    if (!s) { far++; continue }
    distances.push(s.distM)
    if (s.distM > SNAP_LIMIT_M) { far++; continue }
    const a = Math.abs(s.side)
    // 站牌貼在路邊時偏移方向明確；落在路中央（距離接近 0）則判不出來
    if (s.distM < 2) unclear++
    else if (a > 45 && a < 135) (s.side > 0 ? right++ : left++)
    else unclear++
  }
  distances.sort((a, b) => a - b)
  const median = distances.length ? distances[Math.floor(distances.length / 2)] : NaN
  console.log(`${label}（${rows.length} 筆）：`
    + `中位垂距 ${median.toFixed(1)}m｜>${SNAP_LIMIT_M}m 或找不到路 ${far} 筆`
    + `｜右側 ${right}／左側 ${left}／判不出來 ${unclear}`)
}

console.log(`\n原始回應快取在 ${CACHE_DIR}（--refetch 可強制重抓）`)
