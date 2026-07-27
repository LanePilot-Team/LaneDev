// 路網圖 + A*。楠梓區 ~2000 ways 規模，前端毫秒級可解，不需要路由後端。
//
// 起終點吸附：不再 snap 到路口節點，而是吸到「任意路段的最近頂點」，
// 以部分邊（partial edge）接進圖中——路線會從你點的位置開始/結束。
import { haversine, bearing, angleDelta, cumulative, offsetMeters, pointAlong, LANE_WIDTH_M, COS_LAT } from './geo'
import { MOTO_LANE_M, type RoadFeature } from './roads'
import {
  buildLaneGuidanceIndex,
  resolveLaneGuidance,
  type LaneGuidanceIndex,
  type ResolvedLaneGuidance,
} from './laneGuidance'

const SPEED_KMH: Record<string, number> = {
  motorway: 90, trunk: 70, primary: 60, secondary: 50, tertiary: 40,
  unclassified: 40, residential: 30, living_street: 20,
  motorway_link: 50, trunk_link: 40, primary_link: 40, secondary_link: 40, tertiary_link: 40,
}
const MAX_SPEED_MS = 90 / 3.6

export type Profile = 'car' | 'moto'

/** 某方向可供機車使用的汽車車道索引（0-based）；自定義「禁行機車」同步作導航限制。 */
function motoLegalCarLanes(r: RoadFeature, back: boolean): number[] {
  const p = r.properties
  const lanes = p.oneway === 'yes' ? p.lanesForward : back ? p.lanesBackward : p.lanesForward
  const marks = p.oneway === 'yes' || !back ? p.laneMarksF : p.laneMarksB
  const rules = p.oneway === 'yes' || !back ? p.rulesF : p.rulesB
  if (!marks && rules?.includes('no_moto')) return []
  return Array.from({ length: lanes }, (_, k) => k)
    .filter((k) => marks?.[k]?.text.trim() !== '禁行機車')
}

/** 機車可否行駛（國道、OSM motorcycle=no、方向別自定義禁行機車）。 */
export function motoAllowed(r: RoadFeature, back: boolean = false): boolean {
  const p = r.properties
  if (p.highway === 'motorway' || p.highway === 'motorway_link') return false
  if (p.motorcycle === 'no') return false
  const motoLane = p.oneway === 'yes' ? p.motoF : back ? p.motoB : p.motoF
  return motoLane || motoLegalCarLanes(r, back).length > 0
}

/** 汽車可否行駛：OSM motorcar=no（機車專用道路體，如高雄大學路機車道）禁行；
 * 該方向汽車車道數 = 0（編輯成純機車道的路段）也禁行 */
export function carAllowed(r: RoadFeature, back: boolean): boolean {
  const p = r.properties
  if (p.motorcar === 'no') return false
  return (back ? p.lanesBackward : p.lanesForward) > 0
}

/** 車種通行檢查（方向敏感：雙向道可以只有單向被編輯成 0 汽車車道） */
function edgeAllowed(r: RoadFeature, back: boolean, profile: Profile): boolean {
  return profile === 'moto' ? motoAllowed(r, back) : carAllowed(r, back)
}

interface Edge {
  from: number
  to: number
  coords: [number, number][]
  lengthM: number
  timeS: number
  name?: string
  road: RoadFeature
  back: boolean // 是否為反向使用（雙向道）
  twin?: Edge
}

export interface RouteResult {
  coords: [number, number][]
  cum: number[]
  lengthM: number
  timeS: number
  maneuvers: Maneuver[]
  /**
   * 車道偏移區段（coords[?..toIdx]）：
   * offM = 巡航車道、leftM/rightM = 該路段最左/最右可用車道（路口前變道用）。
   * road/back = 該段對應的路與行進方向（禁行審計/除錯用；detour 暫時路線可缺）
   */
  spans: {
    toIdx: number
    offM: number
    leftM: number
    rightM: number
    road?: RoadFeature
    back?: boolean
    laneGuidance?: ResolvedLaneGuidance
  }[]
  /** 分流點（下交流道/左右分道）：轉角不足以成為 maneuver，但要提前切到正確側 */
  diverges: Diverge[]
  /**
   * 匝道交織點的路線里程：路線「經過但不轉出」的交流道節點（該節點有別的匝道進出）。
   * 提前變道不得早於這裡——長途要過兩個交流道才下去時，太早切出去等於整段卡在
   * 別人的出口專用道/匯入道上。
   */
  weaves: number[]
}

/**
 * 分流點：路線在此離開「主流」——匝道出口、Y 型左右分道。轉向角 ≤25° 不會產生
 * maneuver（HUD 也不該報「右轉」），但駕駛必須提前切到該側車道才走得到，
 * 否則到了分流鼻端才橫切＝壓槽化線。laneBand 依 side 做提前變道。
 */
export interface Diverge {
  distM: number
  side: 'left' | 'right'
  nodeId?: number
}

/** 路口前開始變道的最短距離（公尺）——實際提前量再依速率放大，見 leadWindow */
export const LANE_CHANGE_M = 45
/** 每跨一個車道所需秒數／切到定位後到路口的緩衝秒數（提前量 = 速率 × 這兩者）。
 * 車多時要等空隙，一個車道抓 3.5 秒；就位緩衝要涵蓋路口前的排隊長度，
 * 太晚切會卡在車陣外側切不進去 */
const LANE_CHANGE_S = 3.5
const SETTLE_S = 4
/** 分流（匝道/左右分道）的緩衝秒數：走錯邊就得繞一大圈，且分流鼻端前多半是
 * 槽化線不能再變換車道——60km/h 約 167m、90km/h 約 250m 前就要在正確車道上。
 * 真的太早（上一個交流道還沒過）由 weaves 夾住，不會整段掛在別人的出口道上 */
const DIVERGE_SETTLE_S = 10

export interface Maneuver {
  distM: number
  kind: 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'arrive'
  roadName?: string
  nodeId?: number
  pos?: [number, number]
  /** 進入路口時的行向（度）——待轉區方向比對用 */
  fromBearing?: number
  /** 是否為兩段式左轉（由 App 依待轉區標註在路線建立後標記） */
  twoStage?: boolean
  /** 偏心左轉道：路口前變道目標＝bay 中心偏移（way 線右正、左負；由 App 在
   * annotateTwoStage 之後依 turnbays 標記，兩段式左轉不標） */
  bayOffM?: number
  /** 偏心道進入窗（annotateBays 一併標記）：距路口節點 bayMouthM 處儲車段開始，
   * 再往前 bayTaperM 是漸變段開口——路線帶的變道 ramp 對齊這個窗，
   * 從開口進 bay，不壓儲車段白線、更不壓上游槽化線 */
  bayMouthM?: number
  bayTaperM?: number
  /** 右轉附加車道：右轉變道目標＝附加車道中心（annotateRightLanes 標記，
   * 進入窗共用 bayMouthM/bayTaperM） */
  rightOffM?: number
  lanesForward: number
  turnLanes?: string[]
  laneGuidance?: ResolvedLaneGuidance
}

/** scope 內的方向邊（中央槽化線/地面車道箭頭渲染用） */
export interface ScopeEdge {
  coords: [number, number][]
  road: RoadFeature
  back: boolean
  fromNode: number
  toNode: number
  startSetbackM: number
  endSetbackM: number
}

/** 偏心左轉道生成錨點：scope 內每個「進入路口的行向」（turnbays.ts 用）。
 * 是否真的生成 bay 由 turnbays 決定（journal > 最內車道轉向真值 > hasLeftPair 自動） */
