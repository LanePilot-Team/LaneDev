// GPS 定位貼合路線（map matching）：把每筆 watchPosition 的原始座標收斂成「路線帶上的
// 里程 + 座標 + 切線方位」，導航畫面才不會直接吃到 GPS 誤差。
//
// 原本 gpsNav 直接把原始座標當車輛位置、並用 turf 對「整條路線」取最近點，實機上會壞在三處：
//   1. 原始座標畫上去：手機 GPS 誤差 10~20m，而對向車道中心線只差 10~15m，
//      車就會被畫到對向車道去。
//   2. 全線最近點：路線折返、繞回同一條路、來回同一條走廊時，最近點會跳到路線的
//      另一段（常常正好是對向那半），位置瞬間飛走。
//   3. 進度只准前進（單調 max）：每一筆往前抖的雜訊都會永久推進里程，誤差只累加不歸還，
//      走越久偏越多——這就是「剛開始還行，越走越偏」。
// 這裡改成「上一筆里程附近的視窗內找最近點」，並允許有限度的後退，誤差就不會累積。
import { COS_LAT, angleDelta, bearing } from '../core/geo'

/** 精度好過這個值才敢完全相信這筆定位（公尺）——都市峽谷常在 10~30m */
export const ACCURACY_TRUST_M = 35
/** 精度差過這個值就整筆丟掉：這種 fix 連在哪條路上都分不出來，貼上去只會亂跳 */
export const ACCURACY_REJECT_M = 75
/** 視窗往後可回溯的里程（公尺）：夠吸收 GPS 抖動，又不會讓車倒退回上一個路口 */
const WINDOW_BACK_M = 25
/** 視窗往前的最小長度（公尺）：停紅燈、慢速時也留得住前進空間 */
const WINDOW_MIN_FORWARD_M = 60
/** 視窗往前的放寬倍率：以「上次車速 × 間隔」為基準，容忍定位延遲與加速 */
const WINDOW_FORWARD_FACTOR = 2.5

export type MatchQuality =
  /** 精度足夠且貼在路線帶上：位置/方位都用貼合後的值 */
  | 'good'
  /** 精度差或離路線有點遠：位置照貼，但方位不敢用切線（可能貼錯車道） */
  | 'weak'
  /** 這筆定位不可用（精度爛掉）：沿用上一筆狀態，不要動進度 */
  | 'lost'

export interface MatchResult {
  /** 貼合後在路線帶上的里程（公尺） */
  distM: number
  /** 貼合後的座標——畫面上的車就用這個，不用原始 GPS 座標 */
  pos: [number, number]
  /** 貼合點所在線段的切線方位角（度） */
  bearing: number
  /** 原始定位離路線帶多遠（公尺）——偏離判定用這個，不是貼合後的距離 */
  offRouteM: number
  quality: MatchQuality
}

export interface MatchInput {
  /** 路線帶幾何（laneBand 的取樣點）與其累積里程 */
  coords: [number, number][]
  cum: number[]
  /** 這筆定位的原始座標 */
  here: [number, number]
  /** 這筆定位回報的精度半徑（公尺）；null = 瀏覽器沒給 */
  accuracyM: number | null
  /** 上一筆貼合結果；null = 這是第一筆（全線搜尋） */
  prev: MatchResult | null
  /** 距上一筆定位的秒數（第一筆給 0） */
  elapsedS: number
  /** 上一筆的車速（公尺/秒）；null = 不知道 */
  speedMps: number | null
}

interface Projection {
  distM: number
  pos: [number, number]
  bearing: number
  offM: number
}

/** 經緯度差換算成本地平面公尺（楠梓緯度固定 cos，與 core/geo 同一套近似） */
function toLocalM(from: [number, number], to: [number, number]): [number, number] {
  return [(to[0] - from[0]) * 111320 * COS_LAT, (to[1] - from[1]) * 110540]
}

/**
 * 在 [loM, hiM] 這段里程內找離 here 最近的點。只掃過與視窗重疊的線段，
 * 且投影參數 t 會夾在視窗邊界內——車不會被吸到視窗外的另一段路線上。
 */
