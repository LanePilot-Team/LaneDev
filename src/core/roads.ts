// Base Layer 載入與前處理：屬性正規化 + 車道線幾何生成（turf lineOffset）
//
// 車道斷面模型（台灣右駕）：
//   雙向道：way 線 = 分向中心。順向（畫線方向）車道在右側、逆向在左側，
//           各方向最外側可有一條機車道（2.2m，白實線分隔）。
//   單行道：way 線 = 斷面中心，全部車道屬順向。
import { buffer, lineOffset } from '@turf/turf'
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson'
import {
  angleDelta, bearing, cumulative, haversine, offsetMeters, pointAlong, skewFromCross, LANE_WIDTH_M,
} from './geo.ts'

export const MOTO_LANE_M = 2.2

export interface LaneMark {
  text: string
  color: string
}

export interface RoadSourceSegment {
  osmId: number
  navSegmentKey: string
  splitIndex: number
  nodeRefs: number[]
  /** 原始 segment 幾何，供被 couplet 吸收後依舊能以舊 node 精確定位。 */
  coordinates?: [number, number][]
}

/**
 * 少數 OSM 分岔段的中心軸會在實際分流前先與主路重疊。道路面仍需保持連通，
 * 但車道線、箭頭、停止線與路面文字必須等支路完全離開主路後才開始。
 */
export function manualMarkingSetbackM(
  road: RoadFeature, nodeId: number,
): number {
  const p = road.properties
  const hasSourceWay = (osmId: number) => p.osm_id === osmId
    || p.sourceSegments.some((segment) => segment.osmId === osmId)
  if (hasSourceWay(30074958) && p.blockNode === -3582192277538
    && nodeId === p.nodes[0]) return 45
  if (hasSourceWay(256795162) && p.blockNode === 2624297542
    && nodeId === p.nodes[0]) return 28
  return 0
}

