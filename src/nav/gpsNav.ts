// 真 GPS 導航：watchPosition + 路線帶貼合（nav/mapMatch）算出離線距離與沿線進度，
// 輸出跟模擬 Driver 一樣的 DriveState 形狀，讓 App.tsx 的 HUD/車模/鏡頭邏輯兩種模式共用。
//
// 貼合對象是「路線帶」（laneBand）而不是路網中心線——畫面上的藍線就是這條帶，
// 車貼在帶上才會跟藍線重合；貼中心線的話車會固定偏一個車道寬。
import { cumulative, haversine } from '../core/geo'
import { laneBand, spanAtDist, type LaneBandResult, type RouteResult } from '../core/graph'
import { surfaceHeightAt } from '../core/elevated3d'
import type { DriveState } from './drive'
import { matchToRoute, smoothBearing, type MatchResult } from './mapMatch'
import {
  HIGH_ACCURACY_POSITION_OPTIONS,
  geolocationErrorMessage,
  geolocationUnavailableMessage,
} from './geolocation'

/** 離線偵測門檻（公尺）：距離超過這個就算偏離 */
const OFF_ROUTE_THRESHOLD_M = 60
/** 連續這麼多次 GPS fix 都偏離才觸發 reroute（避免單筆抖動誤判，約 1 fix/秒） */
const REROUTE_AFTER_FIXES = 3
/** 剛 reroute 完的冷卻時間（毫秒），避免反覆重畫 */
const REROUTE_COOLDOWN_MS = 10000
/** 抵達判定：GPS 貼合誤差較大，門檻比模擬駕駛（5m）寬鬆 */
const ARRIVE_THRESHOLD_M = 25
/** 「即將抵達」提示範圍（公尺）：HUD 提早換成抵達卡，不要在終點才突然跳出來 */
const ARRIVING_THRESHOLD_M = 150
/**
 * 保底抵達判定：終點常在停車場、巷內或建物裡，GPS 進度不一定推得到路線盡頭，
 * 使用者就會卡在「還剩 30 公尺」永遠不結束。所以再給兩條路：
 *   a) 人已經停在終點附近一段時間 → 算抵達
 *   b) 原始定位直線距離離終點夠近 → 算抵達（不管路線里程走到哪）
 */
const STOP_ARRIVE_M = 70
const STOP_SPEED_KMH = 3
const STOP_HOLD_MS = 6000
const DIRECT_ARRIVE_M = 30

interface WakeLockSentinelLike { release(): Promise<void> }

/** 路線帶里程 → route 里程（帶的取樣點都帶著自己的 route 里程，線性內插即可） */
function routeDistAt(band: LaneBandResult, bandCum: number[], bandDist: number): number {
  let i = 1
  while (i < bandCum.length - 1 && bandCum[i] < bandDist) i++
  const segLen = bandCum[i] - bandCum[i - 1]
  const frac = segLen > 0 ? (bandDist - bandCum[i - 1]) / segLen : 0
  return band.routeD[i - 1] + (band.routeD[i] - band.routeD[i - 1]) * frac
}

export class GpsDriver {
  private watchId: number | null = null
  private wakeLock: WakeLockSentinelLike | null = null
  private offRouteCount = 0
  private lastRerouteTs = 0
  private lastFixTs = 0
  private lastSpeedMps = 0
  private lastFixPos: [number, number] | null = null
  private smoothBrg: number | null = null
  private match: MatchResult | null = null
  private stoppedNearDestSince = 0
  /** 最後一次送出的畫面狀態——GPS 掉訊時原地重送（標上 gpsWeak），畫面不會整個空掉 */
  private lastState: DriveState | null = null
  private band: LaneBandResult
  private bandCum: number[]
  private destination: [number, number]
  private finished = false

  constructor(
    private route: RouteResult,
    private onTick: (s: DriveState) => void,
    /** 連續偏離超過門檻時呼叫，帶目前定位，App 負責重新規劃 */
    private onOffRoute: (pos: [number, number]) => void,
    private onError: (msg: string) => void,
  ) {
    this.band = laneBand(route)
    this.bandCum = cumulative(this.band.coords)
    this.destination = route.coords[route.coords.length - 1]
  }

