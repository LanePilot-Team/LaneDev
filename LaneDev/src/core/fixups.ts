// Base Layer 人工修正（組員實地回報，OSM 資料落後現況）。載入時最先套用，
// 在 couplet 合併之前——改名會影響合併 scope（右昌大橋改名後才會併進藍昌路）。
// ⚠ 這些修正掛在 OSM way id / name 上：LanePilot 換新 PBF 快照後要重新驗證。
import { computeDerived, type RoadFeature } from './roads'

/** 路名修正（2026-07-15 組員回報：實地路牌已全面改名） */
const RENAMES: Record<string, string> = {
  右昌大橋: '藍昌路',
  援中港大橋: '楠海路',
  // OSM 同橋異名（同一座橋兩個方向的 way 被標成不同字）：不歸一名字，couplet
  // 合併的 name 分組會把兩個方向當成落單的獨立道路，永遠配不成對（見 elevation.ts）
  楠楊高架橋: '楠陽高架橋',
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

/** 已確認為 OSM 幾何殘段，不應進入顯示或路由。 */
export const REMOVED_WAY_IDS = new Set([
  287447934,
  287447935,
])

/** way 起點錯位殘尾：裁到指定 OSM node，保留後續主體。 */
const TRIM_WAY_START_NODE: Record<number, number> = {
  // Remove the tiny continuation across 外環西路; its round cap protrudes past the main road.
  126247903: 2206232306,
  287673498: 2912433399, // 援中路往益群橋下來，移除路口左側約 55m 多餘尾巴
}

/** 載入後、couplet 合併前呼叫（預設底圖與「匯入地圖」同一套） */
export function applyFixups(roads: RoadFeature[]) {
  for (const r of roads) {
    const p = r.properties
    const trimNode = TRIM_WAY_START_NODE[p.osm_id]
    if (trimNode !== undefined) {
      const i = p.nodes.indexOf(trimNode)
      if (i > 0 && i < r.geometry.coordinates.length - 1) {
        p.nodes = p.nodes.slice(i)
        r.geometry.coordinates = r.geometry.coordinates.slice(i)
        p.blockNode = trimNode
      }
    }
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
