// 底圖前處理管線（預設 shard 載入與「匯入地圖」共用；離線 harness 也 import 這裡，
// 確保驗證跑的是同一套邏輯）：
//   人工修正（改名/車道） → couplet 成對單行合併（逐路） → 藍田路分段斷面 → 依路口切塊
import { mergeCouplets, applyLantianSections, type DropRemap, type CoupletSection } from './couplet'
import { applyFixups } from './fixups'
import { splitAtIntersections, type RoadFeature } from './roads'
import { MEDIAN_SCOPE_ROADS } from './medians'

/** 自訂斷面的路（下方逐條呼叫），泛用同名合併要跳過 */
const CUSTOM_SECTION_ROADS = new Set(['藍田路', '大學南路', '援中路'])

/** 主慢分離道路：每向 = tertiary 主線＋residential 慢車道並排，泛用掃描會被
 * 「同向並排」防呆整條擋下——顯式只合併主線（慢車道原樣保留為側邊小路） */
const MAINLINE_ONLY_ROADS = new Set(['外環西路', '德民路'])

/** 泛用合併的預設斷面：2+2、中央槽化帶寬由 OSM 兩線實際間距反推（0.6~3.2m）。
 * 是推薦值非真值——實地車道數/機車道/分隔島用編輯模式逐區塊修。 */
const SIMPLE_SECTION: CoupletSection = {
  lanesF: 2, lanesB: 2, centerM: 0.6, centerKind: 'hatch',
  centerFromGap: { roadW: 6.4, min: 0.6, max: 3.2 },
}

/** 泛用同名合併候選：同名 oneway ≥2 條的路，全部丟給 mergeCouplets 逐條試。
 * 安全網都在 mergeCouplets 內：圓環/封閉環排除、同向並排（高雄大學路/楠海路/
 * 德民路型）整路中止、配對頂點 <60% 的落單支段不動。一次一條路——
 * 分組是相對「該路最長 way」的方位角，多條路混在同一個 scope 會亂。 */
function coupletCandidates(roads: RoadFeature[]): string[] {
  const count = new Map<string, number>()
  for (const r of roads) {
    const p = r.properties
    if (p.oneway !== 'yes' || !p.name) continue
    if (CUSTOM_SECTION_ROADS.has(p.name) || MAINLINE_ONLY_ROADS.has(p.name)) continue
    // 高快速公路的分向是實體事實（機車也禁行），雙向化會讓汽車可逆向繞行
    if (/^(motorway|trunk)/.test(p.highway)) continue
    if (p.junction === 'roundabout' || p.nodes[0] === p.nodes[p.nodes.length - 1]) continue
    count.set(p.name, (count.get(p.name) ?? 0) + 1)
  }
  return [...count.keys()].filter((n) => count.get(n)! >= 2).sort()
}

export interface BasePrep {
  roads: RoadFeature[]
  /** couplet 合併造成的 node id 重映射（journal/zones/標註匯入都要跟著遷移） */
  nodeRemap: Map<number, number>
  /** 被合併（drop 側）way id → keep way 對照（標註匯入重映射用） */
  wayRemap: Map<number, DropRemap>
}

/** 載入後的完整前處理。輸入會被就地修改，回傳切塊後的新陣列。 */
export function prepareBaseRoads(raw: RoadFeature[]): BasePrep {
  applyFixups(raw)
  const nodeRemap = new Map<number, number>()
  const wayRemap = new Map<number, DropRemap>()
  // 藍田路 = 2+2+中央 3.2m 偏心帶（槽化）；大學南路 = 2+2+機車道+實體島，
  // 島寬由 OSM 兩線實際間距反推（「把道路切開放入」，不擠壓車道）
  let roads = mergeCouplets(raw, new Set(['藍田路']), undefined, nodeRemap, wayRemap)
  roads = mergeCouplets(roads, MEDIAN_SCOPE_ROADS, {
    lanesF: 2, lanesB: 2, centerM: 2.4, centerKind: 'island',
    motoF: true, motoB: true,
    centerFromGap: { roadW: 8.6, min: 1.6, max: 8 }, // roadW = 2車道+機車道斷面寬
  }, nodeRemap, wayRemap)
  // 援中路：全長成對單行（一條 oneway=-1，載入已反轉）＋中央「偏心槽化帶」
  // （2026-07-14 實地確認是標線偏心不是實體島；偏心道對所有 hatch 合併段自動生成）
  roads = mergeCouplets(roads, new Set(['援中路']), {
    lanesF: 2, lanesB: 2, centerM: 3.2, centerKind: 'hatch',
    motoF: true, motoB: true,
    centerFromGap: { roadW: 8.6, min: 1.6, max: 8 },
  }, nodeRemap, wayRemap)
  // 外環西路/德民路：主慢分離，只合併 tertiary 主線（見 MAINLINE_ONLY_ROADS）
  for (const name of MAINLINE_ONLY_ROADS) {
    roads = mergeCouplets(roads, new Set([name]), SIMPLE_SECTION, nodeRemap, wayRemap,
      (r) => r.properties.highway === 'tertiary')
  }
  for (const name of coupletCandidates(roads)) {
    roads = mergeCouplets(roads, new Set([name]), SIMPLE_SECTION, nodeRemap, wayRemap)
  }
  // 高雄大學路「不」做 couplet 合併：四線並排林蔭大道（主慢分離），
  // 分隔島由 medians.ts TWIN_ISLAND_PAIRS 顯式配對生成
  applyLantianSections(roads) // 745巷以東 = 東三西二、無中央帶
  // 依路口切塊：車道/中央帶/轉向編輯的最小單位 = 路口到路口（journal 區塊鍵）
  return { roads: splitAtIntersections(roads), nodeRemap, wayRemap }
}
