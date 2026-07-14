// 偏心左轉道與中央帶標線（設計見 nav_simulator/路上元件擴充設計.md §1）
//
// 實驗階段（藍田路）：couplet 合併後為單一雙向路體，斷面 = 兩向車道 + 中央帶
// （centerM，預設 3.2m）。中央帶的內容沿路變化：
//   - 路口前：某一方向的偏心左轉道（儲車段 ≥30m + 漸變段雙黃線斜對切）
//   - 其餘：黃色槽化線（兩側雙黃邊界 + 內部斜紋）
// 「查不到就假設每個左轉點都有」：預設生成（source=default），journal 只記覆寫
// （present:0 = 實地確認沒有）。標線顏色規則：分隔對向 = 黃、分隔同向 = 白。
import type { Feature, FeatureCollection } from 'geojson'
import { angleDelta, cumulative, offsetMeters, pointAlong, LANE_WIDTH_M } from './geo'
import { MOTO_LANE_M } from './roads'
import type { RoadGraph, BayAnchor, ScopeEdge, RouteResult } from './graph'
import type { EnhancementRecord } from './enhancements'

/** 實驗範圍：只在這些路名上生成（全路網政策見設計文件 §5.3，驗證後再放大）。
 * 援中路 2026-07-14 加入：中央帶為偏心槽化（couplet 合併時 centerKind=hatch） */
export const BAY_SCOPE_ROADS = new Set(['藍田路', '援中路'])

const DEFAULTS = { bay_len_m: 30, taper_len_m: 15, width_m: 3.0, turns: 'left|uturn' }
/** 儲車段自適應：至少 MIN_BAY；長段讓 bay 伸長、槽化只留 HATCH 目標長；
 * 不夠再去掉槽化段——兩向漸變的雙黃斜切在區塊中點相接（短巷距路口常見樣式）；
 * 連 MIN_DEFORM 都放不下就整段不生成（畸形 bay 比沒有更糟），人工開啟例外 */
const MIN_BAY = 30
const MIN_DEFORM = 14
const HATCH_TARGET = 20

export interface TurnBay {
  key: string // way/W@node/N（反向行進加 ~b 尾碼），journal target key
  wayId: number
  nodeId: number
  /** 進入路口的行向（度）——與 maneuver.fromBearing 比對用 */
  approachBearing: number
  /** center = 雙向路中央帶偏心道；side = 單行道左緣附加車道 */
  kind: 'center' | 'side'
  bayLenM: number
  taperLenM: number
  widthM: number
  turns: string
  source: 'default' | 'manual'
  /** bay 中心相對 way 線的偏移（行進方向右正）：center bay = 0 */
  offM: number
  /** 漸變段起點/儲車段起點/前端（沿進入邊的距離）——槽化線銜接用 */
  d0M: number
  bayStartM: number
  endM: number
  back: boolean
  polygon: [number, number][] | null
  casing: [number, number][] | null
  arrows: { pos: [number, number]; brg: number }[]
  /** 邊線：黃 = 分隔對向（左緣/斜切），白 = 分隔同向（右緣） */
  lines: PaintLine[]
}

/** 標線線段（黃 = 分隔對向/槽化，白 = 分隔同向） */
export interface PaintLine { color: 'yellow' | 'white'; coords: [number, number][] }

/** 地面箭頭（車道走向/偏心道），icon 對應 mapStyle makeIcons */
export interface GroundArrow { pos: [number, number]; brg: number; icon: string }

function foldBayOverrides(journal: EnhancementRecord[]): Map<string, Record<string, string | number>> {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of journal) {
    if (rec.target.type !== 'turn_bay') continue
    if (rec.op === 'delete') out.delete(rec.target.key)
    else out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
  }
  return out
}

const scopeFn = (r: { properties: { name?: string } }) => BAY_SCOPE_ROADS.has(r.properties.name ?? '')

const anchorKey = (a: BayAnchor) => `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`

