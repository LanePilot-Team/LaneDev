// 大眾運輸（TDX）資料的型別與推導邏輯——純函式，不碰 DOM/地圖，
// build script、離線稽核與 App 三邊共用同一套幾何判斷。
//
// 一個貫穿整份檔案的原則：**推導值不進資料檔**。
// 站牌 snap 到哪一段路、在路的哪一側、對應哪個行向，全部在 runtime 現算——
// 因為底圖前處理（couplet 合併、退化清理）會改變路段身分，快照下來的推導值
// 過幾次重建就會跟底圖脫節（同 core/motoBoxLimits 那次「面板推導值不可快照」的教訓）。
// 資料檔只存 TDX 給的來源欄位。
import { angleDelta, bearing, COS_LAT, haversine } from './geo.ts'

// ── 資料檔型別（scripts/build_transit.mjs 產生）──

export interface TransitSource {
  platform: string
  agency: string
  license: string
  licenseUrl: string
  baseUrl: string
  fetchedAt: string
}

export interface BikeStation {
  id: string
  name: string
  pos: [number, number]
  /** 車柱數。無樁系統（Moovo）沒有這個值 */
  capacity?: number
  /** YouBike2.0 / Moovo 之類的系統別（TDX ServiceType） */
  serviceType?: string
  address?: string
}

export interface BusStop {
  id: string
  name: string
  pos: [number, number]
  /**
   * 站牌服務的行車方向（度，0=北），由 TDX 的八方位 Bearing 欄位轉來。
   * 這是與幾何獨立的第二個訊號——用來決定站牌屬於哪個行向，
   * 而不是只知道它在某條路旁邊。解不出來就沒有這個欄位。
   */
  bearingDeg?: number
  /** 停靠此站的路線（BusRoute.id） */
  routeIds: string[]
}

export interface BusRoute {
  id: string
  name: string
  /** 0=去程、1=返程（TDX Direction） */
  direction: number
  /** 站序（BusStop.id），依 StopSequence 排序 */
  stopIds: string[]
  /** 「A → B」的路線頭尾，給圖層 popup 用 */
  headsign?: string
}

export type RailSystem = 'KRTC' | 'KLRT' | 'TRA' | 'THSR'

export interface RailStation {
  id: string
  name: string
  pos: [number, number]
  system: RailSystem
  /** 車站代碼（例如捷運的 R16） */
  code?: string
}

export interface RailLine {
  id: string
  name: string
  system: RailSystem
  coords: [number, number][]
}

export interface TransitDataset {
  version: number
  generatedAt: string
  source: TransitSource
  scope: {
    city: string
    districts: string[]
    /** 公車站牌的收錄門檻（公尺）：必須貼得上路才有用 */
    busStopProximityM: number
    /** 其他站點的收錄門檻（公尺）：車站與 YouBike 站常設在站體內／人行道退縮處 */
    placeProximityM: number
  }
  bikeStations: BikeStation[]
  busStops: BusStop[]
  busRoutes: BusRoute[]
  railStations: RailStation[]
  railLines: RailLine[]
}

/** 公車路線線型另存一檔：疊加圖層預設不畫（122 條線會糊成一團），需要時才載入 */
export interface BusShapeFile {
  version: number
  generatedAt: string
  routes: { id: string; name: string; direction: number; coords: [number, number][] }[]
}

export const RAIL_SYSTEM_LABEL: Record<RailSystem, string> = {
  KRTC: '高雄捷運', KLRT: '高雄輕軌', TRA: '臺鐵', THSR: '高鐵',
}

// ── 八方位 ──

const COMPASS: Record<string, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
}

/**
 * TDX 的 Bearing 欄位（'N'/'NE'/…）轉方位角。認不出來回 undefined——
 * 跟測速照相的方向文字一樣：寧可不判斷，也不要猜錯方向。
 */
export function compassToBearing(text: string | undefined | null): number | undefined {
  if (!text) return undefined
  return COMPASS[text.trim().toUpperCase()]
}

// ── 點對折線的投影（build script 用原始 segment、App 用 RoadFeature，共用這一套）──

export interface PolylineIndex {
  /** 每條折線的 bbox，用來粗篩；折線很多、站點也不少，沒有這層會慢到不能用 */
  boxes: { minLng: number; minLat: number; maxLng: number; maxLat: number }[]
}

export function buildPolylineIndex(polylines: [number, number][][]): PolylineIndex {
  return {
    boxes: polylines.map((cs) => {
      const box = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
      for (const [lng, lat] of cs) {
        box.minLng = Math.min(box.minLng, lng); box.maxLng = Math.max(box.maxLng, lng)
        box.minLat = Math.min(box.minLat, lat); box.maxLat = Math.max(box.maxLat, lat)
      }
      return box
    }),
  }
}

export interface SnapResult {
  /** 命中的折線在輸入陣列中的索引 */
  polylineIndex: number
  /** 投影點到原點的距離（公尺） */
  distM: number
  /** 投影點座標 */
  at: [number, number]
  /** 該線段的方位角（折線的數位化方向，不一定是行車方向） */
  segBearing: number
}

/** 一度經度換算成公尺時的緯度修正——本區域尺度用固定值就夠（同 core/geo 的做法） */
const M_PER_DEG_LNG = 111320 * COS_LAT
const M_PER_DEG_LAT = 110540

