import type { Feature, FeatureCollection } from 'geojson'
import { angleDelta, cumulative, haversine, pointAlong, LANE_WIDTH_M } from './geo'
import { laneSpanM, MOTO_LANE_M, type LaneMark } from './roads'
import { offsetAt, type RightLane, type TurnBay } from './turnbays'
import {
  freeIntervals, indexObstacles, projectNearbyObstacles, type GroundObstacle,
} from './groundAvoid'
import type { RoadGraph } from './graph'

/** 舊名保留：路面文字的避讓輸入就是共用的 GroundObstacle。 */
export type RoadTextObstacle = GroundObstacle

/** 舊 journal 使用的代碼仍保留，讓既有 rules_forward/backward 可向後相容。 */
export const GROUND_RULES = [
  { code: 'no_moto', label: '禁行機車' },
  { code: 'no_car', label: '禁行汽車' },
  { code: 'no_left', label: '禁止左轉' },
  { code: 'no_right', label: '禁止右轉' },
  { code: 'two_stage', label: '兩段左轉' },
]

export const CAR_LANE_MARKS: LaneMark[] = [
  { text: '禁行機車', color: '#facc15' },
]

export const MOTO_LANE_MARKS: LaneMark[] = [
  { text: '機車專用', color: '#ffffff' },
  { text: '機車左轉專用', color: '#ffffff' },
  { text: '機慢車專用', color: '#ffffff' },
  { text: '機車優先', color: '#ffffff' },
  { text: '機慢車優先', color: '#ffffff' },
  { text: '自行車優先', color: '#ffffff' },
]

export const ROAD_TEXT_LEN_M = 10
/** 每字沿路軸佔用長度：mapStyle 的 text-size 1.4m × (1 + letter-spacing 0.12)。 */
export const ROAD_TEXT_CHAR_M = 1.4 * 1.12
/** 文字與箭頭/圖示/停止線之間的最小淨距。 */
const TEXT_CLEAR_M = 1.6
/** 前後各一組文字時，兩組之間至少要留這麼長，否則只放靠近箭頭的那一組。 */
const TEXT_PAIR_GAP_M = 14
/** 偏心左轉儲車道須同時容納箭頭、文字與安全間距；不足時不勉強印字。 */
const TURN_BAY_TEXT_MIN_LEN_M = 28

/** 直排文字沿路軸的長度（含菱形等額外字元）。 */
export function roadTextLengthM(label: string): number {
  return Math.max(1, [...label].length) * ROAD_TEXT_CHAR_M
}

/** 地面箭頭圖示的實際尺寸（mapStyle 的 icon-size = iconMeters(4.5, 96)）。 */
const ARROW_LEN_M = 4.5
const ARROW_HALF_WIDTH_M = 1.1

/**
 * 把已算好的地面元素轉成 buildRoadTexts 的避讓輸入。
 * 尺寸取自 mapStyle 的 icon-size / line-width，改樣式時兩邊要一起改。
 */
export function roadTextObstacles(input: {
  arrows?: { pos: [number, number] }[]
  motoEntryIcons?: { geometry: { coordinates: number[] }; properties?: Record<string, unknown> | null }[]
  stopLines?: { coords: [number, number][] }[]
  motoBoxes?: { ring: [number, number][] | null }[]
}): GroundObstacle[] {
  const out: GroundObstacle[] = []
  for (const arrow of input.arrows ?? []) {
    out.push({
      points: [arrow.pos],
      alongHalfM: ARROW_LEN_M / 2,
      crossHalfM: ARROW_HALF_WIDTH_M,
    })
  }
  for (const icon of input.motoEntryIcons ?? []) {
    const height = Number(icon.properties?.iconHeightM) || 3.2
    out.push({
      points: [icon.geometry.coordinates.slice(0, 2) as [number, number]],
      alongHalfM: height / 2,
      crossHalfM: 0.6,
    })
  }
  for (const line of input.stopLines ?? []) {
    if (line.coords.length < 2) continue
    out.push({ points: line.coords, alongHalfM: 0.4, crossHalfM: 0 })
  }
  for (const box of input.motoBoxes ?? []) {
    if (box.ring && box.ring.length >= 3) out.push({ points: box.ring })
  }
  return out
}

/** 路名沿中心線排字，橫向大約佔這麼寬（13px 字在車道級縮放下的量級）。 */
const LABEL_HALF_WIDTH_M = 3
/** 路名與地面標線之間的最小淨距。 */
const LABEL_CLEAR_M = 4
/** 短於此長度的空檔不值得放路名（MapLibre 放不下也會自己丟掉）。 */
const LABEL_MIN_LEN_M = 12