export function buildTurnBays(graph: RoadGraph, journal: EnhancementRecord[]): TurnBay[] {
  const over = foldBayOverrides(journal)
  const out: TurnBay[] = []
  const anchors = graph.bayAnchors(scopeFn)
  const amap = new Map(anchors.map((a) => [anchorKey(a), a]))
  const handled = new Set<string>()

  /** 是否生成：journal 覆寫（車道面板「偏心道轉向」與偏心道面板都寫這裡）
   * > 左轉配對自動判斷。不看一般車道的轉向真值——實地常見
   * 「偏心道左轉、內側車道全直行」，兩者是獨立車道 */
  const wantBay = (a: BayAnchor): boolean => {
    const o = over.get(anchorKey(a))
    if (o) return Number(o.present) !== 0 // 人工開/關（帶參數的覆寫視為開）
    return a.hasLeftPair
  }

  const tryMake = (a: BayAnchor, dflt: { bayLen: number; taperLen: number }) => {
    const key = anchorKey(a)
    handled.add(key)
    if (!wantBay(a)) return
    const o = over.get(key)
    // 人工開啟（present:1）：自適應長度不足時墊到 MIN_DEFORM，makeBay 再按
    // 可用空間夾住——短區塊「實地確認有偏心道」不能被預設門檻擋死
    const forced = !!o && Number(o.present) === 1
    const bayLen = forced ? Math.max(dflt.bayLen, MIN_DEFORM) : dflt.bayLen
    if (bayLen < MIN_DEFORM && !o?.bay_len_m) return // 放不下且無人工指定
    const bay = makeBay(a, key, o, { bayLen, taperLen: dflt.taperLen })
    if (bay) out.push(bay)
  }

  // 中央帶路段：以順向邊為單位配對兩向 bay，長度依可用空間自適應——
  // 長段 bay 伸長、槽化只留一小段；太短先縮槽化/漸變，再不行整段不生成
  for (const e of graph.scopeEdges(scopeFn)) {
    const p = e.road.properties
    if (e.back || p.oneway !== 'no' || !(p.centerM > 0)) continue
    const fa = amap.get(`way/${p.osm_id}@node/${e.toNode}`)
    const ba = amap.get(`way/${p.osm_id}@node/${e.fromNode}~b`)
    const n = (fa && wantBay(fa) ? 1 : 0) + (ba && wantBay(ba) ? 1 : 0)
    if (n === 0) continue
    const cum = cumulative(e.coords)
    const L = cum[cum.length - 1] - e.startSetbackM - e.endSetbackM // 兩端停止線間
    let taper = DEFAULTS.taper_len_m
    let hatch = n === 2 ? HATCH_TARGET : HATCH_TARGET * 0.8
    let bayLen = (L - n * taper - hatch) / n
    if (bayLen < MIN_BAY) { hatch = 8; bayLen = (L - n * taper - hatch) / n }
    if (bayLen < MIN_BAY) { taper = 10; bayLen = (L - n * taper - hatch) / n }
    // 還是不夠：整段不留槽化，斜切直接畫在區塊中間（兩向各佔一半，中點相接）
    if (bayLen < MIN_BAY) { hatch = 0; bayLen = (L - n * taper) / n }
    if (fa) tryMake(fa, { bayLen, taperLen: taper })
    if (ba) tryMake(ba, { bayLen, taperLen: taper })
  }

  // 其餘錨點（單行道左緣分支）：固定預設
  for (const a of anchors) {
    if (handled.has(anchorKey(a))) continue
    tryMake(a, { bayLen: DEFAULTS.bay_len_m, taperLen: DEFAULTS.taper_len_m })
  }
  return out
}