/** 把點投影到最近的折線。maxM 之外回 null。 */
export function snapToPolylines(
  pos: [number, number],
  polylines: [number, number][][],
  index: PolylineIndex,
  maxM: number,
): SnapResult | null {
  const padLng = maxM / M_PER_DEG_LNG
  const padLat = maxM / M_PER_DEG_LAT
  let best: SnapResult | null = null
  for (let p = 0; p < polylines.length; p++) {
    const box = index.boxes[p]
    if (pos[0] < box.minLng - padLng || pos[0] > box.maxLng + padLng
      || pos[1] < box.minLat - padLat || pos[1] > box.maxLat + padLat) continue
    const cs = polylines[p]
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], b = cs[i]
      const vx = (b[0] - a[0]) * M_PER_DEG_LNG, vy = (b[1] - a[1]) * M_PER_DEG_LAT
      const px = (pos[0] - a[0]) * M_PER_DEG_LNG, py = (pos[1] - a[1]) * M_PER_DEG_LAT
      const len2 = vx * vx + vy * vy
      if (len2 === 0) continue
      const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2))
      const at: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const distM = haversine(at, pos)
      if (best && distM >= best.distM) continue
      best = { polylineIndex: p, distM, at, segBearing: bearing(a, b) }
    }
  }
  return best && best.distM <= maxM ? best : null
}

// ── 公車站牌落點推導（§3-A「公車停靠影響車道」的地基）──

/** 站牌貼路太近時左右分不出來（投影點幾乎就是站牌位置，法向量沒有意義） */
const SIDE_MIN_OFFSET_M = 2
/** TDX 八方位與路段走向差超過這個角度＝對不上，不判定行向 */
const BEARING_TOLERANCE_DEG = 45

export interface BusStopPlacement {
  stop: BusStop
  snap: SnapResult
  /**
   * 站牌服務的行車方向。由 TDX Bearing 與路段走向比對而來——
   * 路段的數位化方向不等於行車方向，所以一定要有第二個訊號才能定。
   * 對不上就是 undefined。
   */
  travelBearing?: number
  /** 站牌在行車方向的哪一側。台灣靠右行駛，正常應該是 right。 */
  side: 'right' | 'left' | 'unknown'
  /** 站牌到路中心線的垂距 */
  offsetM: number
}

/**
 * 判斷站牌屬於哪個行向、在那個行向的哪一側。
 *
 * 為什麼不能只看幾何：路段的數位化方向是隨機的（OSM way 的畫法），
 * 「在線段右邊」對雙向道路沒有意義。TDX 的 Bearing 欄位補上了行車方向，
 * 兩個訊號合起來才能講出「北向車道的右側有一個站牌」這種對導航有用的話。
 */
export function resolveBusStopPlacement(
  stop: BusStop,
  polylines: [number, number][][],
  index: PolylineIndex,
  maxM: number,
): BusStopPlacement | null {
  const snap = snapToPolylines(stop.pos, polylines, index, maxM)
  if (!snap) return null
  const offsetM = snap.distM

  let travelBearing: number | undefined
  if (stop.bearingDeg !== undefined) {
    const forward = Math.abs(angleDelta(snap.segBearing, stop.bearingDeg))
    const backward = Math.abs(angleDelta(snap.segBearing + 180, stop.bearingDeg))
    if (forward <= BEARING_TOLERANCE_DEG && forward <= backward) travelBearing = snap.segBearing
    else if (backward <= BEARING_TOLERANCE_DEG) travelBearing = (snap.segBearing + 180) % 360
  }

  let side: BusStopPlacement['side'] = 'unknown'
  if (travelBearing !== undefined && offsetM >= SIDE_MIN_OFFSET_M) {
    // 從路上的投影點看向站牌：與行車方向夾角為正＝右側
    const toStop = bearing(snap.at, stop.pos)
    const rel = angleDelta(travelBearing, toStop)
    if (Math.abs(rel) > 45 && Math.abs(rel) < 135) side = rel > 0 ? 'right' : 'left'
  }
  return { stop, snap, travelBearing, side, offsetM }
}

// ── 地圖圖層 ──

export function transitToGeoJson(dataset: TransitDataset) {
  const feature = (
    id: string, kind: string, pos: [number, number], props: Record<string, unknown>,
  ) => ({
    type: 'Feature' as const,
    id,
    properties: { id, kind, ...props },
    geometry: { type: 'Point' as const, coordinates: pos },
  })
  return {
    type: 'FeatureCollection' as const,
    features: [
      ...dataset.bikeStations.map((s) => feature(s.id, 'bike', s.pos, {
        name: bikeStationLabel(s.name),
        capacity: s.capacity ?? null,
        serviceType: s.serviceType ?? '',
      })),
      ...dataset.busStops.map((s) => feature(s.id, 'bus', s.pos, {
        name: s.name,
        routes: s.routeIds.length,
        bearing: s.bearingDeg ?? null,
      })),
      ...dataset.railStations.map((s) => feature(s.id, 'rail', s.pos, {
        name: s.name,
        system: s.system,
        systemLabel: RAIL_SYSTEM_LABEL[s.system],
        code: s.code ?? '',
      })),
    ],
  }
}

export function railLinesToGeoJson(dataset: TransitDataset) {
  return {
    type: 'FeatureCollection' as const,
    features: dataset.railLines.filter((l) => l.coords.length >= 2).map((l) => ({
      type: 'Feature' as const,
      id: l.id,
      properties: { id: l.id, name: l.name, system: l.system },
      geometry: { type: 'LineString' as const, coordinates: l.coords },
    })),
  }
}

/** TDX 的 YouBike 站名長這樣：「YouBike2.0_捷運左營站」——系統別另有欄位，顯示時不必重複 */
export function bikeStationLabel(name: string): string {
  return name.replace(/^YouBike\s*\d(?:\.\d)?_/i, '').trim() || name
}
