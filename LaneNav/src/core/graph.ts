// 路網圖 + A*。楠梓區 ~2000 ways 規模，前端毫秒級可解，不需要路由後端。
//
// 起終點吸附：不再 snap 到路口節點，而是吸到「任意路段的最近頂點」，
// 以部分邊（partial edge）接進圖中——路線會從你點的位置開始/結束。
import { haversine, bearing, angleDelta, cumulative, offsetMeters, LANE_WIDTH_M, COS_LAT } from './geo'
import { MOTO_LANE_M, type RoadFeature } from './roads'

const SPEED_KMH: Record<string, number> = {
  motorway: 90, trunk: 70, primary: 60, secondary: 50, tertiary: 40,
  unclassified: 40, residential: 30, living_street: 20,
  motorway_link: 50, trunk_link: 40, primary_link: 40, secondary_link: 40, tertiary_link: 40,
}
const MAX_SPEED_MS = 90 / 3.6

export type Profile = 'car' | 'moto'

/** 機車可否行駛（國道禁行 + OSM motorcycle=no） */
function motoAllowed(r: RoadFeature): boolean {
  const p = r.properties
  if (p.highway === 'motorway' || p.highway === 'motorway_link') return false
  if (p.motorcycle === 'no') return false
  return true
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
   * offM = 巡航車道、leftM/rightM = 該路段最左/最右可用車道（路口前變道用）
   */
  spans: { toIdx: number; offM: number; leftM: number; rightM: number }[]
}

/** 路口前開始變道的距離（公尺） */
export const LANE_CHANGE_M = 45

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
  lanesForward: number
  turnLanes?: string[]
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
  if (p.oneway === 'yes') {
    const L0 = p.lanesForward // 可為 0（純機車道路體）
    const L = Math.max(1, L0)
    const total = L0 * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M : 0)
    const base = -total / 2
    const lane = (k: number) => base + (k - 0.5) * LANE_WIDTH_M
    const moto = p.motoF ? base + L0 * LANE_WIDTH_M + MOTO_LANE_M / 2 : lane(L)
    const car = (k: number) => (L0 > 0 ? lane(k) : moto) // 0 車道時所有偏移落在機車道
    if (profile === 'moto') return { cruise: moto, left: car(1), right: moto }
    return { cruise: car(Math.ceil(L / 2)), left: car(1), right: car(L) }
  }
  const f0 = e.back ? p.lanesBackward : p.lanesForward
  const f = Math.max(1, f0)
  const m = e.back ? p.motoB : p.motoF
  // 分向線位置（行進 frame）＋中央帶：車道整體外移
  const dv = e.back ? -(p.divOffM || 0) : (p.divOffM || 0)
  const c = dv + (p.centerM || 0) / 2
  const lane = (k: number) => c + (k - 0.5) * LANE_WIDTH_M
  const moto = m ? c + f0 * LANE_WIDTH_M + MOTO_LANE_M / 2 : lane(f)
  const car = (k: number) => (f0 > 0 ? lane(k) : moto)
  if (profile === 'moto') return { cruise: moto, left: car(1), right: moto }
  return { cruise: car(1), left: car(1), right: car(f) } // 汽車巡航走內側車道
}

/**
 * 路線上某距離處「應該在的車道偏移」：
 * 距下一個轉彎 < LANE_CHANGE_M 時切到轉向側車道（右轉→最右、左轉→最左、
 * 兩段式左轉→維持最右準備進待轉格），其餘巡航。
 */