const num = (v: string | number | undefined, dflt: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 沿邊在距離 d 處、往行進方向右側偏 off 公尺的點（off 負 = 左）。
 * 偏移方向用當下線段的真實方位角（pointAlong 的 brg），不用平滑值。
 * （export 供 medians.ts 的 Case A 島面共用） */
export function offsetAt(coords: [number, number][], cum: number[], d: number, off: number): [number, number] {
  const { pos, brg } = pointAlong(coords, cum, d)
  const rad = ((brg + 90) * Math.PI) / 180
  return offsetMeters(pos, off * Math.sin(rad), off * Math.cos(rad))
}

/** 取樣距離序列：step 步進 + 指定關鍵點 + 端點 */
function sampleDs(from: number, to: number, step: number, extra: number[] = []): number[] {
  const ds: number[] = []
  for (let d = from; d < to; d += step) ds.push(d)
  ds.push(to, ...extra.filter((x) => x > from && x < to))
  return [...new Set(ds)].sort((x, y) => x - y)
}

function makeBay(
  a: BayAnchor, key: string, o: Record<string, string | number> | undefined,
  dflt: { bayLen: number; taperLen: number },
): TurnBay | null {
  const cum = cumulative(a.coords)
  const total = cum[cum.length - 1]
  // bay 前端收在停止線（節點回退交叉路半寬），不畫進路口框
  const end = total - a.setbackM
  if (end < MIN_DEFORM + 8) return null // 放不下儲車段

  const p = a.road.properties
  const isCenter = p.oneway === 'no' && (p.centerM || 0) > 0
  // 雙向且無中央帶（如藍田路 745巷以東 3+2 段）：沒有偏心空間，不生成 bay，
  // 左轉由最內車道地面箭頭（left;through）表達
  if (p.oneway === 'no' && !isCenter) return null
  const widthM = isCenter ? p.centerM : num(o?.width_m, DEFAULTS.width_m)
  const bayLenM = Math.min(num(o?.bay_len_m, dflt.bayLen), end * 0.8)
  const taperLenM = Math.min(num(o?.taper_len_m, dflt.taperLen), end * 0.3)
  const turns = String(o?.turns ?? DEFAULTS.turns)
  const d0 = end - bayLenM - taperLenM
  const bayStart = end - bayLenM

  const base = {
    key, wayId: a.wayId, nodeId: a.nodeId, approachBearing: a.approachBearing,
    bayLenM, taperLenM, widthM, turns,
    source: (o ? 'manual' : 'default') as TurnBay['source'],
    d0M: d0, bayStartM: bayStart, endM: end,
    back: a.back,
  }

  if (isCenter) {
    // ── 中央帶偏心道：bay = 中央車道本身（藍田路實驗主場）──
    const dv = a.back ? -(p.divOffM || 0) : (p.divOffM || 0) // 中央帶中心（行進 frame）
    const c = p.centerM / 2
    // 漸變段：雙黃線從自己車道側（dv+c）斜切到對向側（dv−c）——「慢慢雙黃線斜對切」
    const taperDs = sampleDs(d0, bayStart, 3)
    const diagonal = taperDs.map((d) =>
      offsetAt(a.coords, cum, d, dv + c - ((d - d0) / Math.max(1e-6, bayStart - d0)) * 2 * c))
    // 儲車段右界（與同向直行道分隔）＝白線
    const whiteDs = sampleDs(bayStart, end, 4)
    const white = whiteDs.map((d) => offsetAt(a.coords, cum, d, dv + c))
    const arrowDs = bayLenM >= 20 ? [end - 7, bayStart + 6] : [end - bayLenM / 2]
    return {
      ...base,
      kind: 'center', offM: dv,
      polygon: null, casing: null, // 中央帶已在路面寬內，不需另鋪面
      arrows: arrowDs.map((d) => ({
        pos: offsetAt(a.coords, cum, d, dv),
        brg: pointAlong(a.coords, cum, d).brg,
      })),
      lines: [
        { color: 'yellow', coords: diagonal },
        { color: 'white', coords: white },
      ],
    }
  }

  // ── 單行道左緣附加車道（成對單行未合併時的舊分支）──
  const roadHalf = p.oneway === 'yes'
    ? (Math.max(1, p.lanesForward) * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M : 0)) / 2
    : p.width_m / 2
  const R0 = -roadHalf
  const offM = R0 - widthM / 2
  const wAt = (d: number) =>
    d >= bayStart ? widthM : taperLenM > 0 ? (widthM * (d - d0)) / taperLenM : widthM
  const ds = sampleDs(d0, end, 3, [bayStart])
  const band = (w: (d: number) => number): [number, number][] => {
    const left = ds.map((d) => offsetAt(a.coords, cum, d, R0 - w(d)))
    const right = ds.map((d) => offsetAt(a.coords, cum, d, R0))
    return [...left, ...right.reverse(), left[0]]
  }
  const leftYellow = ds.map((d) => offsetAt(a.coords, cum, d, R0 - wAt(d)))
  leftYellow.push(offsetAt(a.coords, cum, end, R0))
  const rightWhite = ds.filter((d) => d >= bayStart).map((d) => offsetAt(a.coords, cum, d, R0))
  const arrowDs = bayLenM >= 20 ? [end - 7, bayStart + 6] : [end - bayLenM / 2]
  return {
    ...base,
    kind: 'side', offM,
    polygon: band(wAt), casing: band((d) => wAt(d) + 0.7),
    arrows: arrowDs.map((d) => ({
      pos: offsetAt(a.coords, cum, d, offM),
      brg: pointAlong(a.coords, cum, d).brg,
    })),
    lines: [
      { color: 'yellow', coords: leftYellow },
      { color: 'white', coords: rightWhite },
    ],
  }
}

