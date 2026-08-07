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

function lineLenM(cs: [number, number][]): number {
  let s = 0
  for (let i = 0; i < cs.length - 1; i++) {
    s += Math.hypot((cs[i + 1][0] - cs[i][0]) * KX, (cs[i + 1][1] - cs[i][1]) * KY)
  }
  return s
}

const PAIR_MAX_M = 30 // 對向線間距上限（藍田路實測 ~8-12m）
/** 夾心防呆：中線取樣間距、判定「壓在別條路上」的距離、要中止所需的覆蓋率。
 * 真正的成對單行中線是空的，只有橫向路口會短暫掠過（實測 ≤14%）；被夾住的
 * 主線則是全長貼著（清豐路 100%、德民新橋 100%）。 */
const SANDWICH_STEP_M = 10
const SANDWICH_CLEAR_M = 3.5
const SANDWICH_COVER_MIN = 0.6

/** 被合併掉（drop 側）way 的重映射：外部標註（LanePilot）還掛在舊 way id 上，
 * 匯入時用這張表轉到合併後的 keep way。
 * dropReversed = 該 way 載入時是否因 oneway=-1 反轉過（標註方向是 OSM 原始方向）。
 * sameDir = drop 載入後行向與 keep 順向同向（absorbSideWays 吸收的同向慢車道）；
 * undefined/false = 對向（couplet drop 側，drop 行向 = 合併後 backward）。 */
export interface DropRemap { keepIds: number[]; dropReversed: boolean; sameDir?: boolean }

/** 同組（同向）兩條長 way 平行貼近 = 多線並排道路（高雄大學路型），
 * couplet 兩線模型不適用——硬併會產生重疊路體，整條路直接放棄合併。 */
function sameDirParallel(group: RoadFeature[]): [number, number] | null {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j]
      const ca = a.geometry.coordinates as [number, number][]
      const cb = b.geometry.coordinates as [number, number][]
      // 路口附近的短 stub（穿越段/link）貼近是正常現象，只看兩條都夠長的
      if (Math.min(lineLenM(ca), lineLenM(cb)) < 50) continue
      const na = new Set(a.properties.nodes)
      if (b.properties.nodes.some((n) => na.has(n))) continue // 首尾相接的同一條路
      const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
      let near = 0
      for (const p of short) if (projectToLine(p, long).d < PAIR_MAX_M) near++
      if (short.length >= 2 && near / short.length >= 0.6) {
        return [a.properties.osm_id, b.properties.osm_id]
      }
    }
  }
  return null
}

export interface CoupletSection {
  lanesF: number
  lanesB: number
  centerM: number
  centerKind?: 'hatch' | 'island'
  motoF?: boolean
  motoB?: boolean
  /** 快慢分隔帶寬（motoSepF/B，見 RoadProps）——主慢分離道路合併時給預設值 */
  motoSepF?: number
  motoSepB?: number
  /** 島寬由 OSM 兩線實際間距反推：centerM = clamp(平均間距 − roadW, min, max)。
   * 「把道路切開放入」——不擠壓車道，兩向各就各位、中間放實寬的島 */
  centerFromGap?: { roadW: number; min: number; max: number }
}

export interface SandwichReport {
  /** 中線取樣點數（每 SANDWICH_STEP_M 一點） */
  samples: number
  /** 落在別條路 SANDWICH_CLEAR_M 內的取樣比例 */
  coverage: number
  /** 舊規則：某條路獨佔了首/中/末 3 點中的 ≥2 點 */
  legacyHit: RoadFeature | null
  /** 依佔用點數排序的「壓在中線上的路」 */
  blame: { road: RoadFeature; hits: number }[]
  sandwiched: boolean
}

/**
 * 夾心偵測：把 keep/drop 兩線的中點連成中線，量它有多長被「別條路」佔著。
 *
 * 成對單行的中線是空的——只有橫向路口會短暫掠過（全圖實測 ≤29%）；被夾住的
 * 主線則是全長貼著（清豐路 100%、德民新橋機車道 94%、新莊一路 94%）。
 *
 * 舊版只取首/中/末三點、且要求**同一條 way** 命中 ≥2 點，被夾的路一旦在 OSM 上
 * 分成多段就整個失效：清豐路的兩條側車道（相距 ~29m）夾著 lanes=4 的主線，中線
 * 全長壓在主線上 0.1～0.6m，但三個樣本分別落在 way/799032592、1446434013、
 * 1464614129 三條不同的 way 上，每條都只中 1 點 → 防呆放行，整條路被畫成兩份。
 * 現在改看整體覆蓋率；舊規則保留為第二個觸發條件，因為它在中線很短時比覆蓋率
 * 靈敏（鼎新橋只有 4 個取樣點，覆蓋 50% 達不到門檻，但天祥二路確實壓在中線上）。
 */