export function targetOffsetAt(
  route: RouteResult, d: number,
  span: { offM: number; leftM: number; rightM: number },
): number {
  const next = route.maneuvers.find((m) => m.distM > d + 1 && m.kind !== 'arrive')
  if (!next || next.distM - d > LANE_CHANGE_M) return span.offM
  if (next.kind === 'right' || next.kind === 'slight-right') return span.rightM
  if (next.kind === 'left' || next.kind === 'slight-left' || next.kind === 'uturn') {
    // 兩段式→維持最右；有偏心左轉道→切進 bay 中心；否則最左車道
    return next.twoStage ? span.rightM : (next.bayOffM ?? span.leftM)
  }
  return span.offM
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
  private edges: Edge[] = []

  constructor(roads: RoadFeature[]) {
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
    this.edges.push(e)
  }

  /** 路口清單（相鄰節點 ≥3）——待轉區只能放在路口附近 */
  intersections(): { id: number; pos: [number, number] }[] {
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
      if (profile === 'moto' && !motoAllowed(e.road)) continue
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
  scopeEdges(scope: (r: RoadFeature) => boolean): ScopeEdge[] {
    const crossW = (nodeId: number, self: Edge) => {
      let w = 0
      for (const o of this.adj.get(nodeId) ?? []) {
        if (o === self || o === self.twin) continue
        w = Math.max(w, o.road.properties.width_m)
      }
      return w
    }
    return this.edges
      .filter((e) => e.coords.length >= 2 && scope(e.road))
      .map((e) => ({
        coords: e.coords, road: e.road, back: e.back,
        fromNode: e.from, toNode: e.to,
        startSetbackM: crossW(e.from, e) / 2 + 1.2,
        endSetbackM: crossW(e.to, e) / 2 + 1.2,
      }))
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
      .filter((e) => e.coords.length >= 2 && (profile !== 'moto' || motoAllowed(e.road)))
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
      const forwardOk = sA.seg < sB.seg || (sA.seg === sB.seg && sA.t <= sB.t)
      if (forwardOk) {
        const cs = dedupe([sA.pos, ...sA.edge.coords.slice(sA.seg + 1, sB.seg + 1), sB.pos])
        if (cs.length >= 2) return this.assemble([makeEdge(sA.edge.road, -1, -1, cs, sA.edge.back)], profile)
      } else if (sA.edge.twin) {
        const t = sA.edge.twin
        const a = twinSeg(sA.edge, sA.seg), b = twinSeg(sA.edge, sB.seg)
        const cs = dedupe([sA.pos, ...t.coords.slice(a + 1, b + 1), sB.pos])
        if (cs.length >= 2) return this.assemble([makeEdge(t.road, -1, -1, cs, t.back)], profile)
      }
    }

    // 起點入口：從投影點沿邊走到邊尾（兩個方向都試）
    const startEntries: { node: number; part: Edge }[] = []
    const addStart = (e: Edge, seg: number) => {
      if (profile === 'moto' && !motoAllowed(e.road)) return
      const cs = coordsFromSnap(e, seg, sA.pos)
      if (cs.length >= 2) startEntries.push({ node: e.to, part: makeEdge(e.road, -1, e.to, cs, e.back) })
      else startEntries.push({ node: e.to, part: makeEdge(e.road, -1, e.to, [sA.pos, e.coords[e.coords.length - 1]], e.back) })
    }
    addStart(sA.edge, sA.seg)
    if (sA.edge.twin) addStart(sA.edge.twin, twinSeg(sA.edge, sA.seg))

    // 終點出口：從邊頭走到投影點
    const goalEntries: { node: number; part: Edge }[] = []
    const addGoal = (e: Edge, seg: number) => {
      if (profile === 'moto' && !motoAllowed(e.road)) return
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
        if (profile === 'moto' && !motoAllowed(e.road)) continue
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
      spans.push({ toIdx: coords.length - 1, offM: lo.cruise, leftM: lo.left, rightM: lo.right })
    }
    const cum = cumulative(coords)
    return {
      coords, cum,
      lengthM: cum[cum.length - 1],
      timeS: edges.reduce((s, e) => s + e.timeS, 0),
      maneuvers: buildManeuvers(edges),
      spans,
    }
  }
}

