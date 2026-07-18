// 路面印字（地面規則）：每個方向邊的起點（路段開頭/剛出路口處）各車道印一次。
// 規則來源：人工設定（rulesF/rulesB，車道編輯「地面規則」）優先；
// 無人工設定時 fallback：OSM motorcycle=no → 禁行機車。
// 多條規則依「選取順序」堆疊：keep-upright 後畫面由上往下 = 選取順序。
// 字圖由 mapStyle.makeIcons 生成（rule-<code>），第一字在上、由上往下讀。
import type { Feature, FeatureCollection } from 'geojson'
import { cumulative, pointAlong, LANE_WIDTH_M } from './geo'
import { laneSpanM } from './roads'
import { offsetAt } from './turnbays'
import type { RoadGraph } from './graph'

/** 可標註的地面規則（順序 = 編輯面板按鈕順序）。label 均為 4 字（印字尺寸共用） */
export const GROUND_RULES: { code: string; label: string }[] = [
  { code: 'no_moto', label: '禁行機車' },
  { code: 'no_car', label: '禁行汽車' },
  { code: 'no_left', label: '禁止左轉' },
  { code: 'no_right', label: '禁止右轉' },
  { code: 'two_stage', label: '兩段左轉' },
]

const RULE_CODES = new Set(GROUND_RULES.map((r) => r.code))

/** 與 mapStyle 的 road-text 圖層約定：4 字 × 2.5m */
export const ROAD_TEXT_LEN_M = 10
const STACK_STEP_M = ROAD_TEXT_LEN_M + 4 // 多規則堆疊間距

export function buildRoadTexts(graph: RoadGraph): FeatureCollection {
  const features: Feature[] = []
  const scope = (r: { properties: { rulesF?: string[]; rulesB?: string[]; motorcycle?: string } }) =>
    !!(r.properties.rulesF?.length || r.properties.rulesB?.length || r.properties.motorcycle === 'no')
  for (const e of graph.scopeEdges(scope)) {
    const p = e.road.properties
    const explicit = p.oneway === 'yes' || !e.back ? p.rulesF : p.rulesB
    const rules = (explicit ?? (p.motorcycle === 'no' ? ['no_moto'] : []))
      .filter((c) => RULE_CODES.has(c))
    if (rules.length === 0) continue
    const lanes = p.oneway === 'yes' ? p.lanesForward : e.back ? p.lanesBackward : p.lanesForward
    const cum = cumulative(e.coords)
    const total = cum[cum.length - 1]
    const s0 = e.startSetbackM
    const s1 = total - e.endSetbackM
    // 放得下幾條印幾條（第 k 條佔 [2+k*step, 2+k*step+字長]，尾端留 2m）
    const n = Math.min(rules.length,
      Math.floor((s1 - s0 - ROAD_TEXT_LEN_M - 4) / STACK_STEP_M) + 1)
    if (n < 1) continue
    // 車道基準（行進 frame）：單行道 = 車道塊左緣（不含路寬微調）；雙向 = 分向線 + 中央帶半寬
    const dv = e.back ? -(p.divOffM || 0) : (p.divOffM || 0)
    const base = p.oneway === 'yes' ? -laneSpanM(p, false) / 2 : dv + (p.centerM || 0) / 2
    // 印字橫向位置：各汽車道中心；0 車道（純機車道）時印在機車道中心
    const offs = lanes >= 1
      ? Array.from({ length: lanes }, (_, k) => base + (k + 0.5) * LANE_WIDTH_M)
      : [base + 1.1]
    // keep-upright 下的堆疊方向：南向行進（icon 翻正）= 畫面往下 → 規則[0] 放最靠近起點；
    // 北向行進 = 畫面往上 → 規則[0] 放最遠端。兩者畫面上皆為「由上往下 = 選取順序」
    const brg0 = pointAlong(e.coords, cum, s0 + 2 + ROAD_TEXT_LEN_M / 2).brg
    const a0 = ((brg0 % 360) + 360) % 360
    const southish = a0 >= 90 && a0 < 270
    for (let k = 0; k < n; k++) {
      const slot = southish ? k : n - 1 - k
      const d = s0 + 2 + ROAD_TEXT_LEN_M / 2 + slot * STACK_STEP_M
      const { brg } = pointAlong(e.coords, cum, d)
      const a = ((brg % 360) + 360) % 360
      const iconBrg = a >= 90 && a < 270 ? a - 180 : a
      for (const off of offs) {
        features.push({
          type: 'Feature',
          properties: { icon: `rule-${rules[k]}`, brg: Math.round(iconBrg * 10) / 10 },
          geometry: {
            type: 'Point',
            coordinates: offsetAt(e.coords, cum, d, off),
          },
        })
      }
    }
  }
  return { type: 'FeatureCollection', features }
}
