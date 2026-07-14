// 成對單行 way（couplet）合併：OSM 把藍田路畫成相距 ~10m 的兩條 oneway，
// 但實地是單一路體五車道（西二＋中央偏心一＋東二）。載入時把 scope 內的
// 成對單行合併成一條雙向 way：
//   中心線 = 兩線中點；保留 keep 組的 node id；drop 組上的路口 node 移植到
//   中心線上（其他道路引用同一 node id，座標跟著更新 → 交叉路自動接上）。
// 這也是未來全台分離幹道正規化的雛型（設計文件 §5 開放問題）。
import { bearing, angleDelta, COS_LAT } from './geo'
import { computeDerived, type RoadFeature } from './roads'

const KX = 111320 * COS_LAT
const KY = 110540

/** p 到折線的最近投影（回傳距離公尺與投影點） */
function projectToLine(p: [number, number], cs: [number, number][]):
  { d: number; pos: [number, number]; seg: number; t: number } {
  let best = { d: Infinity, pos: cs[0], seg: 0, t: 0 }
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
        d, seg: i, t,
        pos: [cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t],
      }
    }
  }
  return best
}

function wayBearing(r: RoadFeature): number {
  const cs = r.geometry.coordinates as [number, number][]
  return bearing(cs[0], cs[cs.length - 1])
}

const PAIR_MAX_M = 30 // 對向線間距上限（藍田路實測 ~8-12m）

export interface CoupletSection {
  lanesF: number
  lanesB: number
  centerM: number
  centerKind?: 'hatch' | 'island'
  motoF?: boolean
  motoB?: boolean
  /** 島寬由 OSM 兩線實際間距反推：centerM = clamp(平均間距 − roadW, min, max)。
   * 「把道路切開放入」——不擠壓車道，兩向各就各位、中間放實寬的島 */
  centerFromGap?: { roadW: number; min: number; max: number }
}

/**
 * 合併 scope 內的成對單行 way。section 是合併後的預設斷面
 * （藍田路：2+2+中央 3.2m 偏心帶；大學南路：2+2+機車道+實體島），
 * 個別 way 可再用 journal 覆寫。
 *
 * remapOut：node id 重映射收集器（舊 id → 新 id）。合併會把 drop 側路口 node
 * 併到 keep 側既有 node、去重退化段——journal 區塊鍵/偏心道鍵/待轉區都存 node id，
 * 呼叫端要用這張表遷移既有標註（enhancements.remapJournalNodes）。
 */
