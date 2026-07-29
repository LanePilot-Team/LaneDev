// 偏心左轉道與中央帶標線（設計見 nav_simulator/路上元件擴充設計.md §1）
//
// 實驗階段（藍田路）：couplet 合併後為單一雙向路體，斷面 = 兩向車道 + 中央帶
// （centerM，預設 3.2m）。中央帶的內容沿路變化：
//   - 路口前：某一方向的偏心左轉道（儲車段 ≥30m + 漸變段雙黃線斜對切）
//   - 其餘：黃色槽化線（兩側雙黃邊界 + 內部斜紋）
// 「查不到就假設每個左轉點都有」：預設生成（source=default），journal 只記覆寫
// （present:0 = 實地確認沒有）。標線顏色規則：分隔對向 = 黃、分隔同向 = 白。
import { buffer, featureCollection, intersect, lineString, polygon } from '@turf/turf'
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson'
import { angleDelta, bearing, cumulative, haversine, offsetMeters, pointAlong, skewFromCross, LANE_WIDTH_M } from './geo'
import { laneSpanM, MOTO_LANE_M } from './roads'
import type { RoadGraph, BayAnchor, ScopeEdge, RouteResult } from './graph'
import type { EnhancementRecord } from './enhancements'
import {
  buildCappedTriangleRange, buildHatchDistances, resolveChannelization,
  singleBayUnusedSideOffsets, TAIWAN_YELLOW_HATCH_V1,
} from './channelization'

// 生成範圍（2026-07-15 起不再限路名）：所有 couplet 合併、中央帶為槽化的路段。
// 「查不到就假設有」政策跟著放大到全部合併路——實地沒有的 bay 用面板關（present:0）。
// centerKind 被編輯改成 island 的區塊自動退出（島路段沒有偏心道/槽化線）。

const DEFAULTS = { bay_len_m: 30, taper_len_m: 15, width_m: 3.0, turns: 'left|uturn' }
/** 儲車段自適應：至少 MIN_BAY；長段讓 bay 伸長、槽化只留 HATCH 目標長；
 * 不夠再去掉槽化段——兩向漸變的雙黃斜切在區塊中點相接（短巷距路口常見樣式）；
 * 連 MIN_DEFORM 都放不下就整段不生成（畸形 bay 比沒有更糟），人工開啟例外 */
const MIN_BAY = 30
const MIN_DEFORM = 14
const HATCH_TARGET = 20
/** 「中央帶＋路口左轉道」只在接近路口時開口，不瓜分整個中央帶長度。 */
const ISLAND_BAY_LEN_M = 18
const ISLAND_BAY_TAPER_M = 10
/** 與 centerM=0 的純雙黃線一致：中心線左右各 0.18m。 */
const DOUBLE_YELLOW_HALF_GAP_M = 0.18

/**
 * Place a perpendicular road-end marking behind the whole skewed junction mouth.
 * `axisDistance` is the current centre-line setback and `skew * offset` describes
 * the junction boundary at each lateral offset.  Never advance beyond the
 * centre-line setback; only retreat enough that every point stays upstream.
 */
function perpendicularEndDistance(
  axisDistance: number,
  skew: number,
  innerOffset: number,
  outerOffset: number,
  clearanceM = 0,
): number {
  return axisDistance + Math.min(
    0,
    skew * innerOffset,
    skew * outerOffset,
  ) - clearanceM
}

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
  /** 停止線回退量（= 路口節點到 bay 前端的距離）——路線帶對齊 bay 開口用 */
  setbackM: number
  back: boolean
  /** 同一路段另一端也有偏心左轉道。 */
  paired: boolean
  /** 單邊使用時，另一端採既有封口處理或完全忽略（雙黃線保持直線）。 */
  singleMode: 'capped' | 'ignore'
  polygon: [number, number][] | null
  casing: [number, number][] | null
  arrows: { pos: [number, number]; brg: number; dM: number }[]
  /** 偏心道專屬路面印字錨點；位於儲車段內並朝向路口。 */
  roadText?: { pos: [number, number]; brg: number; dM: number }
  /** 邊線：黃 = 分隔對向（左緣/斜切），白 = 分隔同向（右緣） */
  lines: PaintLine[]
}

/** 標線線段（黃 = 分隔對向/槽化，白 = 分隔同向，stop = 停止線白粗橫線） */
export interface PaintLine {
  color: 'yellow' | 'white' | 'stop'
  coords: [number, number][]
  style?:
    | 'paired-center'
    | 'channel-hatch'
    | 'channel-cap'
    | 'single-bay-used'
    | 'single-bay-unused'
    | 'left-wait-side'
    | 'left-wait-front'
    | 'stop'
  ownerKey?: string
}

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

/**
 * 加昌路／加昌路857巷西側這一個 block 的實際配置是東向由中央實體島
 * 切出左轉儲車道。這是現地單一例外，不放進編輯工具或一般自動判斷。
 */
const scopeFn = (r: {
  properties: {
    coupletMerged?: boolean
    centerKind?: string
    islandBayMode?: boolean
  }
}) =>
  (!!r.properties.coupletMerged && r.properties.centerKind === 'hatch')
  || (r.properties.centerKind === 'island' && !!r.properties.islandBayMode)

/** 該路有任一行向的轉向真值（人工編輯或 OSM turn:lanes）——地面箭頭/停止線 scope 用 */
const hasTl = (r: { properties: { turnLanes?: string[]; turnLanesB?: string[] } }) =>
  !!(r.properties.turnLanes?.length || r.properties.turnLanesB?.length)

/** 停等線/箭頭/停等格擴大適用的「實際幹道／集散道」分級（2026-07-24 起）。 */
const THROUGH_CLASSES = new Set([
  'trunk', 'primary', 'secondary', 'tertiary',
  'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
])
/**
 * 是否為「實際道路」（該補停等線的行向）：幹道／集散道及其匝道；unclassified
 * 只在實際鋪面寬 ≥7m（有標準雙車道）時納入。小巷（service/residential/
 * living_street）、高架（motorway 本線＋橋面另畫）一律排除。
 * 交叉路是否「夠格」（供停等線定位的回退寬）沿用同一判定，見 crossQualifies。
 */
export const isMajorStopRoad = (r: {
  properties: { highway: string; width_m: number; elevated?: boolean }
}) => {
  const p = r.properties
  if (p.elevated) return false
  if (THROUGH_CLASSES.has(p.highway)) return true
  return p.highway === 'unclassified' && p.width_m >= 7
}

/**
 * 停止線適用道路：不看 OSM 道路分級，只看實際車道數。
 * 雙向正反合計至少 2 道（典型一來一往），或單行至少 2 道，就視為需要停止線；
 * 高架與地面道路僅為立體交會，不在地面路口生成。
 */
export const isStopLineRoad = (r: {
  properties: {
    oneway: string
    lanesForward: number
    lanesBackward: number
    elevated?: boolean
    sharedLane?: boolean
  }
}) => {
  const p = r.properties
  if (p.elevated || p.sharedLane) return false
  return p.oneway === 'yes'
    ? p.lanesForward >= 2
    : p.lanesForward + p.lanesBackward >= 2
}

/**
 * 計算停止線退縮量時的「交叉道路」資格。
 *
 * OSM 常把有中央分隔的主要道路拆成兩條單向 way；每條可能只標一車道，
 * 但兩條合計仍是完整的多車道路口。若沿用 isStopLineRoad 逐 way 要求兩
 * 車道，會把這類路口誤判成沒有交叉路，令停止線與機車停等格都無法編輯。
 * 主要道路級別可作為交叉路；住宅巷道仍維持原本的寬度門檻，不會因此普及
 * 生成停止線。
 */
const isStopLineCrossRoad = (r: {
  properties: {
    highway: string
    oneway: string
    lanesForward: number
    lanesBackward: number
    elevated?: boolean
    sharedLane?: boolean
  }
}) => {
  const p = r.properties
  if (p.elevated || p.sharedLane) return false
  // 原本「本身至少雙向合計兩車道」的資格必須保留；主要道路級別是為
  // OSM 拆成單向一車道的 couplet 額外放行，兩者是聯集而非互相取代。
  return isStopLineRoad(r)
    || ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(p.highway)
}

/**
 * 停止線／停等格共用的方向邊查詢：收邊（endSetbackM）必須用同一組交叉路資格
 * 判定，否則「畫得出停止線的路口」與「畫得出停等格的路口」會不一致——面板依
 * 前者放行、建置端依後者拒絕，人工設定就會被靜默還原。
 */
export function stopLineEdges(
  graph: RoadGraph, scope: (r: ScopeEdge['road']) => boolean,
): ScopeEdge[] {
  return graph.scopeEdges(scope, 7, 1.2, isStopLineCrossRoad)
    // 一般地面短段由緊湊配置處理；只有橋面／高架需要跨下一條落地 way
    // 尋找真正路口。限制範圍可避免整份地面路網承擔不必要的追蹤成本。
    .map((edge) => edge.road.properties.elevated
      ? graph.extendApproachToIntersection(edge, 45, 1.2)
      : edge)
}

/**
 * 判斷目前區塊／整條 way 是否曾由編輯器明確寫入指定欄位。
 * 幾何產生器用它區分「自動推薦」與「人工強制」：人工設定可在被 OSM
 * 名稱或 way 邊界切短的連續進口採用緊湊配置，自動標線仍維持保守門檻。
 */
function hasManualRoadField(
  journal: EnhancementRecord[],
  properties: { osm_id: number; blockNode: number },
  fields: string[],
): boolean {
  const blockKey = `way/${properties.osm_id}@b/${properties.blockNode}`
  const wayKey = `way/${properties.osm_id}`
  for (let index = journal.length - 1; index >= 0; index--) {
    const record = journal[index]
    if (record.op === 'delete' || record.target.type !== 'road') continue
    if (record.target.key !== blockKey && record.target.key !== wayKey) continue
    if (fields.some((field) => record.fields?.[field] !== undefined)) return true
  }
  return false
}

const anchorKey = (a: BayAnchor) => `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`