export function sandwichReport(
  roads: RoadFeature[], keep: RoadFeature[], drop: RoadFeature[],
): SandwichReport | null {
  const scopeSet = new Set<RoadFeature>([...keep, ...drop])
  const midlines: [number, number][][] = []
  for (const w of keep) {
    const mids: [number, number][] = []
    for (const p of w.geometry.coordinates as [number, number][]) {
      let best: { d: number; pos: [number, number] } | null = null
      for (const o of drop) {
        const hit = projectToLine(p, o.geometry.coordinates as [number, number][])
        if (hit.d < PAIR_MAX_M && (!best || hit.d < best.d)) best = hit
      }
      if (best) mids.push([(p[0] + best.pos[0]) / 2, (p[1] + best.pos[1]) / 2])
    }
    if (mids.length >= 3) midlines.push(mids)
  }
  if (!midlines.length) return null

  // 以固定間距沿中線取樣，覆蓋率才是「長度比例」而不是「頂點比例」——路口附近
  // 頂點密集，用頂點數會讓一個路口的權重蓋過整段直線。
  const samples: [number, number][] = []
  for (const mids of midlines) {
    for (let i = 0; i < mids.length - 1; i++) {
      const a = mids[i], b = mids[i + 1]
      const span = Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY)
      const steps = Math.max(1, Math.round(span / SANDWICH_STEP_M))
      for (let s = 0; s < steps; s++) {
        const t = s / steps
        samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    samples.push(mids[mids.length - 1])
  }
  // 粗篩：只留頂點落在中線包絡內的候選路，否則每個樣本都要掃全圖
  const box = samples.reduce((acc, [x, y]) => ({
    minX: Math.min(acc.minX, x), maxX: Math.max(acc.maxX, x),
    minY: Math.min(acc.minY, y), maxY: Math.max(acc.maxY, y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  const padX = 60 / KX, padY = 60 / KY
  const candidates = roads.filter((r) => {
    if (scopeSet.has(r)) return false
    const rc = r.geometry.coordinates as [number, number][]
    if (rc.length < 2 || lineLenM(rc) < 30) return false
    return rc.some(([x, y]) => x >= box.minX - padX && x <= box.maxX + padX
      && y >= box.minY - padY && y <= box.maxY + padY)
  })
  const nearest = (s: [number, number]) => {
    let hit: RoadFeature | null = null
    let bestD = SANDWICH_CLEAR_M
    for (const r of candidates) {
      const d = projectToLine(s, r.geometry.coordinates as [number, number][]).d
      if (d < bestD) { bestD = d; hit = r }
    }
    return hit
  }
  const hits = new Map<RoadFeature, number>()
  let covered = 0
  for (const s of samples) {
    const hit = nearest(s)
    if (!hit) continue
    covered++
    hits.set(hit, (hits.get(hit) ?? 0) + 1)
  }
  const blame = [...hits.entries()]
    .map(([road, n]) => ({ road, hits: n }))
    .sort((a, b) => b.hits - a.hits)

  // 舊規則：最長中線的首/中/末 3 點，同一條 way 命中 ≥2 點
  const longestMid = midlines.reduce((a, b) => (b.length > a.length ? b : a))
  const legacy = [longestMid[0], longestMid[Math.floor(longestMid.length / 2)],
    longestMid[longestMid.length - 1]]
  const legacyCount = new Map<RoadFeature, number>()
  for (const s of legacy) {
    const hit = nearest(s)
    if (hit) legacyCount.set(hit, (legacyCount.get(hit) ?? 0) + 1)
  }
  const legacyHit = [...legacyCount.entries()].find(([, n]) => n >= 2)?.[0] ?? null

  const coverage = covered / samples.length
  return {
    samples: samples.length,
    coverage,
    legacyHit,
    blame,
    sandwiched: coverage >= SANDWICH_COVER_MIN || legacyHit !== null,
  }
}

/** mergeCouplets 的成對分組結果——稽核要重現同一套判斷，不能各算各的。 */
export interface CoupletGrouping {
  keep: RoadFeature[]
  drop: RoadFeature[]
  /** 非 null 時代表「同向並排」防呆已中止合併 */
  sameDirParallelPair: [number, number] | null
}

/**
 * 把 scope 內的同名 oneway way 分成 keep／drop 兩組（步驟 1～1.5）。
 * mergeCouplets 與 couplet_audit 共用，避免稽核自行複製一份會漂移的分組邏輯。
 * wayRemapOut 有給時，通過落單保護的 drop way 會登記進去（合併的副作用）。
 */
export function coupletGrouping(
  roads: RoadFeature[],
  scopeNames: Set<string>,
  include?: (r: RoadFeature) => boolean,
  wayRemapOut?: Map<number, DropRemap>,
): CoupletGrouping | null {
  const scope = roads.filter((r) => {
    const p = r.properties
    // 圓環弧段常帶著路名（中央路圓環 = 4 條 oneway 弧）：對切合併會把圓環壓扁，
    // junction=roundabout 與封閉環一律排除
    if (p.junction === 'roundabout' || p.nodes[0] === p.nodes[p.nodes.length - 1]) return false
    // include：主慢分離道路（外環西路/德民路型）只挑主線等級進 scope，
    // 慢車道原樣保留——否則同向並排防呆會讓整條路放棄合併
    if (include && !include(r)) return false
    return scopeNames.has(p.name ?? '') && p.oneway === 'yes'
      && r.geometry.coordinates.length >= 2
  })
  if (scope.length < 2) return null

  // 1) 依行進方位角分兩組（相對最長 way 的方向 ±90°）——鏈有缺口也不會混組；
  //    整條路總轉彎 < 90° 時成立（藍田路 ~61°→90°，OK）
  const longest = scope.reduce((a, b) =>
    (a.geometry.coordinates as [number, number][]).length >=
    (b.geometry.coordinates as [number, number][]).length ? a : b)
  const ref = wayBearing(longest)
  const g0 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) < 90)
  const g1 = scope.filter((r) => Math.abs(angleDelta(ref, wayBearing(r))) >= 90)
  if (g0.length === 0 || g1.length === 0) return null
  // 高雄大學路型防呆：同向兩條長 way 平行貼近 = 多線並排（主線＋慢車道/機車道
  // 各自成線），兩線 couplet 模型硬併會產生重疊路體，整條路放棄合併
  const sameDirParallelPair = sameDirParallel(g0) ?? sameDirParallel(g1)
  const vertexCount = (rs: RoadFeature[]) =>
    rs.reduce((s, r) => s + (r.geometry.coordinates as [number, number][]).length, 0)
  const keep = vertexCount(g0) >= vertexCount(g1) ? g0 : g1
  if (sameDirParallelPair) {
    return { keep, drop: keep === g0 ? g1 : g0, sameDirParallelPair }
  }

  // 1.5) 落單保護：drop 側 way 的頂點過半沒貼到 keep 側（同名的獨立支段，
  // 例：加昌路往南的單行支線——只有路口那端碰到主軸）→ 不是成對單行的一半，
  // 原樣保留不刪。有配對的才進 wayRemapOut（舊 way id → keep way，匯入標註用）。
  // ⚠ 覆蓋率只看距離，投影可以夾在 keep 的端點上：首尾相接的續行段整條都在
  // 對方起點 PAIR_MAX_M 內 → 覆蓋率 100% 被誤判成對向線。轉彎超過 90° 的走廊
  // 會踩到（見 pipeline.NO_COUPLET_ROADS），泛用判準要改請先量全圖 wayRemap 差異。
  const drop = (keep === g0 ? g1 : g0).filter((w) => {
    const keepHits = new Set<number>()
    let near = 0
    const cs = w.geometry.coordinates as [number, number][]
    for (const p of cs) {
      let hit = false
      for (const k of keep) {
        if (projectToLine(p, k.geometry.coordinates as [number, number][]).d < PAIR_MAX_M) {
          keepHits.add(k.properties.osm_id)
          hit = true
        }
      }
      if (hit) near++
    }
    if (near / cs.length < 0.6) return false
    wayRemapOut?.set(w.properties.osm_id,
      { keepIds: [...keepHits], dropReversed: !!w.properties.reversed })
    return true
  })
  return { keep, drop, sameDirParallelPair: null }
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
  wayRemapOut?: Map<number, DropRemap>,
  include?: (r: RoadFeature) => boolean,
): RoadFeature[] {
  // 1) 分組＋同向並排防呆＋落單保護（見 coupletGrouping）
  const grouping = coupletGrouping(roads, scopeNames, include, wayRemapOut)
  if (!grouping) return roads
  if (grouping.sameDirParallelPair) {
    const [a, b] = grouping.sameDirParallelPair
    console.warn(`couplet 合併中止（${[...scopeNames].join('/')}）：`
      + `way/${a} 與 way/${b} 同向並排（多線道路，需顯式配對處理）`)
    return roads
  }
  const { keep, drop } = grouping
  if (drop.length === 0) return roads
  const dropSet = new Set(drop)

  // 保留被吸收側的精確靜態來源。畫面上的 keep way 之後可能包含 drop way 的
  // 路口 node；靜態捏合必須能循此 provenance 找回真正承載該 node 的 segment。
  // 只把確實沿線配對的 drop 掛到對應 keep，避免用路名做模糊回查。
  for (const k of keep) {
    const kc = k.geometry.coordinates as [number, number][]
    const paired = drop.filter((d) => {
      const dc = d.geometry.coordinates as [number, number][]
      let near = 0
      for (const point of dc) if (projectToLine(point, kc).d < PAIR_MAX_M) near++
      return near / dc.length >= 0.6
    })
    const all = [
      ...(k.properties.sourceSegments ?? []),
      ...paired.flatMap((d) => d.properties.sourceSegments ?? []),
    ]
    const seen = new Set<string>()
    k.properties.sourceSegments = all.filter((source) => {
      const key = `${source.osmId}|${source.navSegmentKey}|${source.splitIndex}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // 1.6) 夾心防呆（見 sandwichReport）：這對線若夾著別條路就整路放棄合併
  const sandwich = sandwichReport(roads, keep, drop)
  if (sandwich?.sandwiched) {
    const worst = sandwich.blame.slice(0, 3)
      .map(({ road }) => `way/${road.properties.osm_id}（${road.properties.name ?? '無名'}）`)
    console.warn(`couplet 合併中止（${[...scopeNames].join('/')}）：中線 `
      + `${(100 * sandwich.coverage).toFixed(0)}%（${sandwich.samples} 點）壓在 `
      + `${worst.join('、')} 上——成對線夾著別條路`)
    return roads
  }

  // 2) keep 組頂點移到中點（有對向投影才移），記錄 node 新座標；
  //    整條都沒有對向投影的 keep way（落單）不動、維持單行斷面
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
    // 落單保護（keep 側）：對向投影頂點 < 60%（獨立支段只有路口端碰到對向；
    // 真正的成對單行幾乎全長貼合）→ 不是成對單行的一半，維持單行原樣
    if (dists.length / cs.length < 0.6) continue
    w.geometry.coordinates = next
    nodes.forEach((n, i) => nodeNewPos.set(n, next[i]))
    // 斷面改雙向：預設斷面 + （可選）由實際線距反推島寬
    const p = w.properties
    p.oneway = 'no'
    p.lanesForward = section.lanesF
    p.lanesBackward = section.lanesB
    p.motoF = section.motoF ?? p.motoF
    p.motoB = section.motoB ?? p.motoB
    if (section.motoF !== undefined) p.motoCountF = section.motoF ? 1 : 0
    if (section.motoB !== undefined) p.motoCountB = section.motoB ? 1 : 0
    p.motoSepF = section.motoSepF ?? p.motoSepF
    p.motoSepB = section.motoSepB ?? p.motoSepB
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
      if (remapOut) {
        // 先鏈舊映射（多條路依序合併時，前一輪的映射可能指到 j——目標消失鏈就斷）
        for (const [a, b] of remapOut) if (b === j) remapOut.set(a, nodes[nearIdx])
        remapOut.set(j, nodes[nearIdx])
      }
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
 * 主慢分離道路的側 way（慢車道）吸收：主線 couplet 合併後，慢車道在斷面模型裡
 * 改由主線的機車道（motoF/B）＋快慢分隔帶（motoSep 島）表達，獨立 way 不再需要。
 * 全長貼著主線（60% 頂點在 25m 內）的同名 oneway 移除；被其他道路引用的節點
 * 移植到最近主線（<4m 併用既有 node、否則插點——側街自動接上主線），
 * wayRemap 記 sameDir 旗標（慢車道與主線同向，標註方向換算異於對向 drop）。
 */
export function absorbSideWays(
  roads: RoadFeature[],
  name: string,
  remapOut?: Map<number, number>,
  wayRemapOut?: Map<number, DropRemap>,
): RoadFeature[] {
  const hosts = roads.filter((r) => r.properties.name === name
    && r.properties.coupletMerged && r.geometry.coordinates.length >= 2)
  if (!hosts.length) return roads
  const hostSet = new Set(hosts)
  const nearHost = (pnt: [number, number], max: number) => {
    for (const h of hosts) {
      if (projectToLine(pnt, h.geometry.coordinates as [number, number][]).d < max) return true
    }
    return false
  }
  const targets = roads.filter((r) => {
    const p = r.properties
    if (p.name !== name || p.oneway !== 'yes' || r.geometry.coordinates.length < 2) return false
    const cs = r.geometry.coordinates as [number, number][]
    let near = 0
    for (const pnt of cs) if (nearHost(pnt, 25)) near++
    return near / cs.length >= 0.6
  })
  if (!targets.length) return roads
  const targetSet = new Set(targets)

  // wayRemap：keepIds = 貼到的主線、sameDir = 與最近主線順向同向
  for (const t of targets) {
    const cs = t.geometry.coordinates as [number, number][]
    const keepHits = new Set<number>()
    let bestHost: RoadFeature | null = null
    let bestD = Infinity
    for (const h of hosts) {
      const hit = projectToLine(cs[Math.floor(cs.length / 2)], h.geometry.coordinates as [number, number][])
      if (hit.d < bestD) { bestD = hit.d; bestHost = h }
      for (const pnt of cs) {
        if (projectToLine(pnt, h.geometry.coordinates as [number, number][]).d < 25) {
          keepHits.add(h.properties.osm_id)
          break
        }
      }
    }
    const sameDir = bestHost
      ? Math.abs(angleDelta(wayBearing(t), wayBearing(bestHost))) < 90
      : true
    wayRemapOut?.set(t.properties.osm_id,
      { keepIds: [...keepHits], dropReversed: !!t.properties.reversed, sameDir })
  }

  // 被其他道路引用的 target 節點 → 移植到最近主線（同 mergeCouplets 步驟 3）
  const targetNodes = new Set<number>()
  for (const t of targets) for (const n of t.properties.nodes) targetNodes.add(n)
  const hostNodes = new Set<number>()
  for (const h of hosts) for (const n of h.properties.nodes) hostNodes.add(n)
  const referenced = new Set<number>()
  for (const r of roads) {
    if (targetSet.has(r) || hostSet.has(r)) continue
    for (const n of r.properties.nodes) if (targetNodes.has(n) && !hostNodes.has(n)) referenced.add(n)
  }
  const nodePos = new Map<number, [number, number]>()
  for (const t of targets) {
    const cs = t.geometry.coordinates as [number, number][]
    t.properties.nodes.forEach((n, i) => nodePos.set(n, cs[i]))
  }
  const nodeNewPos = new Map<number, [number, number]>()
  for (const j of referenced) {
    const pnt = nodePos.get(j)
    if (!pnt) continue
    let best: { h: RoadFeature; hit: ReturnType<typeof projectToLine> } | null = null
    for (const h of hosts) {
      const hit = projectToLine(pnt, h.geometry.coordinates as [number, number][])
      if (!best || hit.d < best.hit.d) best = { h, hit }
    }
    if (!best || best.hit.d > 25) continue
    const cs = best.h.geometry.coordinates as [number, number][]
    const nodes = best.h.properties.nodes
    const nearIdx = best.hit.t < 0.5 ? best.hit.seg : best.hit.seg + 1
    const nearD = Math.hypot(
      (cs[nearIdx][0] - best.hit.pos[0]) * KX, (cs[nearIdx][1] - best.hit.pos[1]) * KY)
    if (nearD < 4) {
      nodeNewPos.set(j, cs[nearIdx])
      if (remapOut) {
        for (const [a, b] of remapOut) if (b === j) remapOut.set(a, nodes[nearIdx])
        remapOut.set(j, nodes[nearIdx])
      }
      for (const r of roads) {
        if (targetSet.has(r)) continue
        r.properties.nodes = r.properties.nodes.map((n) => (n === j ? nodes[nearIdx] : n))
      }
    } else {
      cs.splice(best.hit.seg + 1, 0, best.hit.pos)
      nodes.splice(best.hit.seg + 1, 0, j)
      nodeNewPos.set(j, best.hit.pos)
    }
  }

  // 座標傳播（引用被移動 node 的道路端點跟上）＋ 移除 target ＋ 清退化段
  const survivors: RoadFeature[] = []
  const dupRemap = new Map<number, number>()
  for (const r of roads) {
    if (targetSet.has(r)) continue
    const cs = r.geometry.coordinates as [number, number][]
    r.properties.nodes.forEach((n, i) => {
      const np = nodeNewPos.get(n)
      if (np && i < cs.length) cs[i] = np
    })
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
    if (outC.length < 2) continue
    r.geometry.coordinates = outC
    r.properties.nodes = outN
    survivors.push(r)
  }
  if (dupRemap.size > 0) {
    for (const r of survivors) {
      r.properties.nodes = r.properties.nodes.map((n) => dupRemap.get(n) ?? n)
    }
    if (remapOut) {
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