export interface BayAnchor {
  wayId: number
  nodeId: number
  /** 進入邊幾何（行進方向），bay 沿此線從終點回推 */
  coords: [number, number][]
  road: RoadFeature
  /** 雙向 way 的反向行進（同一 way 同一節點可能兩向都有 bay，key 要能區分） */
  back: boolean
  /** 邊末端行向（度） */
  approachBearing: number
  /** 停止線回退量（交叉路最大半寬 + 緩衝）——bay 不能畫進路口框 */
  setbackM: number
  /** 拓撲自動判斷：該行向在此路口有左轉/迴轉配對（無轉向真值時的預設依據） */
  hasLeftPair: boolean
}

/** 路口的一個「左轉配對」：從某行向進入 → 左轉往某行向出去 */
export interface TurnOption {
  nodeId: number
  pos: [number, number]
  fromName?: string
  fromBearing: number
  toName?: string
  toBearing: number
  fromWidth: number
  toWidth: number
}

/**
 * 該路段的車道位置（距 way 中心線右側公尺）：
 * cruise = 平時行駛車道；left/right = 最左/最右可用車道（路口前變道目標）。
 * 機車的 left = 最左汽車車道（免待轉左轉用）、right = 機車道/最外車道。
 */
function laneOffsets(e: Edge, profile: Profile): { cruise: number; left: number; right: number } {
  const p = e.road.properties
  if (p.sharedLane && p.oneway === 'no') return { cruise: 0, left: 0, right: 0 }
  if (p.oneway === 'yes') {
    const L0 = p.lanesForward // 可為 0（純機車道路體）
    const L = Math.max(1, L0)
    const sep = p.motoF ? p.motoSepF || 0 : 0 // 快慢分隔帶：機車道再外移
    const total = L0 * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M + sep : 0)
    const base = -total / 2
    const lane = (k: number) => base + (k - 0.5) * LANE_WIDTH_M
    const moto = p.motoF ? base + L0 * LANE_WIDTH_M + sep + MOTO_LANE_M / 2 : lane(L)
    const car = (k: number) => (L0 > 0 ? lane(k) : moto) // 0 車道時所有偏移落在機車道
    if (profile === 'moto') {
      if (p.motoF) return { cruise: moto, left: moto, right: moto }
      const legal = motoLegalCarLanes(e.road, false)
      const leftK = (legal[0] ?? 0) + 1
      const rightK = (legal[legal.length - 1] ?? L - 1) + 1
      return { cruise: car(rightK), left: car(leftK), right: car(rightK) }
    }
    return { cruise: car(Math.ceil(L / 2)), left: car(1), right: car(L) }
  }
  const f0 = e.back ? p.lanesBackward : p.lanesForward
  const f = Math.max(1, f0)
  const m = e.back ? p.motoB : p.motoF
  const sep = m ? (e.back ? p.motoSepB : p.motoSepF) || 0 : 0
  // 分向線位置（行進 frame）＋中央帶：車道整體外移
  const dv = 0
  const c = dv + (p.centerM || 0) / 2
  const lane = (k: number) => c + (k - 0.5) * LANE_WIDTH_M
  const moto = m ? c + f0 * LANE_WIDTH_M + sep + MOTO_LANE_M / 2 : lane(f)
  const car = (k: number) => (f0 > 0 ? lane(k) : moto)
  if (profile === 'moto') {
    if (m) return { cruise: moto, left: moto, right: moto }
    const legal = motoLegalCarLanes(e.road, e.back)
    const leftK = (legal[0] ?? 0) + 1
    const rightK = (legal[legal.length - 1] ?? f - 1) + 1
    return { cruise: car(rightK), left: car(leftK), right: car(rightK) }
  }
  return { cruise: car(1), left: car(1), right: car(f) } // 汽車巡航走內側車道
}

/** 進彎變道目標（右轉→最右、左轉→bay/最左、兩段式→最右準備進待轉格） */
function turnTarget(
  m: Maneuver, span: { offM: number; leftM: number; rightM: number },
): number {
  if (m.kind === 'right' || m.kind === 'slight-right') return m.rightOffM ?? span.rightM
  if (m.kind === 'left' || m.kind === 'slight-left' || m.kind === 'uturn') {
    return m.twoStage ? span.rightM : (m.bayOffM ?? span.leftM)
  }
  return span.offM
}

/** 路線里程 → 所在 span（GPS 導航查目前道路用；模擬側已有座標 index 直接查） */
export function spanAtDist(route: RouteResult, d: number): RouteResult['spans'][number] | undefined {
  let i = 1
  while (i < route.cum.length - 1 && route.cum[i] < d) i++
  return route.spans.find((s) => s.toIdx >= i)
}

function makeEdge(
  road: RoadFeature, from: number, to: number,
  coords: [number, number][], back: boolean,
): Edge {
  const len = cumulative(coords)[coords.length - 1]
  const speed = (SPEED_KMH[road.properties.highway] ?? 40) / 3.6
  return {
    from, to, coords, lengthM: len, timeS: len / speed,
    name: road.properties.name, road, back,
  }
}

/** 去除幾乎重合的相鄰點（投影點恰為頂點時會產生重複） */
function dedupe(cs: [number, number][]): [number, number][] {
  const out: [number, number][] = [cs[0]]
  for (let i = 1; i < cs.length; i++) {
    if (haversine(out[out.length - 1], cs[i]) > 0.05) out.push(cs[i])
  }
  return out
}

/** 投影點 → 邊尾 的部分邊座標 */
function coordsFromSnap(e: Edge, seg: number, pos: [number, number]): [number, number][] {
  return dedupe([pos, ...e.coords.slice(seg + 1)])
}

/** 邊頭 → 投影點 的部分邊座標 */
function coordsToSnap(e: Edge, seg: number, pos: [number, number]): [number, number][] {
  return dedupe([...e.coords.slice(0, seg + 1), pos])
}

/** 投影結果換算到 twin（反向邊）上的線段位置 */
function twinSeg(e: Edge, seg: number): number {
  return e.coords.length - 2 - seg
}

export class RoadGraph {
  private nodePos = new Map<number, [number, number]>()
  private adj = new Map<number, Edge[]>()
  private adjIn = new Map<number, Edge[]>() // 入邊索引（交叉路走向查詢用）
  private edges: Edge[] = []
  private edgeLookup = new Map<string, Edge>()
  /** 路網建立後不再改變；快取路口索引，避免每條標線重掃完整 edge 集合。 */
  private intersectionCache: { id: number; pos: [number, number] }[] | null = null
  private intersectionIdCache: Set<number> | null = null
  private approachExtensionCache = new Map<string, {
    coords: [number, number][]
    toNode: number
    endSetbackM: number
  } | null>()

  constructor(
    roads: RoadFeature[],
    private laneGuidanceIndex: LaneGuidanceIndex = buildLaneGuidanceIndex([]),
  ) {
    const usage = new Map<number, number>()
    for (const r of roads) {
      const nodes = r.properties.nodes
      if (nodes.length !== r.geometry.coordinates.length) continue
      for (const id of nodes) usage.set(id, (usage.get(id) ?? 0) + 1)
    }
    for (const r of roads) {
      const nodes = r.properties.nodes
      const coords = r.geometry.coordinates as [number, number][]
      if (nodes.length !== coords.length || nodes.length < 2) continue
      for (let i = 0; i < nodes.length; i++) this.nodePos.set(nodes[i], coords[i])

      let segStart = 0
      for (let i = 1; i < nodes.length; i++) {
        const isCut = i === nodes.length - 1 || (usage.get(nodes[i]) ?? 0) > 1
        if (!isCut) continue
        const c = coords.slice(segStart, i + 1)
        // 零長度退化段防呆（兩端同點會產生方位角 0 的幽靈邊）
        if (c.length === 2 && haversine(c[0], c[1]) < 0.1) { segStart = i; continue }
        const fwd = makeEdge(r, nodes[segStart], nodes[i], c, false)
        this.push(fwd)
        if (r.properties.oneway === 'no') {
          const back = makeEdge(r, nodes[i], nodes[segStart], [...c].reverse(), true)
          fwd.twin = back
          back.twin = fwd
          this.push(back)
        }
        segStart = i
      }
    }
  }