  async start() {
    const unavailable = geolocationUnavailableMessage()
    if (unavailable) { this.onError(unavailable); return }
    try {
      const wl = (navigator as Navigator & {
        wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> }
      }).wakeLock
      if (wl) this.wakeLock = await wl.request('screen')
    } catch { /* 拿不到 wake lock 也沒關係，不影響導航 */ }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onFix(pos),
      (err) => this.onError(geolocationErrorMessage(err)),
      HIGH_ACCURACY_POSITION_OPTIONS,
    )
  }

  private onFix(pos: GeolocationPosition) {
    if (this.finished) return
    const { longitude: lon, latitude: lat, speed, accuracy } = pos.coords
    const here: [number, number] = [lon, lat]
    const now = Date.now()
    const elapsedS = this.lastFixTs ? (now - this.lastFixTs) / 1000 : 0

    // 車速：優先用裝置回報值；沒有就用位移/時間推（低速時 GPS 常回 null）
    let speedMps = speed != null && !Number.isNaN(speed) ? Math.max(0, speed) : null
    if (speedMps === null && this.lastFixPos && elapsedS > 0.2) {
      speedMps = haversine(this.lastFixPos, here) / elapsedS
    }

    const match = matchToRoute({
      coords: this.band.coords,
      cum: this.bandCum,
      here,
      accuracyM: Number.isFinite(accuracy) ? accuracy : null,
      prev: this.match,
      elapsedS,
      speedMps: this.lastSpeedMps,
    })
    this.lastFixTs = now
    this.lastFixPos = here
    this.lastSpeedMps = speedMps ?? this.lastSpeedMps

    // 精度爛到不可用：不推進度也不判偏離（動了只會亂跳），但畫面要講清楚現在收不到訊號。
    // 已經在跑就原地重送上一筆並標成訊號弱；還沒有第一筆定位就走錯誤列。
    if (match.quality === 'lost') {
      if (this.lastState) this.emit({ ...this.lastState, speedKmh: 0, gpsWeak: true })
      else this.onError('GPS 訊號微弱，尚未取得可用定位')
      return
    }

    if (match.offRouteM > OFF_ROUTE_THRESHOLD_M) {
      this.offRouteCount += 1
      if (this.offRouteCount >= REROUTE_AFTER_FIXES &&
        now - this.lastRerouteTs > REROUTE_COOLDOWN_MS) {
        this.lastRerouteTs = now
        this.onOffRoute(here)
      }
      return // 偏離路線時不前進進度，避免貼合點亂跳
    }
    this.offRouteCount = 0
    this.match = match

    const speedKmh = (speedMps ?? 0) * 3.6
    // 方位角：貼合可信時用路線帶切線（比裝置 heading 穩得多，低速也不會亂轉），
    // 貼合不可信時 matchToRoute 已經沿用上一筆方位，這裡只再做顯示平滑。
    this.smoothBrg = smoothBearing(this.smoothBrg, match.bearing)

    const traveledM = routeDistAt(this.band, this.bandCum, match.distM)
    const ni = this.route.maneuvers.findIndex((m) => m.distM > traveledM + 1)
    const next = ni >= 0 ? this.route.maneuvers[ni] : null
    const next2 = ni >= 0 ? this.route.maneuvers[ni + 1] ?? null : null
    const remainM = Math.max(0, this.route.lengthM - traveledM)
    const directToDestM = haversine(here, this.destination)

    // 停在終點附近夠久 → 視同抵達（GPS 推不到路線盡頭時的保底）
    if (remainM < STOP_ARRIVE_M && speedKmh < STOP_SPEED_KMH) {
      if (!this.stoppedNearDestSince) this.stoppedNearDestSince = now
    } else {
      this.stoppedNearDestSince = 0
    }
    const heldAtDest = this.stoppedNearDestSince > 0 && now - this.stoppedNearDestSince > STOP_HOLD_MS
    const arrived = remainM < ARRIVE_THRESHOLD_M || directToDestM < DIRECT_ARRIVE_M || heldAtDest
    const arriving = !arrived && remainM < ARRIVING_THRESHOLD_M

    const span = spanAtDist(this.route, traveledM)
    const rp = span?.road?.properties
    // 高架高度：與模擬駕駛同一套（span 路段身分 + 橋面高度）
    const elevM = span?.road ? surfaceHeightAt(span.road, match.pos) : 0
    this.emit({
      roadName: rp?.name,
      roadLaneGuidance: span?.laneGuidance,
      elevM,
      pos: match.pos, // 貼合後的座標——原始 GPS 座標會把車畫到對向車道
      bearing: this.smoothBrg,
      speedKmh,
      traveledM,
      remainM,
      remainS: speedKmh > 1 ? remainM / (speedKmh / 3.6) : 0,
      next,
      next2,
      nextDistM: next ? next.distM - traveledM : 0,
      arrived,
      arriving,
      gpsWeak: match.quality === 'weak',
    })
    if (arrived) {
      this.finished = true
      this.stop()
    }
  }

  private emit(state: DriveState) {
    this.lastState = state
    this.onTick(state)
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
    }
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {})
      this.wakeLock = null
    }
  }
}
