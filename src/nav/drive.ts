// 模擬行駛：沿路線等速前進，回報位置/方位/導航資訊給 App 更新鏡頭與 HUD。
// 車直接沿「藍線」（laneOffsetCoords 的車道偏移路線帶）行駛——與畫面上的路線帶
// 用同一份幾何，變道/轉彎過程都精確貼在藍線上，不再另做一套偏移平滑。
import { pointAlong, angleDelta, offsetMeters, cumulative, LANE_WIDTH_M } from '../core/geo'
import { laneBand, spanAtDist, type LaneBandResult, type RouteResult, type Maneuver } from '../core/graph'
import { surfaceHeightAt } from '../core/elevated3d'
import type { ResolvedLaneGuidance } from '../core/laneGuidance'

export interface DriveState {
  pos: [number, number]
  bearing: number
  speedKmh: number
  traveledM: number
  remainM: number
  remainS: number
  next: Maneuver | null
  /** next 之後緊接的動作（連動指示「隨後…」用） */
  next2: Maneuver | null
  nextDistM: number
  arrived: boolean
  /** 目前所在道路名（span.road）——HUD 底部列顯示；detour 暫時路線可能沒有 */
  roadName?: string
  /** 目前行向的車道數/轉向真值——HUD 車道列隨所在路段即時更新 */
  roadLaneGuidance?: ResolvedLaneGuidance
  /** 高架高度（公尺）：所在路段屬高架清單時 >0，車模 z 用（core/elevation.ts） */
  elevM?: number
}

const BASE_SPEED_KMH = 40

export class Driver {
  private raf = 0
  private last = 0
  private traveled = 0
  private smoothBrg: number | null = null
  /** 藍線幾何（與畫面 route source 同一套 laneBand，含取樣點的 route 里程對應表） */
  private band: LaneBandResult
  private bandCum: number[]
  /** 換車道按鈕的手動偏移（公尺，右正）——每次按一下移一個車道寬，且每幀依目前路段的實際車道範圍夾緊，
   * 不會開出路面（subway-surfer 式的離散換道，不是自由橫移） */
  private manualLaneM = 0
  // reroute 可能從自己的 onTick 內同步觸發（呼叫方會呼叫 stop()）——
  // 這時 loop 仍在執行中，得靠這個旗標擋掉 stop() 之後的重新排程，
  // 不然舊 Driver 會跟新建的那個一起跑，畫面兩台車互搶更新。
  private stopped = false
  multiplier = 3

  constructor(
    private route: RouteResult,
    private onTick: (s: DriveState) => void,
  ) {
    this.band = laneBand(route)
    this.bandCum = cumulative(this.band.coords)
  }

  /** 換車道按鈕：dir -1=往左一車道、1=往右一車道（夾在目前路段的實際車道範圍內） */
  laneStep(dir: -1 | 1) {
    this.manualLaneM += dir * LANE_WIDTH_M
  }

  start() {
    this.last = performance.now()
    const loop = (t: number) => {
      const dt = Math.min((t - this.last) / 1000, 0.2)
      this.last = t
      const speedMs = (BASE_SPEED_KMH * this.multiplier) / 3.6
      const bandLen = this.bandCum[this.bandCum.length - 1]
      this.traveled = Math.min(this.traveled + speedMs * dt, bandLen)
      // 直接沿藍線幾何前進——位置天生貼在路線帶上（變道斜切段也一致）
      const { pos: center, brg, idx } = pointAlong(this.band.coords, this.bandCum, this.traveled)
      // 用取樣點的里程對應表把藍線里程內插回 route 里程，
      // maneuver 距離/剩餘距離仍以 route 里程計（兩者差距僅公尺級）
      const segLen = this.bandCum[idx] - this.bandCum[idx - 1]
      const frac = segLen > 0 ? (this.traveled - this.bandCum[idx - 1]) / segLen : 0
      const dRoute = this.band.routeD[idx - 1] +
        (this.band.routeD[idx] - this.band.routeD[idx - 1]) * frac

      // 方位角平滑，過彎不甩頭
      if (this.smoothBrg === null) this.smoothBrg = brg
      else this.smoothBrg += angleDelta(this.smoothBrg, brg) * Math.min(1, dt * 4)

      // 換車道的手動偏移（相對藍線，右側為正）每幀依「目前路段」的實際車道範圍夾緊——
      // 換路段車道變少時自動收回，車永遠停在真實車道內，不會被夾成開出路面。
      // 偏移方向用「當前線段的真實方位角」——平滑航向在彎路會把車推出車道。
      const span = spanAtDist(this.route, dRoute)
      if (span) {
        const lo = span.leftM - span.offM, hi = span.rightM - span.offM
        this.manualLaneM = Math.max(lo, Math.min(hi, this.manualLaneM))
      }
      const rad = ((brg + 90) * Math.PI) / 180
      const pos = this.manualLaneM === 0 ? center :
        offsetMeters(center, this.manualLaneM * Math.sin(rad), this.manualLaneM * Math.cos(rad))

      const ni = this.route.maneuvers.findIndex((m) => m.distM > dRoute + 1)
      const next = ni >= 0 ? this.route.maneuvers[ni] : null
      const next2 = ni >= 0 ? this.route.maneuvers[ni + 1] ?? null : null
      const remainM = this.route.lengthM - dRoute
      const arrived = remainM < 5 || this.traveled >= bandLen
      // 目前所在道路（HUD 路名/車道列即時更新用）
      const rp = span?.road?.properties
      // 高架高度：用 span 的路段身分查（不做「找最近高架」——平面路從高架下穿過會誤抬）。
      // 走 surfaceHeightAt = 橋面實際高度，與路線帶同一來源（車不會沉進橋面）
      const elevM = span?.road ? surfaceHeightAt(span.road, center) : 0
      this.onTick({
        roadName: rp?.name,
        roadLaneGuidance: span?.laneGuidance,
        elevM,
        pos,
        bearing: (this.smoothBrg + 360) % 360,
        speedKmh: arrived ? 0 : BASE_SPEED_KMH * this.multiplier,
        traveledM: dRoute,
        remainM,
        remainS: remainM / speedMs,
        next,
        next2,
        nextDistM: next ? next.distM - dRoute : 0,
        arrived,
      })
      if (!arrived && !this.stopped) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.stopped = true
    cancelAnimationFrame(this.raf)
  }
}