function nearestInWindow(
  coords: [number, number][], cum: number[], here: [number, number],
  loM: number, hiM: number,
): Projection | null {
  let best: Projection | null = null
  for (let i = 1; i < coords.length; i++) {
    const segStart = cum[i - 1], segEnd = cum[i]
    if (segEnd < loM || segStart > hiM) continue
    const segLen = segEnd - segStart
    if (segLen <= 0) continue
    const a = coords[i - 1], b = coords[i]
    const [abx, aby] = toLocalM(a, b)
    const [apx, apy] = toLocalM(a, here)
    let t = (apx * abx + apy * aby) / (abx * abx + aby * aby)
    // 夾在「線段本身」與「視窗邊界」的交集內
    const tLo = Math.max(0, (loM - segStart) / segLen)
    const tHi = Math.min(1, (hiM - segStart) / segLen)
    t = Math.max(tLo, Math.min(tHi, t))
    const pos: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    const [dx, dy] = toLocalM(pos, here)
    const offM = Math.hypot(dx, dy)
    if (!best || offM < best.offM) {
      best = { distM: segStart + segLen * t, pos, bearing: bearing(a, b), offM }
    }
  }
  return best
}

/**
 * 把一筆定位貼到路線帶上。
 * 第一筆（prev = null）走全線搜尋——那時還沒有里程可以當錨點；
 * 之後每一筆都只在上一筆里程的前後視窗內搜尋，這是不再「越走越偏」的關鍵。
 */
export function matchToRoute(input: MatchInput): MatchResult {
  const { coords, cum, here, accuracyM, prev, elapsedS, speedMps } = input
  const total = cum[cum.length - 1]

  // 精度爛掉：這筆不可用。有上一筆就原地沿用（車停著也比亂跳好），沒有就標 lost 在起點。
  if (accuracyM !== null && accuracyM > ACCURACY_REJECT_M) {
    return prev
      ? { ...prev, quality: 'lost' }
      : { distM: 0, pos: coords[0], bearing: bearing(coords[0], coords[1] ?? coords[0]), offRouteM: Number.POSITIVE_INFINITY, quality: 'lost' }
  }

  let hit: Projection | null
  if (prev === null) {
    hit = nearestInWindow(coords, cum, here, 0, total)
  } else {
    const reach = (speedMps ?? 0) * Math.max(0, elapsedS) * WINDOW_FORWARD_FACTOR
    const lo = Math.max(0, prev.distM - WINDOW_BACK_M)
    const hi = Math.min(total, prev.distM + Math.max(WINDOW_MIN_FORWARD_M, reach + 30))
    hit = nearestInWindow(coords, cum, here, lo, hi)
  }
  if (!hit) {
    return prev
      ? { ...prev, quality: 'lost' }
      : { distM: 0, pos: coords[0], bearing: 0, offRouteM: Number.POSITIVE_INFINITY, quality: 'lost' }
  }

  // 精度差、或離路線帶超過精度半徑一截 → 位置照貼（貼著總比原始座標畫到對向好），
  // 但標成 weak：方位角改用上一筆，免得貼錯車道時車頭反向。
  const trusted = (accuracyM === null || accuracyM <= ACCURACY_TRUST_M)
    && hit.offM <= Math.max(ACCURACY_TRUST_M, (accuracyM ?? 0) + 15)
  return {
    distM: hit.distM,
    pos: hit.pos,
    bearing: trusted || !prev ? hit.bearing : prev.bearing,
    offRouteM: hit.offM,
    quality: trusted ? 'good' : 'weak',
  }
}

/**
 * 顯示用方位角平滑：GPS 的切線方位在取樣點交界會跳，直接餵給鏡頭會甩頭。
 * 與模擬駕駛（drive.ts）同一種做法，只是這裡以「每筆定位」為步長。
 */
export function smoothBearing(prev: number | null, next: number, alpha = 0.45): number {
  if (prev === null) return next
  return (prev + angleDelta(prev, next) * alpha + 360) % 360
}
