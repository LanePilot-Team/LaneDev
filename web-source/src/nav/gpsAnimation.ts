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
/**
 * 平順切換（偏移改善 D）：參考線換掉時（路線帶 ↔ 路網貼合、舊路線 → 新路線），
 * 車先投影到新線上、沿新線照常前進，原本的位置差當成「殘差」在這段時間內平滑收掉。
 * 這樣車不會直線斜切過去，也不會頓一下再衝。
 */
const SWITCH_BLEND_MS = 1500
/** 投影到新路線帶時只在目標里程前後這個範圍找（避免折返路線投到另一段） */
const SWITCH_SEARCH_M = 150

const smoothstep = (t: number) => t * t * (3 - 2 * t)

/** Display-only interpolation of measured fixes. No speed integration/extrapolation. */
export class GpsAnimation {
  private from: StoredFix | null = null
  private to: StoredFix | null = null
  private started = 0
  private duration = 0

  private coords: [number, number][]
  private cum: number[]
  /** 殘差：切換瞬間「畫面位置 − 新線上的起點」，隨時間收斂到 0 */
  private blend: { dx: number; dy: number; dBrg: number; start: number; dur: number } | null = null
  /** 目標點的移動速度估計（公尺/毫秒，指數平滑）：切換時限制畫面車速用 */
  private speedEst = 0
  /** 切換時畫面車速上限 = 估計車速 × 這個倍率 */
  private static readonly CATCHUP_FACTOR = 1.4
  /** 開啟平順切換（偏移改善 D） */
  private smoothSwitch: boolean
  constructor(coords: [number, number][], cum: number[], smoothSwitch = false) {
    this.coords = coords; this.cum = cum; this.smoothSwitch = smoothSwitch
  }

  reset() { this.from = this.to = null; this.duration = 0; this.blend = null }

  private blendK(now: number): number {
    if (!this.blend) return 0
    const t = (now - this.blend.start) / this.blend.dur
    if (t >= 1) { this.blend = null; return 0 }
    return 1 - smoothstep(Math.max(0, t))
  }

  /** 把點投影到路線帶上（只在 around 前後 SWITCH_SEARCH_M 內找），回傳里程 */
  private projectDist(p: [number, number], around: number): number {
    const kx = 111320 * Math.cos((22.73 * Math.PI) / 180), ky = 110540
    let best = around, bestD = Infinity
    for (let i = 1; i < this.coords.length; i++) {
      if (this.cum[i] < around - SWITCH_SEARCH_M || this.cum[i - 1] > around + SWITCH_SEARCH_M) continue
      const a = this.coords[i - 1], b = this.coords[i]
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky
      const px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky
      const len2 = dx * dx + dy * dy
      if (len2 === 0) continue
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
      const d = Math.hypot(px - t * dx, py - t * dy)
      if (d < bestD) { bestD = d; best = this.cum[i - 1] + (this.cum[i] - this.cum[i - 1]) * t }
    }
    return best
  }

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