export interface RoadProps {
  osm_id: number
  name?: string
  highway: string
  lanes: number // 汽車車道總數（f+b）
  lanesForward: number
  lanesBackward: number
  motoF: boolean // 順向機車道
  motoB: boolean // 逆向機車道
  /** 各方向機車道數；motoF/B 保留作既有布林判斷並永遠與 count>0 同步。 */
  motoCountF: number
  motoCountB: number
  /** 快慢分隔帶寬（公尺，預設 0）：汽車車道與機車道之間的實體島空間，
   * 該向有機車道才有意義（journal moto_sep_f/b；主慢分離 couplet 合併預設 1.0）。
   * >0 時該向不畫機車道白線，改由 medians.buildMotoSepIslands 鋪島 */
  motoSepF: number
  motoSepB: number
  /** 機車道入口圖示（預設關閉，需人工明確開啟）。 */
  motoEntryIconF: boolean
  motoEntryIconB: boolean
  motoTextDiamondF: boolean
  motoTextDiamondB: boolean
  stopLineF: boolean
  stopLineB: boolean
  arrowDisplayF: boolean
  arrowDisplayB: boolean
  startArrowDisplayF: boolean
  startArrowDisplayB: boolean
  /** 汽車左轉待轉區：停止線向路口內延伸的虛線框，預設關閉。 */
  leftWaitAreaF: boolean
  leftWaitAreaB: boolean
  /** 路段開頭箭頭，與路口出口箭頭分開設定（駕駛視角左→右）。 */
  startTurnLanes?: string[]
  startTurnLanesB?: string[]
  /** 捏合後仍保留的側街入口；主路 forward 可轉入，backward 不可跨線左轉。 */
  oneSideEntryNodes?: number[]
  /** 捏合接縫實際相鄰的主路方向；舊紀錄缺少時以 allowedBack=false 相容。 */
  oneSideEntryAccess?: { nodeId: number; allowedBack: boolean }[]
  /** 僅記憶體：啟用中的捏合接點視為連續中央島，主路不得在此迴轉。 */
  roadMergeBarrierNodes?: number[]
  /** 僅記憶體：本次 road_merge 視圖加上的限制及其原值，供撤銷重建時精確還原。 */
  roadMergeDerived?: {
    nodeId: number
    hadNode: boolean
    hadBarrier?: boolean
    previousAccess?: { nodeId: number; allowedBack: boolean }
  }[]
  roadMarkingMode: 'all' | 'center' | 'none'
  /** 中央帶寬（公尺，預設 0）：偏心左轉道/槽化線/分隔島共用的中央空間，
   * 兩向車道各外移一半（way 線 = 中央帶中心）。couplet 合併或 journal 設定 */
  centerM: number
  /** 中央帶內容：hatch = 槽化線（可切偏心道）｜island = 實體分隔島（journal center_kind） */
  centerKind: 'hatch' | 'island'
  /** 實體中央帶只在接近路口時切出偏心左轉儲車道。 */
  islandBayMode: boolean
  centerExtendStart: boolean
  centerExtendEnd: boolean
  /** couplet 合併產生的路段——中央帶編輯只對這類路段開放 */
  coupletMerged?: boolean
  /** 路寬微調（公尺，journal extra_width_m）：實際鋪面寬 ≠ lanes×3.2 時的補正，
   * 對稱加減在斷面兩側（路肩語意），車道線/車道位置不動，只影響路面渲染寬 */
  extraM: number
  /** 分向偏移（公尺，右正）：way 線 = 斷面幾何中心時，分向線相對 way 線的位置。
   * 非對稱車道（3+2 等）≠ 0，由 computeDerived 推導；渲染與車道偏移都要加上 */
  divOffM: number
  width_m: number // 斷面總寬（渲染用，由 computeDerived 計算）
  /** 短死巷共用單車道：仍為雙向通行，但兩向共用同一條 3.2m 車道且不畫中央線 */
  sharedLane?: boolean
  oneway: 'yes' | 'no'
  maxspeed?: string
  motorcycle?: string // OSM motorcycle=*（no = 禁行機車）
  motorcar?: string // OSM motorcar=*（no = 禁行汽車，機車專用道路體）
  /** OSM junction=*（roundabout = 圓環弧段，不進 couplet 合併） */
  junction?: string
  /** OSM bridge=*（yes/viaduct…）。注意 bridge=yes ≠ 高架——跨河橋與路面同高；
   * 是否為「真立體交叉」由 elevation.ts 的手動清單/判準決定 */
  bridge?: string
  /** OSM layer=*（疊序整數，可負；缺省 0 = 平面）。高度合成見 elevation.ts */
  layer: number
  /** OSM tunnel=*（隧道/地下道）。視覺下沉本版不做（TODO），僅傳遞資料 */
  tunnel?: string
  /** 高架路段（elevation.isElevated，pipeline 切塊後標記）：地面車道級渲染
   * （路面/分隔線/印字/單行箭頭）全部略過，由 elevated3d 的 3D 橋面取代 */
  elevated?: boolean
  /** 顯示端不在人工確認的複合寬路口區塊上放道路名稱／線上箭頭。 */
  hideIntersectionInfo?: boolean
  /** 地面規則印字（依選取順序印在路面，代碼見 roadtext.ts GROUND_RULES）。
   * undefined = 無人工設定（motorcycle=no 時 fallback 印禁行機車）；[] = 明確無 */
  rulesF?: string[]
  rulesB?: string[]
  /** 各方向依駕駛視角左→右、逐車道的單一路面資訊；最後一格為已定義的機車道。 */
  laneMarksF?: (LaneMark | null)[]
  laneMarksB?: (LaneMark | null)[]
  turnLanes?: string[] // 順向每車道轉向（左→右）
  turnLanesB?: string[] // 逆向每車道轉向（逆向駕駛視角左→右）
  /** 多機車道的路口箭頭；只有 count>=2 時繪製。 */
  motoTurnLanesF?: string[]
  motoTurnLanesB?: string[]
  /** 區塊識別：way 依路口切塊後，區塊第一個 node id（journal 區塊鍵 way/W@b/N 用）。
   * 未切塊（無中間路口）時 = nodes[0]。 */
  blockNode: number
  /** 唯一靜態資料庫中的精確 segment 身分；同一 osm_id 可有多筆 split。 */
  navSegmentKey: string
  splitIndex: number
  /** 前處理（尤其 couplet 攤平）前的靜態 segment 來源。
   * 編輯器用它精確定位畫面節點實際屬於哪一筆靜態 OSM，禁止以同名道路猜測。 */
  sourceSegments: RoadSourceSegment[]
  /** 人工刪除的路口到路口區塊；載入後會從渲染與導航路網排除。 */
  deleted?: boolean
  /** 只從繪圖視圖隱藏；導航與來源追溯仍保留此道路。 */
  renderHidden?: boolean
  /** oneway=-1 反向單行道：載入時已反轉幾何。外部資料（LanePilot 標註）的
   * forward/backward 是 OSM 原始方向，比對時要翻轉 */
  reversed?: boolean
  /** 使用者拉線新增的自訂道路（journal new_road 物化）。注意不能用「osm_id < 0」
   * 判斷——couplet/藍田路切分段也用負 id（-原way id），只有這個旗標可靠 */
  userRoad?: boolean
  nodes: number[]
}

