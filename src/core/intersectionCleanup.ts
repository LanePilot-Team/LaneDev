import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson'
import { haversine } from './geo'
import type { RoadFeature } from './roads'

export const CLEAN_INTERSECTIONS = [
  {
    key: 'kaohsiung-university-yuanzhong',
    center: [120.28617, 22.723287] as [number, number],
    bearing: 68,
    // 沿援中路方向涵蓋高雄大學路四線道路體；橫向只涵蓋援中路本身。
    alongMinM: -26, alongMaxM: 24, acrossMinM: -7, acrossMaxM: 20,
  },
]

export const inIntersectionCleanup = (p: [number, number]) =>
  CLEAN_INTERSECTIONS.some((z) => {
    const east = (p[0] - z.center[0]) * 111320 * Math.cos(22.73 * Math.PI / 180)
    const north = (p[1] - z.center[1]) * 110540
    const rad = z.bearing * Math.PI / 180
    const along = east * Math.sin(rad) + north * Math.cos(rad)
    const across = east * Math.cos(rad) - north * Math.sin(rad)
    return along >= z.alongMinM && along <= z.alongMaxM &&
      across >= z.acrossMinM && across <= z.acrossMaxM
  })

function segmentTouchesCleanup(a: [number, number], b: [number, number]) {
  const n = Math.max(1, Math.ceil(haversine(a, b)))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (inIntersectionCleanup([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return true
  }
  return false
}

export function roadsWithCleanupFlags(roads: RoadFeature[]): RoadFeature[] {
  return roads.map((r) => {
    const cs = r.geometry.coordinates as [number, number][]
    const hit = cs.some((p) => inIntersectionCleanup(p)) ||
      cs.slice(1).some((p, i) => segmentTouchesCleanup(cs[i], p))
    return hit ? { ...r, properties: { ...r.properties, hideIntersectionInfo: true } } : r
  })
}

/** 清空區的經緯度外框（各向外留 40 m，大於任一清空區中心到角落的距離） */
const CLEANUP_BOXES = CLEAN_INTERSECTIONS.map((z) => {
  const margin = Math.hypot(
    Math.max(-z.alongMinM, z.alongMaxM), Math.max(-z.acrossMinM, z.acrossMaxM)) + 10
  const dLon = margin / (111320 * Math.cos(22.73 * Math.PI / 180))
  const dLat = margin / 110540
  return {
    minLon: z.center[0] - dLon, maxLon: z.center[0] + dLon,
    minLat: z.center[1] - dLat, maxLat: z.center[1] + dLat,
  }
})

/**
 * 路口清空：把線上落在清空區內的部分挖掉。
 * 只有外框碰到清空區的線才每 0.5 m 取樣判斷；其餘（全圖幾乎所有線）原樣回傳。
 * 以前是每條線都加密成 0.5 m 一點並把加密點留在輸出，分隔線因此膨脹到 120 MB，
 * MapLibre setData 在主執行緒序列化它要好幾秒（補算後拖地圖的主要卡頓）。
 */
function clipLine(coords: [number, number][]): [number, number][][] {
  if (coords.length < 2) return []
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  const near = CLEANUP_BOXES.some((b) =>
    maxLon >= b.minLon && minLon <= b.maxLon && maxLat >= b.minLat && minLat <= b.maxLat)
  if (!near) return [coords]
  const dense: [number, number][] = []
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i]
    const n = Math.max(1, Math.ceil(haversine(a, b) / 0.5))
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  const runs: [number, number][][] = []
  let run: [number, number][] = []
  let clipped = false
  const flush = () => { if (run.length >= 2) runs.push(run); run = [] }
  for (const p of dense) {
    if (inIntersectionCleanup(p)) {
      clipped = true
      flush()
    } else run.push(p)
  }
  flush()
  // 靠近但沒有真的進入清空區：原線即可，不必帶加密點
  return clipped ? runs : [coords]
}

export function cleanIntersectionFeatures(fc: FeatureCollection): FeatureCollection {
  const features: Feature[] = []
  for (const f of fc.features) {
    // 左轉待轉區本來就刻意畫在路口內，不可被一般「清空路口標線」流程裁掉。
    if (f.properties?.style === 'left-wait-side'
      || f.properties?.style === 'left-wait-front') {
      features.push(f)
      continue
    }
    const g = f.geometry as Geometry | null
    if (!g) continue
    if (g.type === 'Point') {
      if (!inIntersectionCleanup(g.coordinates as [number, number])) features.push(f)
    } else if (g.type === 'LineString') {
      for (const coords of clipLine(g.coordinates as [number, number][])) {
        features.push({ ...f, geometry: { type: 'LineString', coordinates: coords } as LineString })
      }
    } else features.push(f)
  }
  return { type: 'FeatureCollection', features }
}
