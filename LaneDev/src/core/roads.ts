// Base Layer 載入與前處理：屬性正規化 + 車道線幾何生成（turf lineOffset）
//
// 車道斷面模型（台灣右駕）：
//   雙向道：way 線 = 分向中心。順向（畫線方向）車道在右側、逆向在左側，
//           各方向最外側可有一條機車道（2.2m，白實線分隔）。
//   單行道：way 線 = 斷面中心，全部車道屬順向。
import { lineOffset } from '@turf/turf'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import {
  angleDelta, bearing, cumulative, haversine, pointAlong, skewFromCross, LANE_WIDTH_M,
} from './geo'

export const MOTO_LANE_M = 2.2

export interface RoadProps {
  osm_id: number
  name?: string
  highway: string
  lanes: number // 汽車車道總數（f+b）
  lanesForward: number
  lanesBackward: number
  motoF: boolean // 順向機車道
  motoB: boolean // 逆向機車道
  /** 中央帶寬（公尺，預設 0）：偏心左轉道/槽化線/分隔島共用的中央空間，
   * 兩向車道各外移一半（way 線 = 中央帶中心）。couplet 合併或 journal 設定 */
  centerM: number
  /** 中央帶內容：hatch = 槽化線（可切偏心道）｜island = 實體分隔島（journal center_kind） */
  centerKind: 'hatch' | 'island'
  /** couplet 合併產生的路段——中央帶編輯只對這類路段開放 */
  coupletMerged?: boolean
  /** 路寬微調（公尺，journal extra_width_m）：實際鋪面寬 ≠ lanes×3.2 時的補正，
   * 對稱加減在斷面兩側（路肩語意），車道線/車道位置不動，只影響路面渲染寬 */
  extraM: number
  /** 分向偏移（公尺，右正）：way 線 = 斷面幾何中心時，分向線相對 way 線的位置。
   * 非對稱車道（3+2 等）≠ 0，由 computeDerived 推導；渲染與車道偏移都要加上 */
  divOffM: number
  width_m: number // 斷面總寬（渲染用，由 computeDerived 計算）
  oneway: 'yes' | 'no'
  maxspeed?: string
  motorcycle?: string // OSM motorcycle=*（no = 禁行機車）
  motorcar?: string // OSM motorcar=*（no = 禁行汽車，機車專用道路體）
  /** OSM junction=*（roundabout = 圓環弧段，不進 couplet 合併） */
  junction?: string
  /** 地面規則印字（依選取順序印在路面，代碼見 roadtext.ts GROUND_RULES）。
   * undefined = 無人工設定（motorcycle=no 時 fallback 印禁行機車）；[] = 明確無 */
  rulesF?: string[]
  rulesB?: string[]
  turnLanes?: string[] // 順向每車道轉向（左→右）
  turnLanesB?: string[] // 逆向每車道轉向（逆向駕駛視角左→右）
  /** 區塊識別：way 依路口切塊後，區塊第一個 node id（journal 區塊鍵 way/W@b/N 用）。
   * 未切塊（無中間路口）時 = nodes[0]。 */
  blockNode: number
  /** oneway=-1 反向單行道：載入時已反轉幾何。外部資料（LanePilot 標註）的
   * forward/backward 是 OSM 原始方向，比對時要翻轉 */
  reversed?: boolean
  nodes: number[]
}

export type RoadFeature = Feature<LineString> & { properties: RoadProps }

const DEFAULT_LANES: Record<string, number> = {
  motorway: 4, trunk: 4, primary: 4, secondary: 3, tertiary: 2,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
}

/** 由 f/b/moto 重算總車道數與斷面寬（編輯後也要呼叫） */
export function computeDerived(p: RoadProps) {
  p.lanes = p.lanesForward + p.lanesBackward
  const laneSpan =
    LANE_WIDTH_M * (p.lanesForward + p.lanesBackward) +
    MOTO_LANE_M * ((p.motoF ? 1 : 0) + (p.motoB ? 1 : 0)) +
    (p.centerM || 0)
  // 路寬微調對稱加減在兩側，車道塊維持置中（下限 2m，避免負微調把路面壓沒）
  p.width_m = Math.max(2, laneSpan + (p.extraM || 0))
  // 分向線位置 = -車道塊寬/2 + 逆向側寬 + 中央帶一半（對稱斷面 = 0；不含路寬微調）
  p.divOffM = p.oneway === 'yes' ? 0 :
    LANE_WIDTH_M * p.lanesBackward + (p.motoB ? MOTO_LANE_M : 0) +
    (p.centerM || 0) / 2 - laneSpan / 2
}

