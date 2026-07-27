// 待轉區（Enhancement Layer）——v2 模型：
// 不再自由放置。一個待轉區 = 「某路口 + 從哪個行向進入 + 左轉往哪個行向」，
// 位置由路口幾何自動計算（穿過路口後的右前方、對齊出口行向），
// 使用者的自由度只在「選路口、選哪個左轉配對」。
import type { Feature, FeatureCollection } from 'geojson'
import {
  angleDelta, bearing, cumulative, offsetMeters, pointAlong, skewFromCross,
} from './geo'
import { laneSpanM } from './roads'
import type { RoadGraph, ScopeEdge, TurnOption } from './graph'

export interface Zone {
  id: string
  intersectionId: number
  center: [number, number] // 由 planZone 算出的固定位置
  bearing: number // 待轉格朝向 = 左轉後的行向
  w: number
  d: number
  /** 是否顯示此待轉格；獨立於道路標線的 all/center/none 模式。 */
  /** false = 完全停用：不繪製，也不可供路線規劃或導航提示使用。 */
  visible?: boolean
  /** 人工微調以初始位置為基準，限制在路口附近。 */
  baseCenter?: [number, number]
  lateralOffsetM?: number
  forwardOffsetM?: number
  baseBearing?: number
  rotationDeg?: number
  shape?: 'rectangle' | 'square' | 'parallelogram'
  shapeSkew?: number
  /** 斜交路口的停止線 skew 係數（橫向偏移 o 的縱向平移 = o×sk）；
   * 格子前後緣沿用同一係數，與停止線平行。舊資料無此欄位 = 0（正矩形） */
  sk?: number
  from: { name?: string; bearing: number } // 進入路口的行向（觸發比對用）
  to: { name?: string; bearing: number }
}

/** 舊資料沒有 visible 欄位時維持啟用；false 代表整個功能停用，不只是隱藏。 */
export function isZoneEnabled(zone: Zone): boolean {
  return zone.visible !== false
}

const STORAGE_KEY = 'navsim-zones-v2' // v1 是自由放置的舊格式，直接棄用
const DELETED_STORAGE_KEY = 'navsim-zones-deleted-v1'

export function loadZones(): Zone[] {
  try {
    const zs: Zone[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return zs.filter((z) => z.intersectionId && z.from)
      .map((z) => ({ ...z, visible: z.visible !== false }))
  } catch {
    return []
  }
}

export function saveZones(zones: Zone[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(zones))
}

/** 記錄使用者明確刪除的靜態匯入待轉格，避免下次啟動被自動匯入復活。 */
export function loadDeletedZoneIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function markZoneDeleted(id: string) {
  const ids = loadDeletedZoneIds()
  ids.add(id)
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...ids]))
}

/** 停止線對齊定位用的幾何上下文：進入路口的方向邊索引。
 * scopeEdges 全量掃一次不便宜——批次匯入（LanePilot 標註）建一次重複用。 */
export interface ZoneCtx {
  graph: RoadGraph
  byToNode: Map<number, ScopeEdge[]>
}

export function makeZoneCtx(graph: RoadGraph): ZoneCtx {
  const byToNode = new Map<number, ScopeEdge[]>()
  for (const e of graph.scopeEdges(() => true)) {
    let arr = byToNode.get(e.toNode)
    if (!arr) byToNode.set(e.toNode, (arr = []))
    arr.push(e)
  }
  return { graph, byToNode }
}

/**
 * 由左轉配對計算待轉格的位置。優先「停止線對齊」（有 ctx 且找得到交叉路
 * approach）：實際待轉區畫在「左轉後行向的來車 approach」停止線之前（路口側）、
 * 靠出口方向右緣——即進入方向的右前角；寬深依該 approach 的車道塊寬與交叉路
 * 半寬縮放，斜交路口與停止線共用 skew。找不到（丁字路口對向無來路等）退回
 * 幾何近似：沿進入行向穿過路口、靠右路緣的固定尺寸格。
 */
