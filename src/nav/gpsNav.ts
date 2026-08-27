// 真 GPS 導航：watchPosition + turf.nearestPointOnLine 抓離線距離/沿線進度，
// 邏輯照抄 mvp（mvp/frontend/src/App.tsx）驗證過的參數與流程，只是輸出換成跟
// Driver 一樣的 DriveState 形狀，讓 App.tsx 的 HUD/車模/鏡頭邏輯兩種模式共用。
import { nearestPointOnLine, point as turfPoint, lineString } from '@turf/turf'
import type { Feature, LineString } from 'geojson'
import { haversine, bearing } from '../core/geo'
import { spanAtDist, type RouteResult } from '../core/graph'
import { surfaceHeightAt } from '../core/elevated3d'
import type { DriveState } from './drive'
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
/** 抵達判定：GPS snap 誤差較大，門檻比模擬駕駛（5m）寬鬆 */
const ARRIVE_THRESHOLD_M = 20

interface WakeLockSentinelLike { release(): Promise<void> }

export class GpsDriver {
  private watchId: number | null = null
  private wakeLock: WakeLockSentinelLike | null = null
  private progressM = 0
  private offRouteCount = 0
  private lastRerouteTs = 0
  private lastFixPos: [number, number] | null = null
  private lastBearing = 0
  private line: Feature<LineString>

  constructor(
    private route: RouteResult,
    private onTick: (s: DriveState) => void,
    /** 連續偏離超過門檻時呼叫，帶目前定位，App 負責重新規劃 */
    private onOffRoute: (pos: [number, number]) => void,
    private onError: (msg: string) => void,
  ) {
    this.line = lineString(route.coords)
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
    const { longitude: lon, latitude: lat, heading, speed } = pos.coords
    const here: [number, number] = [lon, lat]

    // 前進方向：優先用裝置回報的航向；沒有就用連續兩筆定位算移動方位（照 mvp）
    if (heading != null && !Number.isNaN(heading)) {
      this.lastBearing = heading
    } else if (this.lastFixPos && haversine(this.lastFixPos, here) > 3) {
      this.lastBearing = bearing(this.lastFixPos, here)
    }
    this.lastFixPos = here

    const snap = nearestPointOnLine(this.line, turfPoint(here), { units: 'kilometers' })
    const distFromRouteM = (snap.properties.dist ?? 0) * 1000
    const snappedM = (snap.properties.location ?? 0) * 1000

    if (distFromRouteM > OFF_ROUTE_THRESHOLD_M) {
      this.offRouteCount += 1
      if (this.offRouteCount >= REROUTE_AFTER_FIXES &&
        Date.now() - this.lastRerouteTs > REROUTE_COOLDOWN_MS) {
        this.lastRerouteTs = Date.now()
        this.onOffRoute(here)
      }
      return // 偏離路線時不前進進度，避免 snap 點亂跳
    }
    this.offRouteCount = 0
    if (snappedM > this.progressM) this.progressM = snappedM // 不允許進度倒退（GPS 抖動）

    const ni = this.route.maneuvers.findIndex((m) => m.distM > this.progressM + 1)
    const next = ni >= 0 ? this.route.maneuvers[ni] : null
    const next2 = ni >= 0 ? this.route.maneuvers[ni + 1] ?? null : null
    const remainM = this.route.lengthM - this.progressM
    const arrived = remainM < ARRIVE_THRESHOLD_M
    const speedKmh = speed != null && !Number.isNaN(speed) ? speed * 3.6 : 0
    const span = spanAtDist(this.route, this.progressM)
    const rp = span?.road?.properties
    // 高架高度：與模擬駕駛同一套（span 路段身分 + 橋面高度）
    const elevM = span?.road ? surfaceHeightAt(span.road, here) : 0
    this.onTick({
      roadName: rp?.name,
      roadLaneGuidance: span?.laneGuidance,
      elevM,
      pos: here,
      bearing: this.lastBearing,
      speedKmh,
      traveledM: this.progressM,
      remainM,
      remainS: speedKmh > 1 ? remainM / (speedKmh / 3.6) : 0,
      next,
      next2,
      nextDistM: next ? next.distM - this.progressM : 0,
      arrived,
    })
    if (arrived) this.stop()
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
