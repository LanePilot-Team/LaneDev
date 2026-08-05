// 分隔島（Enhancement Layer，設計見 nav_simulator/路上元件擴充設計.md §2）
//
// v1 = Case B（成對單行 way 之間的實體分隔帶，如大學南路 大學西路~大學東路段）：
// OSM 把有實體分隔的路畫成一對 oneway，「成對」本身就是分隔島存在的證據——
// 島面自動從幾何推導（兩線間隙 − 兩側路面半寬），不需要人工標註；
// 與其他道路相交的節點附近自動斷開（路口 = 開口，設計 §2.3 預設）。
// 路由不用改：couplet 中段本來就沒有穿越邊。
// Case A（單一雙向 way 上的島 + 封閉節點轉向限制）待後續。
import type { Feature, FeatureCollection } from 'geojson'
import { buffer, difference, featureCollection, lineString, polygon } from '@turf/turf'
import { bearing, angleDelta, cumulative, pointAlong, offsetMeters, COS_LAT, LANE_WIDTH_M } from './geo'
import { laneSpanM, manualMarkingSetbackM, type RoadFeature } from './roads'
import type { RoadGraph } from './graph'
import type { EnhancementRecord } from './enhancements'
import { offsetAt, subtract, type TurnBay } from './turnbays'

/** 實驗範圍：先在大學南路驗證（Case B 自動推導對所有分離幹道通用，驗證後放大） */
export const MEDIAN_SCOPE_ROADS = new Set(['大學南路'])