export function mergeCouplets(
  roads: RoadFeature[],
  scopeNames: Set<string>,
  section: CoupletSection = { lanesF: 2, lanesB: 2, centerM: 3.2 },
  remapOut?: Map<number, number>,
): RoadFeature[] {
  const scope = roads.filter(
    (r) => scopeNames.has(r.properties.name ?? '') && r.properties.oneway === 'yes'
      && r.geometry.coordinates.length >= 2)
  if (scope.length < 2) return roads

  // 1) 依行進方位角分兩組（相對最長 way 的方向 ±90°）——鏈有缺口也不會混組；
  //    整條路總轉彎 < 90° 時成立（藍田路 ~61°→90°，OK）
  const longest = scope.reduce((a, b) =>
    (a.geometry.coordinates as [number, number][]).length >=
    (b.geometry.coordinates as [number, number][]).length ? a : b)
  const ref = wayBearing(longest)
  const g0 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) < 90)
  const g1 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) >= 90)
  if (g0.length === 0 || g1.length === 0) return roads
  const lengthOf = (rs: RoadFeature[]) =>
    rs.reduce((s, r) => s + (r.geometry.coordinates as [number, number][]).length, 0)
  const keep = lengthOf(g0) >= lengthOf(g1) ? g0 : g1
  const drop = keep === g0 ? g1 : g0
  const dropSet = new Set(drop)

  // 2) keep 組頂點移到中點（有對向投影才移），記錄 node 新座標
  const nodeNewPos = new Map<number, [number, number]>()
  for (const w of keep) {
    const cs = w.geometry.coordinates as [number, number][]
    const nodes = w.properties.nodes
    const dists: number[] = []
    const next: [number, number][] = cs.map((p) => {
      let best: { d: number; pos: [number, number] } | null = null
      for (const o of drop) {
        const hit = projectToLine(p, o.geometry.coordinates as [number, number][])
        if (hit.d < PAIR_MAX_M && (!best || hit.d < best.d)) best = hit
      }
      if (!best) return p
      dists.push(best.d)
      return [(p[0] + best.pos[0]) / 2, (p[1] + best.pos[1]) / 2]
    })
    w.geometry.coordinates = next
    nodes.forEach((n, i) => nodeNewPos.set(n, next[i]))
    // 斷面改雙向：預設斷面 + （可選）由實際線距反推島寬
    const p = w.properties
    p.oneway = 'no'
    p.lanesForward = section.lanesF
    p.lanesBackward = section.lanesB
    p.motoF = section.motoF ?? p.motoF
    p.motoB = section.motoB ?? p.motoB
    p.centerKind = section.centerKind ?? 'hatch'
    if (section.centerFromGap && dists.length > 0) {
      const g = section.centerFromGap
      const mean = dists.reduce((a, b) => a + b, 0) / dists.length
      p.centerM = Math.round(Math.min(g.max, Math.max(g.min, mean - g.roadW)) * 10) / 10
    } else {
      p.centerM = section.centerM
    }
    p.coupletMerged = true // 中央帶編輯只對合併段開放（一般雙向巷道沒有中央帶概念）
    computeDerived(p)
  }

  // 3) drop 組上被其他道路引用的路口 node 移植到 keep 組（拓撲不斷）
  const dropNodes = new Set<number>()
  for (const w of drop) for (const n of w.properties.nodes) dropNodes.add(n)
  const keepNodes = new Set<number>()
  for (const w of keep) for (const n of w.properties.nodes) keepNodes.add(n)
  const referenced = new Set<number>()
  for (const r of roads) {
    if (dropSet.has(r) || keep.includes(r)) continue
    for (const n of r.properties.nodes) if (dropNodes.has(n) && !keepNodes.has(n)) referenced.add(n)
  }
  const nodePos = new Map<number, [number, number]>()
  for (const w of drop) {
    const cs = w.geometry.coordinates as [number, number][]
    w.properties.nodes.forEach((n, i) => nodePos.set(n, cs[i]))
  }
  for (const j of referenced) {
    const p = nodePos.get(j)
    if (!p) continue
    let best: { w: RoadFeature; hit: ReturnType<typeof projectToLine> } | null = null
    for (const w of keep) {
      const hit = projectToLine(p, w.geometry.coordinates as [number, number][])
      if (!best || hit.d < best.hit.d) best = { w, hit }
    }
    if (!best || best.hit.d > PAIR_MAX_M) continue
    const cs = best.w.geometry.coordinates as [number, number][]
    const nodes = best.w.properties.nodes
    // 距既有頂點很近就併用該 node；否則把 j 插進 keep way
    const nearIdx = best.hit.t < 0.5 ? best.hit.seg : best.hit.seg + 1
    const nearD = Math.hypot(
      (cs[nearIdx][0] - best.hit.pos[0]) * KX, (cs[nearIdx][1] - best.hit.pos[1]) * KY)
    if (nearD < 4) {
      nodeNewPos.set(j, cs[nearIdx])
      remapOut?.set(j, nodes[nearIdx])
      // 其他道路的 j 改指到既有 node，共享路口
      for (const r of roads) {
        if (dropSet.has(r)) continue
        r.properties.nodes = r.properties.nodes.map((n) => (n === j ? nodes[nearIdx] : n))
      }
    } else {
      cs.splice(best.hit.seg + 1, 0, best.hit.pos)
      nodes.splice(best.hit.seg + 1, 0, j)
      nodeNewPos.set(j, best.hit.pos)
    }
  }

  // 4) 座標傳播：所有仍引用被移動 node 的道路，端點座標同步到新位置
  for (const r of roads) {
    if (dropSet.has(r)) continue
    const cs = r.geometry.coordinates as [number, number][]
    r.properties.nodes.forEach((n, i) => {
      const np = nodeNewPos.get(n)
      if (np && i < cs.length) cs[i] = np
    })
  }

  // 5) 清理退化段：EB↔WB 短穿越段的兩端被併成同一節點後變成零長度 way，
  //    會產生方位角 0 的幽靈出口（幽靈左轉配對/幽靈 bay/繞路）。
  //    連續重複點（同 node id 或 <5cm）去重；剩不到兩點的 way 整條移除。
  const survivors: RoadFeature[] = []
  const dupRemap = new Map<number, number>()
  for (const r of roads) {
    if (dropSet.has(r)) continue
    const cs = r.geometry.coordinates as [number, number][]
    const ns = r.properties.nodes
    if (ns.length !== cs.length || cs.length < 2) { survivors.push(r); continue }
    const outC: [number, number][] = [cs[0]]
    const outN: number[] = [ns[0]]
    for (let i = 1; i < cs.length; i++) {
      const prevC = outC[outC.length - 1]
      const dx = (cs[i][0] - prevC[0]) * KX, dy = (cs[i][1] - prevC[1]) * KY
      if (ns[i] === outN[outN.length - 1] || Math.hypot(dx, dy) < 0.05) {
        if (ns[i] !== outN[outN.length - 1]) dupRemap.set(ns[i], outN[outN.length - 1])
        continue
      }
      outC.push(cs[i])
      outN.push(ns[i])
    }
    if (outC.length < 2) continue // 整條退化，移除
    r.geometry.coordinates = outC
    r.properties.nodes = outN
    survivors.push(r)
  }
  // 被去重掉的 node id，其他道路引用改指保留者（位置相同，拓撲不斷）
  if (dupRemap.size > 0) {
    for (const r of survivors) {
      r.properties.nodes = r.properties.nodes.map((n) => dupRemap.get(n) ?? n)
    }
    if (remapOut) {
      // 先前的移植映射若指到被去重的 node，跟著鏈到最終保留者
      for (const [k, v] of remapOut) if (dupRemap.has(v)) remapOut.set(k, dupRemap.get(v)!)
      for (const [a, b] of dupRemap) remapOut.set(a, remapOut.get(b) ?? b)
    }
  }
  return survivors
}