export type RoadFeature = Feature<LineString> & { properties: RoadProps }

type RoadSurfaceProps = RoadProps & { surfaceKind: 'casing' | 'surface' }

const DEFAULT_LANES: Record<string, number> = {
  motorway: 4, trunk: 4, primary: 4, secondary: 3, tertiary: 2,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
}

/** 由 f/b/moto 重算總車道數與斷面寬（編輯後也要呼叫） */
export function computeDerived(p: RoadProps) {
  p.motoCountF = Math.max(0, Math.round(p.motoCountF ?? (p.motoF ? 1 : 0)))
  p.motoCountB = p.oneway === 'yes'
    ? 0 : Math.max(0, Math.round(p.motoCountB ?? (p.motoB ? 1 : 0)))
  p.motoF = p.motoCountF > 0
  p.motoB = p.motoCountB > 0
  if (p.sharedLane && p.oneway === 'no') {
    // lanesForward/Backward 保留為 1，讓 A* 兩個方向都可通行；幾何只算一條共用車道。
    p.lanes = 1
    p.width_m = Math.max(2, LANE_WIDTH_M + (p.extraM || 0))
    p.divOffM = 0
    return
  }
  p.lanes = p.lanesForward + p.lanesBackward
  const laneSpan =
    LANE_WIDTH_M * (p.lanesForward + p.lanesBackward) +
    MOTO_LANE_M * (p.motoCountF + p.motoCountB) +
    (p.motoF ? p.motoSepF || 0 : 0) + (p.motoB ? p.motoSepB || 0 : 0) +
    (p.centerM || 0)
  // 路寬微調對稱加減在兩側，車道塊維持置中（下限 2m，避免負微調把路面壓沒）
  p.width_m = Math.max(2, laneSpan + (p.extraM || 0))
  // 分向線位置 = -車道塊寬/2 + 逆向側寬 + 中央帶一半（對稱斷面 = 0；不含路寬微調）
  p.divOffM = p.oneway === 'yes' ? 0 :
    LANE_WIDTH_M * p.lanesBackward + p.motoCountB * MOTO_LANE_M
      + (p.motoB ? p.motoSepB || 0 : 0) +
    (p.centerM || 0) / 2 - laneSpan / 2
}

/** 該行向的車道塊寬（車道×3.2 + 快慢分隔帶 + 機車道；不含路寬微調）
 * ——地面標線橫向定位用 */
export function laneSpanM(p: RoadProps, back: boolean): number {
  if (p.sharedLane && p.oneway === 'no') return LANE_WIDTH_M
  const lanes = p.oneway === 'yes' ? p.lanesForward : back ? p.lanesBackward : p.lanesForward
  const motoCount = p.oneway === 'yes' ? p.motoCountF : back ? p.motoCountB : p.motoCountF
  const sep = p.oneway === 'yes' ? p.motoSepF : back ? p.motoSepB : p.motoSepF
  return lanes * LANE_WIDTH_M + motoCount * MOTO_LANE_M + (motoCount > 0 ? sep || 0 : 0)
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
      motoCountF: 0,
      motoCountB: 0,
      motoSepF: 0,
      motoSepB: 0,
      motoEntryIconF: false,
      motoEntryIconB: false,
      motoTextDiamondF: false,
      motoTextDiamondB: false,
      stopLineF: true,
      stopLineB: true,
      arrowDisplayF: true,
      arrowDisplayB: true,
      startArrowDisplayF: false,
      startArrowDisplayB: false,
      leftWaitAreaF: false,
      leftWaitAreaB: false,
      startTurnLanes: undefined,
      startTurnLanesB: undefined,
      oneSideEntryNodes: (() => {
        const raw = p.one_side_entry_nodes
        if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite)
        if (typeof raw === 'string' && raw) {
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite)
          } catch { /* malformed optional extension: ignore */ }
        }
        return undefined
      })(),
      roadMarkingMode: 'all',
      centerM: 0,
      centerKind: 'hatch',
      islandBayMode: false,
      centerExtendStart: false,
      centerExtendEnd: false,
      extraM: 0,
      divOffM: 0,
      width_m: 0,
      oneway,
      maxspeed: p.maxspeed ? String(p.maxspeed) : undefined,
      motorcycle: p.motorcycle ? String(p.motorcycle) : undefined,
      motorcar: p.motorcar ? String(p.motorcar) : undefined,
      junction: p.junction ? String(p.junction) : undefined,
      bridge: p.bridge ? String(p.bridge) : undefined,
      // layer 可為負（地下道），不能用 intOr（>0 限定）；Overpass 快照無此欄位 → 0 平面
      layer: Number.isFinite(parseInt(String(p.layer ?? ''), 10))
        ? parseInt(String(p.layer ?? ''), 10) : 0,
      tunnel: p.tunnel ? String(p.tunnel) : undefined,
      turnLanes,
      turnLanesB,
      blockNode: nodes[0] ?? 0,
      navSegmentKey: String(p.nav_segment_key ?? `way/${Number(p.osm_id)}`),
      splitIndex: Number.isFinite(Number(p.split_index)) ? Number(p.split_index) : 0,
      sourceSegments: [],
      reversed,
      nodes,
    }
    props.sourceSegments = [{
      osmId: props.osm_id,
      navSegmentKey: props.navSegmentKey,
      splitIndex: props.splitIndex,
      nodeRefs: [...nodes],
      coordinates: coords.map((coordinate) => [...coordinate] as [number, number]),
    }]
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
 * 產生真正貼在地面的道路面。MapLibre line-width 是螢幕像素寬度，鏡頭傾斜時
 * 近端不會按地面透視縮放，因此車道級路面改用實際公尺 buffer 的 polygon。
 */