/** 該行向的車道塊寬（車道×3.2 + 機車道；不含路寬微調）——地面標線橫向定位用 */
export function laneSpanM(p: RoadProps, back: boolean): number {
  const lanes = p.oneway === 'yes' ? p.lanesForward : back ? p.lanesBackward : p.lanesForward
  const moto = p.oneway === 'yes' ? p.motoF : back ? p.motoB : p.motoF
  return lanes * LANE_WIDTH_M + (moto ? MOTO_LANE_M : 0)
}

export async function loadRoads(url: string): Promise<RoadFeature[]> {
  const raw: FeatureCollection<LineString> = await fetch(url).then((r) => r.json())
  return roadsFromGeoJSON(raw)
}

/** geojson → RoadFeature 正規化（Overpass 快照與匯入的 LanePilot shard 共用） */
export function roadsFromGeoJSON(raw: FeatureCollection<LineString>): RoadFeature[] {
  const out: RoadFeature[] = []
  for (const f of raw.features) {
    const p = f.properties as Record<string, unknown>
    const highway = String(p.highway ?? 'residential')
    let coords = f.geometry.coordinates as [number, number][]
    let nodes: number[] = (p.nodes as number[]) ?? []
    let onewayTag = String(p.oneway ?? 'no')

    let reversed = false
    if (onewayTag === '-1') {
      // 反向單行道：直接反轉幾何，之後一律視為正向（reversed 旗標供外部方向比對）
      coords = [...coords].reverse()
      nodes = [...nodes].reverse()
      onewayTag = 'yes'
      reversed = true
    }
    const oneway = onewayTag === 'yes' || onewayTag === '1' ? 'yes' : 'no'

    const lanes = intOr(p.lanes, DEFAULT_LANES[highway] ?? 2)
    const lanesForward = intOr(
      p.lanes_forward,
      oneway === 'yes' ? lanes : Math.ceil(lanes / 2),
    )
    const lanesBackward = oneway === 'yes'
      ? 0
      : intOr(p.lanes_backward, Math.max(1, lanes - lanesForward))
    const turnRaw = (oneway === 'yes' ? p.turn_lanes : p.turn_lanes_forward) ?? p.turn_lanes
    const turnLanes = typeof turnRaw === 'string' ? turnRaw.split('|') : undefined
    const turnBRaw = oneway === 'no' ? p.turn_lanes_backward : undefined
    const turnLanesB = typeof turnBRaw === 'string' ? turnBRaw.split('|') : undefined

    const props: RoadProps = {
      osm_id: Number(p.osm_id),
      name: p.name ? String(p.name) : undefined,
      highway,
      lanes,
      lanesForward,
      lanesBackward,
      motoF: false, // OSM 幾乎不標機車道，靠 Enhancement 補
      motoB: false,
      centerM: 0,
      centerKind: 'hatch',
      extraM: 0,
      divOffM: 0,
      width_m: 0,
      oneway,
      maxspeed: p.maxspeed ? String(p.maxspeed) : undefined,
      motorcycle: p.motorcycle ? String(p.motorcycle) : undefined,
      motorcar: p.motorcar ? String(p.motorcar) : undefined,
      junction: p.junction ? String(p.junction) : undefined,
      turnLanes,
      turnLanesB,
      blockNode: nodes[0] ?? 0,
      reversed,
      nodes,
    }
    computeDerived(props)
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: props,
    })
  }
  return out
}

/**
 * 把 way 依「路口節點」切成區塊：車道/中央帶/轉向編輯的最小單位 = 路口到路口。
 * 切點規則與 graph.ts 建邊一致（node 被引用 ≥2 次），所以區塊 = 路網邊。
 * 每個區塊繼承原 way 的 osm_id（bay key、way 級 journal 覆寫不變），
 * 以 blockNode（區塊第一個 node）區分，區塊級 journal 鍵 = way/W@b/N。
 * 對已切塊的輸入是冪等的。須在 couplet 合併/分段預設之後、journal 套用之前呼叫。
 */
