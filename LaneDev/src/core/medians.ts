// 分隔島（Enhancement Layer，設計見 nav_simulator/路上元件擴充設計.md §2）
//
// v1 = Case B（成對單行 way 之間的實體分隔帶，如大學南路 大學西路~大學東路段）：
// OSM 把有實體分隔的路畫成一對 oneway，「成對」本身就是分隔島存在的證據——
// 島面自動從幾何推導（兩線間隙 − 兩側路面半寬），不需要人工標註；
// 與其他道路相交的節點附近自動斷開（路口 = 開口，設計 §2.3 預設）。
// 路由不用改：couplet 中段本來就沒有穿越邊。
// Case A（單一雙向 way 上的島 + 封閉節點轉向限制）待後續。
import type { Feature, FeatureCollection } from 'geojson'
import { bearing, angleDelta, cumulative, pointAlong, offsetMeters, COS_LAT } from './geo'
import type { RoadFeature } from './roads'
import type { RoadGraph } from './graph'
import type { EnhancementRecord } from './enhancements'
import { offsetAt, subtract, type TurnBay } from './turnbays'

/** 實驗範圍：先在大學南路驗證（Case B 自動推導對所有分離幹道通用，驗證後放大） */
export const MEDIAN_SCOPE_ROADS = new Set(['大學南路'])

/** 主慢分離道路（每向 tertiary 主線＋residential 慢車道並排）：
 * pipeline 只 couplet 合併主線；快慢之間的分隔島由 buildSlowLaneIslands 自動鋪。
 * 放這裡（而非 pipeline.ts）是因為 pipeline 已 import medians，反向會循環。 */
export const MAINLINE_ONLY_ROADS = new Set(['外環西路', '德民路'])

const KX = 111320 * COS_LAT
const KY = 110540
const PAIR_MAX_M = 35 // 綠帶較寬的分離幹道，間隙上限放寬
const SAMPLE_M = 4
const JUNCTION_CLEAR_M = 8 // 路口節點前後淨空（島在路口斷開 = 開口）

export interface MedianIsland {
  key: string // median/way/W/k（W = 取樣側 way）
  polygon: [number, number][]
  /** 顯式配對島（TWIN_ISLAND_PAIRS）：journal 覆寫鍵 twin/A-B——可編輯 */
  pairKey?: string
  /** 目前生效的固定島寬（undefined = 鋪滿實際間隙） */
  wEff?: number
}

function projectToLine(p: [number, number], cs: [number, number][]):
  { d: number; pos: [number, number] } {
  let best = { d: Infinity, pos: cs[0] as [number, number] }
  for (let i = 0; i < cs.length - 1; i++) {
    const dx = (cs[i + 1][0] - cs[i][0]) * KX
    const dy = (cs[i + 1][1] - cs[i][1]) * KY
    const px = (p[0] - cs[i][0]) * KX
    const py = (p[1] - cs[i][1]) * KY
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const ex = px - t * dx, ey = py - t * dy
    const d = Math.hypot(ex, ey)
    if (d < best.d) {
      best = {
        d,
        pos: [cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t],
      }
    }
  }
  return best
}

const wayBearing = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return bearing(cs[0], cs[cs.length - 1])
}

/** scope way 上被「其他道路」引用的節點 → 「靠近路口」判定（島在路口斷開） */
function junctionGuard(roads: RoadFeature[], scopeSet: Set<RoadFeature>) {
  const otherRef = new Set<number>()
  for (const r of roads) {
    if (scopeSet.has(r)) continue
    for (const n of r.properties.nodes) otherRef.add(n)
  }
  const junctions: [number, number][] = []
  for (const w of scopeSet) {
    const cs = w.geometry.coordinates as [number, number][]
    w.properties.nodes.forEach((n, i) => {
      if (otherRef.has(n) && i < cs.length) junctions.push(cs[i])
    })
  }
  return (p: [number, number]) => junctions.some((j) =>
    Math.hypot((p[0] - j[0]) * KX, (p[1] - j[1]) * KY) < JUNCTION_CLEAR_M)
}

/**
 * 兩組 way 之間的島面採樣（buildMedians 與 buildTwinIslands 共用核心）：
 * 沿 As 每 4m 投影到 Bs 最近線，間隙合理才畫，路口附近斷開。
 * fixedW 給定時畫固定寬度、置中於兩路面邊緣之間；否則鋪滿邊緣到邊緣。
 */
