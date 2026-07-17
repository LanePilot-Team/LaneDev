// Base Layer 載入與前處理：屬性正規化 + 車道線幾何生成（turf lineOffset）
//
// 車道斷面模型（台灣右駕）：
//   雙向道：way 線 = 分向中心。順向（畫線方向）車道在右側、逆向在左側，
//           各方向最外側可有一條機車道（2.2m，白實線分隔）。
//   單行道：way 線 = 斷面中心，全部車道屬順向。
import { lineOffset } from '@turf/turf'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import { LANE_WIDTH_M } from './geo'

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
  p.width_m =
    LANE_WIDTH_M * (p.lanesForward + p.lanesBackward) +
    MOTO_LANE_M * ((p.motoF ? 1 : 0) + (p.motoB ? 1 : 0)) +
    (p.centerM || 0)
  // 分向線位置 = -W/2 + 逆向側寬 + 中央帶一半（對稱斷面 = 0）
  p.divOffM = p.oneway === 'yes' ? 0 :
    LANE_WIDTH_M * p.lanesBackward + (p.motoB ? MOTO_LANE_M : 0) +
    (p.centerM || 0) / 2 - p.width_m / 2
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

/**
 * 生成車道線：
 *   center：雙向道分向線（黃）
 *   lane  ：同向車道分隔（白虛線）
 *   moto  ：機車道分隔（白實線）
 */
export function buildDividers(roads: RoadFeature[]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  const push = (road: RoadFeature, off: number, kind: string) => {
    try {
      const line = off === 0
        ? { type: 'Feature' as const, geometry: road.geometry, properties: {} }
        : lineOffset(road as Feature<LineString>, off, { units: 'meters' })
      features.push({ type: 'Feature', geometry: line.geometry, properties: { kind } })
    } catch { /* 退化幾何略過 */ }
  }
  for (const road of roads) {
    const p = road.properties
    if (road.geometry.coordinates.length < 2) continue
    const f = p.lanesForward // 可為 0（該向純機車道）
    if (p.oneway === 'yes') {
      // 單行道：斷面置中
      const total = f * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M : 0)
      const left = -total / 2
      for (let k = 1; k < f; k++) push(road, RIGHT * (left + k * LANE_WIDTH_M), 'lane')
      // 0 車道時機車道左界 = 斷面左緣，不需分隔線
      if (p.motoF && f > 0) push(road, RIGHT * (left + f * LANE_WIDTH_M), 'moto')
    } else {
      const b = p.lanesBackward
      const c = (p.centerM || 0) / 2 // 中央帶：兩向車道外移一半
      const dv = p.divOffM || 0 // 非對稱車道時分向線不在 way 線上
      // 中央帶存在時分向線由 turnbays 模組畫（±c 雙黃 + 偏心道/槽化內容）
      if (c === 0) push(road, RIGHT * dv, 'center')
      for (let k = 1; k < f; k++) push(road, RIGHT * (dv + c + k * LANE_WIDTH_M), 'lane')
      if (p.motoF && f > 0) push(road, RIGHT * (dv + c + f * LANE_WIDTH_M), 'moto')
      for (let k = 1; k < b; k++) push(road, RIGHT * (dv - c - k * LANE_WIDTH_M), 'lane')
      if (p.motoB && b > 0) push(road, RIGHT * (dv - c - b * LANE_WIDTH_M), 'moto')
    }
  }
  return { type: 'FeatureCollection', features }
}

function intOr(v: unknown, dflt: number): number {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