/**
 * 路名可用的中心線區段：把路段中心線扣掉地面標線佔用的縱向區間。
 *
 * `road-label` 圖層用 `symbol-placement: 'line'`，MapLibre 會沿著給它的線自行找
 * 位置——線給整條路段，名稱就可能落在路口正上方蓋掉箭頭。改餵「已經避開標線的
 * 那幾段」，位置決定權仍在 MapLibre，但它挑不到會擋住重要資訊的地方。
 * 空檔太短就整段不給——寧可少一個路名，也不要蓋住轉向資訊。
 */
export function buildRoadLabelLines(
  roads: {
    geometry: { coordinates: number[][] }
    properties: {
      osm_id: number; name?: string; highway: string; width_m: number
      roadMarkingMode: string; elevated?: boolean
      hideIntersectionInfo?: boolean
    }
  }[],
  obstacles: GroundObstacle[] = [],
): FeatureCollection {
  const grid = indexObstacles(obstacles)
  const features: Feature[] = []
  for (const road of roads) {
    const p = road.properties
    if (!p.name?.trim()) continue
    const coords = road.geometry.coordinates as [number, number][]
    if (coords.length < 2) continue
    const cum = cumulative(coords)
    const total = cum[cum.length - 1]
    if (total < LABEL_MIN_LEN_M) continue
    const projected = projectNearbyObstacles(grid, coords, cum)
    const free = freeIntervals(
      projected, 0, total, 0, LABEL_HALF_WIDTH_M, LABEL_CLEAR_M)
    for (const [lo, hi] of free) {
      if (hi - lo < LABEL_MIN_LEN_M) continue
      const line: [number, number][] = []
      for (let d = lo; d < hi; d += Math.max(2, (hi - lo) / 8)) {
        line.push(pointAlong(coords, cum, d).pos)
      }
      line.push(pointAlong(coords, cum, hi).pos)
      features.push({
        type: 'Feature',
        properties: {
          name: p.name,
          osm_id: p.osm_id,
          highway: p.highway,
          roadMarkingMode: p.roadMarkingMode,
          hideIntersectionInfo: p.hideIntersectionInfo ?? false,
        },
        geometry: { type: 'LineString', coordinates: line },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 逐車道繪製至多一種路面資訊。
 *
 * 位置：汽車車道沿用「剛離開路口」的既有樣式；機車道改印在**靠近路口箭頭**那一端
 * （騎士要在該處判斷車道），路段夠長時上游再補一組。兩組都以 obstacles 為準避開
 * 地面箭頭、機車道入口圖示與停止線——不重算它們的位置，只投影到路軸上挖掉區間。
 */
export function buildRoadTexts(
  graph: RoadGraph, bays: TurnBay[] = [], rightLanes: RightLane[] = [],
  obstacles: RoadTextObstacle[] = [],
): FeatureCollection {
  const features: Feature[] = []
  const grid = indexObstacles(obstacles)
  const scope = (r: { properties: {
    rulesF?: string[]; rulesB?: string[]; laneMarksF?: (LaneMark | null)[]
    laneMarksB?: (LaneMark | null)[]; motorcycle?: string; elevated?: boolean
  } }) => !r.properties.elevated && !!(
    r.properties.laneMarksF?.some(Boolean) || r.properties.laneMarksB?.some(Boolean) ||
    r.properties.rulesF?.length || r.properties.rulesB?.length || r.properties.motorcycle === 'no')

  for (const e of graph.scopeEdges(scope)) {
    const p = e.road.properties
    if (p.roadMarkingMode !== 'all') continue
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    const motoCount = p.oneway === 'yes'
      ? p.motoCountF : e.back ? p.motoCountB : p.motoCountF
    const moto = motoCount > 0
    const explicitMarks = p.oneway === 'yes' || !e.back ? p.laneMarksF : p.laneMarksB
    const legacyRules = p.oneway === 'yes' || !e.back ? p.rulesF : p.rulesB
    const legacyNoMoto = (legacyRules ?? (p.motorcycle === 'no' ? ['no_moto'] : [])).includes('no_moto')
    const marks = explicitMarks ?? [
      ...Array.from({ length: lanes }, () => legacyNoMoto ? CAR_LANE_MARKS[0] : null),
      ...Array.from({ length: motoCount }, () => null),
    ]
    if (!marks.some((m) => m?.text.trim())) continue

    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const s0 = e.startSetbackM
    const s1 = total - e.endSetbackM
    if (s1 - s0 < ROAD_TEXT_LEN_M + 4) continue
    const dv = 0
    const base = p.oneway === 'yes' ? -laneSpanM(p, false) / 2 : dv + (p.centerM || 0) / 2
    const sep = p.oneway === 'yes' ? p.motoSepF || 0 : e.back ? p.motoSepB || 0 : p.motoSepF || 0
    const motoLeft = p.oneway === 'yes' && !!p.motoLeftF && motoCount > 0
    const carBase = base + (motoLeft ? motoCount * MOTO_LANE_M + sep : 0)
    const offs = Array.from({ length: lanes }, (_, k) => carBase + (k + 0.5) * LANE_WIDTH_M)
    for (let k = 0; k < motoCount; k++) {
      offs.push(motoLeft
        ? base + (k + 0.5) * MOTO_LANE_M
        : base + lanes * LANE_WIDTH_M + sep + (k + 0.5) * MOTO_LANE_M)
    }

    // 只投影這條路段附近的障礙（格點索引），再把它們挖成不可用區間
    const projected = projectNearbyObstacles(grid, e.coords, cum)

    const roadKey = p.name?.trim() || `way/${p.osm_id}`
    marks.slice(0, offs.length).forEach((mark, i) => {
      if (!mark?.text.trim()) return
      const isMoto = moto && i >= lanes
      const addDiamond = isMoto &&
        (p.oneway === 'yes' || !e.back ? p.motoTextDiamondF : p.motoTextDiamondB)
      const label = addDiamond ? `◇${mark.text.trim()}◇` : mark.text.trim()
      const textLen = roadTextLengthM(label)
      const laneHalf = (isMoto ? MOTO_LANE_M : LANE_WIDTH_M) / 2
      // 障礙只在橫向真的蓋到這個車道時才擋——隔壁車道的箭頭不影響本車道印字
      const free = freeIntervals(projected, s0 + 2, s1 - 2, offs[i], laneHalf, TEXT_CLEAR_M)
      const usable = free.filter(([lo, hi]) => hi - lo >= textLen)
      if (!usable.length) return

      // 機車道印在靠近路口箭頭那一端（下游）；汽車車道維持「剛離開路口」樣式
      const downstream = usable[usable.length - 1]
      const upstream = usable[0]
      const slots: { d: number; suffix: string }[] = isMoto
        ? [{ d: downstream[1] - textLen / 2, suffix: '' }]
        : [{ d: upstream[0] + textLen / 2, suffix: '' }]
      if (isMoto) {
        // 路段夠長時上游再補一組（同樣落在無障礙區間內、與下游那組拉開距離）
        const secondD = upstream[0] + textLen / 2
        if (slots[0].d - secondD >= textLen + TEXT_PAIR_GAP_M) {
          slots.push({ d: secondD, suffix: ':upstream' })
        }
      }

      for (const slot of slots) {
        const { brg } = pointAlong(e.coords, cum, slot.d)
        const textBrg = ((brg % 360) + 360) % 360
        const pos = offsetAt(e.coords, cum, slot.d, offs[i])
        const key = `${roadKey}${slot.suffix}`
        const duplicate = features.findIndex((f) =>
          f.properties?.roadKey === key && f.properties?.lane === i &&
          f.properties?.label === label && f.properties?.color === (mark.color || '#ffffff') &&
          Math.abs(angleDelta(Number(f.properties?.brg), textBrg)) < 20 &&
          haversine((f.geometry as unknown as { coordinates: [number, number] }).coordinates, pos) < 25)
        const feature: Feature = {
          type: 'Feature',
          properties: {
            label,
            color: mark.color || '#ffffff', lane: i,
            laneType: isMoto ? 'moto' : 'car',
            brg: Math.round(textBrg * 10) / 10,
            roadKey: key, spanM: s1 - s0,
            // 來源區塊（除錯／稽核用）：roadKey 是路名，同名的 way 有很多條
            srcKey: `way/${p.osm_id}@b/${p.blockNode}${e.back ? '~b' : ''}`,
          },
          geometry: { type: 'Point', coordinates: pos },
        }
        if (duplicate < 0) features.push(feature)
        else if (Number(features[duplicate].properties?.spanM) < s1 - s0) {
          features[duplicate] = feature
        }
      }
    })
  }
  for (const bay of bays) {
    if (!bay.roadText || !bay.laneMark?.text.trim()) continue
    if (bay.bayLenM < TURN_BAY_TEXT_MIN_LEN_M) continue
    const brg = ((bay.roadText.brg % 360) + 360) % 360
    features.push({
      type: 'Feature',
      properties: {
        label: bay.laneMark.text.trim(),
        color: bay.laneMark.color || '#facc15', lane: -1, laneType: 'turn_bay',
        brg: Math.round(brg * 10) / 10, roadKey: bay.key, spanM: bay.bayLenM,
      },
      geometry: { type: 'Point', coordinates: bay.roadText.pos },
    })
  }
  for (const lane of rightLanes) {
    if (!lane.roadText || !lane.laneMark?.text.trim()) continue
    const brg = ((lane.roadText.brg % 360) + 360) % 360
    features.push({
      type: 'Feature',
      properties: {
        label: lane.laneMark.text.trim(), color: lane.laneMark.color || '#ffffff',
        lane: -1, laneType: 'right_lane', brg: Math.round(brg * 10) / 10,
        roadKey: lane.key, spanM: lane.lenM,
      },
      geometry: { type: 'Point', coordinates: lane.roadText.pos },
    })
  }
  return { type: 'FeatureCollection', features }
}