/**
 * 車道級路線帶：把路線座標依 spans 偏移到「實際行駛的車道」上。
 * 路線帶畫在車道內、車騎在路線帶上——不偏移的話絲帶壓在道路中心線，
 * 車在旁邊跑，看起來像沒開在路線／車道上。
 */
export function laneOffsetCoords(route: RouteResult): [number, number][] {
  const cs = route.coords
  const out: [number, number][] = []
  let si = 0
  for (let i = 0; i < cs.length; i++) {
    while (si < route.spans.length - 1 && route.spans[si].toIdx < i) si++
    const span = route.spans[si]
    let off = span?.offM ?? 0
    if (span) {
      // 路口前漸進切到轉向車道（與模擬車同一套規則，絲帶先畫出變道軌跡）
      // 找「含轉角頂點本身」的下一個轉彎（排除會在轉角處回跳巡航道的尖刺）
      const d = route.cum[i]
      const next = route.maneuvers.find((m) => m.distM >= d - 1 && m.kind !== 'arrive')
      if (next) {
        const gap = next.distM - d
        if (gap < LANE_CHANGE_M) {
          let target = span.offM
          if (next.kind === 'right' || next.kind === 'slight-right') target = span.rightM
          else if (next.kind === 'left' || next.kind === 'slight-left' || next.kind === 'uturn') {
            target = next.twoStage ? span.rightM : (next.bayOffM ?? span.leftM)
          }
          const t = Math.min(1, Math.max(0, (LANE_CHANGE_M - gap) / (LANE_CHANGE_M * 0.6)))
          off = span.offM + (target - span.offM) * t
        }
      }
    }
    const a = cs[Math.max(0, i - 1)]
    const b = cs[Math.min(cs.length - 1, i + 1)]
    const rad = ((bearing(a, b) + 90) * Math.PI) / 180
    out.push(offsetMeters(cs[i], off * Math.sin(rad), off * Math.cos(rad)))
  }
  return out
}

/** 多段路線合併（起點→停靠點…→終點）：中途的 arrive 併掉，只留最後一個 */
export function mergeRoutes(legs: RouteResult[]): RouteResult {
  const coords = [...legs[0].coords]
  const spans = [...legs[0].spans]
  const maneuvers = [...legs[0].maneuvers.slice(0, -1)]
  let distOff = legs[0].lengthM
  let timeS = legs[0].timeS
  for (let i = 1; i < legs.length; i++) {
    const L = legs[i]
    if (haversine(coords[coords.length - 1], L.coords[0]) > 0.5) coords.push(L.coords[0])
    const base = coords.length - 1
    coords.push(...L.coords.slice(1))
    for (const s of L.spans) spans.push({ ...s, toIdx: base + s.toIdx })
    for (const m of L.maneuvers.slice(0, -1)) maneuvers.push({ ...m, distM: m.distM + distOff })
    distOff += L.lengthM
    timeS += L.timeS
  }
  const last = legs[legs.length - 1]
  const arrive = last.maneuvers[last.maneuvers.length - 1]
  maneuvers.push({ ...arrive, distM: distOff - last.lengthM + arrive.distM })
  const cum = cumulative(coords)
  return { coords, cum, lengthM: cum[cum.length - 1], timeS, maneuvers, spans }
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

function buildManeuvers(edges: Edge[]): Maneuver[] {
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
      cands.push({
        m: {
          distM: dist,
          kind,
          roadName: next.name,
          nodeId: next.from >= 0 ? next.from : prev.to >= 0 ? prev.to : undefined,
          pos: next.coords[0],
          fromBearing: inBrg,
          // HUD 車道格：取「進入行向」的車道數與轉向（逆向邊用 backward 組）
          lanesForward: prev.back
            ? prev.road.properties.lanesBackward
            : prev.road.properties.lanesForward,
          turnLanes: prev.back
            ? prev.road.properties.turnLanesB
            : prev.road.properties.turnLanes,
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