export function buildTurnBays(graph: RoadGraph, journal: EnhancementRecord[]): TurnBay[] {
  const over = foldBayOverrides(journal)
  const out: TurnBay[] = []
  // Candidates remain available for manual confirmation outside the automatic scope.
  const anchors = graph.bayAnchors(() => true)
  const amap = new Map(anchors.map((a) => [anchorKey(a), a]))
  const handled = new Set<string>()

  /** 是否生成：journal 覆寫（車道面板「偏心道轉向」與偏心道面板都寫這裡）
   * > 左轉配對自動判斷。不看一般車道的轉向真值——實地常見
   * 「偏心道左轉、內側車道全直行」，兩者是獨立車道 */
  const wantBay = (a: BayAnchor): boolean => {
    const o = over.get(anchorKey(a))
    if (a.road.properties.centerKind === 'island'
      && a.road.properties.islandBayMode) {
      return !!o && Number(o.present) === 1
    }
    if (o) return Number(o.present) !== 0 // 人工開/關（帶參數的覆寫視為開）
    if (!scopeFn(a.road)) return false
    if (!a.hasLeftPair) return false
    // 中央帶要放得下預設 3m 寬的 bay 才自動生成——泛用合併段的間距反推帶寬
    // 常只有 0.6~2m，硬畫會爆出路體；窄帶實地真有偏心道就用面板人工開啟
    const p = a.road.properties
    return p.oneway !== 'no' || p.centerM >= 3
  }

  const tryMake = (a: BayAnchor, dflt: { bayLen: number; taperLen: number }, paired = false) => {
    const key = anchorKey(a)
    handled.add(key)
    if (!wantBay(a)) return
    const o = over.get(key)
    // 人工開啟（present:1）：自適應長度不足時墊到 MIN_DEFORM，makeBay 再按
    // 可用空間夾住——短區塊「實地確認有偏心道」不能被預設門檻擋死
    const forced = !!o && Number(o.present) === 1
    const bayLen = forced ? Math.max(dflt.bayLen, MIN_DEFORM) : dflt.bayLen
    if (bayLen < MIN_DEFORM && !o?.bay_len_m) return // 放不下且無人工指定
    const sk = crossSkew(graph, a.road, a.nodeId, a.approachBearing)
    const bay = makeBay(a, key, o, { bayLen, taperLen: dflt.taperLen }, sk, paired)
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
    if (p.centerKind === 'island' && p.islandBayMode) {
      if (fa) tryMake(fa, {
        bayLen: ISLAND_BAY_LEN_M,
        taperLen: ISLAND_BAY_TAPER_M,
      }, n === 2)
      if (ba) tryMake(ba, {
        bayLen: ISLAND_BAY_LEN_M,
        taperLen: ISLAND_BAY_TAPER_M,
      }, n === 2)
      continue
    }
    const cum = cumulative(e.coords)
    const L = cum[cum.length - 1] - e.startSetbackM - e.endSetbackM // 兩端停止線間
    let taper = DEFAULTS.taper_len_m
    let hatch = n === 2 ? HATCH_TARGET : HATCH_TARGET * 0.8
    let bayLen = (L - n * taper - hatch) / n
    if (bayLen < MIN_BAY) { hatch = 8; bayLen = (L - n * taper - hatch) / n }
    if (bayLen < MIN_BAY) { taper = 10; bayLen = (L - n * taper - hatch) / n }
    // 還是不夠：整段不留槽化，斜切直接畫在區塊中間（兩向各佔一半，中點相接）
    if (bayLen < MIN_BAY) { hatch = 0; bayLen = (L - n * taper) / n }
    if (fa) tryMake(fa, { bayLen, taperLen: taper }, n === 2)
    if (ba) tryMake(ba, { bayLen, taperLen: taper }, n === 2)
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

/** 停止線/箭頭列對齊交叉路：橫向偏移 o（右正）對應的縱向平移 Δd = o × skew。
 * skew = −tan(α)，α = 交叉路走向與「進入行向法線」的線夾角（夾 ±45°，避免
 * 極銳角交會拉出畸形長線）；無交叉路或近順向岔路時 = 0（維持垂直於自身）。
 * 斜交路口（援中路×藍昌路等）靠這個讓標線平行於交會道路。 */
function crossSkew(
  graph: RoadGraph, road: ScopeEdge['road'], nodeId: number, approachBearing: number,
): number {
  const c = graph.crossOrientationAt(nodeId, approachBearing, road)
  return c === null ? 0 : skewFromCross(approachBearing, c)
}

/** 取樣距離序列：step 步進 + 指定關鍵點 + 端點 */
function sampleDs(from: number, to: number, step: number, extra: number[] = []): number[] {
  const ds: number[] = []
  for (let d = from; d < to; d += step) ds.push(d)
  ds.push(to, ...extra.filter((x) => x > from && x < to))
  return [...new Set(ds)].sort((x, y) => x - y)
}

// 偏心道內的縱向排版：文字在上游、箭頭集中在路口端。
// 文字約長 10m、箭頭約長 4.5m，中心至少相隔 9.25m（兩者半長 + 2m 留白）。
export const BAY_TEXT_ARROW_CLEARANCE_M = 9.25
function bayMarkLayout(d0: number, bayStart: number, end: number, shift: number) {
  const clamp = (d: number) => Math.max(d0 + 2, Math.min(end - 2, d))
  // 偏心道只保留最前方一組轉向箭頭，中心貼近停止線前約 2.8m；
  // 箭頭本體仍完整留在停止線內，不再因長儲車段於中段多畫一組。
  const frontArrow = clamp(end - 2.8 + shift)
  const textD = clamp(Math.min(bayStart + 5 + shift, frontArrow - BAY_TEXT_ARROW_CLEARANCE_M))
  const arrows = [frontArrow]
  return { textD, arrowDs: arrows }
}

function makeBay(
  a: BayAnchor, key: string, o: Record<string, string | number> | undefined,
  dflt: { bayLen: number; taperLen: number }, sk = 0, paired = false,
): TurnBay | null {
  const cum = cumulative(a.coords)
  const total = cum[cum.length - 1]
  // bay 前端收在停止線（節點回退交叉路半寬），不畫進路口框。
  // 人工明確開啟時允許緊湊配置：OSM 常被小巷口切成短 block，不能讓已儲存的
  // present:1 因自動生成的保守門檻而失效；沒有人工覆寫的路段仍維持原門檻。
  const end = total - a.setbackM
  const manuallyForced = !!o && Number(o.present) === 1
  if (end < MIN_DEFORM + (manuallyForced ? 4 : 8)) return null

  const p = a.road.properties
  const isCenter = p.oneway === 'no' && (p.centerM || 0) > 0
  // 雙向且無中央帶（如藍田路 745巷以東 3+2 段）：沒有偏心空間，不生成 bay，
  // 左轉由最內車道地面箭頭（left;through）表達
  if (p.oneway === 'no' && !isCenter) return null
  const widthM = isCenter ? p.centerM : num(o?.width_m, DEFAULTS.width_m)
  const bayLenM = Math.min(num(o?.bay_len_m, dflt.bayLen), end * 0.8)
  // 緊湊 block 仍須保證 bay + taper 不超過可用長度，避免 d0 落到線段外。
  const taperLenM = Math.min(
    num(o?.taper_len_m, dflt.taperLen),
    end * 0.3,
    Math.max(2, end - bayLenM),
  )
  const turns = String(o?.turns ?? DEFAULTS.turns)
  const singleMode: TurnBay['singleMode'] = o?.single_mode === 'ignore' ? 'ignore' : 'capped'
  const d0 = end - bayLenM - taperLenM
  const bayStart = end - bayLenM

  const base = {
    key, wayId: a.wayId, nodeId: a.nodeId, approachBearing: a.approachBearing,
    bayLenM, taperLenM, widthM, turns,
    source: (o ? 'manual' : 'default') as TurnBay['source'],
    d0M: d0, bayStartM: bayStart, endM: end, setbackM: a.setbackM,
    back: a.back, paired, singleMode,
  }

  if (isCenter) {
    // ── 中央帶偏心道：bay = 中央車道本身（藍田路實驗主場）──
    const dv = 0 // 雙向道路中央分向基準固定在 OSM 軸
    const c = p.centerM / 2
    // 漸變段：雙黃線從自己車道側（dv+c）斜切到對向側（dv−c）——「慢慢雙黃線斜對切」
    const taperDs = sampleDs(d0, bayStart, 3)
    const diagonal = (gap: number) => taperDs.map((d) => {
      const t = Math.max(0, Math.min(1, (d - d0) / Math.max(1e-6, bayStart - d0)))
      // 單端偏心道用 smoothstep 進出漸變段，避免直線折角；雙端 S 型仍由
      // buildChannelization 統一生成。
      const smoothT = t * t * (3 - 2 * t)
      return offsetAt(a.coords, cum, d, dv + c - smoothT * 2 * c + gap)
    })
    // 儲車段右界（與同向直行道分隔）＝白線；末端裁到停止線斜線
    const endW = Math.min(total, Math.max(bayStart + 2, end + sk * (dv + c)))
    const whiteDs = sampleDs(bayStart, endW, 4)
    const white = whiteDs.map((d) => offsetAt(a.coords, cum, d, dv + c))
    // 箭頭跟著停止線的交叉路對齊平移（skew×橫向偏移），夾在儲車段內
    const { arrowDs, textD } = bayMarkLayout(d0, bayStart, end, sk * dv)
    return {
      ...base,
      kind: 'center', offM: dv,
      polygon: null, casing: null, // 中央帶已在路面寬內，不需另鋪面
      arrows: arrowDs.map((d) => ({
        pos: offsetAt(a.coords, cum, d, dv),
        brg: pointAlong(a.coords, cum, d).brg,
        dM: d,
      })),
      roadText: bayLenM < 20 ? undefined : {
        pos: offsetAt(a.coords, cum, textD, dv),
        brg: pointAlong(a.coords, cum, textD).brg,
        dM: textD,
      },
      // 中央雙黃線一律由 buildChannelization 統一繪製，避免單向偏心道
      // 同時由 bay 與 channelization 各畫一次而產生重疊。
      lines: [{ color: 'white', coords: white }],
    }
  }

  // ── 單行道左緣附加車道（成對單行未合併時的舊分支）──
  const roadHalf = p.oneway === 'yes'
    ? Math.max(LANE_WIDTH_M, laneSpanM(p, false)) / 2
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
  const { arrowDs, textD } = bayMarkLayout(d0, bayStart, end, sk * offM)
  return {
    ...base,
    kind: 'side', offM,
    polygon: band(wAt), casing: band((d) => wAt(d) + 0.7),
    arrows: arrowDs.map((d) => ({
      pos: offsetAt(a.coords, cum, d, offM),
      brg: pointAlong(a.coords, cum, d).brg,
      dM: d,
    })),
    roadText: bayLenM < 20 ? undefined : {
      pos: offsetAt(a.coords, cum, textD, offM),
      brg: pointAlong(a.coords, cum, textD).brg,
      dM: textD,
    },
    lines: [
      { color: 'yellow', coords: leftYellow },
      { color: 'white', coords: rightWhite },
    ],
  }
}

const GORE_YELLOW = '#f5c542'
const GORE_OUTLINE_M = 0.15
const GORE_STRIPE_M = 0.18
const GORE_STRIPE_SPACING_M = 1.25

export type UnusedLaneGoreParams = {
  roadId: string
  centerline: Feature<LineString>
  sStart: number
  sEnd: number
  doubleYellowOffsetM: number
  centerTurnLaneOuterOffsetM: number
  unusedDirection: 'forward' | 'backward'
}

/** 以道路里程與公尺 offset 建立尖端漸寬的未使用車道槽化面。 */
export function buildUnusedLaneGorePolygon(
  params: UnusedLaneGoreParams,
): Feature<Polygon> | null {
  const coords = params.centerline.geometry.coordinates as [number, number][]
  const cum = cumulative(coords)
  const available = params.sEnd - params.sStart
  const laneWidthM = Math.abs(params.centerTurnLaneOuterOffsetM - params.doubleYellowOffsetM)
  if (coords.length < 2 || available < 4 || laneWidthM < 0.4) return null
  const fullWidthStartT = available < 12 ? 0.82 : 0.72
  const stations = sampleDs(params.sStart, params.sEnd, 0.75)
  const doubleYellowEdge = stations.map((s) => offsetAt(coords, cum, s, params.doubleYellowOffsetM))
  const outerTaperEdge = stations.map((s) => {
    const t = Math.max(0, Math.min(1, (s - params.sStart) / available))
    const x = Math.max(0, Math.min(1, (t - 0.03) / Math.max(0.01, fullWidthStartT - 0.03)))
    const eased = x * x * (3 - 2 * x)
    const offset = params.doubleYellowOffsetM +
      (params.centerTurnLaneOuterOffsetM - params.doubleYellowOffsetM) * eased
    return offsetAt(coords, cum, s, offset)
  })
  const ring = [...doubleYellowEdge, ...outerTaperEdge.reverse(), doubleYellowEdge[0]]
  return polygon([ring], {
    featureType: 'unused_lane_gore',
    color: GORE_YELLOW,
    roadId: params.roadId,
    unusedDirection: params.unusedDirection,
    sStart: params.sStart,
    sEnd: params.sEnd,
    laneWidthM,
    geometryMode: 'center-turn-lane-smooth-taper',
  }) as Feature<Polygon>
}

/** 只描外側邊界與完整寬度端；內側由既有雙黃線負責。 */
export function buildGoreOutlinePolygons(
  gore: Feature<Polygon>,
): Feature<Polygon>[] {
  const ring = gore.geometry.coordinates[0] as [number, number][]
  const n = (ring.length - 1) / 2
  const outer = ring.slice(n, n * 2).reverse()
  const endCap = [ring[n - 1], outer[outer.length - 1]]
  const props = gore.properties ?? {}
  return [outer, endCap].flatMap((coords) => {
    if (coords.length < 2 || haversine(coords[0], coords[coords.length - 1]) < 0.2) return []
    const p = buffer(lineString(coords), GORE_OUTLINE_M / 2, { units: 'meters', steps: 2 })
    return p ? [{ ...p, properties: {
      featureType: 'unused_lane_gore_outline', color: GORE_YELLOW,
      roadId: props.roadId, unusedDirection: props.unusedDirection,
    } } as Feature<Polygon>] : []
  })
}

/** 以公尺間距建立實體 Polygon 斜紋；端點位於槽化面兩界之內。 */
export function buildGoreHatchPolygons(
  gore: Feature<Polygon>,
): Feature<Polygon>[] {
  const ring = gore.geometry.coordinates[0] as [number, number][]
  const n = (ring.length - 1) / 2
  const doubleYellowEdge = ring.slice(0, n)
  const outerEdge = ring.slice(n, n * 2).reverse()
  const props = gore.properties ?? {}
  const out: Feature<Polygon>[] = []
  const sampleStepM = Number(props.sEnd) > Number(props.sStart)
    ? (Number(props.sEnd) - Number(props.sStart)) / Math.max(1, doubleYellowEdge.length - 1)
    : 0.75
  const advance = Math.max(
    1,
    Math.round(Number(props.laneWidthM || 3) / Math.max(0.25, sampleStepM)),
  )
  let lastStation = -Infinity
  for (let i = 1; i < Math.min(doubleYellowEdge.length, outerEdge.length) - 1; i++) {
    const station = Number(props.sStart) + sampleStepM * i
    if (station - lastStation < GORE_STRIPE_SPACING_M) continue
    if (haversine(doubleYellowEdge[i], outerEdge[i]) < 0.55) continue
    const j = Math.min(doubleYellowEdge.length - 1, i + advance)
    const stripe = buffer(lineString([outerEdge[i], doubleYellowEdge[j]]), GORE_STRIPE_M / 2, {
      units: 'meters', steps: 2,
    })
    if (!stripe) continue
    const clipped = intersect(featureCollection([stripe, gore]))
    if (!clipped || clipped.geometry.type !== 'Polygon') continue
    lastStation = station
    out.push({ ...clipped, properties: {
      featureType: 'unused_lane_gore_hatch', color: GORE_YELLOW,
      roadId: props.roadId, unusedDirection: props.unusedDirection,
      stripeAngleDeg: props.unusedDirection === 'forward' ? 45 : -45,
    } } as Feature<Polygon>)
  }
  return out
}

export function renderUnusedLaneGore(
  params: UnusedLaneGoreParams,
): FeatureCollection<Polygon> {
  const gore = buildUnusedLaneGorePolygon(params)
  if (!gore) return featureCollection([])
  return featureCollection([gore, ...buildGoreOutlinePolygons(gore), ...buildGoreHatchPolygons(gore)])
}

export function buildUnusedLaneGores(
  _graph: RoadGraph, _bays: TurnBay[],
): FeatureCollection<Polygon> {
  // 單向與雙向偏心道已統一採 S 型雙黃線；不再另外生成未使用方向槽化面。
  return featureCollection([])
}

/**
 * 中央帶標線（黃）：兩側 ±c 雙黃邊界（bay 開口處讓位）＋ 無 bay 區間的斜紋槽化。
 * 單行道舊分支：左緣整段黃線，畫到 bay 漸變段起點銜接。
 */
export function buildChannelization(
  graph: RoadGraph, bays: TurnBay[], journal: EnhancementRecord[] = [],
): PaintLine[] {
  const bayMap = new Map<string, TurnBay>()
  for (const b of bays) bayMap.set(`${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`, b)
  const out: PaintLine[] = []
  const cappedBayKeys = new Set<string>()
  const manuallyIncludedWays = new Set(
    bays.filter((bay) => bay.source === 'manual' && bay.kind === 'center').map((bay) => bay.wayId),
  )

  // 繪圖線需對所有真交叉道路淨空（含 6.4m 小路），並多留 2m 路口邊界。
  // 偏心道、停止線仍沿用原本 ≥7m 的判定，避免改變交通語意。
  for (const e of graph.scopeEdges(
    (road) => scopeFn(road) || manuallyIncludedWays.has(road.properties.osm_id), 0, 2,
  )) {
    const p = e.road.properties
    if (p.roadMarkingMode === 'none') continue
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const s0 = Math.min(e.startSetbackM, total)
    const s1 = Math.max(0, total - e.endSetbackM)
    if (s1 - s0 < 3) continue
    // 兩端的停止線斜線係數（裁切點 = s0/s1 + 橫向偏移×sk ∓ 0.5，收邊平行交叉路）
    const sk1 = crossSkew(graph, e.road, e.toNode, pointAlong(e.coords, cum, Math.max(0, total - 2)).brg)
    const sk0 = crossSkew(graph, e.road, e.fromNode, pointAlong(e.coords, cum, Math.min(2, total)).brg)

    if (p.oneway === 'yes') {
      // 單行道：左緣（中央側）黃線，有 bay 則畫到漸變段起點
      const bay = bayMap.get(`${p.osm_id}@${e.toNode}`)
      const R0 = -laneSpanM(p, false) / 2
      const from = Math.max(0, s0 + sk0 * R0 + 0.5)
      const to = bay ? bay.d0M : Math.min(total, s1 + sk1 * R0 - 0.5)
      if (to - from < 4) continue
      out.push({ color: 'yellow', coords: lineAt(e, cum, from, to, R0) })
      continue
    }

    const c = (p.centerM || 0) / 2
    if (c === 0 || e.back) continue // 中央帶以順向 frame 統一處理一次
    if (p.centerKind === 'island') continue // 實體島由 medians.buildCenterIslands 畫
    const dv = 0 // 雙向道路中央分向基準固定在 OSM 軸

    // 兩向 bay 在此路段的佔用區間（換算到順向 frame）
    const fwdBay = bayMap.get(`${p.osm_id}@${e.toNode}`)
    const bwdBay = bayMap.get(`${p.osm_id}@${e.fromNode}~b`)
    const fwdOpen = fwdBay ? [fwdBay.d0M, fwdBay.endM] : null // 順向側開口
    const bwdOpen = bwdBay ? [total - bwdBay.endM, total - bwdBay.d0M] : null // 對向側開口
    const paired = !!(fwdBay?.paired && bwdBay?.paired && fwdOpen && bwdOpen)

    const onlyFwdBay = !!fwdOpen && !bwdOpen
    const onlyBwdBay = !!bwdOpen && !fwdOpen
    const singleBay = onlyFwdBay ? fwdBay : onlyBwdBay ? bwdBay : undefined
    if (singleBay?.singleMode === 'ignore') {
      // 單邊使用／另一端完全忽略：不做 S 型換位，也不在未使用端生成槽化、
      // 封口或補償線。雙黃線固定在偏心道的對向側，中央預留寬度整段直接
      // 分配給唯一有左轉功能的行向。
      const off = onlyFwdBay ? dv - c : dv + c
      const from = Math.max(0, s0 + sk0 * off + 0.5)
      const to = Math.min(total, s1 + sk1 * off - 0.5)
      pushDoubleSegs(
        out, e, cum, off, [[from, to]], 'single-bay-used', singleBay.key,
      )
      continue
    }
    if (paired) {
      // 所有偏心左轉道共用同一套平順 S 型雙黃線。
      // 單向使用時，未使用方向維持原車道配置較久，到接近偏心道口才換位。
      let bendFrom: number
      let bendTo: number
      if (paired) {
        bendFrom = Math.max(s0, bwdOpen![1])
        bendTo = Math.min(s1, fwdOpen![0])
      } else if (onlyFwdBay) {
        const delayed = fwdBay!.d0M + fwdBay!.taperLenM * 0.45
        bendFrom = Math.max(s0, delayed)
        bendTo = Math.min(s1, fwdBay!.bayStartM)
      } else {
        bendFrom = Math.max(s0, total - bwdBay!.bayStartM)
        bendTo = Math.min(s1, total - (bwdBay!.d0M + bwdBay!.taperLenM * 0.45))
      }
      // 短區塊或不對稱退界可能讓兩個 bay 的開口重疊。不可退化為中央直線，
      // 改以兩開口交界的中點建立至少 24m（受可用長度限制）的換位區。
      if (bendTo - bendFrom < 12) {
        const mid = Math.max(s0, Math.min(s1, (bendFrom + bendTo) / 2))
        const half = Math.min(18, Math.max(6, (s1 - s0) * 0.22))
        bendFrom = Math.max(s0, mid - half)
        bendTo = Math.min(s1, mid + half)
      }
      const smooth = (t: number) => t * t * (3 - 2 * t)
      const centerOff = (d: number) => {
        if (bendTo <= bendFrom + 0.5) return dv + c
        if (d <= bendFrom) return dv + c
        if (d >= bendTo) return dv - c
        return dv + c - 2 * c * smooth((d - bendFrom) / (bendTo - bendFrom))
      }
      const ds = sampleDs(s0, s1, 2.5, [bendFrom, bendTo])
      for (const gap of [-DOUBLE_YELLOW_HALF_GAP_M, DOUBLE_YELLOW_HALF_GAP_M]) {
        out.push({
          color: 'yellow',
          style: paired ? 'paired-center' : 'single-bay-used',
          ownerKey: paired ? undefined : (fwdBay ?? bwdBay)?.key,
          coords: ds.map((d) => offsetAt(e.coords, cum, d, centerOff(d) + gap)),
        })
      }
      continue
    }

    // 觸到 s0/s1 的段端點改裁到停止線斜線（bay 開口側的內部端點不動）
    const clip = (segs: [number, number][], o: number): [number, number][] =>
      segs.map(([a, b]) => [
        a <= s0 + 1e-6 ? Math.max(0, s0 + sk0 * o + 0.5) : a,
        b >= s1 - 1e-6 ? Math.min(total, s1 + sk1 * o - 0.5) : b,
      ] as [number, number])
    // 斜紋槽化：兩向 bay 都沒佔用的中段（兩端依斜線取保守界，斜紋不戳出停止線）
    const hs = Math.max(s0 + Math.max(sk0 * (dv - c), sk0 * (dv + c)) + 0.5, bwdOpen ? bwdOpen[1] : 0)
    const he = Math.min(s1 + Math.min(sk1 * (dv - c), sk1 * (dv + c)) - 0.5, fwdOpen ? fwdOpen[0] : total)
    const paintBoundary = (off: number, segs: [number, number][]) => {
      for (const seg of segs) {
        const hatchPart: [number, number] = [Math.max(seg[0], hs), Math.min(seg[1], he)]
        if (hatchPart[1] - hatchPart[0] >= 2) {
          // 包覆槽化斜紋的區段維持單黃線。
          pushSegs(out, e, cum, off, [hatchPart])
        }
        // 離開槽化區後，單獨延伸的分向線恢復為純雙黃線樣式。
        for (const plainPart of subtract(seg, he > hs ? [hs, he] : null)) {
          pushDoubleSegs(out, e, cum, off, [plainPart])
        }
      }
    }
    const activeBayKey = (fwdBay ?? bwdBay)?.key
    if (onlyFwdBay || onlyBwdBay) {
      const channelization = activeBayKey && singleBay
        ? resolveChannelization(activeBayKey, singleBay, journal)
        : null
      const smooth = (t: number) => t * t * (3 - 2 * t)
      const activeBay = singleBay!
      const sideOffsets = singleBayUnusedSideOffsets(
        onlyFwdBay ? 'forward' : 'backward', c, dv,
      )
      const fixedOff = sideOffsets.movingStart
      const capOff = sideOffsets.unusedBoundary
      const clippedStart = (off: number) => Math.max(0, s0 + sk0 * off + 0.5)
      const clippedEnd = (off: number) => Math.min(total, s1 + sk1 * off - 0.5)
      const movingCapRoadM = onlyFwdBay ? clippedStart(capOff) : clippedEnd(capOff)
      const fixedCapRoadM = onlyFwdBay ? clippedStart(fixedOff) : clippedEnd(fixedOff)
      // The closed wedge reaches the point where the full-width turn lane
      // separates from the original lane line.  d0M is merely the beginning
      // of the short automatic taper and made the marking collapse into a
      // small triangle beside the stop line.
      const tipRoadM = onlyFwdBay ? activeBay.bayStartM : total - activeBay.bayStartM
      const toUnusedApproachM = (roadM: number) => onlyFwdBay ? total - roadM : roadM
      const tipApproachM = toUnusedApproachM(tipRoadM)
      const movingCapApproachM = toUnusedApproachM(movingCapRoadM)
      const movingAt = (approachM: number) => {
        const t = Math.max(0, Math.min(1,
          (approachM - tipApproachM) / Math.max(1e-6, movingCapApproachM - tipApproachM)))
        return fixedOff + smooth(t) * (capOff - fixedOff)
      }
      const triangle = buildCappedTriangleRange({
        taperStartM: tipApproachM,
        stopBoundaryM: movingCapApproachM,
        movingAt,
        fixedOffsetM: fixedOff,
      })
      const wedgeFrom = triangle
        ? Math.max(s0, onlyFwdBay
          ? Math.max(movingCapRoadM, fixedCapRoadM)
          : tipRoadM)
        : 0
      const wedgeTo = triangle
        ? Math.min(s1, onlyFwdBay
          ? tipRoadM
          : Math.min(movingCapRoadM, fixedCapRoadM))
        : 0
      const triangleMovingOff = (d: number) => triangle?.movingAt(toUnusedApproachM(d)) ?? fixedOff
      const triangleFixedOff = triangle?.fixedOffsetM ?? fixedOff

      // Capped triangle geometry belongs solely to the central-band turn-bay setting.
      // Legacy channelization records may disable it, but cannot move either side or width.
      const boundaryOff = (_d: number) => triangleFixedOff

      if (triangle && activeBay.singleMode === 'capped' && channelization
        && wedgeTo - wedgeFrom >= TAIWAN_YELLOW_HATCH_V1.minLengthM) {
        const movingOutlineFrom = onlyFwdBay ? movingCapRoadM : tipRoadM
        const movingOutlineTo = onlyFwdBay ? tipRoadM : movingCapRoadM
        const fixedOutlineFrom = onlyFwdBay ? fixedCapRoadM : tipRoadM
        const fixedOutlineTo = onlyFwdBay ? tipRoadM : fixedCapRoadM
        out.push(
          {
            color: 'yellow',
            style: 'single-bay-unused',
            ownerKey: activeBayKey,
            coords: sampleDs(movingOutlineFrom, movingOutlineTo, 2.5)
              .map((d) => offsetAt(e.coords, cum, d, triangleMovingOff(d))),
          },
          {
            color: 'yellow',
            style: 'single-bay-unused',
            ownerKey: activeBayKey,
            coords: sampleDs(fixedOutlineFrom, fixedOutlineTo, 2.5)
              .map((d) => offsetAt(e.coords, cum, d, triangleFixedOff)),
          },
        )
        for (const d of buildHatchDistances(wedgeFrom, wedgeTo)) {
          const d2 = Math.min(wedgeTo - TAIWAN_YELLOW_HATCH_V1.insetM,
            d + TAIWAN_YELLOW_HATCH_V1.stripePitchM)
          if (d2 <= d) continue
          const moving = triangleMovingOff(d)
          const boundary = boundaryOff(d)
          const side = Math.sign(boundary - moving)
          if (Math.abs(boundary - moving) < TAIWAN_YELLOW_HATCH_V1.insetM * 2
            || Math.abs(boundaryOff(d2) - triangleMovingOff(d2))
              < TAIWAN_YELLOW_HATCH_V1.insetM * 2) continue
          out.push({
            color: 'yellow',
            style: 'channel-hatch',
            ownerKey: activeBayKey,
            coords: [
              offsetAt(e.coords, cum, d, moving + side * TAIWAN_YELLOW_HATCH_V1.insetM),
              offsetAt(e.coords, cum, d2, boundaryOff(d2) - side * TAIWAN_YELLOW_HATCH_V1.insetM),
            ],
          })
        }
        const cappedKey = `${activeBayKey}:stop`
        if (!cappedBayKeys.has(cappedKey)) {
          cappedBayKeys.add(cappedKey)
          out.push({
            color: 'yellow',
            style: 'channel-cap',
            ownerKey: activeBayKey,
            coords: [
              offsetAt(e.coords, cum, movingCapRoadM, capOff),
              offsetAt(e.coords, cum, fixedCapRoadM, triangleFixedOff),
            ],
          })
        }
      }
      if (onlyFwdBay) {
        pushDoubleSegs(
          out, e, cum, dv - c,
          clip([[fwdBay!.bayStartM, s1]], dv - c),
          'single-bay-used', activeBayKey,
        )
      } else {
        pushDoubleSegs(
          out, e, cum, dv + c,
          clip([[s0, total - bwdBay!.bayStartM]], dv + c),
          'single-bay-used', activeBayKey,
        )
      }
      continue
      // 單方向偏心道：
      // 這裡的「使用／未使用」是道路前後段，不是中央帶的左右邊界：
      // - 沒有左轉功能的另一端，中央預留區以槽化斜紋鋪滿，兩側皆為單黃線。
      // - 有左轉功能的一端，由 makeBay 的平滑雙黃漸變接到儲車段，再以雙黃線
      //   沿儲車段延伸至停止線。
      const hatchRange: [number, number] = [hs, he]
    } else {
      // 無偏心道或兩側皆有非成對人工設定時，沿用一般槽化邊界規則。
      paintBoundary(dv + c, clip(subtract([s0, s1], fwdOpen), dv + c))
      paintBoundary(dv - c, clip(subtract([s0, s1], bwdOpen), dv - c))
    }

    let hatchCount = 0
    const shouldPaintCentralHatch = p.centerKind === 'hatch'
    for (const d of shouldPaintCentralHatch ? buildHatchDistances(hs, he) : []) {
      const d2 = Math.min(he - TAIWAN_YELLOW_HATCH_V1.insetM,
        d + TAIWAN_YELLOW_HATCH_V1.stripePitchM)
      if (d2 <= d) continue
      out.push({
        color: 'yellow',
        style: 'channel-hatch',
        ownerKey: (fwdBay ?? bwdBay)?.key,
        coords: [
          offsetAt(e.coords, cum, d, dv - c + TAIWAN_YELLOW_HATCH_V1.insetM),
          offsetAt(e.coords, cum, d2, dv + c - TAIWAN_YELLOW_HATCH_V1.insetM),
        ],
      })
      hatchCount++
    }
    // 很短的單端未使用段（3~3.7m）也至少放入一道自適應斜紋；
    // 不可因固定 2.2m 斜紋加邊距後放不下，就只剩外框而沒有槽化內容。
    if ((onlyFwdBay || onlyBwdBay) && he - hs >= 3 && hatchCount === 0) {
      const margin = 0.4
      out.push({
        color: 'yellow',
        style: 'channel-hatch',
        ownerKey: activeBayKey,
        coords: [
          offsetAt(e.coords, cum, hs + margin, dv - c + 0.25),
          offsetAt(e.coords, cum, he - margin, dv + c - 0.25),
        ],
      })
    }
    // 單端偏心道的槽化區只在 bay 端收尖，另一端必須以橫向黃線封口。
    if (!!fwdOpen !== !!bwdOpen && he - hs >= 3) {
      const capKey = (fwdBay ?? bwdBay)!.key
      for (const [capSide, capD] of [['start', hs], ['end', he]] as const) {
        const cappedKey = `${capKey}:${capSide}`
        if (cappedBayKeys.has(cappedKey)) continue
        cappedBayKeys.add(cappedKey)
        out.push({
          color: 'yellow',
          style: 'channel-cap',
          ownerKey: capKey,
          coords: [
            offsetAt(e.coords, cum, capD, dv - c),
            offsetAt(e.coords, cum, capD, dv + c),
          ],
        })
      }
    }
  }
  return out
}

function lineAt(e: ScopeEdge, cum: number[], from: number, to: number, off: number): [number, number][] {
  return sampleDs(from, to, 6).map((d) => offsetAt(e.coords, cum, d, off))
}

function pushSegs(
  out: PaintLine[], e: ScopeEdge, cum: number[], off: number, segs: [number, number][],
  style?: PaintLine['style'], ownerKey?: string,
) {
  for (const [a, b] of segs) {
    if (b - a < 2) continue
    // 槽化區左右外框採單黃線；偏心道漸變段的雙黃線由 makeBay 另外生成。
    out.push({ color: 'yellow', coords: lineAt(e, cum, a, b, off), style, ownerKey })
  }
}

function pushDoubleSegs(
  out: PaintLine[], e: ScopeEdge, cum: number[], off: number, segs: [number, number][],
  style?: PaintLine['style'], ownerKey?: string,
) {
  for (const [a, b] of segs) {
    if (b - a < 2) continue
    out.push(
      {
        color: 'yellow', coords: lineAt(e, cum, a, b, off - DOUBLE_YELLOW_HALF_GAP_M),
        style, ownerKey,
      },
      {
        color: 'yellow', coords: lineAt(e, cum, a, b, off + DOUBLE_YELLOW_HALF_GAP_M),
        style, ownerKey,
      },
    )
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
  // 並排式直行+右轉（兩支完整箭頭）：自訂 token，不做合併正規化
  if (v.trim() === 'through+right') return 'through+right'
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
export function buildLaneArrows(
  graph: RoadGraph, bays: TurnBay[], rightLanes: RightLane[] = [],
  motoBoxDirs: Set<string> = new Set(),
  journal: EnhancementRecord[] = [],
): GroundArrow[] {
  const bayMap = new Map(bays.map((b) =>
    [`${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`, b]))
  const rlMap = new Map(rightLanes.map((r) =>
    [`${r.wayId}@${r.nodeId}${r.back ? '~b' : ''}`, r]))
  const bayKeys = new Set(bayMap.keys())
  const rlKeys = new Set(rlMap.keys())
  const out: GroundArrow[] = []
  for (const e of stopLineEdges(graph, (r) =>
    scopeFn(r) || hasTl(r) || isMajorStopRoad(r))) {
    const p = e.road.properties
    if (p.roadMarkingMode !== 'all') continue
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    if (lanes < 1) continue
    // 該行向的轉向真值（行向駕駛視角左→右）
    const tlRaw = (p.oneway === 'yes' || !e.back) ? p.turnLanes : p.turnLanesB
    const explicit = tlRaw?.map(canonTurn)
    const hasExplicit = !!explicit?.some(Boolean)
    const laneMarks = (p.oneway === 'yes' || !e.back) ? p.laneMarksF : p.laneMarksB
    const motoCount = p.oneway === 'yes'
      ? p.motoCountF : e.back ? p.motoCountB : p.motoCountF
    const moto = motoCount > 0
    const hasMotoLeftLane = motoCount === 1 &&
      laneMarks?.[lanes]?.text.trim() === '機車左轉專用'
    // 非實驗範圍：實際幹道／集散道用路口拓撲推薦值（下方 kinds 分支）；
    // 其餘（小巷）只在有轉向真值時畫
    if (!scopeFn(e.road) && !isMajorStopRoad(e.road) && !hasExplicit) continue
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const directionKey = `${p.osm_id}@${e.toNode}${e.back ? '~b' : ''}`
    const hasBay = bayKeys.has(directionKey)
    const showExit = (e.back ? p.arrowDisplayB : p.arrowDisplayF) !== false
    const showStart = total >= 50 && hasBay &&
      (e.back ? p.startArrowDisplayB : p.startArrowDisplayF) === true
    if (!showExit && !showStart && !hasMotoLeftLane) continue
    const endBrg = pointAlong(e.coords, cum, Math.max(0, total - 2)).brg
    const smallCrossW = graph.crossWidthAt(e.toNode, endBrg, e.road)
    const arrowSetback = Math.max(e.endSetbackM, smallCrossW > 0 ? smallCrossW / 2 + 1.2 : 0)
    // 箭頭長約 4.5m；中心退到停止線前 4m，讓整個圖示都留在路口框外。
    // 有機車停等格的行向再退 MOTO_BOX_ARROW_PUSH_M，讓格子夾在箭頭與停止線之間
    const boxPush = motoBoxDirs.has(`${p.osm_id}@${e.toNode}${e.back ? '~b' : ''}`)
      ? MOTO_BOX_ARROW_PUSH_M : 0
    // 箭頭必須以「實際畫出的垂直停止線」為基準，而不是原始 setback。
    // 斜交路口的停止線會整體後移；若仍用原 setback，線就會穿過箭頭前端。
    const span = laneSpanM(p, e.back)
    const dv = 0
    const base = p.oneway === 'yes' ? -span / 2 : dv + (p.centerM || 0) / 2
    const bay = bayMap.get(directionKey)
    const rl = rlMap.get(directionKey)
    const inner = bay
      ? (bay.kind === 'center' ? dv - (p.centerM || 0) / 2 : base - bay.widthM)
      : base
    const outer = base + span + (rl ? rl.widthM : 0)
    const stopSkew = crossSkew(graph, e.road, e.toNode, endBrg)
    const stopAxisD = perpendicularEndDistance(
      total - arrowSetback, stopSkew, inner, outer, 0.2)
    const d = stopAxisD - 4 - boxPush
    // 自動標線仍要求完整的 6m 緩衝；人工已儲存箭頭設定時，允許短 OSM
    // 分段使用較緊湊的配置。典型案例是「益群橋 → 短藍田路 → 援中路」，
    // 道路本身連續，但 OSM 在橋名切換處把進口切成約二十公尺的小段。
    const manualArrow = hasManualRoadField(journal, p, [
      e.back ? 'arrow_display_b' : 'arrow_display_f',
      e.back ? 'turn_lanes_backward' : 'turn_lanes',
    ])
    if (d < e.startSetbackM + (manualArrow ? 1.5 : 6)) continue
    let moves: string[]
    if (hasExplicit) {
      moves = Array.from({ length: lanes }, (_, k) => explicit![k] ?? '')
    } else {
      const kinds = graph.exitKindsAt(e.toNode, endBrg)
      if (kinds.size === 0) continue
      const hasRl = rlKeys.has(`${p.osm_id}@${e.toNode}${e.back ? '~b' : ''}`)
      // 每車道的動作：預設直行；最外側補右轉（右轉道存在時由附加車道承擔）；
      // 無偏心道時最內側補左轉
      moves = Array.from({ length: lanes }, () => (kinds.has('straight') ? 'through' : ''))
      if (kinds.has('right') && !hasRl) moves[lanes - 1] = moves[lanes - 1] ? 'through;right' : 'right'
      if (kinds.has('left') && !hasBay) moves[0] = moves[0] ? 'left;through' : 'left'
    }
    // 車道基準（行進 frame）：單行道 = 車道塊左緣（不含路寬微調）；雙向 = 分向線 + 中央帶半寬
    // 雙向道路以 OSM 軸作中央分向基準；非對稱寬度由路面向多車道側展開。
    if (showExit) {
      // 停止線已統一垂直進入車道；箭頭列也必須共用同一縱向基準。
      // 舊版依斜交路口用 skew 把各車道箭頭前後錯開，極斜路口會將外側箭頭
      // 推到停止線上（例如 way/280277096 東向）。固定 d 可保留約 4m 淨距。
      for (let k = 0; k < lanes; k++) {
        if (!moves[k]) continue
        const off = base + (k + 0.5) * LANE_WIDTH_M
        const dk = Math.max(e.startSetbackM + 4, Math.min(total - arrowSetback - 3, d))
        out.push({
          pos: offsetAt(e.coords, cum, dk, off),
          brg: pointAlong(e.coords, cum, dk).brg,
          icon: ARROW_ICON[moves[k]] ?? 'lane-arrow-through',
        })
      }
      // 多機車道才畫各自的路口箭頭；單一機車道維持既有無箭頭樣式。
      if (motoCount >= 2) {
        const motoMovesRaw = (p.oneway === 'yes' || !e.back)
          ? p.motoTurnLanesF : p.motoTurnLanesB
        const motoMoves = Array.from({ length: motoCount }, (_, k) =>
          canonTurn(motoMovesRaw?.[k] ?? 'through'))
        const sep = p.oneway === 'yes'
          ? p.motoSepF || 0 : e.back ? p.motoSepB || 0 : p.motoSepF || 0
        for (let k = 0; k < motoCount; k++) {
          const move = motoMoves[k]
          if (!move) continue
          const off = base + lanes * LANE_WIDTH_M + sep + (k + 0.5) * MOTO_LANE_M
          const dk = Math.max(e.startSetbackM + 4, Math.min(total - arrowSetback - 3, d))
          out.push({
            pos: offsetAt(e.coords, cum, dk, off),
            brg: pointAlong(e.coords, cum, dk).brg,
            icon: ARROW_ICON[move] ?? 'lane-arrow-through',
          })
        }
      }
    }
    // 「機車左轉專用」是獨立於汽車車道箭頭的道路語意：在最外側機車道、
    // 緊鄰停止線前自動放一枚左轉箭頭。不得占用汽車道的 turn:lanes 欄位。
    if (hasMotoLeftLane) {
      const sep = p.oneway === 'yes' ? p.motoSepF || 0 : e.back ? p.motoSepB || 0 : p.motoSepF || 0
      const motoOff = base + lanes * LANE_WIDTH_M + sep + MOTO_LANE_M / 2
      const motoD = total - arrowSetback - 3.5
      if (motoD >= e.startSetbackM + 2) {
        out.push({
          pos: offsetAt(e.coords, cum, motoD, motoOff),
          brg: pointAlong(e.coords, cum, motoD).brg,
          icon: 'bay-arrow-left',
        })
      }
    }
    if (showStart) {
      const startD = e.startSetbackM + 8
      if (startD < total - e.endSetbackM - 8) {
        const startRaw = (p.oneway === 'yes' || !e.back)
          ? p.startTurnLanes
          : p.startTurnLanesB
        const startMoves = startRaw?.length
          ? Array.from({ length: lanes }, (_, k) => canonTurn(startRaw[k] ?? ''))
          : moves
        for (let k = 0; k < lanes; k++) {
          if (!startMoves[k]) continue
          const off = base + (k + 0.5) * LANE_WIDTH_M
          out.push({
            pos: offsetAt(e.coords, cum, startD, off),
            brg: pointAlong(e.coords, cum, startD).brg,
            icon: ARROW_ICON[startMoves[k]] ?? 'lane-arrow-through',
          })
        }
      }
    }
  }
  return out
}

const ARROW_ICON: Record<string, string> = {
  through: 'lane-arrow-through',
  right: 'lane-arrow-right',
  'through;right': 'lane-arrow-through-right',
  'through+right': 'lane-arrow-through-right-dual', // 兩支完整箭頭並排

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
  rightLanes: RightLane[] = [],
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
  const hasRl = rightLanes.some((r) =>
    r.wayId === p.osm_id && r.nodeId === e.toNode && r.back === back)
  const moves: string[] = Array.from({ length: lanes }, () => (kinds.has('straight') ? 'through' : ''))
  if (kinds.has('right') && !hasRl) moves[lanes - 1] = moves[lanes - 1] ? 'through;right' : 'right'
  if (kinds.has('left') && !hasBay) moves[0] = moves[0] ? 'left;through' : 'left'
  return moves.map((m) => m || 'through')
}

// ── 右轉附加車道（Enhancement：journal target type 'right_lane'）──
// 「路口前最外車道外側加一段車道」：儲車段（預設 20m，全寬）＋漸變段（斜張開），
// 左界白線（分隔同向）、車道內右轉箭頭、路面以 polygon 加寬（同 side bay 的畫法）。
// 純人工開啟（無自動生成）；鍵 = bay 鍵 + '~r' 尾碼。

const RL_DEFAULTS = { len_m: 20, taper_len_m: 10, width_m: 3.0 }

export interface RightLane {
  key: string // way/W@node/N[~b]~r（journal target key）
  wayId: number
  nodeId: number
  back: boolean
  approachBearing: number
  lenM: number
  taperLenM: number
  widthM: number
  /** 車道中心相對 way 線的偏移（行進方向右正）——導航右轉變道目標 */
  offM: number
  setbackM: number
  d0M: number
  startM: number
  endM: number
  polygon: [number, number][]
  casing: [number, number][]
  arrows: GroundArrow[]
  lines: PaintLine[]
}

function foldRightLaneOverrides(journal: EnhancementRecord[]): Map<string, Record<string, string | number>> {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of journal) {
    if (rec.target.type !== 'right_lane') continue
    if (rec.op === 'delete') out.delete(rec.target.key)
    else out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
  }
  return out
}

export function buildRightLanes(graph: RoadGraph, journal: EnhancementRecord[]): RightLane[] {
  const over = foldRightLaneOverrides(journal)
  if (over.size === 0) return []
  // 錨點不限實驗範圍：右轉道可加在任何路口進入行向（人工開啟才生成）
  const amap = new Map(graph.bayAnchors(() => true).map((a) => [anchorKey(a), a]))
  const out: RightLane[] = []
  for (const [key, o] of over) {
    if (Number(o.present) === 0) continue
    const a = amap.get(key.replace(/~r$/, ''))
    if (!a) continue
    const sk = crossSkew(graph, a.road, a.nodeId, a.approachBearing)
    const rl = makeRightLane(a, key, o, sk)
    if (rl) out.push(rl)
  }
  return out
}

function makeRightLane(
  a: BayAnchor, key: string, o: Record<string, string | number>, sk = 0,
): RightLane | null {
  const cum = cumulative(a.coords)
  const total = cum[cum.length - 1]
  const end = total - a.setbackM // 前端收在停止線，不畫進路口框
  if (end < 10) return null
  const p = a.road.properties
  const span = laneSpanM(p, a.back)
  if (span <= 0) return null
  const widthM = num(o.width_m, RL_DEFAULTS.width_m)
  const lenM = Math.min(num(o.len_m, RL_DEFAULTS.len_m), Math.max(8, end * 0.7))
  const taperLenM = Math.min(num(o.taper_len_m, RL_DEFAULTS.taper_len_m), end * 0.25)
  const d0 = Math.max(0, end - lenM - taperLenM)
  const start = end - lenM // 全寬儲車段起點
  // 既有斷面右緣（行進 frame）：單行道置中、雙向 = 分向線 + 中央帶半寬 + 車道塊
  const dv = 0
  const R0 = p.oneway === 'yes' ? span / 2 : dv + (p.centerM || 0) / 2 + span
  const wAt = (d: number) =>
    d >= start ? widthM : taperLenM > 0 ? (widthM * (d - d0)) / taperLenM : widthM
  // 前緣對齊停止線斜線：內外兩緣各自裁到「end + 橫向偏移×skew」，前端蓋斜切
  const endAt = (o: number) => Math.min(total, Math.max(start + 2, end + sk * o))
  const band = (w: (d: number) => number): [number, number][] => {
    const inner = sampleDs(d0, endAt(R0), 3, [start])
      .map((d) => offsetAt(a.coords, cum, d, R0))
    const outer = sampleDs(d0, endAt(R0 + widthM), 3, [start])
      .map((d) => offsetAt(a.coords, cum, d, R0 + w(d)))
    return [...inner, ...outer.reverse(), inner[0]]
  }
  // 箭頭跟著停止線的交叉路對齊平移（skew×橫向偏移），夾在儲車段內
  const arrowDs = (lenM >= 20 ? [end - 7, start + 6] : [end - lenM / 2])
    .map((d) => Math.max(d0 + 2, Math.min(end - 2, d + sk * (R0 + widthM / 2))))
  return {
    key, wayId: a.wayId, nodeId: a.nodeId, back: a.back, approachBearing: a.approachBearing,
    lenM, taperLenM, widthM, offM: R0 + widthM / 2, setbackM: a.setbackM,
    d0M: d0, startM: start, endM: end,
    polygon: band(wAt), casing: band((d) => wAt(d) + 0.7),
    arrows: arrowDs.map((d) => ({
      pos: offsetAt(a.coords, cum, d, R0 + widthM / 2),
      brg: pointAlong(a.coords, cum, d).brg,
      icon: 'lane-arrow-right',
    })),
    // 儲車段左界白線（分隔同向直行車道，末端裁到停止線斜線）；
    // 漸變段外緣是路面邊，由 casing 表達
    lines: [{
      color: 'white',
      coords: sampleDs(start, endAt(R0), 4).map((d) => offsetAt(a.coords, cum, d, R0)),
    }],
  }
}

/** 編輯面板用：某路口各進入行向的右轉道現況（純人工，無 default 生成） */
export interface RightLaneCandidate {
  key: string
  roadName?: string
  approachBearing: number
  rl?: RightLane
  /** journal 有紀錄但幾何放不下（路段太短） */
  failed: boolean
}

export function rightLaneCandidatesAt(
  graph: RoadGraph, journal: EnhancementRecord[], rightLanes: RightLane[], nodeId: number,
): RightLaneCandidate[] {
  const over = foldRightLaneOverrides(journal)
  return graph.bayAnchors(() => true)
    .filter((a) => a.nodeId === nodeId)
    .map((a) => {
      const key = `${anchorKey(a)}~r`
      const rl = rightLanes.find((r) => r.key === key)
      const o = over.get(key)
      return {
        key, roadName: a.road.properties.name, approachBearing: a.approachBearing,
        rl, failed: !rl && !!o && Number(o.present) !== 0,
      }
    })
    .sort((x, y) => x.approachBearing - y.approachBearing)
}

/**
 * 路線建好後標記右轉道：右轉 maneuver 在其路口、進入行向一致時，變道目標改成
 * 附加車道中心（rightOffM），並沿用 bay 的進入窗機制（從漸變段開口切進去）。
 */
export function annotateRightLanes(route: RouteResult, rightLanes: RightLane[]) {
  for (const m of route.maneuvers) {
    if (m.kind !== 'right' && m.kind !== 'slight-right') continue
    if (m.nodeId === undefined || m.fromBearing === undefined) continue
    const rl = rightLanes.find((r) =>
      r.nodeId === m.nodeId && Math.abs(angleDelta(r.approachBearing, m.fromBearing!)) < 40)
    if (rl) {
      m.rightOffM = rl.offM
      m.bayMouthM = rl.setbackM + rl.lenM
      m.bayTaperM = rl.taperLenM
    }
  }
}

/**
 * 路口停止線：畫地面箭頭的每個進入行向（實驗範圍/有轉向真值），在箭頭前方
 * （距路口 = 收邊量處，與 bay 前端同一基準）畫一條橫向白粗線，橫跨該行向
 * 全部車道（含中央偏心道與右轉附加車道）。
 */
export function buildStopLines(
  graph: RoadGraph, bays: TurnBay[], rightLanes: RightLane[],
  journal: EnhancementRecord[] = [],
): PaintLine[] {
  const bayMap = new Map(bays.map((b) => [`${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`, b]))
  const rlMap = new Map(rightLanes.map((r) => [`${r.wayId}@${r.nodeId}${r.back ? '~b' : ''}`, r]))
  const rlWays = new Set(rightLanes.map((r) => r.wayId))
  // 只在真路口畫（鄰接 ≥3）：區塊邊界含「度數 2 純續接節點」（way 換 id 處），
  // 在那裡畫停止線會變成路中間一條白橫線
  const inter = new Set(graph.intersections().map((i) => i.id))
  const out: PaintLine[] = []
  const seen = new Set<string>()
  for (const e of stopLineEdges(graph, (r) =>
    scopeFn(r) || hasTl(r) || rlWays.has(r.properties.osm_id)
      || isStopLineRoad(r) || isMajorStopRoad(r))) {
    const p = e.road.properties
    if (p.roadMarkingMode !== 'all') continue
    if ((e.back ? p.stopLineB : p.stopLineF) === false) continue
    const dirKey = `${p.osm_id}@${e.toNode}${e.back ? '~b' : ''}`
    if (seen.has(dirKey)) continue
    const rl = rlMap.get(dirKey)
    // 與地面箭頭同一批行向；右轉道行向即使無箭頭真值也畫（有停止線才有意義）；
    // 實際幹道／集散道進入真路口也畫（2026-07-24 起，忽略小巷）
    if (!scopeFn(e.road) && !hasTl(e.road) && !rl
      && !isStopLineRoad(e.road) && !isMajorStopRoad(e.road)) continue
    if (!inter.has(e.toNode)) continue // 純續接節點/死路端不畫
    if (e.endSetbackM <= 2) continue // 終點無交叉路不畫
    const span = laneSpanM(p, e.back)
    if (span <= 0) continue
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const d = total - e.endSetbackM
    // 人工明確開啟停止線時允許緊湊進口；自動生成仍維持 6m 防護，
    // 不會因此替其他短路段普遍補線。
    const manualStop = hasManualRoadField(
      journal, p, [e.back ? 'stop_line_b' : 'stop_line_f'])
    if (d < e.startSetbackM + (manualStop ? 1 : 6)) continue
    // 同一 way/節點可能有多個切塊候選；只有真正成功產生停止線後才標記，
    // 避免先遇到過短切塊而把後續有效進入方向誤判為重複。
    seen.add(dirKey)
    const dv = 0
    const base = p.oneway === 'yes' ? -span / 2 : dv + (p.centerM || 0) / 2
    const bay = bayMap.get(dirKey)
    // 內界：有中央偏心道延伸到對向側邊界、side bay 延伸過附加車道；否則車道塊左緣
    const inner = bay
      ? (bay.kind === 'center' ? dv - (p.centerM || 0) / 2 : base - bay.widthM)
      : base
    const outer = base + span + (rl ? rl.widthM : 0)
    // 對齊交會道路：兩端點依橫向位置縱向平移，線與交叉路平行（斜交路口不歪）
    const sk = crossSkew(graph, e.road, e.toNode, pointAlong(e.coords, cum, d).brg)
    const perpendicularD = perpendicularEndDistance(d, sk, inner, outer, 0.2)
    const pt = (o: number) => offsetAt(
      e.coords, cum, Math.min(total, Math.max(0, perpendicularD)), o)
    out.push({
      color: 'stop', style: 'stop', ownerKey: dirKey,
      coords: [pt(inner + 0.15), pt(outer - 0.15)],
    })
  }
  return out
}

/**
 * 汽車左轉待轉區：由既有停止線向路口內突出。
 * 左右為密集白色虛線，前端為實心白色停止線；不含文字，且只依人工開關生成。
 */
export function buildLeftTurnWaitingAreas(
  graph: RoadGraph, bays: TurnBay[],
): PaintLine[] {
  const out: PaintLine[] = []
  const bayMap = new Map(bays.map((bay) => [
    `${bay.wayId}@${bay.nodeId}${bay.back ? '~b' : ''}`, bay,
  ]))
  const seen = new Set<string>()

  for (const edge of stopLineEdges(graph, (road) => {
    const p = road.properties
    return p.roadMarkingMode === 'all' && (p.leftWaitAreaF || p.leftWaitAreaB)
  })) {
    const p = edge.road.properties
    const enabled = p.oneway === 'yes' || !edge.back ? p.leftWaitAreaF : p.leftWaitAreaB
    if (!enabled) continue
    const key = `${p.osm_id}@${edge.toNode}${edge.back ? '~b' : ''}`
    if (seen.has(key)) continue

    const turns = p.oneway === 'yes' || !edge.back ? p.turnLanes : p.turnLanesB
    const bay = bayMap.get(key)
    if (!bay && !turns?.[0]?.includes('left')) continue

    const cum = cumulative(edge.coords)
    const total = cum[cum.length - 1]
    const stopD = total - edge.endSetbackM
    const frontD = Math.min(total - 0.45, stopD + Math.min(8, edge.endSetbackM - 0.45))
    if (frontD - stopD < 2) continue

    // 依實際左轉出口角度決定彎曲量。行進 frame 中左側為負 offset；
    // 起點維持接在原停止線，往路口內持續微彎，不在前端把切線拉回直線。
    const inBrg = pointAlong(edge.coords, cum, Math.max(0, total - 1)).brg
    const leftExit = graph.alternativesAt(edge.toNode, inBrg, 'car')
      .find((option) => option.kind === 'left' && option.coords.length >= 2)
    const turnDelta = leftExit
      ? Math.abs(angleDelta(inBrg, bearing(leftExit.coords[0], leftExit.coords[1])))
      : 70
    const waitLen = frontD - stopD
    const maxBendM = Math.min(1.8, waitLen * 0.2 * Math.min(1, turnDelta / 90))
    const bendAt = (d: number) => {
      const t = Math.max(0, Math.min(1, (d - stopD) / waitLen))
      return -maxBendM * t * t
    }

    const span = laneSpanM(p, edge.back)
    const normalInner = p.oneway === 'yes' ? -span / 2 : (p.centerM || 0) / 2
    let inner = normalInner
    let outer = normalInner + Math.min(LANE_WIDTH_M, span)
    if (bay) {
      inner = bay.offM - bay.widthM / 2
      outer = bay.offM + bay.widthM / 2
    }

    // 由原停止線後方一點開始，避免虛線與原本粗停止線黏成一塊。
    const dashStart = stopD + 0.35
    const dashEnd = frontD - 0.3
    const dashM = 0.55
    const gapM = 0.35
    for (let d = dashStart; d < dashEnd; d += dashM + gapM) {
      const d1 = Math.min(d + dashM, dashEnd)
      if (d1 - d < 0.2) continue
      for (const offset of [inner, outer]) {
        out.push({
          color: 'white',
          style: 'left-wait-side',
          coords: [
            offsetAt(edge.coords, cum, d, offset + bendAt(d)),
            offsetAt(edge.coords, cum, d1, offset + bendAt(d1)),
          ],
        })
      }
    }
    out.push({
      color: 'stop',
      style: 'left-wait-front',
      coords: [
        offsetAt(edge.coords, cum, frontD, inner + bendAt(frontD)),
        offsetAt(edge.coords, cum, frontD, outer + bendAt(frontD)),
      ],
    })
    seen.add(key)
  }
  return out
}

// ── 機車停等區 ──
// 停止線之前、車道箭頭之後的白框方格（暫為空白框；機慢車標誌 icon 之後補）。
// 不畫的行向：
//   1) 機車專用道以快慢分隔島隔開（騎士在專用道停等，不進車道）
//   2) 全部車道禁行機車且無機車道（無合法停等空間）
// 左界 = 自最外側車道往內連續「非禁行機車」車道的左緣（禁行車道不可涵蓋，
// 全禁行時退到線隔機車道）；右界 = 車道塊外緣（含線隔機車道與右轉附加車道）。
export const MOTO_BOX_DEPTH_M = 3.0
/** 前緣與停止線中心的縱向間隔（停止線寬 0.45m，留 ~0.5m 淨空） */
const MOTO_BOX_GAP_M = 0.7
/** 有停等格的行向，車道箭頭中心再往後退讓的量（buildLaneArrows 用）。
 * 格深 3m + 1.2m 圖示淨空；不可只用舊版 2.5m，否則長箭頭在斜路口仍壓入格內。 */
export const MOTO_BOX_ARROW_PUSH_M = MOTO_BOX_DEPTH_M + 1.2
/** 內緣（貼中央側）避讓量：kL=0 緊鄰雙黃/中央帶時多留淨空，不碰雙黃線 */
const MOTO_BOX_INNER_CLEAR_M = 0.45
/** 內緣位於車道分隔線時的避讓量 */
const MOTO_BOX_LANE_CLEAR_M = 0.15

export interface MotoBox {
  /** journal 覆寫鍵：way/W@node/N[~b]~m */
  key: string
  /** 行向鍵（`${wayId}@${toNode}[~b]`）——箭頭退讓/面板比對 */
  dir: string
  /** 封閉 5 點框（前緣→外→後→內→前）；null = 關閉或幾何放不下（不渲染） */
  ring: [number, number][] | null
  /** 目前涵蓋的合法車道數（0 = 關閉） */
  coveredLanes: number
  /** 自駕駛視角左至右的起訖車道；endLane 不含尾端。 */
  startLane: number
  endLane: number
  /** 合法可涵蓋的最大車道數（禁行機車不計）——面板 stepper 上限 */
  maxLanes: number
  /** 停等格內路面標誌；單道一枚機車，兩道以上為左機車、右自行車。 */
  icons?: Array<{
    image: 'moto-box-motorcycle' | 'moto-box-bicycle'
    pos: [number, number]
    brg: number
    /** 依分配到的橫向空間自動縮放後的實際高度（公尺）。 */
    heightM: number
  }>
}

export interface MotoBoxes {
  boxes: MotoBox[]
  /** 已畫格的行向鍵（`${wayId}@${toNode}[~b]`）——箭頭退讓比對用 */
  dirs: Set<string>
}

/** 新增機車專用道入口的路面圖示；數量由 journal 的 moto_forward/backward 保存。 */
export function buildMotoLaneEntryIcons(
  graph: RoadGraph,
  journal: EnhancementRecord[] = [],
): FeatureCollection<Point> {
  const laneCounts = new Map<string, { forward?: number; backward?: number }>()
  for (const record of journal) {
    if (record.target.type !== 'road' || record.op === 'delete') continue
    const match = record.target.key.match(/^way\/(\d+)/)
    if (!match) continue
    const fields = record.fields ?? {}
    const current = laneCounts.get(match[1]) ?? {}
    if (fields.moto_forward !== undefined) {
      current.forward = Math.max(0, Number(fields.moto_forward) || 0)
    }
    if (fields.moto_backward !== undefined) {
      current.backward = Math.max(0, Number(fields.moto_backward) || 0)
    }
    laneCounts.set(match[1], current)
  }

  const features: Feature<Point>[] = []
  const seen = new Set<string>()
  for (const edge of graph.scopeEdges(scopeFn, 0, 2)) {
    const properties = edge.road.properties
    const hasMotoLane = properties.oneway === 'yes'
      ? properties.motoF
      : edge.back ? properties.motoB : properties.motoF
    const showEntryIcon = properties.oneway === 'yes' || !edge.back
      ? properties.motoEntryIconF
      : properties.motoEntryIconB
    if (!hasMotoLane || !showEntryIcon || properties.roadMarkingMode !== 'all') continue

    const key = `${properties.osm_id}@${edge.fromNode}${edge.back ? '~b' : ''}`
    if (seen.has(key)) continue
    seen.add(key)

    const cum = cumulative(edge.coords)
    const total = cum[cum.length - 1]
    const distance = edge.startSetbackM + 6
    if (distance >= total - edge.endSetbackM - 2) continue

    const directionLaneCount = properties.oneway === 'yes' || !edge.back
      ? laneCounts.get(String(properties.osm_id))?.forward
      : laneCounts.get(String(properties.osm_id))?.backward
    const motorcycleLaneCount = Math.max(1, directionLaneCount ?? 1)
    const laneWidthM = MOTO_LANE_M * motorcycleLaneCount
    const carLaneCount = properties.oneway === 'yes'
      ? properties.lanesForward
      : edge.back ? properties.lanesBackward : properties.lanesForward
    const separatorWidth = properties.oneway === 'yes'
      ? properties.motoSepF || 0
      : edge.back ? properties.motoSepB || 0 : properties.motoSepF || 0
    const dividerOffset = 0
    const innerEdge = properties.oneway === 'yes'
      ? -properties.width_m / 2 + carLaneCount * LANE_WIDTH_M + separatorWidth
      : dividerOffset + (properties.centerM || 0) / 2 +
        carLaneCount * LANE_WIDTH_M + separatorWidth
    const iconSpecs = motorcycleLaneCount >= 2
      ? [
          { icon: 'moto-box-motorcycle', fraction: 0.25, aspect: 292 / 809 },
          { icon: 'moto-box-bicycle', fraction: 0.75, aspect: 450 / 809 },
        ] as const
      : [{ icon: 'moto-box-motorcycle', fraction: 0.5, aspect: 292 / 809 }] as const

    const { brg } = pointAlong(edge.coords, cum, distance)
    for (const spec of iconSpecs) {
      const allocatedWidth = motorcycleLaneCount >= 2 ? laneWidthM / 2 : laneWidthM
      const iconHeightM = Math.min(3.2, allocatedWidth * 0.78 / spec.aspect)
      features.push({
        type: 'Feature',
        properties: {
          kind: 'moto-lane-entry-icon',
          key,
          icon: spec.icon,
          brg: Math.round(brg * 10) / 10,
          iconHeightM,
          motorcycleLaneCount,
        },
        geometry: {
          type: 'Point',
          coordinates: offsetAt(
            edge.coords, cum, distance,
            innerEdge + laneWidthM * spec.fraction,
          ),
        },
      })
    }
  }
  return featureCollection(features)
}

/** 停等格逐行向的資格與合法上限（面板 stepper 與 buildMotoBoxes 共用同一份判定） */
export interface MotoBoxSlot {
  /** 依附條件成立：標線模式 all + 終點為真路口 + 有夠格交叉路（同停止線）+ 縱向放得下。
   * false 時面板不顯示 stepper——不給建置端一定會拒絕的設定入口。 */
  eligible: boolean
  /** 合法可涵蓋車道數上限（自最外側往內掃，遇禁行機車即止；0 = 無合法停等空間）。
   * 人工設定同樣不可越過禁行機車車道，故此上限對自動與人工一致。 */
  maxLanes: number
  /** 第一條可合法納入停等格的汽車道（駕駛視角左→右，0 起算）。 */
  firstLegalLane: number
  /** 汽車道全禁行、僅靠線隔機車道成立的一格（格子只涵蓋機車道） */
  motoOnly: boolean
  /** 被快慢分隔島隔開：自動不生成（騎士在專用道停等），僅既有人工紀錄仍尊重 */
  sepIsland: boolean
  /** 是否有自動配置所需的完整縱向空間；人工啟用可在短 OSM 進口緊湊配置。 */
  fitsLengthwise: boolean
}

/**
 * graph 級前置（路口集合）只算一次，回傳逐行向的停等格判定函式。
 * useEditor 的面板與 buildMotoBoxes 都走這裡，兩邊的規則不會再各走各的。
 */
export function makeMotoBoxSlot(graph: RoadGraph): (e: ScopeEdge) => MotoBoxSlot {
  const inter = new Set(graph.intersections().map((i) => i.id))
  return (e: ScopeEdge): MotoBoxSlot => {
    const p = e.road.properties
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    const moto = p.oneway === 'yes' ? p.motoF : e.back ? p.motoB : p.motoF
    const sep = (p.oneway === 'yes' ? p.motoSepF : e.back ? p.motoSepB : p.motoSepF) || 0
    // 每車道「禁行機車」判定：顯式車道標記優先，否則舊制 rules/motorcycle=no
    // 展開為全車道禁行（同 buildRoadTexts 的相容規則）
    const explicitMarks = p.oneway === 'yes' || !e.back ? p.laneMarksF : p.laneMarksB
    const legacyRules = p.oneway === 'yes' || !e.back ? p.rulesF : p.rulesB
    const legacyNoMoto = (legacyRules ?? (p.motorcycle === 'no' ? ['no_moto'] : []))
      .includes('no_moto')
    const noMotoAt = (k: number): boolean => explicitMarks
      ? explicitMarks[k]?.text.trim() === '禁行機車'
      : legacyNoMoto
    // 合法左界（自最外側車道往內掃，遇禁行即停）→ 合法可涵蓋車道數
    let autoKL = lanes
    for (let k = lanes - 1; k >= 0; k--) {
      if (noMotoAt(k)) break
      autoKL = k
    }
    const legalCarLanes = lanes - autoKL
    const motoOnly = legalCarLanes < 1 && !!moto
    const total = cumulative(e.coords)[e.coords.length - 1]
    // 縱向：停止線退 GAP 再退一整格深，前面還要留 4m 給車道箭頭（同 d0 檢查）
    const fitsLengthwise =
      total - e.endSetbackM - MOTO_BOX_GAP_M - MOTO_BOX_DEPTH_M >= e.startSetbackM + 4
    return {
      eligible: p.roadMarkingMode === 'all' && inter.has(e.toNode) && e.endSetbackM > 2
        && lanes >= 1 && laneSpanM(p, e.back) > 0,
      maxLanes: lanes < 1 ? 0 : legalCarLanes + (moto ? 1 : 0),
      firstLegalLane: motoOnly ? lanes : autoKL,
      motoOnly,
      sepIsland: !!moto && sep > 0,
      fitsLengthwise,
    }
  }
}

function foldMotoBoxOverrides(journal: EnhancementRecord[]): Map<string, Record<string, string | number>> {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of journal) {
    if (rec.target.type !== 'moto_box') continue
    if (rec.op === 'delete') out.delete(rec.target.key)
    else out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
  }
  return out
}

export function buildMotoBoxes(
  graph: RoadGraph, bays: TurnBay[], rightLanes: RightLane[], journal: EnhancementRecord[] = [],
): MotoBoxes {
  const over = foldMotoBoxOverrides(journal)
  // 人工明確指定的停等格必須進入候選掃描；不可先被預設道路範圍濾掉，
  // 否則會形成「journal 有資料、面板顯示已設定，但地圖沒有幾何」。
  const explicitWays = new Set<number>()
  for (const [key, fields] of over) {
    const match = key.match(/^way\/(\d+)@node\//)
    if (match && Number(fields.lanes) > 0) explicitWays.add(Number(match[1]))
  }
  const rlMap = new Map(rightLanes.map((r) => [`${r.wayId}@${r.nodeId}${r.back ? '~b' : ''}`, r]))
  const rlWays = new Set(rightLanes.map((r) => r.wayId))
  const slotOf = makeMotoBoxSlot(graph)
  const boxes: MotoBox[] = []
  const dirs = new Set<string>()
  const seen = new Set<string>()
  // 收邊與停止線同一組交叉路資格（stopLineEdges）：畫得出停止線的路口就畫得出格子。
  for (const e of stopLineEdges(graph, (r) =>
    scopeFn(r) || hasTl(r) || rlWays.has(r.properties.osm_id)
      || isMajorStopRoad(r) || explicitWays.has(r.properties.osm_id))) {
    const p = e.road.properties
    const dir = `${p.osm_id}${'@'}${e.toNode}${e.back ? '~b' : ''}`
    const key = `way/${p.osm_id}@node/${e.toNode}${e.back ? '~b' : ''}~m`
    const ov = over.get(key)
    const requestedLanes = Math.max(0, Number(ov?.lanes) || 0)
    const requestedStart = Number(ov?.start_lane)
    const requestedEnd = Number(ov?.end_lane)
    const hasExplicitRange = Number.isFinite(requestedStart) && Number.isFinite(requestedEnd)
      && requestedEnd > requestedStart
    const explicitlyEnabled = requestedLanes > 0 || hasExplicitRange
    if (seen.has(dir)) continue
    const rl = rlMap.get(dir)
    // 與停止線同一批行向（格子必須依附停止線存在）
    if (!scopeFn(e.road) && !hasTl(e.road) && !rl
      && !isMajorStopRoad(e.road) && !explicitlyEnabled) continue
    const slot = slotOf(e)
    // 人工明確啟用的停等格優先於自動候選篩選。像斜交路口或經過靜態
    // 捏合的 block，endSetback/intersection 判定可能不足，但既有合法車道
    // 與後續幾何邊界檢查仍會阻止無寬度、越界或放不下的方框。
    if ((!slot.eligible && !explicitlyEnabled)
      || (!slot.fitsLengthwise && !explicitlyEnabled)) continue
    // 自動模式不跨快慢分隔島；人工明確指定時由人工判斷現場狀況。
    if (slot.sepIsland && !explicitlyEnabled) continue
    const { maxLanes, firstLegalLane } = slot
    if (maxLanes < 1) continue // 2) 無合法停等空間（人工設定同樣不可涵蓋禁行機車車道）
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    const span = laneSpanM(p, e.back)
    // 同一 way/節點可能有多個切塊候選；只有真正成為候選後才標記，避免先遇到
    // 不合格的切塊而把後續有效的進入方向誤判為重複（同 buildStopLines）。
    seen.add(dir)
    // 新格式用左→右的 [start_lane,end_lane) 指定任意連續範圍；舊格式 lanes
    // 仍相容，解讀為合法汽車道最外側 N 道。右轉附加道不再預設納入停等格。
    const motoSlots = p.oneway === 'yes'
      ? p.motoCountF
      : e.back ? p.motoCountB : p.motoCountF
    const moto = motoSlots > 0
    const slotCount = lanes + motoSlots + (rl ? 1 : 0)
    let startLane = firstLegalLane
    let endLane = lanes + motoSlots
    if (hasExplicitRange) {
      startLane = Math.max(firstLegalLane, Math.min(slotCount - 1, Math.floor(requestedStart)))
      endLane = Math.max(startLane + 1, Math.min(slotCount, Math.floor(requestedEnd)))
    } else if (ov?.lanes !== undefined) {
      const n = Math.max(0, Math.min(maxLanes, Number(ov.lanes)))
      startLane = Math.max(firstLegalLane, lanes - n)
      endLane = n > 0 ? lanes + motoSlots : startLane
    }
    const coveredLanes = Math.max(0, endLane - startLane)
    // 關閉：仍記錄候選（ring=null）供面板顯示 stepper 與上限
    if (coveredLanes === 0) {
      boxes.push({ key, dir, ring: null, coveredLanes: 0, startLane, endLane, maxLanes })
      continue
    }
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const stopAxisD = total - e.endSetbackM
    const dv = 0
    const base = p.oneway === 'yes' ? -span / 2 : dv + (p.centerM || 0) / 2
    // 內緣淨空：緊鄰中央多留避雙黃線；附加右轉道位於既有斷面外側。
    const innerClear = startLane === 0 ? MOTO_BOX_INNER_CLEAR_M : MOTO_BOX_LANE_CLEAR_M
    const laneBoundary = (index: number) => {
      if (index <= lanes) return base + index * LANE_WIDTH_M
      if (moto && index <= lanes + motoSlots) {
        const sep = e.back ? (p.motoSepB || 0) : (p.motoSepF || 0)
        return base + lanes * LANE_WIDTH_M + sep
          + (index - lanes) * MOTO_LANE_M
      }
      return base + span + (rl ? (index - lanes - motoSlots) * rl.widthM : 0)
    }
    const inner = laneBoundary(startLane) + innerClear
    const outer = laneBoundary(endLane) - 0.15
    const stopBrg = pointAlong(e.coords, cum, stopAxisD).brg
    const sk = crossSkew(graph, e.road, e.toNode, stopBrg)
    const perpendicularStopD = perpendicularEndDistance(
      stopAxisD, sk, inner, outer, 0.2)
    const d1 = perpendicularStopD - MOTO_BOX_GAP_M
    const d0 = d1 - MOTO_BOX_DEPTH_M
    // 太窄：記錄候選但不渲染（ring=null；縱向長度已由 slot.eligible 先擋）
    const longitudinalClearance = explicitlyEnabled ? 0.75 : 4
    if (d0 < e.startSetbackM + longitudinalClearance || outer - inner < 1.2) {
      boxes.push({ key, dir, ring: null, coveredLanes, startLane, endLane, maxLanes }); continue
    }
    // 前緣與交會路平行（同停止線的斜交補償）。格子為剛體：後緣 = 前緣沿
    // 行向直線退 MOTO_BOX_DEPTH_M（不沿折線走——急彎內側沿線退會讓外側塌陷；
    // 斜交大時前角被端點夾住也不影響格深）
    const brg1 = pointAlong(e.coords, cum, d1).brg
    const rad1 = (brg1 * Math.PI) / 180
    const backE = -Math.sin(rad1) * MOTO_BOX_DEPTH_M
    const backN = -Math.cos(rad1) * MOTO_BOX_DEPTH_M
    const corner = (o: number) => {
      const front = offsetAt(e.coords, cum, Math.min(total, Math.max(0, d1)), o)
      return { front, rear: offsetMeters(front, backE, backN) }
    }
    const ci = corner(inner)
    const co = corner(outer)
    const boxWidthM = haversine(ci.front, co.front)
    const iconAt = (
      image: 'moto-box-motorcycle' | 'moto-box-bicycle',
      across: number, allocatedWidthM: number, aspect: number,
    ) => {
      const front: [number, number] = [
        ci.front[0] + (co.front[0] - ci.front[0]) * across,
        ci.front[1] + (co.front[1] - ci.front[1]) * across,
      ]
      const rear: [number, number] = [
        ci.rear[0] + (co.rear[0] - ci.rear[0]) * across,
        ci.rear[1] + (co.rear[1] - ci.rear[1]) * across,
      ]
      return {
        image,
        pos: [(front[0] + rear[0]) / 2, (front[1] + rear[1]) / 2] as [number, number],
        brg: brg1,
        // 前後受 3m 格深限制，左右則保留至少 0.3m 邊距；寬度改變時自動縮小。
        heightM: Math.min(2.1, Math.max(0.1, allocatedWidthM - 0.6) / aspect),
      }
    }
    const icons = coveredLanes >= 2
      ? [
          iconAt('moto-box-motorcycle', 0.25, boxWidthM / 2, 292 / 809),
          iconAt('moto-box-bicycle', 0.75, boxWidthM / 2, 450 / 809),
        ]
      : [iconAt('moto-box-motorcycle', 0.5, boxWidthM, 292 / 809)]
    boxes.push({
      key, dir,
      ring: [ci.front, co.front, co.rear, ci.rear, ci.front],
      coveredLanes,
      startLane,
      endLane,
      maxLanes,
      icons,
    })
    dirs.add(dir)
  }
  return { boxes, dirs }
}

export function baysToGeoJSON(
  bays: TurnBay[], extraLines: PaintLine[] = [], extraArrows: GroundArrow[] = [],
  rightLanes: RightLane[] = [], motoBoxes: MotoBox[] = [],
): FeatureCollection {
  const features: Feature[] = []
  // 機車停等格：Polygon（kind='motobox'）——樣式用 fill（路面色蓋掉框內車道線，
  // 即「車道線在格前截止」）＋ line（白框）兩層渲染。ring=null 為關閉/放不下，不渲染
  for (const mb of motoBoxes) {
    if (!mb.ring) continue
    features.push({
      type: 'Feature', properties: { kind: 'motobox', key: mb.key },
      geometry: { type: 'Polygon', coordinates: [mb.ring] },
    })
    for (const icon of mb.icons ?? []) {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'motobox-icon', key: mb.key, icon: icon.image,
          brg: Math.round(icon.brg * 10) / 10,
          iconHeightM: icon.heightM,
        },
        geometry: { type: 'Point', coordinates: icon.pos },
      })
    }
  }
  const pushLine = (line: PaintLine, key?: string) => features.push({
    type: 'Feature',
    properties: { kind: 'line', color: line.color, style: line.style, key },
    geometry: { type: 'LineString', coordinates: line.coords },
  })
  const pushArrow = (ar: GroundArrow, key?: string) => features.push({
    type: 'Feature',
    properties: { kind: 'arrow', icon: ar.icon, brg: Math.round(ar.brg * 10) / 10, key },
    geometry: { type: 'Point', coordinates: ar.pos },
  })
  for (const line of extraLines) pushLine(line)
  for (const ar of extraArrows) pushArrow(ar)
  for (const rl of rightLanes) {
    features.push({
      type: 'Feature', properties: { kind: 'casing', key: rl.key },
      geometry: { type: 'Polygon', coordinates: [rl.casing] },
    })
    features.push({
      type: 'Feature', properties: { kind: 'fill', key: rl.key },
      geometry: { type: 'Polygon', coordinates: [rl.polygon] },
    })
    for (const line of rl.lines) pushLine(line, rl.key)
    for (const ar of rl.arrows) pushArrow(ar, rl.key)
  }
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
  return graph.bayAnchors(() => true)
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
    if (bay) {
      m.bayOffM = bay.offM
      // bay 進入窗：距路口節點 bayMouthM 處儲車段開始、再往前 bayTaperM 為漸變開口。
      // 路線帶據此把變道 ramp 對齊開口——從斜切段進 bay，不壓上游槽化線
      m.bayMouthM = bay.setbackM + bay.bayLenM
      m.bayTaperM = bay.taperLenM
    }
  }
}