/**
 * 中央帶標線（黃）：兩側 ±c 雙黃邊界（bay 開口處讓位）＋ 無 bay 區間的斜紋槽化。
 * 單行道舊分支：左緣整段黃線，畫到 bay 漸變段起點銜接。
 */
export function buildChannelization(graph: RoadGraph, bays: TurnBay[]): PaintLine[] {
  const bayMap = new Map<string, TurnBay>()
  for (const b of bays) bayMap.set(`${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`, b)
  const out: PaintLine[] = []

  for (const e of graph.scopeEdges(scopeFn)) {
    const p = e.road.properties
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const s0 = Math.min(e.startSetbackM, total)
    const s1 = Math.max(0, total - e.endSetbackM)
    if (s1 - s0 < 3) continue

    if (p.oneway === 'yes') {
      // 單行道：左緣（中央側）黃線，有 bay 則畫到漸變段起點
      const bay = bayMap.get(`${p.osm_id}@${e.toNode}`)
      const to = bay ? bay.d0M : s1
      if (to - s0 < 4) continue
      const R0 = -p.width_m / 2
      out.push({ color: 'yellow', coords: lineAt(e, cum, s0, to, R0) })
      continue
    }

    const c = (p.centerM || 0) / 2
    if (c === 0 || e.back) continue // 中央帶以順向 frame 統一處理一次
    if (p.centerKind === 'island') continue // 實體島由 medians.buildCenterIslands 畫
    const dv = p.divOffM || 0 // 中央帶中心（順向 frame）

    // 兩向 bay 在此路段的佔用區間（換算到順向 frame）
    const fwdBay = bayMap.get(`${p.osm_id}@${e.toNode}`)
    const bwdBay = bayMap.get(`${p.osm_id}@${e.fromNode}~b`)
    const fwdOpen = fwdBay ? [fwdBay.d0M, fwdBay.endM] : null // 順向側開口
    const bwdOpen = bwdBay ? [total - bwdBay.endM, total - bwdBay.d0M] : null // 對向側開口

    // 順向側邊界黃線：避開順向 bay 開口
    pushSegs(out, e, cum, dv + c, subtract([s0, s1], fwdOpen))
    // 對向側邊界黃線：避開對向 bay 開口
    pushSegs(out, e, cum, dv - c, subtract([s0, s1], bwdOpen))

    // 斜紋槽化：兩向 bay 都沒佔用的中段
    const hs = Math.max(s0, bwdOpen ? bwdOpen[1] : s0)
    const he = Math.min(s1, fwdOpen ? fwdOpen[0] : s1)
    for (let d = hs + 1.5; d + 2.2 < he; d += 4) {
      out.push({
        color: 'yellow',
        coords: [
          offsetAt(e.coords, cum, d, dv - c + 0.25),
          offsetAt(e.coords, cum, d + 2.2, dv + c - 0.25),
        ],
      })
    }
  }
  return out
}

