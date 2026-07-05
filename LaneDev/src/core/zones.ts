// 待轉區（Enhancement Layer）——v2 模型：
// 不再自由放置。一個待轉區 = 「某路口 + 從哪個行向進入 + 左轉往哪個行向」，
// 位置由路口幾何自動計算（穿過路口後的右前方、對齊出口行向），
// 使用者的自由度只在「選路口、選哪個左轉配對」。
import type { Feature, FeatureCollection } from 'geojson'
import { offsetMeters } from './geo'
import type { TurnOption } from './graph'

export interface Zone {
  id: string
  intersectionId: number
  center: [number, number] // 由 planZone 算出的固定位置
  bearing: number // 待轉格朝向 = 左轉後的行向
  w: number
  d: number
  from: { name?: string; bearing: number } // 進入路口的行向（觸發比對用）
  to: { name?: string; bearing: number }
}

const STORAGE_KEY = 'navsim-zones-v2' // v1 是自由放置的舊格式，直接棄用

export function loadZones(): Zone[] {
  try {
    const zs: Zone[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return zs.filter((z) => z.intersectionId && z.from)
  } catch {
    return []
  }
}

export function saveZones(zones: Zone[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(zones))
}

/**
 * 由左轉配對計算待轉格的固定位置：
 * 沿進入行向穿過路口（越過交叉道路的一半寬 + 緩衝），靠進入方向的右側路緣，
 * 格子朝向 = 左轉後的行向（騎士在格內面向即將行駛的方向）。
 */
export function planZone(opt: TurnOption): Zone {
  const φ = (opt.fromBearing * Math.PI) / 180
  const f = [Math.sin(φ), Math.cos(φ)] // 進入行向單位向量
  const r = [Math.cos(φ), -Math.sin(φ)] // 右側
  const d1 = opt.toWidth / 2 + 2.2 // 越過交叉路
  const d2 = Math.max(1.2, opt.fromWidth / 2 - 2.4) // 靠右路緣
  const center = offsetMeters(
    opt.pos,
    d1 * f[0] + d2 * r[0],
    d1 * f[1] + d2 * r[1],
  )
  return {
    id: `zone-${Date.now().toString(36)}`,
    intersectionId: opt.nodeId,
    center,
    bearing: opt.toBearing,
    w: 4.2,
    d: 2.8,
    from: { name: opt.fromName, bearing: opt.fromBearing },
    to: { name: opt.toName, bearing: opt.toBearing },
  }
}

export function zonePolygon(z: Zone): [number, number][] {
  const φ = (z.bearing * Math.PI) / 180
  const f = [Math.sin(φ), Math.cos(φ)]
  const r = [Math.cos(φ), -Math.sin(φ)]
  const corner = (sw: number, sd: number) =>
    offsetMeters(
      z.center,
      (sw * z.w * r[0] + sd * z.d * f[0]) / 2,
      (sw * z.w * r[1] + sd * z.d * f[1]) / 2,
    )
  const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  return [...c, c[0]]
}

/** 待轉區 GeoJSON：每個 zone 一個 Polygon（框）+ 一個 Point（文字標籤） */
export function zonesToGeoJSON(zones: Zone[], selectedId: string | null): FeatureCollection {
  const features: Feature[] = []
  for (const z of zones) {
    const selected = z.id === selectedId
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected },
      geometry: { type: 'Polygon', coordinates: [zonePolygon(z)] },
    })
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected, bearing: z.bearing },
      geometry: { type: 'Point', coordinates: z.center },
    })
  }
  return { type: 'FeatureCollection', features }
}
