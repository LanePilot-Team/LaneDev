// Base Layer 人工修正（組員實地回報，OSM 資料落後現況）。載入時最先套用，
// 在 couplet 合併之前——改名會影響合併 scope（右昌大橋改名後才會併進藍昌路）。
// ⚠ 這些修正掛在 OSM way id / name 上：LanePilot 換新 PBF 快照後要重新驗證。
import { computeDerived, type RoadFeature } from './roads'

/** 路名修正（2026-07-15 組員回報：實地路牌已全面改名） */
const RENAMES: Record<string, string> = {
  右昌大橋: '藍昌路',
  援中港大橋: '楠海路',
}

/** 車道數修正（way 級，單行 way 的 lanes = 該向車道數）。
 * 德民路接德民新橋走廊「三切二切三」：橋西德民路成對段與橋東土庫一路成對段
 * 實地為 3 車道，橋本體維持 2（tertiary 預設）。 */
const LANES_FIX: Record<number, number> = {
  75852429: 3, // 德民路 東北向（德民新橋西端）
  75852430: 3, // 德民路 西南向（德民新橋西端）
  126247891: 3, // 土庫一路 西向（德民新橋東端）
  1464614123: 3, // 土庫一路 東向（德民新橋東端）
}

/** 載入後、couplet 合併前呼叫（預設底圖與「匯入地圖」同一套） */
export function applyFixups(roads: RoadFeature[]) {
  for (const r of roads) {
    const p = r.properties
    const rename = p.name && RENAMES[p.name]
    if (rename) p.name = rename
    const lanes = LANES_FIX[p.osm_id]
    if (lanes !== undefined) {
      p.lanesForward = lanes
      if (p.oneway === 'no') p.lanesBackward = lanes
      computeDerived(p)
    }
  }
}