function lineAt(e: ScopeEdge, cum: number[], from: number, to: number, off: number): [number, number][] {
  return sampleDs(from, to, 6).map((d) => offsetAt(e.coords, cum, d, off))
}

function pushSegs(out: PaintLine[], e: ScopeEdge, cum: number[], off: number, segs: [number, number][]) {
  for (const [a, b] of segs) {
    if (b - a < 2) continue
    out.push({ color: 'yellow', coords: lineAt(e, cum, a, b, off) })
  }
}

/** 區間扣除：[range] − [hole]（hole 可為 null；export 供 medians.ts 共用） */
export function subtract(range: [number, number], hole: number[] | null): [number, number][] {
  if (!hole) return [range]
  const out: [number, number][] = []
  if (hole[0] > range[0]) out.push([range[0], Math.min(hole[0], range[1])])
  if (hole[1] < range[1]) out.push([Math.max(hole[1], range[0]), range[1]])
  return out
}

/** turn:lanes 值正規化成箭頭 icon 鍵（slight_/sharp_ 併入左右；未知值 → ''） */
function canonTurn(v: string): string {
  const set = new Set<string>()
  for (const t of v.split(';')) {
    if (t === 'left' || t === 'slight_left' || t === 'sharp_left') set.add('left')
    else if (t === 'right' || t === 'slight_right' || t === 'sharp_right') set.add('right')
    else if (t === 'through') set.add('through')
    else if (t === 'reverse') set.add('reverse')
  }
  if (set.has('reverse') && set.size === 1) return 'reverse'
  return ['left', 'through', 'right'].filter((k) => set.has(k)).join(';')
}

/**
 * 路口地面車道箭頭：每個進入行向，在停止線前依每車道畫轉向箭頭。
 * 有轉向真值（人工編輯 turn_lanes/turn_lanes_backward 或 OSM tag）的行向照真值畫，
 * 全路網適用；否則僅實驗範圍（藍田路）畫預設推薦值
 * （直行/最外側補右轉；左轉由偏心道的箭頭承擔，無偏心道才畫在最內車道）。
 */
export function buildLaneArrows(graph: RoadGraph, bays: TurnBay[]): GroundArrow[] {
  const bayKeys = new Set(bays.map((b) => `${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`))
  const out: GroundArrow[] = []
  const hasTl = (r: { properties: { turnLanes?: string[]; turnLanesB?: string[] } }) =>
    !!(r.properties.turnLanes?.length || r.properties.turnLanesB?.length)
  for (const e of graph.scopeEdges((r) => scopeFn(r) || hasTl(r))) {
    const p = e.road.properties
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    if (lanes < 1) continue
    // 該行向的轉向真值（行向駕駛視角左→右）
    const tlRaw = (p.oneway === 'yes' || !e.back) ? p.turnLanes : p.turnLanesB
    const explicit = tlRaw?.map(canonTurn)
    const hasExplicit = !!explicit?.some(Boolean)
    if (!scopeFn(e.road) && !hasExplicit) continue // 非實驗範圍只畫有真值的行向
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const d = total - e.endSetbackM - 2.5
    if (d < e.startSetbackM + 6) continue // 短段不畫，避免疊在上一路口
    let moves: string[]
    if (hasExplicit) {
      moves = Array.from({ length: lanes }, (_, k) => explicit![k] ?? '')
    } else {
      const endBrg = pointAlong(e.coords, cum, Math.max(0, total - 2)).brg
      const kinds = graph.exitKindsAt(e.toNode, endBrg)
      if (kinds.size === 0) continue
      const hasBay = bayKeys.has(`${p.osm_id}@${e.toNode}${e.back ? '~b' : ''}`)
      // 每車道的動作：預設直行；最外側補右轉；無偏心道時最內側補左轉
      moves = Array.from({ length: lanes }, () => (kinds.has('straight') ? 'through' : ''))
      if (kinds.has('right')) moves[lanes - 1] = moves[lanes - 1] ? 'through;right' : 'right'
      if (kinds.has('left') && !hasBay) moves[0] = moves[0] ? 'left;through' : 'left'
    }
    // 車道基準（行進 frame）：單行道 = 斷面左緣；雙向 = 分向線 + 中央帶半寬
    const dv = e.back ? -(p.divOffM || 0) : (p.divOffM || 0)
    const base = p.oneway === 'yes' ? -p.width_m / 2 : dv + (p.centerM || 0) / 2
    const { brg } = pointAlong(e.coords, cum, d)
    for (let k = 0; k < lanes; k++) {
      if (!moves[k]) continue
      out.push({
        pos: offsetAt(e.coords, cum, d, base + (k + 0.5) * LANE_WIDTH_M),
        brg,
        icon: ARROW_ICON[moves[k]] ?? 'lane-arrow-through',
      })
    }
  }
  return out
}

