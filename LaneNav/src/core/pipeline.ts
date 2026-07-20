// 底圖前處理管線（預設 shard 載入與「匯入地圖」共用；離線 harness 也 import 這裡，
// 確保驗證跑的是同一套邏輯）：
//   人工修正（改名/車道） → couplet 成對單行合併（逐路） → 藍田路分段斷面 → 依路口切塊
import {
  mergeCouplets, absorbSideWays, applyLantianSections,
  type DropRemap, type CoupletSection,
} from './couplet'
import { applyFixups, REMOVED_WAY_IDS } from './fixups'
import {
  collapseShortDeadEnds, removeUnnamedShortSpurs, splitAtIntersections, type RoadFeature,
} from './roads'
import { MEDIAN_SCOPE_ROADS } from './medians'
import { isElevated } from './elevation'

/** 自訂斷面的路（下方逐條呼叫），泛用同名合併要跳過。
 * 高楠公路：只顯式併陸橋本體兩 way（見 GAONAN_BRIDGE_IDS）——地面段有
 * 主慢分離/同向並排，泛用掃描本來就會被防呆整條擋下，列這裡免做白工 */
const CUSTOM_SECTION_ROADS = new Set(['藍田路', '大學南路', '援中路', '楠陽高架橋', '高楠公路'])

/** 高楠公路陸橋本體（跨楠梓路口的成對單行，間距 ~12m）。北段短橋對
 * （103678994/103679015，間距 26m+）是實體分離雙橋、南段（294647549 等）是
 * 同向並排雙 way——都不是 couplet 對切模型，維持原樣 */
const GAONAN_BRIDGE_IDS = new Set([23939182, 271982159])

/** 主慢分離道路：每向 = tertiary 主線＋residential 慢車道並排，泛用掃描會被
 * 「同向並排」防呆整條擋下。顯式處理：只合併 tertiary 主線 → 慢車道吸收進
 * 斷面（機車道＋快慢分隔島），獨立慢車道 way 移除、側街節點移植接上主線 */
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
  let roads = mergeCouplets(
    raw.filter((r) => !REMOVED_WAY_IDS.has(r.properties.osm_id)),
    new Set(['藍田路']), undefined, nodeRemap, wayRemap,
  )
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
  // 楠陽高架橋：實地三線道＋低矮中央護欄（2026-07-19 街景比對），不是泛用預設
  // 的 2+2——OSM 兩方向 way 同橋異名（見 fixups RENAMES），改名後才會被抓進來
  roads = mergeCouplets(roads, new Set(['楠陽高架橋']), {
    lanesF: 3, lanesB: 3, centerM: 0.6, centerKind: 'island',
  }, nodeRemap, wayRemap)
  // 高楠公路陸橋：同楠陽模式（成對單行 → 單一橋體＋中央護欄）。OSM 無 lanes
  // 真值（primary 預設 4 是猜的），陸橋給 2+2 推薦值，實地確認後用編輯模式修
  roads = mergeCouplets(roads, new Set(['高楠公路']), {
    lanesF: 2, lanesB: 2, centerM: 0.6, centerKind: 'island',
  }, nodeRemap, wayRemap, (r) => GAONAN_BRIDGE_IDS.has(r.properties.osm_id))
  // 外環西路/德民路：主慢分離（見 MAINLINE_ONLY_ROADS）——
  // 主線合併成 2+2＋機車道＋快慢分隔島（寬度可編輯），再吸收慢車道 way
  for (const name of MAINLINE_ONLY_ROADS) {
    roads = mergeCouplets(roads, new Set([name]), {
      ...SIMPLE_SECTION,
      motoF: true, motoB: true, motoSepF: 1.0, motoSepB: 1.0,
    }, nodeRemap, wayRemap, (r) => r.properties.highway === 'tertiary')
    roads = absorbSideWays(roads, name, nodeRemap, wayRemap)
    // 主線 OSM 常帶 motorcycle=no（原語意：快車道禁行，騎士走慢車道）。
    // 慢車道已吸收進斷面（機車道），整段禁行要解除，否則機車在此無路可走；
    // 改成「快車道地面印禁行機車」（印字只落在汽車車道，機車道不印）
    for (const r of roads) {
      const p = r.properties
      if (p.name === name && p.coupletMerged && p.motorcycle === 'no') {
        p.motorcycle = undefined
        p.rulesF = p.rulesF ?? ['no_moto']
        p.rulesB = p.rulesB ?? ['no_moto']
      }
    }
  }
  for (const name of coupletCandidates(roads)) {
    roads = mergeCouplets(roads, new Set([name]), SIMPLE_SECTION, nodeRemap, wayRemap)
  }
  // 高雄大學路「不」做 couplet 合併：四線並排林蔭大道（主慢分離），
  // 分隔島由 medians.ts TWIN_ISLAND_PAIRS 顯式配對生成
  applyLantianSections(roads) // 745巷以東 = 東三西二、無中央帶
  // 依路口切塊：車道/中央帶/轉向編輯的最小單位 = 路口到路口（journal 區塊鍵）
  let blocks = splitAtIntersections(roads)
  blocks = removeUnnamedShortSpurs(blocks).roads
  collapseShortDeadEnds(blocks)
  // 高架旗標：地面車道級渲染（路面/分隔線/印字/單行箭頭）略過這些區塊，
  // 改由 elevated3d 的 3D 橋面全長取代（含近地爬升段）
  for (const r of blocks) {
    if (isElevated(r.properties)) r.properties.elevated = true
  }
  return { roads: blocks, nodeRemap, wayRemap }
}
