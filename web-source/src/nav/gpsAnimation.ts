import { angleDelta, haversine } from '../core/geo.ts'

export interface GpsDisplayFix {
  distanceM: number
  timestamp: number
  bearing: number
  elevM: number
  /**
   * 偏離路線時的實際顯示座標。有值代表這筆不貼路線帶，車要畫在這裡；
   * 沒有值則照舊由 distanceM 在路線帶上取點。
   */
  pos?: [number, number]
}

interface StoredFix extends GpsDisplayFix { pt: [number, number] }

/** 重新規劃換新路線時，從上一條路線最後畫面位置接過來的過渡時間（毫秒） */
const SEED_BLEND_MS = 600

/** Display-only interpolation of measured fixes. No speed integration/extrapolation. */
export class GpsAnimation {
  private from: StoredFix | null = null
  private to: StoredFix | null = null
  private started = 0
  private duration = 0

  private coords: [number, number][]
  private cum: number[]
  constructor(coords: [number, number][], cum: number[]) { this.coords = coords; this.cum = cum }

  reset() { this.from = this.to = null; this.duration = 0 }

  /**
   * 以上一條路線最後畫在畫面上的位置當起點：重新規劃後第一筆定位從這裡補間過去，
   * 車不會因為換成新路線帶而瞬移。
   */
  seed(pos: [number, number], bearing: number, elevM: number) {
    if (![...pos, bearing, elevM].every(Number.isFinite)) return
    const fix: StoredFix = { distanceM: 0, timestamp: Number.NEGATIVE_INFINITY, bearing, elevM, pos, pt: pos }
    this.from = this.to = fix
    this.duration = 0
  }

  private positionAt(distance: number): [number, number] {
    const d = Math.max(0, Math.min(distance, this.cum[this.cum.length - 1]))
    let low = 1, high = this.cum.length - 1
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.cum[mid] < d) low = mid + 1
      else high = mid
    }
    const length = this.cum[low] - this.cum[low - 1]
    const t = length > 0 ? (d - this.cum[low - 1]) / length : 0
    const a = this.coords[low - 1], b = this.coords[low]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }

  push(fix: GpsDisplayFix, now: number): boolean {
    const { pos, ...scalars } = fix
    if (!Object.values(scalars).every(Number.isFinite) || (pos && !pos.every(Number.isFinite)) ||
      (this.to && fix.timestamp <= this.to.timestamp)) return false
    const next: StoredFix = { ...fix, pt: pos ?? this.positionAt(fix.distanceM) }
    const previous = this.to
    const current = this.sampleStored(now)
    const seeded = previous !== null && !Number.isFinite(previous.timestamp)
    const interval = previous && !seeded ? fix.timestamp - previous.timestamp : 0
    const onRoute = !!current && !current.pos && !next.pos
    // Discontinuities/long gaps are real corrections, never animate across a city.
    const snap = !current || interval > 3000 || (onRoute
      ? Math.abs(next.distanceM - current.distanceM) > 120 || next.distanceM < current.distanceM - 10
      : haversine(current.pt, next.pt) > 120)
    this.from = snap ? next : current
    this.to = next
    this.started = now
    this.duration = snap ? 0 : seeded ? SEED_BLEND_MS : Math.max(150, Math.min(1000, interval))
    return true
  }

  private sampleStored(now: number): (StoredFix & { t: number }) | null {
    if (!this.from || !this.to) return null
    const from = this.from, to = this.to
    const t = this.duration ? Math.max(0, Math.min(1, (now - this.started) / this.duration)) : 1
    const mix = (a: number, b: number) => a + (b - a) * t
    const distanceM = mix(from.distanceM, to.distanceM)
    // 兩端都在路線上：沿路線帶補間（轉角不抄捷徑）；任一端是實際座標：直線補間
    const free = !!(from.pos || to.pos)
    const pt: [number, number] = free
      ? [mix(from.pt[0], to.pt[0]), mix(from.pt[1], to.pt[1])]
      : this.positionAt(distanceM)
    return {
      distanceM,
      bearing: (from.bearing + angleDelta(from.bearing, to.bearing) * t + 360) % 360,
      elevM: mix(from.elevM, to.elevM),
      timestamp: to.timestamp,
      pos: free && t < 1 ? pt : to.pos,
      pt,
      t,
    }
  }

  sample(now: number) {
    const s = this.sampleStored(now)
    if (!s || !this.from || !this.to) return null
    const from = this.from, to = this.to
    const fix: GpsDisplayFix = { distanceM: s.distanceM, bearing: s.bearing, elevM: s.elevM, timestamp: s.timestamp }
    return { fix, pos: s.pt,
      moving: s.t < 1 && (Math.abs(to.distanceM - from.distanceM) > 0.01 ||
        haversine(from.pt, to.pt) > 0.01 ||
        Math.abs(angleDelta(from.bearing, to.bearing)) > 0.1 ||
        Math.abs(to.elevM - from.elevM) > 0.01) }
  }
}
