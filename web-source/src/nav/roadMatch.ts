// 偏離路線時的定位貼合（偏移改善）。預設 abd = A＋B＋D 合併；各方案仍可用 VITE_DEVIATION_MODE 單獨對照：
//
//   a — RoadMatcher：偏離路線帶後改貼「整張路網」。對附近有向車道做輕量 HMM（Viterbi），
//       同時看距離、車頭方向、與上一筆路段是否連通，車永遠畫在最可能的那條路的車道上，
//       不再直接畫原始 GPS 座標（原本會畫到人行道、建物、分隔島上）。
//   b — BranchWatch：接近下一個轉彎路口時同時追蹤「照路線走」與其他分岔，過路口後
//       1～2 筆定位就判定有沒有轉，沒轉就馬上改畫在實際那條分岔上並觸發重規劃，
//       不必等「連續 3 筆離線 50m」（原本約 5 秒、期間車卡在路口角落）。
//
// 計算量：兩者都是每筆定位（約 1 次/秒）才算一次，只看附近 40m 內的路段（格網索引），
// 不是每幀算。實測耗時寫進 [gps] console 紀錄。
import { angleDelta, cumulative, haversine, COS_LAT } from '../core/geo.ts'
import { gpsLog } from './gpsDebug.ts'
import type { LaneCandidate, Profile, RoadGraph, RouteResult, Maneuver } from '../core/graph.ts'

export type DeviationMode = 'orig' | 'a' | 'b' | 'abd'

/**
 * 預設 abd（合併版）。VITE_DEVIATION_MODE=orig／a／b 只供對照實驗
 * （例：`VITE_DEVIATION_MODE=orig npx vite --port 5191` 開原本行為對照）。
 */
export function deviationMode(): DeviationMode {
  const v = String(import.meta.env?.VITE_DEVIATION_MODE ?? '').toLowerCase()
  return v === 'orig' || v === 'a' || v === 'b' ? v : 'abd'
}

/** 各方案是否啟用：abd = A 貼路網 + B 路口分岔 + D 平順切換 */
export function deviationFeatures(mode = deviationMode()) {
  return {
    road: mode === 'a' || mode === 'abd',
    branch: mode === 'b' || mode === 'abd',
    smooth: mode === 'abd',
  }
}

// ── A：路網 HMM ─────────────────────────────────────────────

/** 候選搜尋半徑（公尺） */
const CAND_RADIUS_M = 40
/** 保留的狀態數（Viterbi 剪枝） */
const KEEP_STATES = 10

interface State { c: LaneCandidate; cost: number }

export class RoadMatcher {
  private states: State[] = []
  /** 剛判定走哪條分岔時，第一步偏向這些邊（B 的結論交給 A 接手） */
  private prefer: Set<number> | null = null

  reset() { this.states = []; this.prefer = null }

  preferKeys(keys: number[]) { this.prefer = new Set(keys) }

  /**
   * 走一步：here = 原始定位、heading = 行進方位（不知道給 null）、movedM = 與上一筆的位移。
   * 回傳最可能的車道候選；附近沒有路則回 null（呼叫端退回原始座標）。
   */
  step(
    graph: RoadGraph, profile: Profile, here: [number, number],
    accuracyM: number | null, heading: number | null, movedM: number,
  ): LaneCandidate | null {
    const cands = graph.nearbyLanes(here, profile, CAND_RADIUS_M)
    if (!cands.length) { this.states = []; return null }
    const sigma = Math.max(5, Math.min(20, accuracyM ?? 10))
    const next: State[] = []
    for (const c of cands) {
      // 觀測成本：離車道中心多遠（以精度為尺度）
      let emit = (c.distM / sigma) ** 2 / 2
      // 方向成本：逆向（>120°）幾乎不可能——這是分得出對向車道的關鍵
      if (heading !== null) {
        const d = Math.abs(angleDelta(c.bearing, heading))
        emit += d > 120 ? 12 : (d / 45) ** 2
      }
      if (this.prefer && !this.states.length && !this.prefer.has(c.key)) emit += 3
      let trans = 0
      if (this.states.length) {
        trans = Infinity
        for (const s of this.states) trans = Math.min(trans, s.cost + transitionCost(graph, s.c, c, movedM))
      }
      next.push({ c, cost: trans + emit })
    }
    next.sort((a, b) => a.cost - b.cost)
    const base = next[0].cost
    this.states = next.slice(0, KEEP_STATES).map((s) => ({ c: s.c, cost: s.cost - base }))
    return this.states[0].c
  }
}