  private push(e: Edge) {
    if (!this.adj.has(e.from)) this.adj.set(e.from, [])
    this.adj.get(e.from)!.push(e)
    if (!this.adjIn.has(e.to)) this.adjIn.set(e.to, [])
    this.adjIn.get(e.to)!.push(e)
    this.edges.push(e)
    this.edgeLookup.set(
      `${e.road.properties.osm_id}@${e.road.properties.blockNode}:${e.from}>${e.to}:${e.back ? 1 : 0}`,
      e,
    )
  }

  /**
   * 路口「交叉路」的線方位（度）：排除自身路（同 way/同名續行）後，取與進入
   * 行向最接近垂直的一條（線夾角需 >25°，順向岔路不算）。停止線/地面箭頭列
   * 對齊交會道路用（斜交路口如援中路×藍昌路，垂直於自身會歪）；null = 無交叉路。
   * 出邊＋入邊都看——單行道交叉路可能只進不出。
   */
  crossOrientationAt(nodeId: number, fromBearing: number, selfRoad: RoadFeature): number | null {
    let best: number | null = null
    let bestPerp = 25
    const consider = (b: number, road: RoadFeature) => {
      const q = road.properties
      if (q.osm_id === selfRoad.properties.osm_id) return
      if (selfRoad.properties.name && q.name === selfRoad.properties.name) return
      let d = Math.abs(angleDelta(fromBearing, b))
      if (d > 90) d = 180 - d // 折成線夾角（0~90）
      if (d > bestPerp) { bestPerp = d; best = b }
    }
    for (const e of this.adj.get(nodeId) ?? []) {
      if (e.coords.length >= 2) consider(bearing(e.coords[0], e.coords[1]), e.road)
    }
    for (const e of this.adjIn.get(nodeId) ?? []) {
      const c = e.coords
      if (c.length >= 2) consider(bearing(c[c.length - 2], c[c.length - 1]), e.road)
    }
    return best
  }

  /** 指定道路在節點上真正交叉（線夾角 >25°）的最大路寬。
   * 車道箭頭用它補足小巷路口退界，不改動 bay／停止線原本較嚴格的 scope setback。 */
  crossWidthAt(nodeId: number, fromBearing: number, selfRoad: RoadFeature): number {
    let width = 0
    const seen = new Set<RoadFeature>()
    const consider = (e: Edge, awayBearing: number) => {
      if (seen.has(e.road)) return
      seen.add(e.road)
      const p = e.road.properties
      const self = selfRoad.properties
      if (p.osm_id === self.osm_id || (self.name && p.name === self.name)) return
      let d = Math.abs(angleDelta(fromBearing, awayBearing))
      if (d > 90) d = 180 - d
      if (d > 25) width = Math.max(width, p.width_m)
    }
    for (const e of this.adj.get(nodeId) ?? []) {
      if (e.coords.length >= 2) consider(e, bearing(e.coords[0], e.coords[1]))
    }
    for (const e of this.adjIn.get(nodeId) ?? []) {
      const c = e.coords
      if (c.length >= 2) consider(e, bearing(c[c.length - 1], c[c.length - 2]))
    }
    return width
  }

  /** 路口清單（相鄰節點 ≥3）——待轉區只能放在路口附近 */
  intersections(): { id: number; pos: [number, number] }[] {
    if (this.intersectionCache) return this.intersectionCache
    const neighbors = new Map<number, Set<number>>()
    for (const e of this.edges) {
      if (!neighbors.has(e.from)) neighbors.set(e.from, new Set())
      if (!neighbors.has(e.to)) neighbors.set(e.to, new Set())
      neighbors.get(e.from)!.add(e.to)
      neighbors.get(e.to)!.add(e.from)
    }
    const out: { id: number; pos: [number, number] }[] = []
    for (const [id, ns] of neighbors) {
      if (ns.size >= 3 && this.nodePos.has(id)) out.push({ id, pos: this.nodePos.get(id)! })
    }
    this.intersectionCache = out
    return out
  }

  /**
   * 投影到最近路段「線段上的精確點」（不是頂點！長直路段頂點稀疏，
   * 吸頂點會讓起終點/車輛偏移幾十公尺）。只看順向邊；反向由 twin 處理。
   */
  private project(p: [number, number], profile: Profile):
    { edge: Edge; seg: number; t: number; pos: [number, number] } | null {
    const kx = 111320 * COS_LAT, ky = 110540
    let best: { edge: Edge; seg: number; t: number; pos: [number, number] } | null = null
    let bestD2 = Infinity
    for (const e of this.edges) {
      if (e.back) continue
      // 兩個行進方向都禁行的路體（如 motorcar=no 機車道之於汽車）不做吸附候選
      if (!edgeAllowed(e.road, false, profile) &&
        !(e.twin && edgeAllowed(e.road, true, profile))) continue
      const cs = e.coords
      for (let i = 0; i < cs.length - 1; i++) {
        const dx = (cs[i + 1][0] - cs[i][0]) * kx
        const dy = (cs[i + 1][1] - cs[i][1]) * ky
        const px = (p[0] - cs[i][0]) * kx
        const py = (p[1] - cs[i][1]) * ky
        const len2 = dx * dx + dy * dy
        let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0
        t = Math.max(0, Math.min(1, t))
        const ex = px - t * dx, ey = py - t * dy
        const d2 = ex * ex + ey * ey
        if (d2 < bestD2) {
          bestD2 = d2
          best = {
            edge: e, seg: i, t,
            pos: [
              cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t,
              cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t,
            ],
          }
        }
      }
    }
    return best
  }

  /** 某路口所有可能的「左轉配對」（進入行向 × 左轉出口），供待轉區設定選單用 */
  leftTurnOptions(nodeId: number): TurnOption[] {
    const pos = this.nodePos.get(nodeId)
    if (!pos) return []
    const incoming = this.edges.filter((e) => e.to === nodeId && e.coords.length >= 2)
    const outgoing = (this.adj.get(nodeId) ?? []).filter((e) => e.coords.length >= 2)
    const opts: TurnOption[] = []
    const seen = new Set<string>()
    for (const inc of incoming) {
      const c = inc.coords
      const fb = bearing(c[c.length - 2], c[c.length - 1])
      for (const out of outgoing) {
        const tb = bearing(out.coords[0], out.coords[1])
        const d = angleDelta(fb, tb)
        if (d >= -135 && d <= -45) { // 左轉範圍
          const key = `${Math.round(fb / 15)}_${Math.round(tb / 15)}`
          if (seen.has(key)) continue
          seen.add(key)
          opts.push({
            nodeId, pos,
            fromName: inc.name, fromBearing: fb,
            toName: out.name, toBearing: tb,
            fromWidth: inc.road.properties.width_m,
            toWidth: out.road.properties.width_m,
          })
        }
      }
    }
    return opts.sort((a, b) => a.fromBearing - b.fromBearing)
  }