  /**
   * 平順切換（D）：換新路線時接手舊動畫正在走的那一段（換成實際座標，與路線帶無關），
   * 車不停頓；下一筆定位進來時再由 pushSmooth 投影到新路線帶上。
   */
  takeOver(old: GpsAnimation, now: number): boolean {
    const s = old.sample(now)
    if (!s || !old.to) return false
    const toPt = old.to.pos ?? old.to.pt
    const remain = Math.max(0, old.started + old.duration - now)
    this.from = { ...old.to, distanceM: 0, pos: s.pos, pt: s.pos, bearing: s.fix.bearing, elevM: s.fix.elevM }
    this.to = { ...old.to, distanceM: 0, pos: toPt, pt: toPt }
    this.started = now
    this.duration = remain
    this.blend = null
    return true
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
    if (this.smoothSwitch && current && this.pushSmooth(current, next, seeded, interval, now)) return true
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

  /**
   * 平順切換。只處理「參考線換掉」的情況，其他照原本的補間：
   *   - 原本畫在路網/原始座標（或剛換新路線的 seed）→ 這筆在路線帶上：投影到帶上沿帶前進＋殘差收斂
   *   - 原本在路線帶上 → 這筆改畫路網座標：從畫面位置直線補間，但車頭不突然轉
   * 回傳 true 表示已處理。
   */
  private pushSmooth(
    current: StoredFix & { t: number }, next: StoredFix, seeded: boolean, interval: number, now: number,
  ): boolean {
    const k = this.blendK(now)
    const shown: [number, number] = this.blend
      ? [current.pt[0] + this.blend.dx * k, current.pt[1] + this.blend.dy * k] : current.pt
    const shownBrg = this.blend ? (current.bearing + this.blend.dBrg * k + 360) % 360 : current.bearing
    const curFree = !!current.pos || seeded
    if (haversine(shown, next.pt) > 120 || (!seeded && interval > 3000)) return false
    if (this.to && interval > 0) {
      const v = haversine(this.to.pt, next.pt) / interval
      this.speedEst = this.speedEst ? this.speedEst * 0.6 + v * 0.4 : v
    }
    const dur = Math.max(300, Math.min(1000, seeded ? 1000 : interval))
    /** 走 distM 需要的補間時間：不讓畫面車速超過估計車速太多（多的時間最多拉到 2 秒） */
    const capped = (distM: number) => this.speedEst > 0.001
      ? Math.min(2000, Math.max(dur, distM / (this.speedEst * GpsAnimation.CATCHUP_FACTOR))) : dur
    if (curFree && !next.pos) {
      // 進路線帶：從投影點沿帶走到這筆的里程（不倒退）。前進量不超過原本車速能走的距離，
      // 落後的部分併進殘差慢慢收，不要一口氣追上去（看起來像暴衝）
      const prevSpeed = this.duration > 0 && this.from && this.to
        ? haversine(this.from.pt, this.to.pt) / this.duration : 0 // 公尺/毫秒
      const proj = Math.min(next.distanceM, this.projectDist(shown, next.distanceM))
      const d = prevSpeed > 0 ? Math.max(proj, next.distanceM - prevSpeed * 1.2 * dur) : proj
      const startPt = this.positionAt(d)
      this.from = { ...next, distanceM: d, pt: startPt, bearing: shownBrg, pos: undefined, timestamp: next.timestamp - dur }
      this.to = next
      this.blend = { dx: shown[0] - startPt[0], dy: shown[1] - startPt[1], dBrg: 0, start: now, dur: SWITCH_BLEND_MS }
      this.started = now
      this.duration = dur
      return true
    }
    if (next.pos) {
      // 改畫實際座標（離開路線帶，或在路網貼合之間）：從畫面位置直線補間，限速
      this.from = { ...current, pos: shown, pt: shown, bearing: shownBrg }
      this.to = next
      this.blend = null
      this.started = now
      this.duration = capped(haversine(shown, next.pt))
      return true
    }
    return false
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
    const k = this.blendK(now)
    const pt: [number, number] = this.blend
      ? [s.pt[0] + this.blend.dx * k, s.pt[1] + this.blend.dy * k] : s.pt
    const bearing = this.blend ? (s.bearing + this.blend.dBrg * k + 360) % 360 : s.bearing
    const fix: GpsDisplayFix = { distanceM: s.distanceM, bearing, elevM: s.elevM, timestamp: s.timestamp }
    return { fix, pos: pt,
      moving: k > 0 || s.t < 1 && (Math.abs(to.distanceM - from.distanceM) > 0.01 ||
        haversine(from.pt, to.pt) > 0.01 ||
        Math.abs(angleDelta(from.bearing, to.bearing)) > 0.1 ||
        Math.abs(to.elevM - from.elevM) > 0.01) }
  }
}