const ARROW_ICON: Record<string, string> = {
  through: 'lane-arrow-through',
  right: 'lane-arrow-right',
  'through;right': 'lane-arrow-through-right',
  left: 'bay-arrow-left',
  'left;through': 'lane-arrow-left-through',
  'left;right': 'lane-arrow-left-right',
  reverse: 'bay-arrow-uturn',
}

/**
 * 某區塊/行向的「路面圖示轉向」：有真值用真值，否則用與 buildLaneArrows 相同的
 * 預設推導——車道編輯面板的初始值要跟路面畫的一致（以路面圖示為主）。
 */
export function groundMoves(
  graph: RoadGraph, bays: TurnBay[], road: ScopeEdge['road'], back: boolean,
): string[] {
  const p = road.properties
  const lanes = Math.max(1, p.oneway === 'yes' ? p.lanesForward : back ? p.lanesBackward : p.lanesForward)
  const explicit = (p.oneway === 'yes' || !back) ? p.turnLanes : p.turnLanesB
  if (explicit?.some(Boolean)) {
    return Array.from({ length: lanes }, (_, k) => explicit[k] || 'through')
  }
  const fallback = Array.from({ length: lanes }, () => 'through')
  const e = graph.scopeEdges((r) => r === road).find((x) => x.back === back)
  if (!e) return fallback
  const cum = cumulative(e.coords)
  const total = cum[cum.length - 1]
  const endBrg = pointAlong(e.coords, cum, Math.max(0, total - 2)).brg
  const kinds = graph.exitKindsAt(e.toNode, endBrg)
  if (kinds.size === 0) return fallback
  const hasBay = bays.some((b) =>
    b.wayId === p.osm_id && b.nodeId === e.toNode && b.back === back)
  const moves: string[] = Array.from({ length: lanes }, () => (kinds.has('straight') ? 'through' : ''))
  if (kinds.has('right')) moves[lanes - 1] = moves[lanes - 1] ? 'through;right' : 'right'
  if (kinds.has('left') && !hasBay) moves[0] = moves[0] ? 'left;through' : 'left'
  return moves.map((m) => m || 'through')
}