  /**
   * 偏心左轉道生成錨點：scope 內的每條邊，其終點若有左轉（-135°~-45°）或迴轉
   * （|Δ|>150°）配對即成錨。原路 twin 折返不算（雙向道每個節點都能折返，會過量生成）。
   */
  bayAnchors(scope: (r: RoadFeature) => boolean): BayAnchor[] {
    const out: BayAnchor[] = []
    const seen = new Set<string>()
    for (const e of this.edges) {
      if (e.coords.length < 2 || !scope(e.road)) continue
      const c = e.coords
      const endBrg = bearing(c[c.length - 2], c[c.length - 1])
      const others = (this.adj.get(e.to) ?? []).filter(
        (o) => o !== e.twin && o.coords.length >= 2)
      if (others.length === 0) continue // 死路端點：無處可轉
      const hasLeftPair = others.some((o) => {
        const d = angleDelta(endBrg, bearing(o.coords[0], o.coords[1]))
        return (d >= -135 && d <= -45) || Math.abs(d) > 150
      })
      const key = `way/${e.road.properties.osm_id}@node/${e.to}${e.back ? '~b' : ''}`
      if (seen.has(key)) continue
      seen.add(key)
      // 停止線回退：取路口上其他道路的最大斷面寬（近似交叉路寬）
      let crossW = 0
      for (const o of others) crossW = Math.max(crossW, o.road.properties.width_m)
      out.push({
        wayId: e.road.properties.osm_id, nodeId: e.to,
        coords: c, road: e.road, back: e.back, approachBearing: endBrg,
        setbackM: crossW / 2 + 1.2,
        hasLeftPair,
      })
    }
    return out
  }

  /**
   * 中央槽化線渲染用：scope 內所有方向邊 + 兩端路口的收邊量（交叉路半寬），
   * 標線不畫進路口框。turnbays.ts 的 buildChannelization 使用。
   */
  scopeEdges(
    scope: (r: RoadFeature) => boolean, minCrossWidthM = 7, clearanceM = 1.2,
    crossQualifies?: (r: RoadFeature) => boolean,
  ): ScopeEdge[] {
    // 收邊只看「夠格的交叉路」：不同路（id 與路名都不同）且寬 ≥7m（≥2 車道）。
    // 小巷（residential 6.4m）交會不清標線也不生停止線——實際道路的車道線
    // 會直接越過巷口；同路續接區塊也不算（自寬會把收邊撐到半個路寬）。
    // crossQualifies（選用）：另讓「實際幹道／集散道」交叉路夠格（停等線用），
    // 即使窄於 minCrossWidthM——幹道×幹道兩條 6.4m 相交也要有停等線回退。
    const crossW = (nodeId: number, self: Edge) => {
      let w = 0
      const sp = self.road.properties
      for (const o of this.adj.get(nodeId) ?? []) {
        if (o === self || o === self.twin) continue
        const q = o.road.properties
        if (q.osm_id === sp.osm_id || (sp.name && q.name === sp.name)) continue
        if (q.width_m < minCrossWidthM && !crossQualifies?.(o.road)) continue
        w = Math.max(w, q.width_m)
      }
      return w
    }
    return this.edges
      .filter((e) => e.coords.length >= 2 && scope(e.road))
      .map((e) => {
        const w0 = crossW(e.from, e)
        const w1 = crossW(e.to, e)
        return {
          coords: e.coords, road: e.road, back: e.back,
          fromNode: e.from, toNode: e.to,
          startSetbackM: w0 > 0 ? w0 / 2 + clearanceM : 0,
          endSetbackM: w1 > 0 ? w1 / 2 + clearanceM : 0,
        }
      })
  }

  /**
   * 將「道路本體 → 短落地連接 way → 真正路口」視為同一個進口。
   *
   * OSM 常在橋名、bridge/layer 或 way ID 切換處插入數公尺至數十公尺的
   * 連接段；若標線只看原 edge，箭頭、停止線與停等格會被判定為尚未到路口。
   * 本函式只穿越沒有真正岔路、方向近乎連續的短段，不會跨越一般路口。
   */
  extendApproachToIntersection(
    input: ScopeEdge, maxExtensionM = 45, clearanceM = 1.2,
  ): ScopeEdge {
    const intersections = this.intersectionIdCache
      ?? (this.intersectionIdCache = new Set(this.intersections().map((item) => item.id)))
    if (intersections.has(input.toNode)) return input

    const cacheKey =
      `${input.road.properties.osm_id}@${input.road.properties.blockNode}:`
      + `${input.fromNode}>${input.toNode}:${input.back ? 1 : 0}:`
      + `${maxExtensionM}:${clearanceM}`
    const cached = this.approachExtensionCache.get(cacheKey)
    if (cached === null) return input
    if (cached) return { ...input, ...cached }

    let current = this.edgeLookup.get(
      `${input.road.properties.osm_id}@${input.road.properties.blockNode}:`
      + `${input.fromNode}>${input.toNode}:${input.back ? 1 : 0}`,
    )
    if (!current) {
      this.approachExtensionCache.set(cacheKey, null)
      return input
    }

    const coords = [...input.coords]
    let nodeId = input.toNode
    let addedM = 0
    const visited = new Set<Edge>([current])

    for (let step = 0; step < 4 && !intersections.has(nodeId); step++) {
      const incomingBearing = bearing(
        coords[coords.length - 2], coords[coords.length - 1])
      const candidates = (this.adj.get(nodeId) ?? [])
        .filter((edge) => !visited.has(edge) && edge.coords.length >= 2)
        .map((edge) => ({
          edge,
          delta: Math.abs(angleDelta(
            incomingBearing, bearing(edge.coords[0], edge.coords[1]))),
        }))
        .filter(({ edge, delta }) =>
          delta <= 35 && addedM + edge.lengthM <= maxExtensionM
          && edgeAllowed(edge.road, edge.back, 'car'))
        .sort((a, b) => a.delta - b.delta)

      // 有兩條同樣合理的出口代表已經分岔，不替使用者猜路。
      if (candidates.length === 0
        || (candidates.length > 1 && candidates[1].delta - candidates[0].delta < 8)) break

      current = candidates[0].edge
      visited.add(current)
      coords.push(...current.coords.slice(1))
      addedM += current.lengthM
      nodeId = current.to
    }

    if (!intersections.has(nodeId)) {
      this.approachExtensionCache.set(cacheKey, null)
      return input
    }
    const endBearing = bearing(coords[coords.length - 2], coords[coords.length - 1])
    const crossWidth = this.crossWidthAt(nodeId, endBearing, current.road)
    const extension = {
      coords,
      toNode: nodeId,
      endSetbackM: crossWidth > 0 ? crossWidth / 2 + clearanceM : input.endSetbackM,
    }
    this.approachExtensionCache.set(cacheKey, extension)
    return { ...input, ...extension }
  }

  /** 路口出口方向查詢（地面車道箭頭用）：該行向在節點可直行/左轉/右轉？ */
  exitKindsAt(nodeId: number, fromBearing: number): Set<'left' | 'straight' | 'right'> {
    const out = new Set<'left' | 'straight' | 'right'>()
    for (const a of this.alternativesAt(nodeId, fromBearing, 'car')) out.add(a.kind)
    return out
  }

  /**
   * 路口決策用：給定進入路口的行向，回傳該路口所有可行的出口邊，依角度分類 left/straight/right。
   * 用來讓模擬駕駛「不照指引走」，改走同一路口的其他道路（觸發 reroute 用）。
   */
  alternativesAt(nodeId: number, fromBearing: number, profile: Profile):
    { kind: 'left' | 'straight' | 'right'; coords: [number, number][] }[] {
    const outgoing = (this.adj.get(nodeId) ?? [])
      .filter((e) => e.coords.length >= 2 && edgeAllowed(e.road, e.back, profile))
    const out: { kind: 'left' | 'straight' | 'right'; coords: [number, number][] }[] = []
    for (const e of outgoing) {
      const tb = bearing(e.coords[0], e.coords[1])
      const turn = classifyTurn(angleDelta(fromBearing, tb))
      if (turn === 'uturn') continue
      const kind = turn === null ? 'straight' : turn === 'left' || turn === 'slight-left' ? 'left' : 'right'
      out.push({ kind, coords: e.coords })
    }
    return out
  }

