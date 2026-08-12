// 產生 public/data/transit.json（＋公車路線線型獨立檔）：
// 從 TDX 抓高雄市的公車／公共自行車／捷運輕軌／臺鐵高鐵資料，
// 篩出「離本專案路網夠近」的部分，正規化後寫成 App 直接讀的版本化資料檔。
//
// 三個設計決定（理由見 docs/tdx-transit-plan.md §10.5）：
//   1. **範圍用路網距離定義，不用 bbox 矩形**。bbox 會掃進三民、鼓山等鄰區；
//      而且「離我們的路網太遠」本來就等於「這筆資料對我們沒用」。
//   2. **推導值不落地**。站牌 snap 到哪一段、在哪一側，全部 runtime 現算，
//      這裡只存 TDX 給的來源欄位。底圖前處理會變，快照下來的推導值會脫節。
//   3. **公車路線線型另存一檔**。122 條線同時畫會糊成一團，疊加圖層預設不載入。
//
// 用法：
//   node scripts/build_transit.mjs            # 用快取（沒有才連線抓）
//   node scripts/build_transit.mjs --refetch  # 強制重抓
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tdxGetAll, TDX_BASE } from './tdx_client.mjs'
import {
  buildPolylineIndex, compassToBearing, snapToPolylines,
} from '../src/core/transit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, '.tdx-cache')
const OUT = resolve(HERE, '../public/data/transit.json')
const OUT_SHAPES = resolve(HERE, '../public/data/transit_bus_shapes.json')
const REFETCH = process.argv.includes('--refetch')

const CITY = 'Kaohsiung'
const DISTRICTS = ['楠梓區', '左營區']
/**
 * 收錄範圍＝**離本專案路網多近**，不是行政區界（我們沒有區界多邊形，
 * 而路網本來就是楠梓＋左營的 shard）。門檻依「這筆資料是拿來做什麼的」分兩種：
 *
 * - 公車站牌 25m：它的用途就是要貼到某一段路的某一側（Phase 3），
 *   snap 不上的站牌對我們沒有意義。
 * - 其他站點 100m：YouBike 站常設在人行道退縮處或公園內，
 *   軌道車站的參考點更是落在站體中央——實測捷運左營站離最近道路 61m、
 *   高鐵左營站 74m，用 25m 會把整個左營轉運核心刷掉。
 *   100m 同時仍排得掉鄰區的臺鐵內惟（236m）與捷運青埔（308m）。
 *
 * 副作用（刻意接受）：區界外緣、但我們路網摸得到的站點會被收進來。
 * 使用者開到區界時本來就看得到它們，硬切反而奇怪。
 */
const BUS_STOP_PROXIMITY_M = 25
const PLACE_PROXIMITY_M = 100

const SOURCE = {
  platform: '交通部 TDX 運輸資料流通服務平臺',
  agency: '交通部',
  license: '政府資料開放授權條款第 1 版',
  licenseUrl: 'https://data.gov.tw/license',
  baseUrl: TDX_BASE,
}

const ENDPOINTS = {
  bikeStation: `/Bike/Station/City/${CITY}`,
  busStop: `/Bus/Stop/City/${CITY}`,
  busStopOfRoute: `/Bus/StopOfRoute/City/${CITY}`,
  busShape: `/Bus/Shape/City/${CITY}`,
  metroStationKRTC: '/Rail/Metro/Station/KRTC',
  metroStationKLRT: '/Rail/Metro/Station/KLRT',
  metroShapeKRTC: '/Rail/Metro/Shape/KRTC',
  metroShapeKLRT: '/Rail/Metro/Shape/KLRT',
  traStation: '/Rail/TRA/Station',
  thsrStation: '/Rail/THSR/Station',
}

mkdirSync(CACHE_DIR, { recursive: true })

// ── 路網（範圍判定的依據）──
const db = JSON.parse(readFileSync(resolve(HERE, '../public/data/road_database.json'), 'utf8'))
const roads = db.segments
  .map((s) => s.geometry?.coordinates)
  .filter((cs) => Array.isArray(cs) && cs.length >= 2)
const roadIndex = buildPolylineIndex(roads)
const nearRoads = (pos, maxM) => !!snapToPolylines(pos, roads, roadIndex, maxM)

/** 路網的實際範圍框（線型裁切用），四周留 300m 餘裕免得邊界上的線被切得零碎 */
const areaBbox = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
for (const cs of roads) for (const [lng, lat] of cs) {
  areaBbox.minLng = Math.min(areaBbox.minLng, lng); areaBbox.maxLng = Math.max(areaBbox.maxLng, lng)
  areaBbox.minLat = Math.min(areaBbox.minLat, lat); areaBbox.maxLat = Math.max(areaBbox.maxLat, lat)
}
{
  const padLng = 300 / (111320 * Math.cos((areaBbox.minLat * Math.PI) / 180))
  const padLat = 300 / 110540
  areaBbox.minLng -= padLng; areaBbox.maxLng += padLng
  areaBbox.minLat -= padLat; areaBbox.maxLat += padLat
}