export function splitAtIntersections(roads: RoadFeature[]): RoadFeature[] {
  const usage = new Map<number, number>()
  for (const r of roads) {
    if (r.properties.nodes.length !== r.geometry.coordinates.length) continue
    for (const id of r.properties.nodes) usage.set(id, (usage.get(id) ?? 0) + 1)
  }
  const out: RoadFeature[] = []
  for (const r of roads) {
    const nodes = r.properties.nodes
    const coords = r.geometry.coordinates as [number, number][]
    const cuts: number[] = []
    if (nodes.length === coords.length) {
      for (let i = 1; i < nodes.length - 1; i++) {
        if ((usage.get(nodes[i]) ?? 0) > 1) cuts.push(i)
      }
    }
    if (cuts.length === 0) {
      r.properties.blockNode = nodes[0] ?? 0
      out.push(r)
      continue
    }
    let start = 0
    for (const cut of [...cuts, nodes.length - 1]) {
      if (cut <= start) continue
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.slice(start, cut + 1) },
        properties: {
          ...r.properties,
          nodes: nodes.slice(start, cut + 1),
          blockNode: nodes[start],
        },
      })
      start = cut
    }
  }
  return out
}

// turf lineOffset 正值 = 線行進方向的「右側」（實測：東向線 +100m 偏到南邊）。
// 台灣右駕，順向車道在右側 → 正號。
const RIGHT = 1

/** 折線依里程裁切 [from, to]（分隔線終止端收邊用）；剩不到 2m 回傳 null */
function sliceByDist(
  coords: [number, number][], cum: number[], from: number, to: number,
): [number, number][] | null {
  if (to - from < 2) return null
  const pts: [number, number][] = [pointAlong(coords, cum, from).pos]
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] > from && cum[i] < to && haversine(pts[pts.length - 1], coords[i]) > 0.05) {
      pts.push(coords[i])
    }
  }
  const end = pointAlong(coords, cum, to).pos
  if (haversine(pts[pts.length - 1], end) > 0.05) pts.push(end)
  return pts.length >= 2 ? pts : null
}

/**
 * 生成車道線：
 *   center：雙向道分向線（黃）
 *   lane  ：同向車道分隔（白虛線）
 *   moto  ：機車道分隔（白實線）
 * 路口收邊：區塊端節點上有「別條路」（不同 way 且不同路名）交會時，分隔線
 * 收回交叉路最大半寬 + 1.2m——路口框內不殘留黃分向線/白車道線（2026-07-18
 * 使用者要求「路口中間全清」，含主線通過的十字/丁字路口）。同路純續接節點
 *（way 換 id 處、度數 2）不收，標線連續。
 */