  /** 放置車輛模型用：吸到最近車道中心的精確位置（比較兩個行進方向，取離點擊較近者） */
  snapToLane(p: [number, number], type: Profile):
    { pos: [number, number]; bearing: number; road?: string } | null {
    const hit = this.project(p, type)
    if (!hit) return null
    const cands: { e: Edge; seg: number }[] = [{ e: hit.edge, seg: hit.seg }]
    if (hit.edge.twin) cands.push({ e: hit.edge.twin, seg: twinSeg(hit.edge, hit.seg) })
    let best: { pos: [number, number]; bearing: number; road?: string } | null = null
    let bestD = Infinity
    for (const { e, seg } of cands) {
      if (!edgeAllowed(e.road, e.back, type)) continue
      const brg = bearing(e.coords[seg], e.coords[seg + 1])
      const off = laneOffsets(e, type).cruise
      const rad = ((brg + 90) * Math.PI) / 180
      const pos: [number, number] = [
        hit.pos[0] + (off * Math.sin(rad)) / (111320 * COS_LAT),
        hit.pos[1] + (off * Math.cos(rad)) / 110540,
      ]
      const d = haversine(p, pos)
      if (d < bestD) { bestD = d; best = { pos, bearing: brg, road: e.name } }
    }
    return best
  }

  route(fromP: [number, number], toP: [number, number], profile: Profile = 'car'): RouteResult | null {
    const sA = this.project(fromP, profile)
    const sB = this.project(toP, profile)
    if (!sA || !sB) return null

    // 同一條（順向）邊且順序正確 → 直接一段
    if (sA.edge === sB.edge) {
      const forwardOk = (sA.seg < sB.seg || (sA.seg === sB.seg && sA.t <= sB.t)) &&
        edgeAllowed(sA.edge.road, sA.edge.back, profile)
      if (forwardOk) {
        const cs = dedupe([sA.pos, ...sA.edge.coords.slice(sA.seg + 1, sB.seg + 1), sB.pos])
        if (cs.length >= 2) return this.assemble([makeEdge(sA.edge.road, -1, -1, cs, sA.edge.back)], profile)
      } else if (sA.edge.twin && edgeAllowed(sA.edge.road, true, profile)) {
        const t = sA.edge.twin
        const a = twinSeg(sA.edge, sA.seg), b = twinSeg(sA.edge, sB.seg)
        const cs = dedupe([sA.pos, ...t.coords.slice(a + 1, b + 1), sB.pos])
        if (cs.length >= 2) return this.assemble([makeEdge(t.road, -1, -1, cs, t.back)], profile)
      }
    }

    // 起點入口：從投影點沿邊走到邊尾（兩個方向都試）
    const startEntries: { node: number; part: Edge }[] = []
    const addStart = (e: Edge, seg: number) => {
      if (!edgeAllowed(e.road, e.back, profile)) return
      const cs = coordsFromSnap(e, seg, sA.pos)
      if (cs.length >= 2) startEntries.push({ node: e.to, part: makeEdge(e.road, -1, e.to, cs, e.back) })
      else startEntries.push({ node: e.to, part: makeEdge(e.road, -1, e.to, [sA.pos, e.coords[e.coords.length - 1]], e.back) })
    }
    addStart(sA.edge, sA.seg)
    if (sA.edge.twin) addStart(sA.edge.twin, twinSeg(sA.edge, sA.seg))

    // 終點出口：從邊頭走到投影點
    const goalEntries: { node: number; part: Edge }[] = []
    const addGoal = (e: Edge, seg: number) => {
      if (!edgeAllowed(e.road, e.back, profile)) return
      const cs = coordsToSnap(e, seg, sB.pos)
      if (cs.length >= 2) goalEntries.push({ node: e.from, part: makeEdge(e.road, e.from, -1, cs, e.back) })
    }
    addGoal(sB.edge, sB.seg)
    if (sB.edge.twin) addGoal(sB.edge.twin, twinSeg(sB.edge, sB.seg))
    if (startEntries.length === 0 || goalEntries.length === 0) return null

    const goalPos = toP
    const g = new Map<number, number>()
    const cameFrom = new Map<number, Edge>()
    const startPart = new Map<number, Edge>()
    const open = new Map<number, number>()
    for (const s of startEntries) {
      if (s.part.timeS < (g.get(s.node) ?? Infinity)) {
        g.set(s.node, s.part.timeS)
        startPart.set(s.node, s.part)
        open.set(s.node, s.part.timeS +
          haversine(this.nodePos.get(s.node) ?? s.part.coords[s.part.coords.length - 1], goalPos) / MAX_SPEED_MS)
      }
    }
    const closed = new Set<number>()
    let bestGoal: { cost: number; node: number; part: Edge } | null = null

    while (open.size > 0) {
      let cur = -1, curF = Infinity
      for (const [id, f] of open) if (f < curF) { curF = f; cur = id }
      open.delete(cur)
      if (bestGoal && curF >= bestGoal.cost) break
      closed.add(cur)
      for (const ge of goalEntries) {
        if (ge.node === cur) {
          const total = g.get(cur)! + ge.part.timeS
          if (!bestGoal || total < bestGoal.cost) bestGoal = { cost: total, node: cur, part: ge.part }
        }
      }
      for (const e of this.adj.get(cur) ?? []) {
        if (closed.has(e.to)) continue
        if (!edgeAllowed(e.road, e.back, profile)) continue
        const tentative = g.get(cur)! + e.timeS
        if (tentative < (g.get(e.to) ?? Infinity)) {
          g.set(e.to, tentative)
          cameFrom.set(e.to, e)
          startPart.delete(e.to) // 走圖比直接入口便宜，起點部分邊不再適用
          open.set(e.to, tentative + haversine(this.nodePos.get(e.to)!, goalPos) / MAX_SPEED_MS)
        }
      }
    }
    if (!bestGoal) return null

    const chain: Edge[] = [bestGoal.part]
    let cur = bestGoal.node
    while (!startPart.has(cur)) {
      const e = cameFrom.get(cur)
      if (!e) return null // 理論上不會發生
      chain.unshift(e)
      cur = e.from
    }
    chain.unshift(startPart.get(cur)!)
    return this.assemble(chain.filter((e) => e.coords.length >= 2), profile)
  }

  private assemble(edges: Edge[], profile: Profile): RouteResult | null {
    if (edges.length === 0) return null
    const coords: [number, number][] = [edges[0].coords[0]]
    const spans: RouteResult['spans'] = []
    for (const e of edges) {
      coords.push(...e.coords.slice(1))
      const lo = laneOffsets(e, profile)
      const p = e.road.properties
      const roadLaneCount = e.back ? p.lanesBackward : p.lanesForward
      const osmMovements = e.back ? p.turnLanesB : p.turnLanes
      spans.push({
        toIdx: coords.length - 1,
        offM: lo.cruise,
        leftM: lo.left,
        rightM: lo.right,
        road: e.road,
        back: e.back,
        laneGuidance: resolveLaneGuidance(this.laneGuidanceIndex, {
          wayId: p.osm_id,
          direction: e.back ? 'backward' : 'forward',
          roadLaneCount,
          osmMovements,
        }),
      })
    }
    const cum = cumulative(coords)
    return {
      coords, cum,
      lengthM: cum[cum.length - 1],
      timeS: edges.reduce((s, e) => s + e.timeS, 0),
      maneuvers: buildManeuvers(edges, this.laneGuidanceIndex),
      spans,
      ...this.buildDiverges(edges, profile),
    }
  }