console.log(`路網 ${roads.length} 段；收錄條件 = 公車站牌離路網 ${BUS_STOP_PROXIMITY_M}m 內、`
  + `其他站點 ${PLACE_PROXIMITY_M}m 內\n`)

// ── 取資料（帶快取；TDX 限流嚴格，不要為了重跑一次腳本就重抓兩萬筆）──
let fetchedAt = null
async function grab(name) {
  const file = join(CACHE_DIR, `${name}.json`)
  if (!REFETCH && existsSync(file)) {
    fetchedAt ??= new Date(statSync(file).mtime).toISOString()
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  process.stdout.write(`  抓取 ${name}…`)
  const res = await tdxGetAll(ENDPOINTS[name])
  if (!res.ok) throw new Error(`${name} 取回失敗：HTTP ${res.status} ${res.detail ?? ''}`)
  if (!res.complete) throw new Error(`${name} 超過翻頁上限，資料不完整——不要拿半套資料建檔`)
  writeFileSync(file, JSON.stringify(res.rows), 'utf8')
  fetchedAt = new Date().toISOString()
  console.log(` ${res.rows.length} 筆`)
  return res.rows
}

const zh = (v) => (typeof v === 'string' ? v : v?.Zh_tw ?? v?.Zh_TW ?? '')
const posOf = (p) => (p && typeof p.PositionLon === 'number' && typeof p.PositionLat === 'number'
  ? [p.PositionLon, p.PositionLat] : null)

console.log('── 取得原始資料 ──')
const raw = {}
for (const name of Object.keys(ENDPOINTS)) raw[name] = await grab(name)

// ── 公共自行車 ──
const bikeStations = []
for (const s of raw.bikeStation) {
  const pos = posOf(s.StationPosition)
  if (!pos || !nearRoads(pos, PLACE_PROXIMITY_M)) continue
  bikeStations.push({
    id: s.StationUID,
    name: zh(s.StationName),
    pos,
    ...(Number.isFinite(s.BikesCapacity) ? { capacity: s.BikesCapacity } : {}),
    ...(s.ServiceType ? { serviceType: String(s.ServiceType) } : {}),
    ...(zh(s.StationAddress) ? { address: zh(s.StationAddress) } : {}),
  })
}

// ── 公車站牌（先篩範圍，路線再依這批站牌決定要不要留）──
const busStopById = new Map()
let noBearing = 0
for (const s of raw.busStop) {
  const pos = posOf(s.StopPosition)
  if (!pos || !nearRoads(pos, BUS_STOP_PROXIMITY_M)) continue
  const bearingDeg = compassToBearing(s.Bearing)
  if (bearingDeg === undefined) noBearing++
  busStopById.set(s.StopUID, {
    id: s.StopUID,
    name: zh(s.StopName),
    pos,
    ...(bearingDeg === undefined ? {} : { bearingDeg }),
    routeIds: [],
  })
}

// ── 公車路線：只留「有停靠範圍內站牌」的方向 ──
const busRoutes = []
for (const r of raw.busStopOfRoute) {
  const stops = (r.Stops ?? []).filter((s) => busStopById.has(s.StopUID))
  if (!stops.length) continue
  const ordered = [...stops].sort((a, b) => (a.StopSequence ?? 0) - (b.StopSequence ?? 0))
  const id = `${r.RouteUID}:${r.Direction ?? 0}`
  busRoutes.push({
    id,
    name: zh(r.RouteName),
    direction: r.Direction ?? 0,
    // 只留範圍內的站序。整條路線的站序沒有意義——我們的底圖只到兩區邊界，
    // 存了也對不上任何一段路，只是把檔案撐大。
    stopIds: ordered.map((s) => s.StopUID),
    ...(r.DepartureStopNameZh && r.DestinationStopNameZh
      ? { headsign: `${r.DepartureStopNameZh} → ${r.DestinationStopNameZh}` } : {}),
  })
  for (const s of ordered) busStopById.get(s.StopUID).routeIds.push(id)
}
const keptRouteUids = new Set(busRoutes.map((r) => r.id.split(':')[0]))

// 沒有任何路線停靠的站牌通常是廢站或跨區殘留，留著只會在圖上長出點不出東西的點
const busStops = [...busStopById.values()].filter((s) => s.routeIds.length > 0)
const droppedStops = busStopById.size - busStops.length

// ── 軌道 ──
const railStations = []
for (const [name, system] of [
  ['metroStationKRTC', 'KRTC'], ['metroStationKLRT', 'KLRT'],
  ['traStation', 'TRA'], ['thsrStation', 'THSR'],
]) {
  for (const s of raw[name]) {
    const pos = posOf(s.StationPosition)
    if (!pos || !nearRoads(pos, PLACE_PROXIMITY_M)) continue
    railStations.push({
      id: s.StationUID ?? s.StationID,
      name: zh(s.StationName),
      pos,
      system,
      ...(s.StationID ? { code: String(s.StationID) } : {}),
    })
  }
}

/** TDX 線型是 WKT 字串（LINESTRING / MULTILINESTRING） */
function parseWkt(wkt) {
  if (typeof wkt !== 'string') return []
  const lines = []
  const body = wkt.trim()
  const chunks = body.startsWith('MULTILINESTRING')
    ? [...body.matchAll(/\(([^()]+)\)/g)].map((m) => m[1])
    : [body.replace(/^LINESTRING\s*\(/i, '').replace(/\)\s*$/, '')]
  for (const chunk of chunks) {
    const coords = chunk.split(',').map((pair) => {
      const [lng, lat] = pair.trim().split(/\s+/).map(Number)
      return [lng, lat]
    }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    if (coords.length >= 2) lines.push(coords)
  }
  return lines
}

/**
 * 線型裁切到範圍內。
 *
 * **用範圍框、不用「離道路多遠」**——這點踩過坑：原本逐點檢查離路網距離，
 * 結果捷運紅線穿過半屏山那一段（世運↔左營之間）整整 1.1 km 被丟掉，
 * 因為山裡本來就沒有路。軌道有自己的路廊、會走隧道與專用高架，
 * 拿道路當存在條件是錯的判準。公車雖然跟著路走，但也可能經過我們沒收錄的橋段，
 * 同樣不該用道路距離裁切。
 *
 * 跨出範圍框才切斷（那是真的「出了我們的地圖」），不會在框內憑空斷開。
 */
function clipToBbox(coords) {
  const inside = (c) => c[0] >= areaBbox.minLng && c[0] <= areaBbox.maxLng
    && c[1] >= areaBbox.minLat && c[1] <= areaBbox.maxLat
  const out = []
  let run = []
  for (const c of coords) {
    if (inside(c)) run.push(c)
    else { if (run.length >= 2) out.push(run); run = [] }
  }
  if (run.length >= 2) out.push(run)
  return out
}

const railLines = []
for (const [name, system] of [['metroShapeKRTC', 'KRTC'], ['metroShapeKLRT', 'KLRT']]) {
  for (const s of raw[name]) {
    const lineName = zh(s.LineName) || zh(s.RouteName) || system
    parseWkt(s.Geometry).flatMap(clipToBbox).forEach((coords, i) => {
      railLines.push({
        id: `${system}:${s.LineNo ?? s.LineID ?? lineName}:${i}`,
        name: lineName, system, coords,
      })
    })
  }
}

// ── 公車路線線型（獨立檔）──
const busShapes = []
for (const s of raw.busShape) {
  if (!keptRouteUids.has(s.RouteUID)) continue
  parseWkt(s.Geometry).flatMap(clipToBbox).forEach((coords, i) => {
    busShapes.push({
      id: `${s.RouteUID}:${s.Direction ?? 0}:${i}`,
      name: zh(s.RouteName),
      direction: s.Direction ?? 0,
      coords,
    })
  })
}

// ── 寫檔 ──
const generatedAt = new Date().toISOString()
const dataset = {
  version: 1,
  generatedAt,
  source: { ...SOURCE, fetchedAt: fetchedAt ?? generatedAt },
  scope: {
    city: CITY, districts: DISTRICTS,
    busStopProximityM: BUS_STOP_PROXIMITY_M, placeProximityM: PLACE_PROXIMITY_M,
  },
  bikeStations,
  busStops,
  busRoutes,
  railStations,
  railLines,
}
writeFileSync(OUT, JSON.stringify(dataset), 'utf8')
writeFileSync(OUT_SHAPES, JSON.stringify({
  version: 1, generatedAt, routes: busShapes,
}), 'utf8')

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`
console.log('\n── 產出 ──')
console.log(`公共自行車站  ${String(bikeStations.length).padStart(5)}（全市 ${raw.bikeStation.length}）`)
console.log(`公車站牌      ${String(busStops.length).padStart(5)}（全市 ${raw.busStop.length}`
  + `；無路線停靠而剔除 ${droppedStops}；無 Bearing ${noBearing}）`)
console.log(`公車路線方向  ${String(busRoutes.length).padStart(5)}（全市 ${raw.busStopOfRoute.length}）`)
console.log(`軌道車站      ${String(railStations.length).padStart(5)}`)
for (const system of ['KRTC', 'KLRT', 'TRA', 'THSR']) {
  const rows = railStations.filter((s) => s.system === system)
  if (rows.length) console.log(`  ${system.padEnd(5)} ${rows.length}：${rows.map((s) => s.name).join('、')}`)
}
console.log(`軌道線型段    ${String(railLines.length).padStart(5)}`)
console.log(`公車線型段    ${String(busShapes.length).padStart(5)}`)
console.log(`\n${OUT}  ${kb(OUT)}`)
console.log(`${OUT_SHAPES}  ${kb(OUT_SHAPES)}`)
console.log('\n下一步：npm run audit:transit')