/** 轉移成本：同一條邊照里程前進最便宜；接到後繼邊次之；不連通（跳到別條路）最貴 */
function transitionCost(graph: RoadGraph, p: LaneCandidate, c: LaneCandidate, movedM: number): number {
  if (p.key === c.key) {
    const adv = c.alongM - p.alongM
    return Math.abs(adv - movedM) / 10 + (adv < -5 ? 2 : 0)
  }
  const succ = graph.successorKeys(p.key)
  if (succ.includes(c.key)) {
    const adv = (p.lengthM - p.alongM) + c.alongM
    return 0.3 + Math.abs(adv - movedM) / 10
  }
  // 路口很短的連接邊：容許隔一條
  for (const k of succ) if (graph.successorKeys(k).includes(c.key)) return 1 + Math.abs(movedM - 10) / 20
  if (c.key === p.twinKey) return 8 // 原地迴轉
  return 6
}

// ── B：路口分岔判定 ────────────────────────────────────────────

/** 進入路口前多少公尺開始監看 */
const ARM_BEFORE_M = 30
/** 離路口節點至少這麼遠才開始判斷（太近時各分岔都差不多近） */
const DECIDE_MIN_FROM_NODE_M = 10
/** 判斷要的分岔長度（公尺） */
const BRANCH_LEN_M = 80
/** 其他分岔要比路線分岔近這麼多（公尺，含方向懲罰）才算 */
const MARGIN_M = 5
/** 連續幾筆同結論才定案 */
const VOTES = 2
/** 超過這個距離還沒定案就放棄監看（交給原本的偏離判定） */
const GIVE_UP_M = 70

interface Branch { kind: 'route' | 'other' | 'approach'; key: number; coords: [number, number][]; name?: string }

export type BranchVerdict =
  | { kind: 'none' }
  /** 判定沒照路線走：key = 實際所在的分岔邊，bearing = 該分岔方位 */
  | { kind: 'deviated'; key: number; bearing: number; name?: string }

export class BranchWatch {
  private man: Maneuver | null = null
  private branches: Branch[] = []
  private nodePos: [number, number] | null = null
  private votes = { other: 0, route: 0, otherKey: -1 }
  /** 已過路口、目前領先的是非路線分岔但票數還不夠：畫面不該再貼著路線帶卡在路口 */
  pending = false

  reset() { this.man = null; this.branches = []; this.votes = { other: 0, route: 0, otherKey: -1 } }

  /**
   * 每筆在線上的定位呼叫：traveledM = 目前路線里程估計、next = 下一個動作。
   * 回傳 deviated 時呼叫端應立刻改畫在該分岔上並重規劃。
   */
  step(
    graph: RoadGraph, profile: Profile, route: RouteResult,
    traveledM: number, next: Maneuver | null, here: [number, number], heading: number | null,
  ): BranchVerdict {
    this.pending = false
    // 接近一個有 nodeId 的轉彎 → 裝上監看
    if (!this.man && next && next.kind !== 'arrive' && next.nodeId !== undefined && next.pos
      && next.distM - traveledM < ARM_BEFORE_M) {
      this.arm(graph, profile, route, next)
    }
    if (!this.man || !this.nodePos) return { kind: 'none' }
    const fromNode = haversine(here, this.nodePos)
    if (fromNode < DECIDE_MIN_FROM_NODE_M) return { kind: 'none' }
    // 每條分岔的分數 = 到分岔線的距離 + 方向懲罰（每 10° 算 1m）
    let best: Branch | null = null, bestScore = Infinity, routeScore = Infinity
    for (const b of this.branches) {
      const { distM, bearing } = nearestOnLine(b.coords, here)
      // approach 的線是從節點往回指，行進方向要反過來比
      const along = b.kind === 'approach' ? (bearing + 180) % 360 : bearing
      const score = distM + (heading === null ? 0 : Math.abs(angleDelta(along, heading)) / 10)
      if (b.kind === 'route') routeScore = Math.min(routeScore, score)
      if (score < bestScore) { bestScore = score; best = b }
    }
    if (!best || best.kind === 'approach') {
      // 還在路口前（或 GPS 落後）：不判
      if (fromNode > GIVE_UP_M) this.reset()
      return { kind: 'none' }
    }
    if (best.kind === 'route' || routeScore - bestScore < MARGIN_M) {
      this.votes.other = 0
      if (++this.votes.route >= VOTES) this.reset() // 有照路線轉，這個路口結案
      return { kind: 'none' }
    }
    this.votes.route = 0
    // 「沒照路線走」的票不分是哪條分岔都算（GPS 誤差下相鄰分岔常互換第一），定案時取最新的那條
    this.votes.other += 1
    this.votes.otherKey = best.key
    if (this.votes.other < VOTES) { this.pending = true; return { kind: 'none' } }
    const verdict: BranchVerdict = {
      kind: 'deviated', key: best.key, name: best.name,
      bearing: nearestOnLine(best.coords, here).bearing,
    }
    this.reset()
    return verdict
  }