  /**
   * 分流點偵測：路線在某節點離開「主流」，但轉角小到不成為 maneuver。
   * 判定條件（三者皆須成立）：
   *   1. 該節點還有其他大致同向（≤FORK_FWD_DEG）的出邊——橫交道路不是分流；
   *   2. 路線的出邊與所有競爭出邊都在同一側（角差 >FORK_SEP_DEG），才有「該切哪邊」；
   *   3. 路線本身就是分出去的那條——比競爭者更偏（或路線是匝道 _link 而對方不是）。
   *      主線直行、旁邊有匝道分出去的情況不算：續行主線不需要為別人換道。
   */
  private buildDiverges(edges: Edge[], profile: Profile): { diverges: Diverge[]; weaves: number[] } {
    const out: Diverge[] = []
    const weaves: number[] = []
    let dist = edges[0].lengthM
    for (let i = 1; i < edges.length; i++) {
      const prev = edges[i - 1], next = edges[i]
      const node = next.from >= 0 ? next.from : prev.to
      const pc = prev.coords
      const inBrg = bearing(pc[pc.length - 2], pc[pc.length - 1])
      const outBrg = bearing(next.coords[0], next.coords[1])
      const dOut = angleDelta(inBrg, outBrg)
      // 交織點：此節點有「不屬於本路線」的匝道進出（別人的出口/匯入）
      if (node >= 0 && this.hasOtherRamp(node, prev.road, next.road)) weaves.push(dist)
      if (node >= 0 && !classifyTurn(dOut)) {
        // 競爭出邊（同節點、大致同向、本車種可走）。partial edge 不是圖上的物件，
        // 排不掉自己，但自己的角差 ≈0 會被 FORK_SEP_DEG 濾掉。
        let nAlt = 0, minAlt = Infinity, relMin = Infinity, relMax = -Infinity
        for (const a of this.adj.get(node) ?? []) {
          if (a === next || a === prev.twin || a.coords.length < 2) continue
          if (!edgeAllowed(a.road, a.back, profile)) continue
          const ab = bearing(a.coords[0], a.coords[1])
          if (Math.abs(angleDelta(inBrg, ab)) > FORK_FWD_DEG) continue
          nAlt++
          minAlt = Math.min(minAlt, Math.abs(angleDelta(inBrg, ab)))
          const rel = angleDelta(ab, outBrg) // >0：路線在該支線右側
          relMin = Math.min(relMin, rel)
          relMax = Math.max(relMax, rel)
        }
        const side = nAlt === 0 ? null
          : relMin > FORK_SEP_DEG ? 'right' : relMax < -FORK_SEP_DEG ? 'left' : null
        const isRamp = isLink(next.road) && !isLink(prev.road)
        if (side && (isRamp || Math.abs(dOut) >= minAlt - FORK_SEP_DEG)) {
          out.push({ distM: dist, side, nodeId: node })
        }
      }
      dist += next.lengthM
    }
    return { diverges: out, weaves }
  }

  /** 該節點是否有「本路線以外」的匝道進出（出邊、入邊都算）——交流道交織區的判準 */
  private hasOtherRamp(node: number, from: RoadFeature, to: RoadFeature): boolean {
    const mine = (r: RoadFeature) =>
      r.properties.osm_id === from.properties.osm_id || r.properties.osm_id === to.properties.osm_id
    for (const list of [this.adj.get(node), this.adjIn.get(node)]) {
      for (const e of list ?? []) {
        if (isLink(e.road) && !mine(e.road)) return true
      }
    }
    return false
  }
}

/** 匝道（交流道連絡道）路體 */
function isLink(r: RoadFeature): boolean {
  return r.properties.highway.endsWith('_link')
}

/** 只有大致同向的出邊才是分流競爭者（橫交道路走的是別的動線） */
const FORK_FWD_DEG = 60
/** 兩條出邊要差這麼多度才分得出左右（同角度＝重疊資料，不是分流） */
const FORK_SEP_DEG = 4

/** 轉彎後從轉向側車道漸出回巡航車道的過渡距離（公尺） */
const EXIT_MERGE_M = 25
/** 路線帶取樣步距（公尺）：變道/出彎軌跡以距離取樣，不受路線頂點疏密影響。
 * 頂點間距動輒數十公尺，若只在頂點內插，轉彎後「回巡航道」會變成一條
 * 橫掃對向/中央槽化線的長斜線（車貼帶行駛後這個瑕疵會直接變成行駛軌跡） */
const BAND_STEP_M = 6

/** 橫移一個車道寬的最短漸變長度：至少 14m，高速再依速率放長 */
const SPAN_TAPER_MIN_M = 14
const SPAN_TAPER_S = 1.5

/** 每公尺可橫移量上限（= 一個車道寬 / 漸變長度）——巡航漸變與變道 ramp 共用同一斜率 */
function maxSlew(v: number): number {
  return LANE_WIDTH_M / Math.max(SPAN_TAPER_MIN_M, v * SPAN_TAPER_S)
}

export interface LaneBandResult {
  coords: [number, number][]
  /** 每個取樣點的 route 里程——模擬車沿帶行駛時內插回 route 里程（HUD/maneuver 用） */
  routeD: number[]
}

/** 橫向事件：轉向與分流統一成「到某里程前要切到某車道」，laneBand 一視同仁處理 */
interface LatEvent {
  distM: number
  /** 轉向（有 HUD 指引）；分流事件為 undefined */
  man?: Maneuver
  /** 分流側（man 為 undefined 時有值） */
  side?: 'left' | 'right'
}

/** 事件前最後一個經過的匝道交織點里程（沒有就 0）——變道不從那之前開始 */
function lastWeaveBefore(weaves: number[], distM: number): number {
  let out = 0
  for (const w of weaves) {
    if (w < distM - 1 && w > out) out = w
  }
  return out
}

/** 該路段的設計速率（m/s）——變道提前量與漸變長度都依它換算 */
function spanSpeedMs(span?: RouteResult['spans'][number]): number {
  return (SPEED_KMH[span?.road?.properties.highway ?? ''] ?? 40) / 3.6
}

/**
 * 變道視窗：回傳〔開始變道距事件多遠, 完成變道距事件多遠〕（公尺）。
 * 提前量隨速率與要跨的車道數放大：分流在 60km/h 跨一車道約 142m 前開始、100m 前就位，
 * 一律固定 45m（90km/h 只有 1.8 秒）等於到了路口/鼻端才橫切。
 */
function leadWindow(v: number, latM: number, diverge: boolean): [number, number] {
  const lanes = Math.max(1, Math.abs(latM) / LANE_WIDTH_M)
  const end = Math.max(LANE_CHANGE_M * 0.4, v * (diverge ? DIVERGE_SETTLE_S : SETTLE_S))
  return [end + Math.max(LANE_CHANGE_M * 0.6, v * LANE_CHANGE_S * lanes), end]
}

/**
 * 巡航偏移的橫向變化率限制：車道數/路寬改變（或匝道接主線）時 span 的 offM 會直接跳，
 * 逐段內插不夠用——路口附近常有數公尺長的碎段，漸變長度會被夾成 0 而還原成直角。
 * 改成對整串取樣做斜率限制：正向一次、反向一次再取平均＝以交界為中心的對稱漸變，
 * 需要時自然跨過好幾個碎段。每公尺可橫移量 = 一個車道寬 / 漸變長度（依速率）。
 */
function slewLimit(ds: number[], raw: number[], vs: number[]): number[] {
  const n = raw.length
  const rate = (i: number) => maxSlew(vs[i])
  const pass = (order: number[]): number[] => {
    const out = raw.slice()
    for (let k = 1; k < n; k++) {
      const i = order[k], j = order[k - 1]
      const step = Math.abs(ds[i] - ds[j]) * Math.min(rate(i), rate(j))
      out[i] = Math.max(out[j] - step, Math.min(out[j] + step, raw[i]))
    }
    return out
  }
  const fwd = pass([...raw.keys()])
  const bwd = pass([...raw.keys()].reverse())
  return raw.map((_, i) => (fwd[i] + bwd[i]) / 2)
}