function islandsBetween(
  As: RoadFeature[], Bs: RoadFeature[],
  nearJunction: (p: [number, number]) => boolean,
  pairMaxM: number, fixedW?: number,
): MedianIsland[] {
  const out: MedianIsland[] = []
  for (const A of As) {
    const csA = A.geometry.coordinates as [number, number][]
    if (csA.length < 2) continue
    const cum = cumulative(csA)
    const total = cum[cum.length - 1]
    const halfA = A.properties.width_m / 2
    let edgeA: [number, number][] = []
    let edgeB: [number, number][] = []
    let runIdx = 0
    const flush = () => {
      if (edgeA.length >= 2) {
        out.push({
          key: `median/way/${A.properties.osm_id}/${runIdx++}`,
          polygon: [...edgeA, ...[...edgeB].reverse(), edgeA[0]],
        })
      }
      edgeA = []
      edgeB = []
    }
    for (let d = 0; d <= total; d += SAMPLE_M) {
      const { pos: p } = pointAlong(csA, cum, d)
      let best: { d: number; pos: [number, number]; halfB: number } | null = null
      for (const B of Bs) {
        if (B === A || B.geometry.coordinates.length < 2) continue
        const hit = projectToLine(p, B.geometry.coordinates as [number, number][])
        if (hit.d < pairMaxM && (!best || hit.d < best.d)) {
          best = { ...hit, halfB: B.properties.width_m / 2 }
        }
      }
      // 塞不下就不畫（不擠壓——線距不足的正解是 couplet 合併重新展開，見 §2.7）
      const gapW = best ? best.d - halfA - best.halfB : 0
      if (!best || gapW < 0.4 || nearJunction(p) || nearJunction(best.pos)) {
        flush()
        continue
      }
      const ux = (best.pos[0] - p[0]) * KX / best.d
      const uy = (best.pos[1] - p[1]) * KY / best.d
      if (fixedW !== undefined && gapW > fixedW) {
        // 固定島寬：置中於兩路面邊緣之間
        const midM = halfA + gapW / 2
        edgeA.push(offsetMeters(p, ux * (midM - fixedW / 2), uy * (midM - fixedW / 2)))
        edgeB.push(offsetMeters(p, ux * (midM + fixedW / 2), uy * (midM + fixedW / 2)))
      } else {
        edgeA.push(offsetMeters(p, ux * halfA, uy * halfA))
        edgeB.push(offsetMeters(best.pos, -ux * best.halfB, -uy * best.halfB))
      }
    }
    flush()
  }
  return out
}

export function buildMedians(roads: RoadFeature[]): MedianIsland[] {
  const scope = roads.filter((r) =>
    MEDIAN_SCOPE_ROADS.has(r.properties.name ?? '') &&
    r.properties.oneway === 'yes' && r.geometry.coordinates.length >= 2)
  if (scope.length < 2) return []
  const scopeSet = new Set(scope)

  // 依行進方位角分兩組（同 couplet.ts 邏輯）
  const longest = scope.reduce((a, b) =>
    (a.geometry.coordinates as [number, number][]).length >=
    (b.geometry.coordinates as [number, number][]).length ? a : b)
  const ref = wayBearing(longest)
  const g0 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) < 90)
  const g1 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) >= 90)
  if (g0.length === 0 || g1.length === 0) return []

  return islandsBetween(g0, g1, junctionGuard(roads, scopeSet), PAIR_MAX_M)
}

/**
 * 顯式成對 way 分隔島（Case B 的一般化：同向的主線↔慢車道並排也能配對，
 * 不受方位角分組限制）。w = 實地島寬（公尺），省略則鋪滿兩路面邊緣間隙。
 * 高雄大學路 = 四線並排林蔭大道（2026-07-14 實地確認），不做 couplet 合併：
 * 兩段（援中→藍田、藍田→大學南路）樣式統一 = 兩側主慢對 1.6m ＋ 中央大綠帶。
 * 島寬/開關可在編輯模式點島覆寫（journal target type = twin_island, key = twin/A-B）。
 */
const TWIN_ISLAND_PAIRS: { a: number; b: number; w?: number }[] = [
  // ── 南段（援中路→藍田路）──
  { a: 297138325, b: 339750718, w: 1.6 }, // 西側：南向主線↔慢車道
  { a: 24275644, b: 297138319, w: 1.6 },  // 東側：北向主線↔慢車道
  { a: 339750718, b: 24275644 },          // 中央大綠帶（鋪滿實際間隙）
  // ── 北段（藍田路→大學南路）──
  { a: 24275640, b: 339750719, w: 1.6 },  // 西側：南向主線↔慢車道
  { a: 339750719, b: 297138331 },         // 中央大綠帶（鋪滿實際間隙）
  { a: 297138331, b: 297138333, w: 6.4 }, // 東側兩路體（實地 6.4m）
]

const twinKey = (a: number, b: number) => `twin/${a}-${b}`

function foldTwinOverrides(journal: EnhancementRecord[]): Map<string, Record<string, string | number>> {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of journal) {
    if (rec.target.type !== 'twin_island') continue
    if (rec.op === 'delete') out.delete(rec.target.key)
    else out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
  }
  return out
}