export function buildRoadSurfaces(
  roads: RoadFeature[],
): FeatureCollection<Polygon | MultiPolygon, RoadSurfaceProps> {
  const features: Feature<Polygon | MultiPolygon, RoadSurfaceProps>[] = []
  for (const road of roads) {
    if (road.properties.elevated || road.geometry.coordinates.length < 2) continue
    // OSM 的雙向道路軸代表分向基準，不是非對稱斷面的外框中心。
    // 將路面中心往車道較多的一側平移，中央帶與相鄰對稱區段才能連續。
    let surfaceAxis: Feature<LineString> = road
    if (road.properties.oneway === 'no' && Math.abs(road.properties.divOffM || 0) > 0.01) {
      try {
        surfaceAxis = lineOffset(road, -(road.properties.divOffM || 0), { units: 'meters' })
      } catch {
        surfaceAxis = road
      }
    }
    for (const [surfaceKind, extraWidth] of [
      ['casing', 2.4],
      ['surface', 0.8],
    ] as const) {
      const polygon = buffer(surfaceAxis, (road.properties.width_m + extraWidth) / 2, {
        units: 'meters',
        steps: 4,
      })
      if (!polygon) continue
      features.push({
        ...polygon,
        properties: { ...road.properties, surfaceKind },
      })
    }
  }
  return { type: 'FeatureCollection', features }
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

/**
 * 短死巷自動改為雙向共用單車道。只處理普通 1+1 的低等級道路；較長道路、
 * 兩端都接路網的區塊、單行道、已有機車道或中央帶的人工斷面都不動。
 */
export function collapseShortDeadEnds(roads: RoadFeature[], maxLengthM = 60): number {
  const endUse = new Map<number, number>()
  for (const r of roads) {
    const ns = r.properties.nodes
    if (ns.length < 2) continue
    for (const n of [ns[0], ns[ns.length - 1]]) endUse.set(n, (endUse.get(n) ?? 0) + 1)
  }
  const eligibleHighways = new Set(['residential', 'living_street', 'service', 'unclassified'])
  let changed = 0
  for (const r of roads) {
    const p = r.properties
    const ns = p.nodes
    const cs = r.geometry.coordinates as [number, number][]
    if (p.oneway !== 'no' || p.lanesForward !== 1 || p.lanesBackward !== 1 ||
      p.motoF || p.motoB || p.centerM > 0 || !eligibleHighways.has(p.highway) ||
      ns.length < 2 || cs.length < 2) continue
    const use0 = endUse.get(ns[0]) ?? 0
    const use1 = endUse.get(ns[ns.length - 1]) ?? 0
    if (!((use0 === 1 && use1 > 1) || (use1 === 1 && use0 > 1))) continue
    const cum = cumulative(cs)
    if (cum[cum.length - 1] > maxLengthM) continue
    p.sharedLane = true
    computeDerived(p)
    changed++
  }
  return changed
}

/**
 * 移除未命名的短死端殘段。從度數 1 的死端起，沿未命名低等級道路追蹤到正式
 * 路網；只有整條支線鏈的總長不超過上限才移除，避免逐段剝掉長距離無名道路。
 */
export function removeUnnamedShortSpurs(
  roads: RoadFeature[], maxLengthM = 60,
): { roads: RoadFeature[]; removed: number } {
  const eligibleHighways = new Set(['residential', 'living_street', 'service', 'unclassified'])
  const eligible = (r: RoadFeature) => {
    const p = r.properties
    return !p.name?.trim() && p.nodes.length >= 2 && r.geometry.coordinates.length >= 2 &&
      eligibleHighways.has(p.highway)
  }
  const ends = (r: RoadFeature): [number, number] => {
    const ns = r.properties.nodes
    return [ns[0], ns[ns.length - 1]]
  }
  const lengthM = (r: RoadFeature) => {
    const cum = cumulative(r.geometry.coordinates as [number, number][])
    return cum[cum.length - 1]
  }
  const byNode = new Map<number, RoadFeature[]>()
  for (const r of roads) {
    for (const n of ends(r)) {
      if (!byNode.has(n)) byNode.set(n, [])
      byNode.get(n)!.push(r)
    }
  }
  const remove = new Set<RoadFeature>()
  for (const [deadNode, refs] of byNode) {
    if (refs.length !== 1 || !eligible(refs[0]) || remove.has(refs[0])) continue
    const chain: RoadFeature[] = []
    const seen = new Set<RoadFeature>()
    let road = refs[0]
    let node = deadNode
    let total = 0
    let connected = false
    while (!seen.has(road)) {
      seen.add(road)
      chain.push(road)
      total += lengthM(road)
      if (total > maxLengthM) break
      const [a, b] = ends(road)
      const nextNode = node === a ? b : a
      const next = (byNode.get(nextNode) ?? []).filter((r) => r !== road)
      if (next.length === 1 && eligible(next[0]) && !seen.has(next[0])) {
        // 下一段會讓整條鏈超過上限：它屬於長道路主體，當作連接邊界，只裁短尾巴。
        if (total + lengthM(next[0]) > maxLengthM) {
          connected = true
          break
        }
        road = next[0]
        node = nextNode
        continue
      }
      connected = next.length > 0 // 接到命名道路、較高等級道路或真正路口
      break
    }
    if (connected && total <= maxLengthM) for (const r of chain) remove.add(r)
  }
  return { roads: roads.filter((r) => !remove.has(r)), removed: remove.size }
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
 * 路口收邊：區塊端節點上有另一道路以足夠角度交會時，分隔線收回交叉路最大
 * 半寬 + 1.2m——路口框與楔形內不殘留黃分向線/白車道線。所有道路等級都適用，
 * 小巷也不能讓標線穿過路口；同一路純續接（幾何近乎平行）則保持標線連續。
 */
export function buildDividers(roads: RoadFeature[]): FeatureCollection<LineString> {
  // 複合／分離式主路在 OSM 可能只以單側窄 way 與支路共點，通用半寬會低估路口範圍。
  // 僅增加標線退界，不裁道路面，也不改變導航拓樸。
  const specialEndTrim = (road: RoadFeature, nodeId: number) => {
    const fixed = road.properties.osm_id === 676539849 && nodeId === 1400036263 ? 14 : 0
    return Math.max(fixed, manualMarkingSetbackM(road, nodeId))
  }
  // 節點 → 佔用道路（切塊後交叉路在路口節點必有端點/中間點落在這裡）
  const nodeUse = new Map<number, RoadFeature[]>()
  for (const r of roads) {
    for (const n of r.properties.nodes) {
      if (!nodeUse.has(n)) nodeUse.set(n, [])
      nodeUse.get(n)!.push(r)
    }
  }
  /** 端節點收邊資訊：trim = 收邊量（停止線位置基準：交叉路最大寬/2 + 1.2，
   * 與 graph.scopeEdges 的 setback 一致——分隔線才不會戳過停止線）；
   * 交叉路 = 與自身走向夾角 >25° 的其他路段，不以名稱或道路寬度排除。sk =
   * 交叉路斜交係數（橫向偏移 o 的裁切點沿路軸平移 o×sk，收邊線平行交叉路
   * ＝停止線的延長線）。trim=0 = 不收。 */
  const endInfo = (n: number, self: RoadFeature, fwdBrg: number): { trim: number; sk: number } => {
    // 捏合主路只是經過側巷入口：主路所有標線保持連續，不將此節點
    // 當成交叉路口退縮。側巷仍會在自己的 endInfo 中依主路寬度收邊。
    const hasDistinctRoad = (nodeUse.get(n) ?? []).some((road) =>
      road.properties.osm_id !== self.properties.osm_id)
    if (self.properties.oneSideEntryNodes?.includes(n) && hasDistinctRoad) {
      return { trim: 0, sk: 0 }
    }
    let anyCross = false
    let w = 0
    let crossBrg: number | null = null
    let bestPerp = 25 // 交叉路需與自身線夾角 >25°，順向岔路不定義斜線
    for (const f of nodeUse.get(n) ?? []) {
      if (f === self) continue
      const q = f.properties
      const idx = q.nodes.indexOf(n)
      const cs2 = f.geometry.coordinates as [number, number][]
      if (idx >= 0 && q.nodes.length === cs2.length && cs2.length >= 2) {
        const brg = idx < cs2.length - 1
          ? bearing(cs2[idx], cs2[idx + 1])
          : bearing(cs2[idx - 1], cs2[idx])
        let d = Math.abs(angleDelta(fwdBrg, brg))
        if (d > 90) d = 180 - d
        if (d <= 25) continue // 同一路續接或近乎平行的分岔，不形成需清空的路口楔形
        w = Math.max(w, q.width_m)
        anyCross = true
        if (d > bestPerp) { bestPerp = d; crossBrg = brg }
      }
    }
    if (!anyCross) return { trim: 0, sk: 0 }
    const mergeCarrier = (nodeUse.get(n) ?? []).some((road) =>
      road !== self && road.properties.oneSideEntryNodes?.includes(n))
    // 一般路口沿用既有 2m 淨空；捏合側巷以主路實際半寬為邊界，
    // 僅保留標線本身的 0.2m 收邊，不使用固定退縮距離。
    return {
      trim: w / 2 + (mergeCarrier ? 0.2 : 2),
      sk: crossBrg === null ? 0 : skewFromCross(fwdBrg, crossBrg),
    }
  }

  const ZERO = { trim: 0, sk: 0 }
  const features: Feature<LineString>[] = []
  let cs0: [number, number][] = []
  let cum: number[] | null = null
  let L = 0
  let info0 = ZERO
  let info1 = ZERO
  let curId = 0
  let roadMarkingMode: RoadProps['roadMarkingMode'] = 'all'
  let axisShift = 0
  let roadHalfWidth = 0
  let centerExtendStart = false
  let centerExtendEnd = false
  let centerTipExtensionM = 0
  /** 依「該端停止線的延長線」裁切後偏移：裁切點 = 收邊基準 + 橫向偏移×skew ∓ 0.5m */
  const push = (off: number, kind: string) => {
    if (roadMarkingMode === 'center' && (kind === 'lane' || kind === 'moto')) return
    const isCenterLine = kind === 'center' || kind === 'center-double'
    let cs = cs0
    if (cum) {
      const from = !isCenterLine || !centerExtendStart
        ? (info0.trim > 0 ? info0.trim + Math.abs(info0.sk) * roadHalfWidth + 0.5 : 0)
        : 0
      const to = !isCenterLine || !centerExtendEnd
        ? (info1.trim > 0 ? L - info1.trim - Math.abs(info1.sk) * roadHalfWidth - 0.5 : L)
        : L
      const sliced = sliceByDist(cs0, cum, Math.max(0, from), Math.min(L, to))
      if (!sliced) return // 這條分隔線全在路口框內
      cs = sliced
    }
    if (isCenterLine && cs.length >= 2) {
      cs = [...cs]
      if (centerExtendStart) {
        const brg = bearing(cs[1], cs[0])
        cs.unshift(offsetMeters(
          cs[0],
          Math.sin(brg * Math.PI / 180) * centerTipExtensionM,
          Math.cos(brg * Math.PI / 180) * centerTipExtensionM,
        ))
      }
      if (centerExtendEnd) {
        const brg = bearing(cs[cs.length - 2], cs[cs.length - 1])
        cs.push(offsetMeters(
          cs[cs.length - 1],
          Math.sin(brg * Math.PI / 180) * centerTipExtensionM,
          Math.cos(brg * Math.PI / 180) * centerTipExtensionM,
        ))
      }
    }
    try {
      const feat: Feature<LineString> = {
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: cs },
      }
      const renderOff = off + axisShift
      const line = Math.abs(renderOff) < 0.001
        ? feat
        : lineOffset(feat, renderOff, { units: 'meters' })
      features.push({
        type: 'Feature', geometry: line.geometry,
        properties: { kind, osm_id: curId }, // osm_id 供除錯/離線稽核，樣式不使用
      })
    } catch { /* 退化幾何略過 */ }
  }
  for (const road of roads) {
    const p = road.properties
    curId = p.osm_id
    roadMarkingMode = p.roadMarkingMode
    axisShift = p.oneway === 'no' ? -(p.divOffM || 0) : 0
    roadHalfWidth = p.width_m / 2
    centerExtendStart = p.oneway === 'no' && p.centerExtendStart
    centerExtendEnd = p.oneway === 'no' && p.centerExtendEnd
    centerTipExtensionM = Math.max(1, p.width_m / 2)
    if (roadMarkingMode === 'none') continue
    if (p.elevated) continue // 高架：標線由 elevated3d 畫在橋面，地面不畫
    if (road.geometry.coordinates.length < 2) continue
    if (p.sharedLane) continue // 雙向共用單車道沒有分向線或車道分隔線
    cs0 = road.geometry.coordinates as [number, number][]
    const ns = p.nodes
    cum = null
    info0 = ZERO
    info1 = ZERO
    if (ns.length === cs0.length && ns.length >= 2) {
      info0 = endInfo(ns[0], road, bearing(cs0[0], cs0[1]))
      info1 = endInfo(ns[ns.length - 1], road, bearing(cs0[cs0.length - 2], cs0[cs0.length - 1]))
      info0 = { ...info0, trim: Math.max(info0.trim, specialEndTrim(road, ns[0])) }
      info1 = { ...info1, trim: Math.max(info1.trim, specialEndTrim(road, ns[ns.length - 1])) }
      // 人工指定「整段標線延後」時優先於中央線延伸到圓頭的顯示選項。
      if (manualMarkingSetbackM(road, ns[0]) > 0) centerExtendStart = false
      if (manualMarkingSetbackM(road, ns[ns.length - 1]) > 0) centerExtendEnd = false
      if (info0.trim > 0 || info1.trim > 0) {
        cum = cumulative(cs0)
        L = cum[cum.length - 1]
      }
    }
    const f = p.lanesForward // 可為 0（該向純機車道）
    // 快慢分隔帶 >0 時該向不畫機車道白線——島面（buildMotoSepIslands）取代
    const sepF = p.motoF ? p.motoSepF || 0 : 0
    const sepB = p.motoB ? p.motoSepB || 0 : 0
    if (p.oneway === 'yes') {
      // 單行道：斷面置中
      const total = f * LANE_WIDTH_M + p.motoCountF * MOTO_LANE_M + sepF
      const left = -total / 2
      for (let k = 1; k < f; k++) push(RIGHT * (left + k * LANE_WIDTH_M), 'lane')
      // 0 車道時機車道左界 = 斷面左緣，不需分隔線
      if (p.motoF && f > 0 && sepF === 0) push(RIGHT * (left + f * LANE_WIDTH_M), 'moto')
      for (let k = 1; k < p.motoCountF; k++) {
        push(RIGHT * (left + f * LANE_WIDTH_M + sepF + k * MOTO_LANE_M), 'lane')
      }
    } else {
      const b = p.lanesBackward
      const c = (p.centerM || 0) / 2 // 中央帶：兩向車道外移一半
      const dv = p.divOffM || 0 // 非對稱車道時分向線不在 way 線上
      // 中央帶存在時分向線由 turnbays 模組畫（±c 雙黃 + 偏心道/槽化內容）。
      // 無偏心中央帶的寬道路（正反合計 ≥4 車道）改畫雙黃線；窄路維持單黃線。
      if (c === 0) {
        if (f + b >= 4) {
          push(RIGHT * (dv - 0.18), 'center-double')
          push(RIGHT * (dv + 0.18), 'center-double')
        } else {
          push(RIGHT * dv, 'center')
        }
      }
      for (let k = 1; k < f; k++) push(RIGHT * (dv + c + k * LANE_WIDTH_M), 'lane')
      if (p.motoF && f > 0 && sepF === 0) push(RIGHT * (dv + c + f * LANE_WIDTH_M), 'moto')
      for (let k = 1; k < p.motoCountF; k++) {
        push(RIGHT * (dv + c + f * LANE_WIDTH_M + sepF + k * MOTO_LANE_M), 'lane')
      }
      for (let k = 1; k < b; k++) push(RIGHT * (dv - c - k * LANE_WIDTH_M), 'lane')
      if (p.motoB && b > 0 && sepB === 0) push(RIGHT * (dv - c - b * LANE_WIDTH_M), 'moto')
      for (let k = 1; k < p.motoCountB; k++) {
        push(RIGHT * (dv - c - b * LANE_WIDTH_M - sepB - k * MOTO_LANE_M), 'lane')
      }
    }
  }

  // 加昌路 block 533725078 的逆向最外側車道會續接到短機車分流
  // way/42680534。一般路口收邊只會把兩條道路各自畫到端點，視覺上會讓
  // 最外側車道縮回主路內；在兩者之間補一段平滑的雙側白線，讓車道真正
  // 由主路外側切入機車道。此為單一路口人工幾何，不改其他機車道斷面。
  const main = roads.find((road) =>
    road.properties.blockNode === 533725078
    && (road.properties.osm_id === 230216178
      || road.properties.sourceSegments.some((s) => s.osmId === 230216178)))
  const connector = roads.find((road) =>
    road.properties.osm_id === 42680534
    || road.properties.sourceSegments.some((s) => s.osmId === 42680534))
  if (main && connector && main.properties.roadMarkingMode === 'all') {
    try {
      const mainCoords = main.geometry.coordinates as [number, number][]
      const mainNodeIndex = main.properties.nodes.indexOf(533725078)
      const connectorNodeIndex = connector.properties.nodes.indexOf(533725078)
      if (mainNodeIndex >= 0 && connectorNodeIndex >= 0
        && mainCoords.length >= 2 && connector.geometry.coordinates.length >= 2) {
        const mainFromNode = mainNodeIndex === 0
          ? mainCoords
          : [...mainCoords].reverse()
        const mainAxis: Feature<LineString> = {
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: mainFromNode },
        }
        const p = main.properties
        const reverseOuterLaneCenter = -(
          (p.centerM || 0) / 2
          + (Math.max(1, p.lanesBackward) - 0.5) * LANE_WIDTH_M
        )
        const shiftedMain = lineOffset(mainAxis, reverseOuterLaneCenter, { units: 'meters' })
        const shiftedCoords = shiftedMain.geometry.coordinates as [number, number][]
        const shiftedCum = cumulative(shiftedCoords)
        const start = pointAlong(
          shiftedCoords, shiftedCum,
          Math.min(32, shiftedCum[shiftedCum.length - 1]),
        ).pos
        const control = shiftedCoords[0]
        const connectorCoords = connector.geometry.coordinates as [number, number][]
        const connectorFromNode = connectorNodeIndex === 0
          ? connectorCoords
          : [...connectorCoords].reverse()
        const connectorCum = cumulative(connectorFromNode)
        const end = pointAlong(
          connectorFromNode, connectorCum,
          Math.min(18, connectorCum[connectorCum.length - 1]),
        ).pos
        const centerCurve: [number, number][] = Array.from({ length: 13 }, (_, i) => {
          const t = i / 12
          const u = 1 - t
          return [
            u * u * start[0] + 2 * u * t * control[0] + t * t * end[0],
            u * u * start[1] + 2 * u * t * control[1] + t * t * end[1],
          ]
        })
        const curve: Feature<LineString> = {
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: centerCurve },
        }
        for (const side of [-1.15, 1.15]) {
          const boundary = lineOffset(curve, side, { units: 'meters' })
          features.push({
            type: 'Feature', geometry: boundary.geometry,
            properties: { kind: 'moto', osm_id: main.properties.osm_id },
          })
        }
      }
    } catch { /* 特殊接線幾何退化時維持一般路面，不影響其餘道路 */ }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 僅供視覺輸出使用：行政區重疊資料可能留下同一 OSM way 的短副本。
 * 保留導航與編輯用道路集合不變，只隱藏已被較長捏合段完整涵蓋的副本。
 */
export function roadsForRendering(roads: RoadFeature[]): RoadFeature[] {
  const containsPath = (outer: number[], inner: number[]) => {
    if (inner.length > outer.length) return false
    const matches = (candidate: number[]) => {
      for (let start = 0; start <= outer.length - candidate.length; start++) {
        let equal = true
        for (let index = 0; index < candidate.length; index++) {
          if (outer[start + index] !== candidate[index]) { equal = false; break }
        }
        if (equal) return true
      }
      return false
    }
    return matches(inner) || matches([...inner].reverse())
  }
  const activeRoadsByOsmId = new Map<number, RoadFeature[]>()
  for (const road of roads) {
    if (road.properties.deleted) continue
    const osmId = road.properties.osm_id
    const candidates = activeRoadsByOsmId.get(osmId)
    if (candidates) candidates.push(road)
    else activeRoadsByOsmId.set(osmId, [road])
  }
  const exactSeen = new Set<string>()
  return roads.filter((road) => {
    if (road.properties.deleted) return true
    const osmId = road.properties.osm_id
    const exactKey = `${osmId}:${road.properties.nodes.join(',')}`
    if (exactSeen.has(exactKey)) return false
    exactSeen.add(exactKey)
    return !(activeRoadsByOsmId.get(osmId) ?? []).some((candidate) =>
      candidate !== road
      && candidate.properties.nodes.length > road.properties.nodes.length
      && containsPath(candidate.properties.nodes, road.properties.nodes))
  })
}

function intOr(v: unknown, dflt: number): number {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
