// 模擬行駛（dev 限定）：沿路線帶等速前進，回報 DriveState 給 HUD／車模／鏡頭。
// 移植自舊 main 的 src/nav/drive.ts（拿掉換車道按鈕）：車直接沿 laneBand 的藍線幾何走，
// 跟畫面上的路線帶是同一份幾何，所以看到的就是規劃結果本身。
import { pointAlong, angleDelta, cumulative } from '../core/geo.ts'
import { laneBand, spanAtDist, type LaneBandResult, type RouteResult } from '../core/graph.ts'
import { surfaceHeightAt } from '../core/elevated3d.ts'
import type { DriveState } from '../nav/driveState.ts'
import { SIM_BASE_KMH } from './sim.ts'

/** 「即將抵達」提示範圍（公尺）——與 GPS 導航同一個門檻 */
const ARRIVING_THRESHOLD_M = 150

export class SimDriver {
  private raf = 0
  private last = 0
  private traveled = 0
  private smoothBrg: number | null = null
  private band: LaneBandResult
  private bandCum: number[]
  private stopped = false
  multiplier = 3
  paused = false

  constructor(
    private route: RouteResult,
    private onTick: (s: DriveState) => void,
  ) {
    this.band = laneBand(route)
    this.bandCum = cumulative(this.band.coords)
  }

  start() {
    this.last = performance.now()
    const loop = (t: number) => {
      const dt = this.paused ? 0 : Math.min((t - this.last) / 1000, 0.2)
      this.last = t
      const speedMs = (SIM_BASE_KMH * this.multiplier) / 3.6
      const bandLen = this.bandCum[this.bandCum.length - 1]
      this.traveled = Math.min(this.traveled + speedMs * dt, bandLen)
      const { pos, brg, idx } = pointAlong(this.band.coords, this.bandCum, this.traveled)
      // 藍線里程 → route 里程（maneuver 距離/剩餘距離以 route 里程計）
      const segLen = this.bandCum[idx] - this.bandCum[idx - 1]
      const frac = segLen > 0 ? (this.traveled - this.bandCum[idx - 1]) / segLen : 0
      const dRoute = this.band.routeD[idx - 1] +
        (this.band.routeD[idx] - this.band.routeD[idx - 1]) * frac

      // 方位角平滑，過彎不甩頭
      if (this.smoothBrg === null) this.smoothBrg = brg
      else this.smoothBrg += angleDelta(this.smoothBrg, brg) * Math.min(1, dt * 4)

      const span = spanAtDist(this.route, dRoute)
      const ni = this.route.maneuvers.findIndex((m) => m.distM > dRoute + 1)
      const next = ni >= 0 ? this.route.maneuvers[ni] : null
      const next2 = ni >= 0 ? this.route.maneuvers[ni + 1] ?? null : null
      const remainM = Math.max(0, this.route.lengthM - dRoute)
      const arrived = remainM < 5 || this.traveled >= bandLen
      const rp = span?.road?.properties
      const elevM = span?.road ? surfaceHeightAt(span.road, pos) : 0
      this.onTick({
        roadName: rp?.name,
        roadLaneGuidance: span?.laneGuidance,
        elevM,
        pos,
        bearing: (this.smoothBrg + 360) % 360,
        speedKmh: arrived || this.paused ? 0 : SIM_BASE_KMH * this.multiplier,
        traveledM: dRoute,
        remainM,
        remainS: remainM / speedMs,
        next,
        next2,
        nextDistM: next ? next.distM - dRoute : 0,
        arrived,
        arriving: !arrived && remainM < ARRIVING_THRESHOLD_M,
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
