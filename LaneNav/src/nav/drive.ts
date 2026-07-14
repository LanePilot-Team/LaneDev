// 模擬行駛：沿路線等速前進，回報位置/方位/導航資訊給 App 更新鏡頭與 HUD。
// 位置會依 route.spans 做車道偏移——車跑在自己的車道內，不是壓中心線。
import { pointAlong, angleDelta, offsetMeters, LANE_WIDTH_M } from '../core/geo'
import { targetOffsetAt, type RouteResult, type Maneuver } from '../core/graph'

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
}

const BASE_SPEED_KMH = 40

export class Driver {
  private raf = 0
  private last = 0
  private traveled = 0
  private smoothBrg: number | null = null
  private smoothOff: number | null = null
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
  ) {}

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
      this.traveled = Math.min(this.traveled + speedMs * dt, this.route.lengthM)
      const { pos: center, brg, idx } = pointAlong(this.route.coords, this.route.cum, this.traveled)

      // 方位角平滑，過彎不甩頭
      if (this.smoothBrg === null) this.smoothBrg = brg
      else this.smoothBrg += angleDelta(this.smoothBrg, brg) * Math.min(1, dt * 4)

      // 車道偏移（右側為正），換路段時橫向滑順過渡。
      // 偏移方向必須用「當前線段的真實方位角」——用平滑航向會在彎路把車推出車道
      //（平滑值落後實際路向，機車道 4.3m 偏移乘上角度誤差就出界了）。
      const span = this.route.spans.find((s) => s.toIdx >= idx)
      // 路口前 45m 開始切到轉向車道（右轉→最右、左轉→最左、兩段式→維持右側）
      const targetOff = span ? targetOffsetAt(this.route, this.traveled, span) : 0
      if (this.smoothOff === null) this.smoothOff = targetOff
      else this.smoothOff += (targetOff - this.smoothOff) * Math.min(1, dt * 3)
      // 換車道的手動偏移每幀依「目前路段」的實際車道範圍夾緊——換路段車道變少時
      // 自動收回，車永遠停在真實車道內，不會被夾成開出路面
      if (span) {
        const lo = span.leftM - span.offM, hi = span.rightM - span.offM
        this.manualLaneM = Math.max(lo, Math.min(hi, this.manualLaneM))
      }
      const off = this.smoothOff + this.manualLaneM
      const rad = ((brg + 90) * Math.PI) / 180
      const pos = offsetMeters(center, off * Math.sin(rad), off * Math.cos(rad))

      const ni = this.route.maneuvers.findIndex((m) => m.distM > this.traveled + 1)
      const next = ni >= 0 ? this.route.maneuvers[ni] : null
      const next2 = ni >= 0 ? this.route.maneuvers[ni + 1] ?? null : null
      const remainM = this.route.lengthM - this.traveled
      const arrived = remainM < 5
      this.onTick({
        pos,
        bearing: (this.smoothBrg + 360) % 360,
        speedKmh: arrived ? 0 : BASE_SPEED_KMH * this.multiplier,
        traveledM: this.traveled,
        remainM,
        remainS: remainM / speedMs,
        next,
        next2,
        nextDistM: next ? next.distM - this.traveled : 0,
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