/**
 * 車道級路線帶：把路線幾何偏移到「實際行駛的車道」上，含四種過渡：
 *   進彎/分流：路口或分流鼻端前，依速率提前漸進切到目標車道（見 leadWindow）；
 *        偏心左轉道改對齊 bay 開口（漸變段斜切開始才變道，不壓上游槽化線與儲車段白線）
 *   出彎：轉彎後從轉向側車道（左轉→最內、右轉→最外）漸出回巡航車道；
 *        分流因轉角小、橫向座標系幾乎沒轉，直接由通過分流點時的偏移續接
 *   巡航：span 的 offM，跨路段以 slewLimit 漸變（不會有橫向直角）
 * 路線帶畫在車道內、車貼在路線帶上（drive.ts 直接沿這條帶行駛）。
 */
export function laneBand(route: RouteResult): LaneBandResult {
  const cs = route.coords
  const cum = route.cum
  const total = cum[cum.length - 1]
  // 轉向與分流合成一條依里程排序的事件序列
  const evs: LatEvent[] = [
    ...route.maneuvers.filter((m) => m.kind !== 'arrive').map((m) => ({ distM: m.distM, man: m })),
    ...(route.diverges ?? []).map((g) => ({ distM: g.distM, side: g.side })),
  ].sort((a, b) => a.distM - b.distM)

  // 取樣里程：原頂點（轉角錨點）＋ 全程步進（頂點附近 1.5m 內的步進點略過）
  const ds: number[] = [...cum]
  for (let d = BAND_STEP_M; d < total; d += BAND_STEP_M) ds.push(d)
  ds.sort((a, b) => a - b)
  const samples: number[] = []
  for (const d of ds) {
    if (samples.length === 0 || d - samples[samples.length - 1] > 1.5) samples.push(d)
    else if (cum.includes(d)) samples[samples.length - 1] = d // 頂點優先於鄰近步進點
  }

  // 前置：每點的位置/所屬 span/原始巡航偏移，巡航偏移再做斜率限制（跨段漸變）
  const at = samples.map((d) => pointAlong(cs, cum, d))
  const sidx: number[] = []
  let si = 0
  for (const p of at) {
    while (si < route.spans.length - 1 && route.spans[si].toIdx < p.idx) si++
    sidx.push(si)
  }
  const cruises = slewLimit(
    samples,
    sidx.map((i) => route.spans[i]?.offM ?? 0),
    sidx.map((i) => spanSpeedMs(route.spans[i])))

  const offs: number[] = []
  let mi = 0
  let lastOff: number | null = null // 上一取樣點的偏移
  let passOff: number | null = null // 通過分流點當下的偏移（下游續接用）
  for (let k = 0; k < samples.length; k++) {
    const d = samples[k]
    const { pos, brg } = at[k]
    const span = route.spans[sidx[k]]
    let off = span ? cruises[k] : 0
    if (span) {
      const cruise = off
      while (mi < evs.length && evs[mi].distM < d - 0.5) { passOff = lastOff; mi++ }
      const next = mi < evs.length ? evs[mi] : null
      const prev = mi > 0 ? evs[mi - 1] : null
      let entering = false
      if (next) {
        const target = next.man ? turnTarget(next.man, span)
          : next.side === 'right' ? span.rightM : span.leftM
        // 偏心道/右轉道對齊 bay 幾何（漸變段起點→儲車段起點）；其餘依速率提前
        const hasBayWin = next.man &&
          (next.man.bayOffM ?? next.man.rightOffM) !== undefined && next.man.bayMouthM !== undefined
        const v = spanSpeedMs(span)
        let [rampStart, rampEnd] = hasBayWin
          ? [next.man!.bayMouthM! + (next.man!.bayTaperM ?? 15), next.man!.bayMouthM!]
          : leadWindow(v, target - cruise, !next.man)
        if (!hasBayWin) {
          // 提前量的起點不得早於：上一個事件（連續路口會變成整段左右擺）、
          // 以及最後一個經過的匝道交織點（長途在兩個交流道之後才下去時，
          // 早於前一個交流道切出去會整段掛在別人的出口/匯入道上）。
          // 但壓縮到比 maxSlew 還陡就不叫變道了，斜率下限優先（bay 的窗是實體幾何，不動）
          const bound = Math.max(
            prev ? prev.distM + EXIT_MERGE_M : 0,
            lastWeaveBefore(route.weaves, next.distM))
          const floor = rampEnd + Math.abs(target - cruise) / maxSlew(v)
          rampStart = Math.min(rampStart, Math.max(floor, next.distM - bound))
        }
        const gap = next.distM - d
        if (gap <= rampStart) {
          const t = Math.min(1, Math.max(0, (rampStart - gap) / Math.max(1, rampStart - rampEnd)))
          off = cruise + (target - cruise) * t
          entering = true
        }
      }
      if (!entering && prev) {
        // 出彎漸出：左轉/迴轉從最內車道、右轉從最外車道，漸回巡航車道。
        // 分流沒有轉向、橫向座標系也沒轉，改從通過分流點時的偏移續接（匝道中心線
        // 起點就在主線中心線上，不續接會在鼻端出現一整個車道寬的橫跳）。
        const e = d - prev.distM
        if (e < EXIT_MERGE_M) {
          const p = prev.man
          const from = !p ? passOff ?? cruise
            : p.kind === 'right' || p.kind === 'slight-right' || p.twoStage ? span.rightM
            : p.kind === 'left' || p.kind === 'slight-left' || p.kind === 'uturn' ? span.leftM
            : cruise
          off = from + (cruise - from) * Math.max(0, e / EXIT_MERGE_M)
        }
      }
    }
    lastOff = off
    offs.push(off)
  }

  // 收尾再限一次斜率：span 交界處連「目標車道」本身都會跳（前後路段車道數不同，
  // 最內/最外的位置不一樣），變道中途遇到交界就會在 ramp 上折一角。
  const smooth = slewLimit(samples, offs, sidx.map((i) => spanSpeedMs(route.spans[i])))
  const coords: [number, number][] = []
  const routeD: number[] = []
  for (let k = 0; k < samples.length; k++) {
    const { pos } = at[k]
    // 轉角 miter 偏移：方向取前後鄰取樣點的角平分線、長度除以 cos(半轉角)。
    // 逐點垂直於「進入段」方位角（pointAlong 在頂點回傳進入段）會讓內側轉角
    // 先沿直行方向衝過頭、再急折回目標路——右轉（右駕右偏移）路口尤其明顯，
    // 模擬車看起來像過了路口才繞回來。miter 上限 2（≈120° 轉角）防銳角尖刺。
    const prevPos = k > 0 ? at[k - 1].pos : pos
    const nextPos = k < samples.length - 1 ? at[k + 1].pos : pos
    const bIn = k > 0 ? bearing(prevPos, pos) : bearing(pos, nextPos)
    const bOut = k < samples.length - 1 ? bearing(pos, nextPos) : bIn
    const half = angleDelta(bIn, bOut) / 2
    const brg = bIn + half
    const miter = Math.min(2, 1 / Math.max(0.5, Math.cos((half * Math.PI) / 180)))
    const off = smooth[k] * miter
    const rad = ((brg + 90) * Math.PI) / 180
    coords.push(offsetMeters(pos, off * Math.sin(rad), off * Math.cos(rad)))
    routeD.push(samples[k])
  }
  return trimInsideCorners(coords, routeD, route.maneuvers)
}