export function baysToGeoJSON(
  bays: TurnBay[], extraLines: PaintLine[] = [], extraArrows: GroundArrow[] = [],
): FeatureCollection {
  const features: Feature[] = []
  const pushLine = (line: PaintLine, key?: string) => features.push({
    type: 'Feature',
    properties: { kind: 'line', color: line.color, key },
    geometry: { type: 'LineString', coordinates: line.coords },
  })
  const pushArrow = (ar: GroundArrow, key?: string) => features.push({
    type: 'Feature',
    properties: { kind: 'arrow', icon: ar.icon, brg: Math.round(ar.brg * 10) / 10, key },
    geometry: { type: 'Point', coordinates: ar.pos },
  })
  for (const line of extraLines) pushLine(line)
  for (const ar of extraArrows) pushArrow(ar)
  for (const b of bays) {
    if (b.casing) {
      features.push({
        type: 'Feature', properties: { kind: 'casing', key: b.key },
        geometry: { type: 'Polygon', coordinates: [b.casing] },
      })
    }
    if (b.polygon) {
      features.push({
        type: 'Feature', properties: { kind: 'fill', key: b.key },
        geometry: { type: 'Polygon', coordinates: [b.polygon] },
      })
    }
    for (const line of b.lines) pushLine(line, b.key)
    for (const ar of b.arrows) {
      pushArrow({
        ...ar, icon: b.turns.includes('left') ? 'bay-arrow-left' : 'bay-arrow-uturn',
      }, b.key)
    }
  }
  return { type: 'FeatureCollection', features }
}

/** 編輯面板用：某路口的偏心道候選（= bayAnchors 在該節點的行向）與目前狀態 */
export interface BayCandidate {
  key: string
  roadName?: string
  approachBearing: number
  /** default 預設生成｜manual 人工參數｜off 人工關閉｜blocked 無法生成 */
  state: 'default' | 'manual' | 'off' | 'blocked'
  blockedReason?: string
  /** blocked 但可用 journal present:1 強制開啟（幾何放得下，只是判斷條件不滿足） */
  canForce?: boolean
  bay?: TurnBay
  /** journal 目前的覆寫欄位（含 present/參數） */
  fields?: Record<string, string | number>
}

export function bayCandidatesAt(
  graph: RoadGraph, journal: EnhancementRecord[], bays: TurnBay[], nodeId: number,
): BayCandidate[] {
  const over = foldBayOverrides(journal)
  return graph.bayAnchors(scopeFn)
    .filter((a) => a.nodeId === nodeId)
    .map((a) => {
      const key = `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`
      const bay = bays.find((b) => b.key === key)
      const o = over.get(key)
      let state: BayCandidate['state']
      let blockedReason: string | undefined
      let canForce = false
      if (bay) state = bay.source
      else if (o && Number(o.present) === 0) state = 'off'
      else {
        state = 'blocked'
        const p = a.road.properties
        if (p.oneway === 'no' && !(p.centerM > 0)) {
          blockedReason = '無中央帶——先在車道編輯把此路段的中央帶設 > 0'
        } else if (!a.hasLeftPair) {
          blockedReason = '自動判斷此行向無左轉配對——可直接開啟（或在車道編輯設偏心道轉向）'
          canForce = true
        } else {
          blockedReason = '路段太短，放不下儲車段'
        }
      }
      return { key, roadName: a.road.properties.name, approachBearing: a.approachBearing, state, blockedReason, canForce, bay, fields: o }
    })
    .sort((x, y) => x.approachBearing - y.approachBearing)
}

/**
 * 路線建好後標記偏心道：左轉/迴轉 maneuver 若在其路口、且進入行向與 bay 一致，
 * 記下 bay 中心偏移（targetOffsetAt / laneOffsetCoords 據此把變道目標改成 bay）。
 * 兩段式左轉不進 bay，所以要在 annotateTwoStage 之後呼叫。
 */
export function annotateBays(route: RouteResult, bays: TurnBay[]) {
  for (const m of route.maneuvers) {
    if (m.twoStage) continue
    if (m.kind !== 'left' && m.kind !== 'uturn') continue
    if (m.nodeId === undefined || m.fromBearing === undefined) continue
    const bay = bays.find((b) =>
      b.nodeId === m.nodeId && Math.abs(angleDelta(b.approachBearing, m.fromBearing!)) < 40)
    if (bay) m.bayOffM = bay.offM
  }
}
