import { angleDelta } from '../core/geo.ts'

export interface GpsDisplayFix {
  distanceM: number
  timestamp: number
  bearing: number
  elevM: number
}

/** Display-only interpolation of measured fixes. No speed integration/extrapolation. */
export class GpsAnimation {
  private from: GpsDisplayFix | null = null
  private to: GpsDisplayFix | null = null
  private started = 0
  private duration = 0

  private coords: [number, number][]
  private cum: number[]
  constructor(coords: [number, number][], cum: number[]) { this.coords = coords; this.cum = cum }

  reset() { this.from = this.to = null; this.duration = 0 }

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
    if (!Object.values(fix).every(Number.isFinite) ||
      (this.to && fix.timestamp <= this.to.timestamp)) return false
    const previous = this.to
    const current = this.sample(now)?.fix
    const interval = previous ? fix.timestamp - previous.timestamp : 0
    // Discontinuities/long gaps are real corrections, never animate across a city.
    const snap = !current || interval > 3000 ||
      Math.abs(fix.distanceM - current.distanceM) > 120 || fix.distanceM < current.distanceM - 10
    this.from = snap ? fix : current
    this.to = fix
    this.started = now
    this.duration = snap ? 0 : Math.max(150, Math.min(1000, interval))
    return true
  }

  sample(now: number) {
    if (!this.from || !this.to) return null
    const t = this.duration ? Math.max(0, Math.min(1, (now - this.started) / this.duration)) : 1
    const mix = (a: number, b: number) => a + (b - a) * t
    const fix = {
      distanceM: mix(this.from.distanceM, this.to.distanceM),
      bearing: (this.from.bearing + angleDelta(this.from.bearing, this.to.bearing) * t + 360) % 360,
      elevM: mix(this.from.elevM, this.to.elevM),
      timestamp: this.to.timestamp,
    }
    return { fix, pos: this.positionAt(fix.distanceM),
      moving: t < 1 && (Math.abs(this.to.distanceM - this.from.distanceM) > 0.01 ||
        Math.abs(angleDelta(this.from.bearing, this.to.bearing)) > 0.1 ||
        Math.abs(this.to.elevM - this.from.elevM) > 0.01) }
  }
}