export function planZone(opt: TurnOption, ctx?: ZoneCtx): Zone {
  const aligned = ctx && planZoneAtStopLine(opt, ctx)
  if (aligned) return aligned
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

/** 停止線對齊：找「沿左轉後行向進入本路口」的交叉路 approach 邊，
 * 格子放在其停止線（total − endSetbackM，同 buildStopLines）前 0.5m 的路口側，
 * 右緣貼該向車道塊外緣。 */
function planZoneAtStopLine(opt: TurnOption, ctx: ZoneCtx): Zone | null {
  let best: { e: ScopeEdge; err: number } | null = null
  for (const e of ctx.byToNode.get(opt.nodeId) ?? []) {
    const c = e.coords
    const brg = bearing(c[c.length - 2], c[c.length - 1])
    const err = Math.abs(angleDelta(brg, opt.toBearing))
    if (err < 40 && (!best || err < best.err)) best = { e, err }
  }
  if (!best) return null
  const e = best.e
  const p = e.road.properties
  const span = laneSpanM(p, e.back)
  if (span <= 0) return null
  const cum = cumulative(e.coords)
  const total = cum[cum.length - 1]
  const dStop = total - e.endSetbackM
  if (dStop < 1) return null // approach 太短（停止線都擠不下），退回幾何近似
  // 橫向定位同 buildStopLines：車道塊 [base, base+span]，右緣即停止線外端
  const dv = 0
  const base = p.oneway === 'yes' ? -span / 2 : dv + (p.centerM || 0) / 2
  const w = Math.max(2.4, Math.min(span, 6.4) - 0.4) // 寬：貼車道塊、上限兩車道
  const oCenter = base + span - 0.3 - w / 2
  // 深：交叉路（= 進入方向那條路）半寬的六成，夾在機車實際使用的 2.2~3.2m
  const d = Math.max(2.2, Math.min(3.2, (e.endSetbackM - 1.2) * 0.6))
  const stop = pointAlong(e.coords, cum, dStop)
  const cross = ctx.graph.crossOrientationAt(opt.nodeId, stop.brg, e.road)
  const sk = cross === null ? 0 : skewFromCross(stop.brg, cross)
  // 錨點 = 停止線上（含 skew）橫向 oCenter 處，再沿行向前推間隙 + 半深
  const a = pointAlong(e.coords, cum, Math.max(0, Math.min(total, dStop + sk * oCenter)))
  const φr = ((stop.brg + 90) * Math.PI) / 180
  const anchor = offsetMeters(a.pos, oCenter * Math.sin(φr), oCenter * Math.cos(φr))
  const φf = (stop.brg * Math.PI) / 180
  const adv = 0.5 + d / 2
  return {
    id: `zone-${Date.now().toString(36)}`,
    intersectionId: opt.nodeId,
    center: offsetMeters(anchor, adv * Math.sin(φf), adv * Math.cos(φf)),
    bearing: stop.brg,
    w,
    d,
    sk,
    from: { name: opt.fromName, bearing: opt.fromBearing },
    to: { name: opt.toName, bearing: opt.toBearing },
  }
}

export function zonePolygon(z: Zone): [number, number][] {
  const φ = (z.bearing * Math.PI) / 180
  const f = [Math.sin(φ), Math.cos(φ)]
  const r = [Math.cos(φ), -Math.sin(φ)]
  const shape = z.shape ?? (Math.abs(z.sk ?? 0) > 0.04 ? 'parallelogram' : 'rectangle')
  const depth = shape === 'square' ? z.w : z.d
  const skew = shape === 'parallelogram' ? (z.shapeSkew ?? z.sk ?? 0.25) : 0
  const corner = (sw: number, sd: number) => {
    const lat = (sw * z.w) / 2
    const lon = (sd * depth) / 2 + skew * lat
    return offsetMeters(z.center, lat * r[0] + lon * f[0], lat * r[1] + lon * f[1])
  }
  const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  return [...c, c[0]]
}

/** 待轉區 GeoJSON：面、兩層實際公尺寬外框，以及貼地文字錨點。 */
export function zonesToGeoJSON(
  zones: Zone[],
  selectedId: string | null,
  highlightedId: string | null = null,
): FeatureCollection {
  const features: Feature[] = []
  for (const z of zones) {
    if (!isZoneEnabled(z)) continue
    const selected = z.id === selectedId
    const highlighted = z.id === highlightedId
    const polygon = zonePolygon(z)
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected, highlighted, kind: 'fill' },
      geometry: { type: 'Polygon', coordinates: [polygon] },
    })
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected, highlighted, kind: 'outline-casing' },
      geometry: { type: 'LineString', coordinates: polygon },
    })
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected, highlighted, kind: 'outline' },
      geometry: { type: 'LineString', coordinates: polygon },
    })
    features.push({
      type: 'Feature',
      properties: { id: z.id, selected, highlighted, kind: 'label', bearing: z.bearing },
      geometry: { type: 'Point', coordinates: z.center },
    })
  }
  return { type: 'FeatureCollection', features }
}