  private arm(graph: RoadGraph, profile: Profile, route: RouteResult, man: Maneuver) {
    this.man = man
    this.nodePos = man.pos!
    const routeOut = sliceByDist(route.coords, route.cum, man.distM, man.distM + BRANCH_LEN_M)
    const approach = sliceByDist(route.coords, route.cum, man.distM - BRANCH_LEN_M, man.distM).reverse()
    const outBrg = bearingAlong(routeOut)
    const backBrg = bearingAlong(approach)
    this.branches = [
      { kind: 'route', key: -1, coords: routeOut },
      { kind: 'approach', key: -1, coords: approach },
    ]
    for (const b of graph.branchesAt(man.nodeId!, profile)) {
      if (Math.abs(angleDelta(b.bearing, outBrg)) < 25) continue // 就是路線那條
      if (Math.abs(angleDelta(b.bearing, backBrg)) < 25) continue // 折返來時路
      this.branches.push({ kind: 'other', key: b.key, coords: extend(graph, profile, b.key, b.coords), name: b.name })
    }
    gpsLog('[b] 監看路口', `node ${man.nodeId} ${man.kind}  分岔：${this.branches.filter((b) => b.kind === 'other')
      .map((b) => b.name ?? '無名').join('、') || '（無其他分岔）'}`)
  }
}

/** 分岔邊太短（路口內的小段）就接上直行方向的後繼邊，湊到判斷長度 */
function extend(graph: RoadGraph, profile: Profile, key: number, coords: [number, number][]): [number, number][] {
  const len = cumulative(coords)
  if (len[len.length - 1] >= BRANCH_LEN_M / 2) return coords
  const brg = bearingAlong(coords)
  let best: { coords: [number, number][]; d: number } | null = null
  for (const k of graph.successorKeys(key)) {
    const e = graph.branchesAt(graph.edgeTo(key), profile).find((b) => b.key === k)
    if (!e) continue
    const d = Math.abs(angleDelta(e.bearing, brg))
    if (!best || d < best.d) best = { coords: e.coords, d }
  }
  return best && best.d < 30 ? [...coords, ...best.coords.slice(1)] : coords
}

function sliceByDist(coords: [number, number][], cum: number[], from: number, to: number): [number, number][] {
  const total = cum[cum.length - 1]
  const a = Math.max(0, from), b = Math.min(total, to)
  const at = (d: number): [number, number] => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < d) i++
    const seg = cum[i] - cum[i - 1]
    const t = seg > 0 ? (d - cum[i - 1]) / seg : 0
    return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t]
  }
  const out: [number, number][] = [at(a)]
  for (let i = 0; i < coords.length; i++) if (cum[i] > a && cum[i] < b) out.push(coords[i])
  out.push(at(b))
  return out
}

/** 線的起始方位（取前 15m，避開路口內的小折角） */
function bearingAlong(coords: [number, number][]): number {
  const cum = cumulative(coords)
  const d = Math.min(15, cum[cum.length - 1])
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  return bearingOf(coords[0], coords[i])
}

function bearingOf(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * COS_LAT, dy = b[1] - a[1]
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360
}

function nearestOnLine(coords: [number, number][], p: [number, number]): { distM: number; bearing: number } {
  const kx = 111320 * COS_LAT, ky = 110540
  let best = { distM: Infinity, bearing: 0 }
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1]
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky
    const px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
    const d = Math.hypot(px - t * dx, py - t * dy)
    if (d < best.distM) best = { distM: d, bearing: bearingOf(a, b) }
  }
  return best
}