/** 帶點倒退判定門檻：相鄰兩段夾角超過此值（度）視為「衝過切點再折回」的鋸齒 */
const BACKTRACK_DEG = 95
/** 只在左右轉 ±這個範圍（公尺）內做內側切角清理 */
const CORNER_TRIM_M = 20

/**
 * 內側轉角清理：偏移帶在轉角內側有「切角區」——偏移 o、轉角 θ 時，兩條偏移線
 * 的交點落在節點前後各 o·tan(θ/2)（寬路右轉可達 8m+）。取樣按路線里程走，
 * 會沿進入向多畫到節點才折回出彎線，帶出現倒退鋸齒＝模擬車「過了路口再繞回」。
 * 把造成倒退的點迭代移除，帶自然收斂成兩條偏移線的交點連線（正確內側切角）。
 * 只清左右轉附近；迴轉的髮夾彎是真實行駛幾何，剪了會切過分隔島，不動。
 */
function trimInsideCorners(
  coords: [number, number][], routeD: number[], maneuvers: Maneuver[],
): LaneBandResult {
  const wins = maneuvers
    .filter((m) => m.kind === 'left' || m.kind === 'right')
    .map((m) => m.distM)
  if (!wins.length || coords.length < 3) return { coords, routeD }
  const kx = 111320 * COS_LAT, ky = 110540
  const keep = coords.map(() => true)
  const near = (d: number) => wins.some((w) => Math.abs(d - w) < CORNER_TRIM_M)
  const cosLimit = Math.cos((BACKTRACK_DEG * Math.PI) / 180)
  for (let pass = 0; pass < 12; pass++) {
    const idx: number[] = []
    for (let i = 0; i < coords.length; i++) if (keep[i]) idx.push(i)
    let changed = false
    for (let k = 1; k < idx.length - 1; k++) {
      const i = idx[k]
      if (!near(routeD[i])) continue
      const a = coords[idx[k - 1]], b = coords[i], c = coords[idx[k + 1]]
      const abx = (b[0] - a[0]) * kx, aby = (b[1] - a[1]) * ky
      const bcx = (c[0] - b[0]) * kx, bcy = (c[1] - b[1]) * ky
      const la = Math.hypot(abx, aby), lb = Math.hypot(bcx, bcy)
      if (la < 0.05 || lb < 0.05) continue
      if ((abx * bcx + aby * bcy) / (la * lb) < cosLimit) { keep[i] = false; changed = true }
    }
    if (!changed) break
  }
  return {
    coords: coords.filter((_, i) => keep[i]),
    routeD: routeD.filter((_, i) => keep[i]),
  }
}

/** 路線帶幾何（畫圖用）；模擬行駛要拿里程對應表，用 laneBand */
export function laneOffsetCoords(route: RouteResult): [number, number][] {
  return laneBand(route).coords
}

/** 多段路線合併（起點→停靠點…→終點）：中途的 arrive 併掉，只留最後一個 */
export function mergeRoutes(legs: RouteResult[]): RouteResult {
  const coords = [...legs[0].coords]
  const spans = [...legs[0].spans]
  const maneuvers = [...legs[0].maneuvers.slice(0, -1)]
  const diverges = [...legs[0].diverges]
  const weaves = [...legs[0].weaves]
  let distOff = legs[0].lengthM
  let timeS = legs[0].timeS
  for (let i = 1; i < legs.length; i++) {
    const L = legs[i]
    if (haversine(coords[coords.length - 1], L.coords[0]) > 0.5) coords.push(L.coords[0])
    const base = coords.length - 1
    coords.push(...L.coords.slice(1))
    for (const s of L.spans) spans.push({ ...s, toIdx: base + s.toIdx })
    for (const m of L.maneuvers.slice(0, -1)) maneuvers.push({ ...m, distM: m.distM + distOff })
    for (const g of L.diverges) diverges.push({ ...g, distM: g.distM + distOff })
    for (const w of L.weaves) weaves.push(w + distOff)
    distOff += L.lengthM
    timeS += L.timeS
  }
  const last = legs[legs.length - 1]
  const arrive = last.maneuvers[last.maneuvers.length - 1]
  maneuvers.push({ ...arrive, distM: distOff - last.lengthM + arrive.distM })
  const cum = cumulative(coords)
  return { coords, cum, lengthM: cum[cum.length - 1], timeS, maneuvers, spans, diverges, weaves }
}

/** 相鄰轉向合併門檻：錯位路口/巷弄接駁的兩個轉向點通常在 20m 內 */
const MERGE_GAP_M = 22

function classifyTurn(d: number): Maneuver['kind'] | null {
  if (Math.abs(d) > 150) return 'uturn'
  if (d > 55) return 'right'
  if (d > 25) return 'slight-right'
  if (d < -55) return 'left'
  if (d < -25) return 'slight-left'
  return null
}

function buildManeuvers(
  edges: Edge[],
  laneGuidanceIndex: LaneGuidanceIndex,
): Maneuver[] {
  type Cand = { m: Maneuver; inBrg: number; outBrg: number; d: number }
  const cands: Cand[] = []
  let dist = edges[0].lengthM
  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1], next = edges[i]
    const inBrg = bearing(
      prev.coords[prev.coords.length - 2], prev.coords[prev.coords.length - 1])
    const outBrg = bearing(next.coords[0], next.coords[1])
    const d = angleDelta(inBrg, outBrg)
    const kind = classifyTurn(d)
    if (kind) {
      const nodeId = next.from >= 0 ? next.from : prev.to >= 0 ? prev.to : undefined
      const roadProps = prev.road.properties
      const roadLaneCount = prev.back
        ? roadProps.lanesBackward
        : roadProps.lanesForward
      const osmMovements = prev.back
        ? roadProps.turnLanesB
        : roadProps.turnLanes
      cands.push({
        m: {
          distM: dist,
          kind,
          roadName: next.name,
          nodeId,
          pos: next.coords[0],
          fromBearing: inBrg,
          // HUD 車道格：取「進入行向」的車道數與轉向（逆向邊用 backward 組）
          lanesForward: roadLaneCount,
          turnLanes: osmMovements,
          laneGuidance: resolveLaneGuidance(laneGuidanceIndex, {
            wayId: roadProps.osm_id,
            intersectionNodeId: nodeId,
            direction: prev.back ? 'backward' : 'forward',
            roadLaneCount,
            osmMovements,
          }),
        },
        inBrg, outBrg, d,
      })
    }
    dist += next.lengthM
  }
  // 錯位路口/巷弄接駁常拆成兩個相近的轉向（例：微左後右轉）。逼近時 HUD 一直
  // 顯示第一個，到轉向點才換——駕駛看到的方向是錯的。近距離成對合併成「淨轉向」：
  // 淨角度歸直行者整組移除（錯位直行），其餘以角度較大者為錨、依淨角度重新分類。
  for (let i = 0; i + 1 < cands.length; ) {
    const a = cands[i], b = cands[i + 1]
    if (b.m.distM - a.m.distM >= MERGE_GAP_M) { i++; continue }
    const net = angleDelta(a.inBrg, b.outBrg)
    const kind = classifyTurn(net)
    if (!kind) {
      cands.splice(i, 2)
    } else {
      const dom = Math.abs(a.d) >= Math.abs(b.d) ? a : b
      cands.splice(i, 2, {
        m: { ...dom.m, kind, roadName: b.m.roadName },
        inBrg: a.inBrg, outBrg: b.outBrg, d: net,
      })
    }
    if (i > 0) i-- // 合併後可能與前一個又進到門檻內，回頭再檢查
  }
  const out = cands.map((c) => c.m)
  out.push({
    distM: dist, kind: 'arrive',
    lanesForward: edges[edges.length - 1].road.properties.lanesForward,
  })
  return out
}