const KX = 111320 * COS_LAT
const KY = 110540
const PAIR_MAX_M = 35 // 綠帶較寬的分離幹道，間隙上限放寬
const SAMPLE_M = 4
const MIN_ISLAND_M = 8
/** 兩端都延續到隔壁路段的連續島面沒有最小長度可言，只擋退化幾何。 */
const MIN_JOINED_ISLAND_M = 0.5
/** 貫通接點兩側島面的重疊長度（公尺）：兩個多邊形端面方位角不同，需重疊補縫。 */
const CENTER_ISLAND_JOIN_OVERLAP_M = 0.6
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
export function medianJunctionGuard(roads: RoadFeature[], scopeSet: Set<RoadFeature>) {
  const mergeThroughNodes = new Set<number>()
  for (const road of scopeSet) {
    for (const node of road.properties.oneSideEntryNodes ?? []) {
      mergeThroughNodes.add(node)
    }
  }
  const otherRef = new Map<number, number>()
  for (const r of roads) {
    if (scopeSet.has(r)) continue
    for (const n of r.properties.nodes) {
      // 捏合接縫保留側路拓撲，但中央島在此沒有開口；側路端點仍由自己的
      // road-surface／停止線規則收邊，不能反過來切斷主路中央島。
      if (mergeThroughNodes.has(n)) continue
      otherRef.set(n, Math.max(otherRef.get(n) ?? 0, r.properties.width_m))
    }
  }
  const junctions: { pos: [number, number]; clearM: number }[] = []
  for (const w of scopeSet) {
    const cs = w.geometry.coordinates as [number, number][]
    w.properties.nodes.forEach((n, i) => {
      const crossW = otherRef.get(n) ?? 0
      if (crossW > 0 && i < cs.length) {
        junctions.push({ pos: cs[i], clearM: Math.max(JUNCTION_CLEAR_M, crossW / 2 + 2) })
      }
    })
  }
  return (p: [number, number]) => junctions.some((j) =>
    Math.hypot((p[0] - j.pos[0]) * KX, (p[1] - j.pos[1]) * KY) < j.clearM)
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
    let runStart = 0
    let runEnd = 0
    let runIdx = 0
    const flush = () => {
      if (edgeA.length >= 2 && runEnd - runStart >= MIN_ISLAND_M) {
        out.push({
          key: `median/way/${A.properties.osm_id}/${runIdx++}`,
          polygon: [...edgeA, ...[...edgeB].reverse(), edgeA[0]],
        })
      }
      edgeA = []
      edgeB = []
    }
    const samples: number[] = []
    for (let d = 0; d < total; d += SAMPLE_M) samples.push(d)
    samples.push(total)
    for (const d of samples) {
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
      if (edgeA.length === 0) runStart = d
      runEnd = d
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

/**
 * 以真實道路面裁切完整綠化帶。相較用 junctionGuard 整段挖空，差集只移除
 * 橫向道路實際佔用的多邊形，路口四角與不規則空隙仍由綠化帶填滿。
 */
function subtractRoadSurfaces(
  islands: MedianIsland[], roads: RoadFeature[], scopeSet: Set<RoadFeature>,
): MedianIsland[] {
  const out: MedianIsland[] = []
  for (const island of islands) {
    const xs = island.polygon.map((p) => p[0]), ys = island.polygon.map((p) => p[1])
    const padX = 4 / KX, padY = 4 / KY
    const box = {
      minX: Math.min(...xs) - padX, maxX: Math.max(...xs) + padX,
      minY: Math.min(...ys) - padY, maxY: Math.max(...ys) + padY,
    }
    let pieces = [polygon([island.polygon])]
    for (const road of roads) {
      if (scopeSet.has(road) || pieces.length === 0) continue
      const cs = road.geometry.coordinates as [number, number][]
      if (cs.length < 2) continue
      const rxs = cs.map((p) => p[0]), rys = cs.map((p) => p[1])
      if (Math.max(...rxs) < box.minX || Math.min(...rxs) > box.maxX ||
          Math.max(...rys) < box.minY || Math.min(...rys) > box.maxY) continue
      const surface = buffer(lineString(cs), road.properties.width_m / 2 + 0.2, { units: 'meters' })
      if (!surface) continue
      const next: typeof pieces = []
      for (const piece of pieces) {
        const cut = difference(featureCollection([piece, surface]))
        if (!cut) continue
        if (cut.geometry.type === 'Polygon') next.push(polygon(cut.geometry.coordinates))
        else for (const coords of cut.geometry.coordinates) next.push(polygon(coords))
      }
      pieces = next
    }
    pieces.forEach((piece, i) => {
      const ring = piece.geometry.coordinates[0] as [number, number][]
      if (ring.length >= 4) out.push({ ...island, key: `${island.key}/clip${i}`, polygon: ring })
    })
  }
  return out
}

export function buildMedians(roads: RoadFeature[]): MedianIsland[] {
  const scope = roads.filter((r) =>
    MEDIAN_SCOPE_ROADS.has(r.properties.name ?? '') &&
    r.properties.roadMarkingMode !== 'none' &&
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

  return islandsBetween(g0, g1, medianJunctionGuard(roads, scopeSet), PAIR_MAX_M)
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
    if (r.properties.roadMarkingMode === 'none') continue
    if (!byId.has(r.properties.osm_id)) byId.set(r.properties.osm_id, [])
    byId.get(r.properties.osm_id)!.push(r)
    scopeSet.add(r)
  }
  if (scopeSet.size === 0) return []
  const over = foldTwinOverrides(journal)
  const out: MedianIsland[] = []
  for (const { a, b, w } of TWIN_ISLAND_PAIRS) {
    const key = twinKey(a, b)
    const o = over.get(key)
    if (o && Number(o.present) === 0) continue // 實地確認沒有
    // 覆寫島寬：w > 0 = 固定寬；w <= 0 = 回復「自動鋪滿」
    const ow = o?.w !== undefined ? Number(o.w) : undefined
    const wEff = ow !== undefined ? (ow > 0 ? ow : undefined) : w
    const full = islandsBetween(byId.get(a) ?? [], byId.get(b) ?? [], () => false, 40, wEff)
    const islands = subtractRoadSurfaces(full, roads, scopeSet)
    for (const m of islands) { m.pairKey = key; m.wEff = wEff }
    out.push(...islands)
  }
  return out
}

/** 綠化帶專用路口退縮：只有該行向確實可左／右轉時，才為較窄的支路額外留口。 */
function islandSetbacks(graph: RoadGraph, e: ReturnType<RoadGraph['scopeEdges']>[number], total: number) {
  // road_merge 的 oneSideEntryNodes 對導航仍是可互動節點，但對承載它的主路
  // 只是連續道路中的側街入口；中央島不可在此被當成完整路口切斷。
  // 現地指定的中央島貫通接點（centerIslandJoinNodes）同理：島面在此不斷開，
  // 差別只在兩段道路沒有被捏合成一段，所以要各自畫到接點。
  const joined = (node: number) =>
    e.road.properties.centerIslandJoinNodes?.includes(node) ?? false
  const mergeThroughStart = joined(e.fromNode)
    || ((e.road.properties.oneSideEntryNodes?.includes(e.fromNode) ?? false)
      && graph.hasDistinctRoadAt(e.fromNode, e.road))
  const mergeThroughEnd = joined(e.toNode)
    || ((e.road.properties.oneSideEntryNodes?.includes(e.toNode) ?? false)
      && graph.hasDistinctRoadAt(e.toNode, e.road))
  const startBrg = bearing(e.coords[1], e.coords[0])
  const endBrg = bearing(e.coords[e.coords.length - 2], e.coords[e.coords.length - 1])
  const extra = (node: number, brg: number) => {
    const turns = graph.exitKindsAt(node, brg)
    if (!turns.has('left') && !turns.has('right')) return 0
    const w = graph.crossWidthAt(node, brg, e.road)
    return w > 0 ? w / 2 + 2 : 0
  }
  return {
    s0: mergeThroughStart
      ? 0 : Math.min(Math.max(e.startSetbackM, extra(e.fromNode, startBrg)), total),
    s1: mergeThroughEnd
      ? total : Math.max(0, total - Math.max(e.endSetbackM, extra(e.toNode, endBrg))),
    /** 該端的島面是否延續到隔壁路段（接縫或貫通接點），而不是在路口收邊 */
    throughStart: mergeThroughStart,
    throughEnd: mergeThroughEnd,
  }
}

/**
 * 快慢分隔島（斷面內建，可編輯）：某行向 motoSep > 0 時，汽車車道與機車道之間
 * 的實體島——島面鋪在 [車道塊內緣＋車道寬, ＋motoSep] 的橫向區間，兩端依交叉路
 * 半寬收邊（同停止線 setback，路口 = 開口）。寬度/開關走車道編輯面板的
 * journal 欄位 moto_sep_f/b（=0 回復機車道白線）。
 */
export function buildMotoSepIslands(graph: RoadGraph): MedianIsland[] {
  const out: MedianIsland[] = []
  const edges = graph.scopeEdges((r) => {
    const p = r.properties
    if (p.roadMarkingMode === 'none') return false
    return (p.motoF && (p.motoSepF || 0) > 0)
      || (p.oneway === 'no' && p.motoB && (p.motoSepB || 0) > 0)
  })
  for (const e of edges) {
    const p = e.road.properties
    // 現地指定例外：這些精確路段是白色槽化帶，不建立實體分隔島。
    // 白色槽化標線由 turnbays.buildSpecifiedWhiteMotoHatch 繪製。
    if ((p.osm_id === 126247880 && p.blockNode === 258785735)
      || (p.osm_id === 23875933 && p.blockNode === 2401086121)
      || (p.osm_id === 94402836 && p.blockNode === 258785638)
      || (p.osm_id === 1454602407 && p.blockNode === 7244167956)) continue
    const lanes = p.oneway === 'yes' || !e.back ? p.lanesForward : p.lanesBackward
    const moto = p.oneway === 'yes' ? p.motoF : e.back ? p.motoB : p.motoF
    const sep = (p.oneway === 'yes' ? p.motoSepF : e.back ? p.motoSepB : p.motoSepF) || 0
    if (!moto || sep <= 0 || lanes <= 0) continue // 0 車道（純機車道）無快慢界線
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const setbacks = islandSetbacks(graph, e, total)
    // 「中央線延伸至圓形端頭」也控制快慢車道分隔島；實體中央島由
    // buildCenterIslands 管理，刻意不套用這項設定。
    const extendFrom = (e.back ? p.centerExtendEnd : p.centerExtendStart)
      && manualMarkingSetbackM(e.road, e.fromNode) === 0
    const extendTo = (e.back ? p.centerExtendStart : p.centerExtendEnd)
      && manualMarkingSetbackM(e.road, e.toNode) === 0
    const s0 = extendFrom ? 0 : setbacks.s0
    const s1 = extendTo ? total : setbacks.s1
    if (s1 - s0 < MIN_ISLAND_M) continue
    const dv = 0
    const base = p.oneway === 'yes' ? -laneSpanM(p, false) / 2 : dv + (p.centerM || 0) / 2
    const inner = base + lanes * LANE_WIDTH_M
    const ds: number[] = []
    for (let d = s0; d < s1; d += 4) ds.push(d)
    ds.push(s1)
    const left = ds.map((d) => offsetAt(e.coords, cum, d, inner))
    const right = ds.map((d) => offsetAt(e.coords, cum, d, inner + sep))
    // 道路面端頭是圓形 buffer。依分隔島外側距道路面中心的橫向距離，
    // 算出仍位於圓頭內的最大縱向延伸，避免島面突出路面。
    const surfaceCenterOff = p.oneway === 'no' ? -(p.divOffM || 0) : 0
    const lateral = Math.max(
      Math.abs(inner - surfaceCenterOff),
      Math.abs(inner + sep - surfaceCenterOff),
    )
    const radius = p.width_m / 2
    const tipExtension = Math.min(6, Math.sqrt(Math.max(0, radius * radius - lateral * lateral)))
    const extendPoint = (pt: [number, number], brg: number) => offsetMeters(
      pt,
      Math.sin(brg * Math.PI / 180) * tipExtension,
      Math.cos(brg * Math.PI / 180) * tipExtension,
    )
    if (tipExtension > 0.05 && extendFrom) {
      const outward = bearing(e.coords[1], e.coords[0])
      left.unshift(extendPoint(left[0], outward))
      right.unshift(extendPoint(right[0], outward))
    }
    if (tipExtension > 0.05 && extendTo) {
      const outward = bearing(e.coords[e.coords.length - 2], e.coords[e.coords.length - 1])
      left.push(extendPoint(left[left.length - 1], outward))
      right.push(extendPoint(right[right.length - 1], outward))
    }
    out.push({
      key: `median/way/${p.osm_id}/S${e.back ? 'b' : 'f'}-${e.fromNode}`,
      polygon: [...left, ...[...right].reverse(), left[0]],
    })
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
    r.properties.roadMarkingMode !== 'none' &&
    // 高架：中央帶由 elevated3d 畫在橋面上，地面鋪島會在橋下留一條島面
    // （高楠陸橋 way/23939182、楠楊高架橋 way/103678964 實例）
    !r.properties.elevated &&
    r.properties.centerKind === 'island')
  for (const e of edges) {
    if (e.back) continue // 以順向 frame 統一處理一次
    const p = e.road.properties
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const setbacks = islandSetbacks(graph, e, total)
    const extendFrom = p.centerExtendStart
      && manualMarkingSetbackM(e.road, e.fromNode) === 0
    const extendTo = p.centerExtendEnd
      && manualMarkingSetbackM(e.road, e.toNode) === 0
    const s0 = extendFrom ? 0 : setbacks.s0
    const s1 = extendTo ? total : setbacks.s1
    const c = p.centerM / 2
    const radius = p.width_m / 2
    const tipExtension = Math.min(6, Math.sqrt(Math.max(0, radius * radius - c * c)))
    // 貫通接點兩側是兩個獨立多邊形，端面各自垂直於自己的最後一段。方位角只要
    // 差幾度，接縫就會留下一條細縫，所以兩邊都往接點外多鋪一點形成重疊。
    const joinOverlap = Math.min(CENTER_ISLAND_JOIN_OVERLAP_M, tipExtension)
    const joinStart = p.centerIslandJoinNodes?.includes(e.fromNode) ?? false
    const joinEnd = p.centerIslandJoinNodes?.includes(e.toNode) ?? false
    // 兩端都延續到隔壁路段時，這段只是連續島面的一小截；套用 8m 下限會在
    // 接點與接縫之間留一段空白（外環西路那截只有 5.3m）。
    const continuousPiece = (a: number, b: number) =>
      Math.abs(a - s0) < 0.01 && setbacks.throughStart
      && Math.abs(b - s1) < 0.01 && setbacks.throughEnd
    const minIslandM = (a: number, b: number) =>
      continuousPiece(a, b) ? MIN_JOINED_ISLAND_M : MIN_ISLAND_M
    if (s1 - s0 < minIslandM(s0, s1)) continue
    const dv = 0
    const extendPoint = (pt: [number, number], brg: number, dist: number) => offsetMeters(
      pt,
      Math.sin(brg * Math.PI / 180) * dist,
      Math.cos(brg * Math.PI / 180) * dist,
    )
    // 貫通接點所在的路段，其每個接縫都要補縫：scopeEdges 會在側街處把路段切開，
    // 島面因此由數個多邊形拼成，端面方位角不同就會留下細縫。
    const knitSeams = joinStart || joinEnd
    /** reachStart/reachEnd = 這塊島面確實鋪到路段端點（沒有被偏心道切掉）。 */
    const extendIslandEnds = (
      left: [number, number][], right: [number, number][],
      reachStart: boolean, reachEnd: boolean,
    ) => {
      const startDist = !reachStart ? 0
        : extendFrom ? tipExtension
          : knitSeams && setbacks.throughStart ? joinOverlap : 0
      const endDist = !reachEnd ? 0
        : extendTo ? tipExtension
          : knitSeams && setbacks.throughEnd ? joinOverlap : 0
      if (startDist > 0.05) {
        const outward = bearing(e.coords[1], e.coords[0])
        left.unshift(extendPoint(left[0], outward, startDist))
        right.unshift(extendPoint(right[0], outward, startDist))
      }
      if (endDist > 0.05) {
        const outward = bearing(e.coords[e.coords.length - 2], e.coords[e.coords.length - 1])
        left.push(extendPoint(left[left.length - 1], outward, endDist))
        right.push(extendPoint(right[right.length - 1], outward, endDist))
      }
    }
    const fwdBay = bayMap.get(`${p.osm_id}@${e.toNode}`)
    const bwdBay = bayMap.get(`${p.osm_id}@${e.fromNode}~b`)
    if (p.islandBayMode && (fwdBay || bwdBay)) {
      // 此模式的尖端直接對齊各方向停止線；一般分隔島額外預留的
      // 0.8m 路口淨空不套用在削尖端，避免島尖過早消失。
      const shapeStart = bwdBay ? total - bwdBay.endM : s0
      const shapeEnd = fwdBay ? fwdBay.endM : s1
      const breaks = [shapeStart, shapeEnd]
      if (fwdBay) breaks.push(fwdBay.d0M, fwdBay.endM)
      if (bwdBay) breaks.push(total - bwdBay.endM, total - bwdBay.d0M)
      const ds: number[] = []
      const sorted = [...new Set(breaks
        .map((d) => Math.max(shapeStart, Math.min(shapeEnd, d))))
      ].sort((a, b) => a - b)
      for (let index = 0; index < sorted.length - 1; index++) {
        const from = sorted[index]
        const to = sorted[index + 1]
        for (let d = from; d < to; d += 2) ds.push(d)
      }
      ds.push(sorted[sorted.length - 1])

      const smooth = (value: number) => {
        const t = Math.max(0, Math.min(1, value))
        return t * t * (3 - 2 * t)
      }
      const offsetsAt = (d: number): [number, number] => {
        let left = -c
        let right = c
        // 順向左轉道：中央帶靠順向車道的一側逐漸退向另一側，
        // 尖端落在順向停止線。
        if (fwdBay && d >= fwdBay.d0M) {
          const t = smooth(
            (d - fwdBay.d0M) / Math.max(0.1, fwdBay.endM - fwdBay.d0M))
          right = c - 2 * c * t
        }
        // 逆向左轉道沿道路座標反向削尖；在逆向停止線為尖端，
        // 往道路中段逐漸恢復完整中央帶寬。
        if (bwdBay) {
          const start = total - bwdBay.endM
          const end = total - bwdBay.d0M
          if (d <= end) {
            const t = smooth((d - start) / Math.max(0.1, end - start))
            left = c - 2 * c * t
          }
        }
        return [left, right]
      }
      const left = ds.map((d) => offsetAt(e.coords, cum, d, offsetsAt(d)[0]))
      const right = ds.map((d) => offsetAt(e.coords, cum, d, offsetsAt(d)[1]))
      extendIslandEnds(
        left, right, !bwdBay && s0 <= 0.01, !fwdBay && s1 >= total - 0.01)
      const ring = [...left, ...[...right].reverse(), left[0]]
      if (ring.length >= 4) {
        out.push({ key: `median/way/${p.osm_id}/A0`, polygon: ring })
      }
      continue
    }
    let ivs: [number, number][] = [[s0, s1]]
    if (fwdBay) ivs = ivs.flatMap((iv) => subtract(iv, [fwdBay.d0M, fwdBay.endM]))
    if (bwdBay) ivs = ivs.flatMap((iv) => subtract(iv, [total - bwdBay.endM, total - bwdBay.d0M]))
    let k = 0
    for (const [a, b] of ivs) {
      if (b - a < minIslandM(a, b)) continue
      const ds: number[] = []
      for (let d = a; d < b; d += 4) ds.push(d)
      ds.push(b)
      const left = ds.map((d) => offsetAt(e.coords, cum, d, dv - c))
      const right = ds.map((d) => offsetAt(e.coords, cum, d, dv + c))
      extendIslandEnds(
        left, right,
        Math.abs(a) < 0.01,
        Math.abs(b - total) < 0.01,
      )
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
