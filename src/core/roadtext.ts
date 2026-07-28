import type { Feature, FeatureCollection } from 'geojson'
import { angleDelta, cumulative, haversine, pointAlong, LANE_WIDTH_M } from './geo'
import { laneSpanM, MOTO_LANE_M, type LaneMark } from './roads'
import { offsetAt, type TurnBay } from './turnbays'
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
/** 偏心左轉儲車道須同時容納箭頭、文字與安全間距；不足時不勉強印字。 */
const TURN_BAY_TEXT_MIN_LEN_M = 28

/** 每個方向剛離開路口處，依駕駛視角左→右逐車道繪製至多一種路面資訊。 */
export function buildRoadTexts(graph: RoadGraph, bays: TurnBay[] = []): FeatureCollection {
  const features: Feature[] = []
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

    const d = s0 + 2 + ROAD_TEXT_LEN_M / 2
    const { brg } = pointAlong(e.coords, cum, d)
    const iconBrg = ((brg % 360) + 360) % 360
    marks.slice(0, offs.length).forEach((mark, i) => {
      if (!mark?.text.trim()) return
      const pos = offsetAt(e.coords, cum, d, offs[i])
      const roadKey = p.name?.trim() || `way/${p.osm_id}`
      const duplicate = features.findIndex((f) =>
        f.properties?.roadKey === roadKey && f.properties?.lane === i &&
        f.properties?.label === mark.text.trim() && f.properties?.color === (mark.color || '#ffffff') &&
        Math.abs(angleDelta(Number(f.properties?.brg), iconBrg)) < 20 &&
        haversine((f.geometry as unknown as { coordinates: [number, number] }).coordinates, pos) < 25)
      const addDiamond = moto && i >= lanes &&
        (p.oneway === 'yes' || !e.back ? p.motoTextDiamondF : p.motoTextDiamondB)
      const feature: Feature = {
        type: 'Feature',
        properties: {
          label: addDiamond ? `◇${mark.text.trim()}◇` : mark.text.trim(),
          color: mark.color || '#ffffff', lane: i,
          laneType: moto && i >= lanes ? 'moto' : 'car',
          brg: Math.round(iconBrg * 10) / 10,
          roadKey, spanM: s1 - s0,
        },
        geometry: { type: 'Point', coordinates: pos },
      }
      if (duplicate < 0) features.push(feature)
      else if (Number(features[duplicate].properties?.spanM) < s1 - s0) features[duplicate] = feature

      // 機車左轉專用道在路口前再提示一次：箭頭由 turnbays.ts 放在最靠近
      // 停止線處，這裡的文字接在箭頭後方（行進方向的上游側）。
      if (moto && i >= lanes && mark.text.trim() === '機車左轉專用') {
        // 六字直排（可能另含上下菱形）比一般四字標記更長，需與前方
        // 左轉箭頭保留足夠淨距，避免文字尾端壓到箭身。
        const nearD = s1 - 16
        if (nearD > d + 7 && nearD > s0 + ROAD_TEXT_LEN_M / 2) {
          const near = pointAlong(e.coords, cum, nearD)
          features.push({
            type: 'Feature',
            properties: {
              label: addDiamond ? '◇機車左轉專用◇' : '機車左轉專用',
              color: mark.color || '#ffffff',
              lane: i,
              laneType: 'moto',
              brg: Math.round((((near.brg % 360) + 360) % 360) * 10) / 10,
              roadKey: `${roadKey}:moto-left-near`,
              spanM: s1 - s0,
            },
            geometry: {
              type: 'Point',
              coordinates: offsetAt(e.coords, cum, nearD, offs[i]),
            },
          })
        }
      }
    })
  }
  for (const bay of bays) {
    if (!bay.roadText) continue
    if (bay.bayLenM < TURN_BAY_TEXT_MIN_LEN_M) continue
    const brg = ((bay.roadText.brg % 360) + 360) % 360
    features.push({
      type: 'Feature',
      properties: {
        label: '禁行機車', color: '#facc15', lane: -1, laneType: 'turn_bay',
        brg: Math.round(brg * 10) / 10, roadKey: bay.key, spanM: bay.bayLenM,
      },
      geometry: { type: 'Point', coordinates: bay.roadText.pos },
    })
  }
  return { type: 'FeatureCollection', features }
}
