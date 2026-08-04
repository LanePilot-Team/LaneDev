import type { Feature, FeatureCollection } from 'geojson'
import {
  angleDelta, cumulative, haversine, pointAlong, COS_LAT, LANE_WIDTH_M,
} from './geo'
import { laneSpanM, MOTO_LANE_M, type LaneMark } from './roads'
import { offsetAt, type RightLane, type TurnBay } from './turnbays'
import type { RoadGraph } from './graph'

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

/**
 * 路面文字要避開的既有元素（地面箭頭、機車道入口圖示、停止線、機車停等格…）。
 * 呼叫端把已經算好的圖徵轉成這個形狀；roadtext 只負責投影到路軸上避讓，
 * 不重算任何一種元素的位置——重算就等於維護兩份會漂移的規則。
 */
export interface RoadTextObstacle {
  /** 佔位取樣點（單點圖示給 1 點、線段給兩端、方框給四角） */
  points: [number, number][]
  /** 沿路軸方向的半長（公尺） */
  alongHalfM?: number
  /** 橫向半寬（公尺） */
  crossHalfM?: number
}

const KX = 111320 * COS_LAT
const KY = 110540
const CELL_M = 48

const cellKey = (p: [number, number]) =>
  `${Math.round((p[0] * KX) / CELL_M)},${Math.round((p[1] * KY) / CELL_M)}`

/** 障礙的粗略空間索引：每條路段只投影附近的障礙，避免 N×M 全比對。 */
function indexObstacles(obstacles: RoadTextObstacle[]) {
  const grid = new Map<string, RoadTextObstacle[]>()
  for (const o of obstacles) {
    const keys = new Set<string>()
    for (const p of o.points) {
      const cx = Math.round((p[0] * KX) / CELL_M)
      const cy = Math.round((p[1] * KY) / CELL_M)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) keys.add(`${cx + dx},${cy + dy}`)
      }
    }
    for (const key of keys) {
      const bucket = grid.get(key)
      if (bucket) bucket.push(o)
      else grid.set(key, [o])
    }
  }
  return grid
}

/**
 * 點投影到路段折線 → 沿路軸距離 d 與橫向偏移 off（右正，同 offsetAt）。
 *
 * 頭尾兩段**不夾住** t：疊在一起的兩條 way（OSM 常見的雙向 way + 兩條單行 way）
 * 會讓隔壁路的箭頭落在本路段端點之外，夾住 t 會把它算成「貼在端點、橫向很近」，
 * 於是橫向判定誤以為不同車道而不避讓——那正是印字壓到對向箭頭的來源。
 * 延伸端點線段後 d 會超出 [0, total]，橫向偏移才是真的。
 */
function projectOnEdge(
  p: [number, number], coords: [number, number][], cum: number[],
): { d: number; off: number } {
  let best = { d: 0, off: Infinity, dist: Infinity }
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (p[0] - coords[i][0]) * KX
    const ay = (p[1] - coords[i][1]) * KY
    const vx = (coords[i + 1][0] - coords[i][0]) * KX
    const vy = (coords[i + 1][1] - coords[i][1]) * KY
    const len2 = vx * vx + vy * vy
    if (len2 <= 0) continue
    const raw = (ax * vx + ay * vy) / len2
    const t = Math.max(i === 0 ? -Infinity : 0,
      Math.min(i === coords.length - 2 ? Infinity : 1, raw))
    const ex = ax - vx * t
    const ey = ay - vy * t
    const dist = Math.hypot(ex, ey)
    if (dist >= best.dist) continue
    // 行進方向的右側為正：右向量 = (前進向量順時針轉 90°)
    const len = Math.sqrt(len2)
    best = {
      d: cum[i] + t * len,
      off: (ex * vy - ey * vx) / len,
      dist,
    }
  }
  return { d: best.d, off: best.off }
}

/** 區間扣除：free 內挖掉 [a, b] */
function punch(free: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = []
  for (const [lo, hi] of free) {
    if (b <= lo || a >= hi) { out.push([lo, hi]); continue }
    if (a > lo) out.push([lo, a])
    if (b < hi) out.push([b, hi])
  }
  return out
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
}): RoadTextObstacle[] {
  const out: RoadTextObstacle[] = []
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
    const offs = Array.from({ length: lanes }, (_, k) => base + (k + 0.5) * LANE_WIDTH_M)
    for (let k = 0; k < motoCount; k++) {
      offs.push(base + lanes * LANE_WIDTH_M + sep + (k + 0.5) * MOTO_LANE_M)
    }

    // 只投影這條路段附近的障礙（格點索引），再把它們挖成不可用區間
    const nearby = new Set<RoadTextObstacle>()
    for (let d = 0; d <= total; d += CELL_M / 2) {
      for (const o of grid.get(cellKey(pointAlong(e.coords, cum, d).pos)) ?? []) nearby.add(o)
    }
    const projected = [...nearby].map((o) => {
      let d0 = Infinity, d1 = -Infinity, off0 = Infinity, off1 = -Infinity
      for (const point of o.points) {
        const hit = projectOnEdge(point, e.coords, cum)
        d0 = Math.min(d0, hit.d); d1 = Math.max(d1, hit.d)
        off0 = Math.min(off0, hit.off); off1 = Math.max(off1, hit.off)
      }
      const alongHalf = o.alongHalfM ?? 0
      const crossHalf = o.crossHalfM ?? 0
      return {
        d0: d0 - alongHalf, d1: d1 + alongHalf,
        off0: off0 - crossHalf, off1: off1 + crossHalf,
      }
    })

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
      let free: [number, number][] = [[s0 + 2, s1 - 2]]
      for (const o of projected) {
        if (o.off1 < offs[i] - laneHalf || o.off0 > offs[i] + laneHalf) continue
        free = punch(free, o.d0 - TEXT_CLEAR_M, o.d1 + TEXT_CLEAR_M)
      }
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