/**
 * 藍田路分段斷面（2026-07-09 實地驗收）：745巷以東到大學路為東三西二、無中央帶
 * （中央第五車道在此直接變成東向直行道）。合併後 keep 組座標一律朝東，
 * forward = 東向。粒度到 way：745巷交點在 way 1464405421 中段，
 * 該 way 維持 2+2+中央帶（誤差 ~40m，之後要更準得切 way）。
 */
const LANTIAN_EAST_3_2 = new Set([
  297138317, 297138318, 297138332, 297138334, 297138329,
  254325308, 126382198, 297138321, 297138322,
])

const LANE745_NODE = 1080697223 // 藍田路 × 745巷 交點（way 1464405421 中段）

export function applyLantianSections(roads: RoadFeature[]) {
  // 745巷交點把 way 1464405421 切成兩段：西半維持 2+2+中央帶、東半歸入 3+2
  const idx = roads.findIndex((r) => r.properties.osm_id === 1464405421)
  if (idx >= 0) {
    const w = roads[idx]
    const cut = w.properties.nodes.indexOf(LANE745_NODE)
    if (cut > 0 && cut < w.properties.nodes.length - 1) {
      const cs = w.geometry.coordinates as [number, number][]
      const east: RoadFeature = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: cs.slice(cut) },
        // 合成負數 id：切分段不能與原 way 共用 id，否則路段級 journal 覆寫會同時
        // 打到兩段（東段 3+2 會被西段的編輯清掉）
        properties: { ...w.properties, osm_id: -w.properties.osm_id, nodes: w.properties.nodes.slice(cut) },
      }
      w.geometry.coordinates = cs.slice(0, cut + 1)
      w.properties.nodes = w.properties.nodes.slice(0, cut + 1)
      roads.splice(idx + 1, 0, east)
      east.properties.lanesForward = 3
      east.properties.lanesBackward = 2
      east.properties.centerM = 0
      computeDerived(east.properties)
    }
  }
  for (const r of roads) {
    if (!LANTIAN_EAST_3_2.has(r.properties.osm_id)) continue
    const p = r.properties
    p.lanesForward = 3
    p.lanesBackward = 2
    p.centerM = 0
    computeDerived(p)
  }
}
