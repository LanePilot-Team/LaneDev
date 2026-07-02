// 地理計算工具。楠梓區緯度 ~22.73，公尺→像素換算用固定 cos(lat) 即可。
import type { ExpressionSpecification } from 'maplibre-gl'

export const NANZI_CENTER: [number, number] = [120.2986, 22.7280]
export const COS_LAT = Math.cos((22.73 * Math.PI) / 180)
export const LANE_WIDTH_M = 3.2

const toRad = (d: number) => (d * Math.PI) / 180

export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** 方位角（度，0=北，順時針） */
export function bearing(a: [number, number], b: [number, number]): number {
  const λ1 = toRad(a[0]), φ1 = toRad(a[1])
  const λ2 = toRad(b[0]), φ2 = toRad(b[1])
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1)
  return (Math.atan2(y, x) * 180) / Math.PI < 0
    ? (Math.atan2(y, x) * 180) / Math.PI + 360
    : (Math.atan2(y, x) * 180) / Math.PI
}

/** 把 (東 dx, 北 dy) 公尺位移加到座標上 */
export function offsetMeters(c: [number, number], dx: number, dy: number): [number, number] {
  return [c[0] + dx / (111320 * COS_LAT), c[1] + dy / 110540]
}

/** 角度差正規化到 (-180, 180]，正值 = 右轉 */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/** 某 zoom 下 1 公尺等於幾像素（512px tile） */
export function pxPerMeter(zoom: number): number {
  return Math.pow(2, zoom + 9) / (40075016.686 * COS_LAT)
}

/**
 * 「實際公尺寬」的 line-width 表達式：路面/車道線隨 zoom 保持真實比例。
 * metersExpr 可以是常數或 data-driven 表達式（單位公尺）。
 */
export function widthMeters(metersExpr: number | ExpressionSpecification): ExpressionSpecification {
  const m = (z: number): ExpressionSpecification | number =>
    typeof metersExpr === 'number'
      ? metersExpr * pxPerMeter(z)
      : (['*', metersExpr, pxPerMeter(z)] as ExpressionSpecification)
  return ['interpolate', ['exponential', 2], ['zoom'], 10, m(10), 24, m(24)]
}

/** 沿折線走 dist 公尺後的位置與方位角（用預先累積的距離表） */
export function pointAlong(
  coords: [number, number][],
  cum: number[],
  dist: number,
): { pos: [number, number]; brg: number; idx: number } {
  const total = cum[cum.length - 1]
  const d = Math.max(0, Math.min(dist, total))
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  const segLen = cum[i] - cum[i - 1]
  const t = segLen > 0 ? (d - cum[i - 1]) / segLen : 0
  const a = coords[i - 1], b = coords[i]
  return {
    pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    brg: bearing(a, b),
    idx: i,
  }
}

export function cumulative(coords: [number, number][]): number[] {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]))
  return cum
}