export function buildTwinIslands(roads: RoadFeature[], journal: EnhancementRecord[] = []): MedianIsland[] {
  const ids = new Set(TWIN_ISLAND_PAIRS.flatMap((p) => [p.a, p.b]))
  const byId = new Map<number, RoadFeature[]>()
  const scopeSet = new Set<RoadFeature>()
  for (const r of roads) {
    if (!ids.has(r.properties.osm_id)) continue
    if (!byId.has(r.properties.osm_id)) byId.set(r.properties.osm_id, [])
    byId.get(r.properties.osm_id)!.push(r)
    scopeSet.add(r)
  }
  if (scopeSet.size === 0) return []
  const over = foldTwinOverrides(journal)
  const nearJunction = junctionGuard(roads, scopeSet)
  const out: MedianIsland[] = []
  for (const { a, b, w } of TWIN_ISLAND_PAIRS) {
    const key = twinKey(a, b)
    const o = over.get(key)
    if (o && Number(o.present) === 0) continue // 實地確認沒有
    // 覆寫島寬：w > 0 = 固定寬；w <= 0 = 回復「自動鋪滿」
    const ow = o?.w !== undefined ? Number(o.w) : undefined
    const wEff = ow !== undefined ? (ow > 0 ? ow : undefined) : w
    const islands = islandsBetween(byId.get(a) ?? [], byId.get(b) ?? [], nearJunction, 40, wEff)
    for (const m of islands) { m.pairKey = key; m.wEff = wEff }
    out.push(...islands)
  }
  return out
}

/**
 * 主慢分離道路的快慢分隔島（自動推導，Case B 的變體）：couplet 只合併了
 * tertiary 主線（雙向化），residential 慢車道原樣保留在兩側——沿每條慢車道
 * 採樣、投影到合併後主線，鋪滿兩路面邊緣間隙；路口/巷口節點附近自動斷開
 * （慢車道接側街處 = 開口）。間隙塞不下（<0.4m）不畫，不擠壓。
 */
export function buildSlowLaneIslands(roads: RoadFeature[]): MedianIsland[] {
  const out: MedianIsland[] = []
  for (const name of MAINLINE_ONLY_ROADS) {
    const mains = roads.filter((r) => r.properties.name === name
      && r.properties.coupletMerged && r.properties.oneway === 'no'
      && r.geometry.coordinates.length >= 2)
    const slows = roads.filter((r) => r.properties.name === name
      && r.properties.oneway === 'yes' && r.geometry.coordinates.length >= 2)
    if (!mains.length || !slows.length) continue
    const scopeSet = new Set([...mains, ...slows])
    out.push(...islandsBetween(slows, mains, junctionGuard(roads, scopeSet), 25))
  }
  return out
}

/**
 * Case A 島（可編輯）：雙向 way 設定中央帶（centerM > 0）且類型 = island
 * （車道編輯面板「分隔島」，journal 欄位 center_kind）。
 * 島面鋪滿中央帶的非 bay 區間——偏心道照常在路口前切進島（實地就是讓位），
 * 兩端依交叉路半寬收邊。轉向封鎖（Case A 的路網語意）留待 turn_restriction 統一。
 */
export function buildCenterIslands(graph: RoadGraph, bays: TurnBay[]): MedianIsland[] {
  const bayMap = new Map(bays.map((b) => [`${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`, b]))
  const out: MedianIsland[] = []
  const edges = graph.scopeEdges((r) =>
    r.properties.oneway === 'no' && (r.properties.centerM || 0) > 0 &&
    r.properties.centerKind === 'island')
  for (const e of edges) {
    if (e.back) continue // 以順向 frame 統一處理一次
    const p = e.road.properties
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const s0 = Math.min(e.startSetbackM, total)
    const s1 = Math.max(0, total - e.endSetbackM)
    if (s1 - s0 < 3) continue
    const dv = p.divOffM || 0
    const c = p.centerM / 2
    const fwdBay = bayMap.get(`${p.osm_id}@${e.toNode}`)
    const bwdBay = bayMap.get(`${p.osm_id}@${e.fromNode}~b`)
    let ivs: [number, number][] = [[s0, s1]]
    if (fwdBay) ivs = ivs.flatMap((iv) => subtract(iv, [fwdBay.d0M, fwdBay.endM]))
    if (bwdBay) ivs = ivs.flatMap((iv) => subtract(iv, [total - bwdBay.endM, total - bwdBay.d0M]))
    let k = 0
    for (const [a, b] of ivs) {
      if (b - a < 3) continue
      const ds: number[] = []
      for (let d = a; d < b; d += 4) ds.push(d)
      ds.push(b)
      const left = ds.map((d) => offsetAt(e.coords, cum, d, dv - c))
      const right = ds.map((d) => offsetAt(e.coords, cum, d, dv + c))
      out.push({
        key: `median/way/${p.osm_id}/A${k++}`,
        polygon: [...left, ...[...right].reverse(), left[0]],
      })
    }
  }
  return out
}

export function mediansToGeoJSON(islands: MedianIsland[]): FeatureCollection {
  const features: Feature[] = islands.map((m) => ({
    type: 'Feature',
    properties: { kind: 'island', key: m.key, pairKey: m.pairKey, wEff: m.wEff },
    geometry: { type: 'Polygon', coordinates: [m.polygon] },
  }))
  return { type: 'FeatureCollection', features }
}