export function buildDividers(roads: RoadFeature[]): FeatureCollection<LineString> {
  // 節點 → 佔用道路（切塊後交叉路在路口節點必有端點/中間點落在這裡）
  const nodeUse = new Map<number, RoadFeature[]>()
  for (const r of roads) {
    for (const n of r.properties.nodes) {
      if (!nodeUse.has(n)) nodeUse.set(n, [])
      nodeUse.get(n)!.push(r)
    }
  }
  /** 端節點收邊資訊：trim = 收邊量（停止線位置基準：節點上「任何別的區塊」
   * 最大寬/2 + 1.2，與 graph.scopeEdges 的 setback 一致——分隔線才不會戳過
   * 停止線）；sk = 交叉路斜交係數（橫向偏移 o 的裁切點沿路軸平移 o×sk，
   * 收邊線平行交叉路＝停止線的延長線）。trim=0 = 不收（節點上沒有不同路名
   * 的交叉路：純續接或死路）。 */
  const endInfo = (n: number, self: RoadFeature, fwdBrg: number): { trim: number; sk: number } => {
    let anyCross = false
    let w = 0
    let crossBrg: number | null = null
    let bestPerp = 25 // 交叉路需與自身線夾角 >25°，順向岔路不定義斜線
    for (const f of nodeUse.get(n) ?? []) {
      if (f === self) continue
      const q = f.properties
      w = Math.max(w, q.width_m)
      if (q.osm_id === self.properties.osm_id ||
        (self.properties.name && q.name === self.properties.name)) continue // 同路續行不算交叉
      anyCross = true
      const idx = q.nodes.indexOf(n)
      const cs2 = f.geometry.coordinates as [number, number][]
      if (idx >= 0 && q.nodes.length === cs2.length && cs2.length >= 2) {
        const brg = idx < cs2.length - 1
          ? bearing(cs2[idx], cs2[idx + 1])
          : bearing(cs2[idx - 1], cs2[idx])
        let d = Math.abs(angleDelta(fwdBrg, brg))
        if (d > 90) d = 180 - d
        if (d > bestPerp) { bestPerp = d; crossBrg = brg }
      }
    }
    if (!anyCross) return { trim: 0, sk: 0 }
    return { trim: w / 2 + 1.2, sk: crossBrg === null ? 0 : skewFromCross(fwdBrg, crossBrg) }
  }

  const ZERO = { trim: 0, sk: 0 }
  const features: Feature<LineString>[] = []
  let cs0: [number, number][] = []
  let cum: number[] | null = null
  let L = 0
  let info0 = ZERO
  let info1 = ZERO
  let curId = 0
  /** 依「該端停止線的延長線」裁切後偏移：裁切點 = 收邊基準 + 橫向偏移×skew ∓ 0.5m */
  const push = (off: number, kind: string) => {
    let cs = cs0
    if (cum) {
      const from = info0.trim > 0 ? info0.trim + info0.sk * off + 0.5 : 0
      const to = info1.trim > 0 ? L - info1.trim + info1.sk * off - 0.5 : L
      const sliced = sliceByDist(cs0, cum, Math.max(0, from), Math.min(L, to))
      if (!sliced) return // 這條分隔線全在路口框內
      cs = sliced
    }
    try {
      const feat: Feature<LineString> = {
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: cs },
      }
      const line = off === 0 ? feat : lineOffset(feat, off, { units: 'meters' })
      features.push({
        type: 'Feature', geometry: line.geometry,
        properties: { kind, osm_id: curId }, // osm_id 供除錯/離線稽核，樣式不使用
      })
    } catch { /* 退化幾何略過 */ }
  }
  for (const road of roads) {
    const p = road.properties
    curId = p.osm_id
    if (road.geometry.coordinates.length < 2) continue
    cs0 = road.geometry.coordinates as [number, number][]
    const ns = p.nodes
    cum = null
    info0 = ZERO
    info1 = ZERO
    if (ns.length === cs0.length && ns.length >= 2) {
      info0 = endInfo(ns[0], road, bearing(cs0[0], cs0[1]))
      info1 = endInfo(ns[ns.length - 1], road, bearing(cs0[cs0.length - 2], cs0[cs0.length - 1]))
      if (info0.trim > 0 || info1.trim > 0) {
        cum = cumulative(cs0)
        L = cum[cum.length - 1]
      }
    }
    const f = p.lanesForward // 可為 0（該向純機車道）
    if (p.oneway === 'yes') {
      // 單行道：斷面置中
      const total = f * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M : 0)
      const left = -total / 2
      for (let k = 1; k < f; k++) push(RIGHT * (left + k * LANE_WIDTH_M), 'lane')
      // 0 車道時機車道左界 = 斷面左緣，不需分隔線
      if (p.motoF && f > 0) push(RIGHT * (left + f * LANE_WIDTH_M), 'moto')
    } else {
      const b = p.lanesBackward
      const c = (p.centerM || 0) / 2 // 中央帶：兩向車道外移一半
      const dv = p.divOffM || 0 // 非對稱車道時分向線不在 way 線上
      // 中央帶存在時分向線由 turnbays 模組畫（±c 雙黃 + 偏心道/槽化內容）
      if (c === 0) push(RIGHT * dv, 'center')
      for (let k = 1; k < f; k++) push(RIGHT * (dv + c + k * LANE_WIDTH_M), 'lane')
      if (p.motoF && f > 0) push(RIGHT * (dv + c + f * LANE_WIDTH_M), 'moto')
      for (let k = 1; k < b; k++) push(RIGHT * (dv - c - k * LANE_WIDTH_M), 'lane')
      if (p.motoB && b > 0) push(RIGHT * (dv - c - b * LANE_WIDTH_M), 'moto')
    }
  }
  return { type: 'FeatureCollection', features }
}

function intOr(v: unknown, dflt: number): number {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
