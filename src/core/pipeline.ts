// 底圖前處理管線（預設 shard 載入與「匯入地圖」共用；離線 harness 也 import 這裡，
// 確保驗證跑的是同一套邏輯）：
//   人工修正（改名/車道） → couplet 成對單行合併（逐路） → 藍田路分段斷面 → 依路口切塊
import {
  mergeCouplets, absorbSideWays, applyLantianSections,
  type DropRemap, type CoupletSection,
} from './couplet'
import { applyFixups, collapseKnownIntersections, REMOVED_WAY_IDS } from './fixups'
import {
  collapseShortDeadEnds, removeUnnamedShortSpurs, splitAtIntersections, type RoadFeature,
} from './roads'
import { isElevated } from './elevation'

/** 自訂斷面的路（下方逐條呼叫），泛用同名合併要跳過。
 * 高楠公路：只顯式併陸橋本體兩 way（見 GAONAN_BRIDGE_IDS）——地面段有
 * 主慢分離/同向並排，泛用掃描本來就會被防呆整條擋下，列這裡免做白工 */
const CUSTOM_SECTION_ROADS = new Set([
  '藍田路', '大學南路', '援中路', '楠陽高架橋', '高楠公路', '翠華路', '旗楠路',
  '土庫一路',
])

/** 高楠公路陸橋本體（跨楠梓路口的成對單行，間距 ~12m）。北段短橋對
 * （103678994/103679015，間距 26m+）是實體分離雙橋、南段（294647549 等）是
 * 同向並排雙 way——都不是 couplet 對切模型，維持原樣 */
const GAONAN_BRIDGE_IDS = new Set([23939182, 271982159])

/** 主慢分離道路：每向 = tertiary 主線＋residential 慢車道並排，泛用掃描會被
 * 「同向並排」防呆整條擋下。顯式處理：只合併 tertiary 主線 → 慢車道吸收進
 * 斷面（機車道＋快慢分隔島），獨立慢車道 way 移除、側街節點移植接上主線 */
const MAINLINE_ONLY_ROADS = new Set(['外環西路', '德民路'])

/**
 * 一律不做 couplet 合併的路名：機慢車道走廊本來就是單向一條，沒有「對向的另一半」。
 *
 * 泛用同名合併的分組只看**整條 way 的走向**（相對最長 way ±90°），轉彎超過 90°
 * 的走廊會被切到不同組；短的那截又整條落在對方起點的 PAIR_MAX_M 內（投影全夾在
 * 端點）→ 覆蓋率 100%，被當成 drop side 整條刪掉。
 * 機車專用道(往橋頭/楠梓車站方向) way/1495039671（39.5m，接在 way/23787573 西端
 * 與 way/1495039674 東端之間）就是這樣消失的，整條走廊在朝新路口斷成兩截。
 * 全圖這個名稱底下只有這一筆合併，所以整名排除沒有副作用。
 */
const NO_COUPLET_ROADS = new Set([
  '機車專用道(往橋頭/楠梓車站方向)',
  '機車專用道(往高雄市區、楠梓方向)',
])

/** 翠華路北段的兩組實際分向主線。南側另有交流道短接線，同名但不可一起配對。 */
const CUEIHUA_MAINLINE_PAIRS = [
  new Set([267715853, 28526260]),
  new Set([267715863, 267715867]),
]

/**
 * 建楠路由四組相反方向的 oneway 組成；若整個路名一次分組，前後相接的同向
 * 分段會被防呆誤判為「同向並排」。逐組限定來源 way 可保留防呆門檻，並讓
 * mergeCouplets 原有的 nodeRemap 把沿線側巷接回合體中心線。
 */
const JIANNAN_PAIRS = [
  new Set([23787570, 271982142]),
  new Set([27527298, 271982144]),
  // 東端的兩條短橫段各只有兩個取樣點，必須與相接彎道同組，才有足夠
  // 投影覆蓋率完成配對。
  new Set([27527294, 230282047, 271982140, 1456608388]),
]

/** 土庫一路中央的成對汽車主線；同名 unclassified 為外側道路，不參與合體。 */
const TUKU_MAINLINE_IDS = new Set([126247863, 126247891, 1464614123])

/**
 * 旗楠路的機慢車道（motorcycle=yes／汽車主線是 motorcycle=no）。OSM 把它標成
 * 與主線同名同 highway=primary 的單行 way，只靠 highway 篩選會被當成分向主線的
 * 一半：couplet 會把它的中心線投影到「機車道 ↔ 對向主線」的中點，整條被拉進
 * 合體主線的路面裡（實測側距只剩 3～5m，主線半寬 10.3m → 全長壓在路面內）。
 * 機慢車道是主線外側的獨立車道，不是對向線，排除在配對之外。
 */
const QINAN_MOTO_LANE_IDS = new Set([25706466])

/**
 * 旗楠路／土庫一路口的 OSM 分向線在合體後留下數條重疊 block。只移除經人工
 * 點名且已驗證不承擔路口進出連接的區塊；其餘短接頭保留，避免切斷土庫一路。
 */
const QINAN_TUKU_REMOVED_BLOCKS = new Set([
  // 重疊主線：保留 way/271982114 的連續中心線。
  'way/25706466@b/1400036190',
  'way/25706466@b/8198448992',
  // 重疊主線：保留 way/25706464@b/1400036165。
  'way/25706466@b/1400036869',
  // 土庫一路主線合體會把 1400036869 重映射成 1400036531；仍是上面同一塊。
  'way/25706466@b/1400036531',
  // 不承擔必要轉向的碎塊；移除後四個土庫一路進出方向仍可達。
  'way/25706466@b/265591751',
  'way/24436713@b/280277447',
])

const blockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

/** Hide only the floating names on this pair of overlapping motorcycle-lane blocks. */
const HIDDEN_FLOATING_ROAD_LABEL_BLOCKS = new Set([
  'way/776417983@b/1196964599',
  'way/103679020@b/1196964599',
])

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
    if (NO_COUPLET_ROADS.has(p.name)) continue
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

/**
 * 跨區界的 way 會同時出現在兩份行政區 shard 裡（楠梓 3184＋左營 2351 = 5535，
 * 其中 57 個分段兩邊都有），build_static_road_database.mjs 只是直接串接，於是
 * 同一條路載入後就是兩個幾何完全相同的物件。切塊後放大成 410 組重複區塊鍵，
 * 每一份各自套用 journal 覆寫、各自畫中央帶——畫面上就是整段雙重黃線與交叉斜紋。
 *
 * 就地移除，回傳移除筆數。必須排在 applyFixups 之前：後面每一個階段（couplet
 * 合併、切塊、標線生成）都會把重複放大。
 */
function dedupeIdenticalWays(roads: RoadFeature[]): number {
  const seen = new Map<string, string>()
  let removed = 0
  for (let i = roads.length - 1; i >= 0; i--) {
    const r = roads[i]
    const id = `${r.properties.osm_id}#${r.properties.splitIndex ?? 0}`
    const shape = JSON.stringify(r.geometry.coordinates)
    const prev = seen.get(id)
    if (prev === undefined) { seen.set(id, shape); continue }
    // 只丟幾何完全相同的那一份；同 id 但幾何不同是真的分段，不能動
    if (prev !== shape) continue
    roads.splice(i, 1)
    removed++
  }
  return removed
}

/** 載入後的完整前處理。輸入會被就地修改，回傳切塊後的新陣列。 */
export function prepareBaseRoads(raw: RoadFeature[]): BasePrep {
  // 去重暫時停用：2026-07-29 實測會把軍校路整條移除、journal 孤兒 8→46、
  // 並讓 7 筆 deleted:1 失效（被刪的路段復活）。判定條件顯然不只命中那 57 條
  // 跨區重複，根因釐清前不可啟用。
  void dedupeIdenticalWays
  applyFixups(raw)
  const nodeRemap = new Map<number, number>()
  const wayRemap = new Map<number, DropRemap>()
  // 藍田路 = 2+2+中央 3.2m 偏心帶（槽化）；大學南路 = 2+2+機車道+實體島，
  // 島寬由 OSM 兩線實際間距反推（「把道路切開放入」，不擠壓車道）
  let roads = mergeCouplets(
    raw.filter((r) => !REMOVED_WAY_IDS.has(r.properties.osm_id)),
    new Set(['藍田路']), undefined, nodeRemap, wayRemap,
  )
  roads = mergeCouplets(roads, new Set(['大學南路']), {
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
  // 旗楠路的 primary 是一組連續分向幹道；同名 residential 短側線不是對向主線，
  // 若整個路名一起分組會觸發「同向並排」防呆而整條不合併。
  // 機慢車道同樣是 primary，但不是對向主線（見 QINAN_MOTO_LANE_IDS）。
  roads = mergeCouplets(roads, new Set(['旗楠路']), {
    lanesF: 2, lanesB: 2, centerM: 0.6, centerKind: 'hatch',
    centerFromGap: { roadW: 6.4, min: 0.6, max: 3.2 },
  }, nodeRemap, wayRemap, (r) => r.properties.highway === 'primary'
    && !QINAN_MOTO_LANE_IDS.has(r.properties.osm_id))
  roads = mergeCouplets(roads, new Set(['土庫一路']), {
    lanesF: 3, lanesB: 3, centerM: 0.6, centerKind: 'hatch',
    centerFromGap: { roadW: 9.6, min: 0.6, max: 3.2 },
  }, nodeRemap, wayRemap, (r) => TUKU_MAINLINE_IDS.has(r.properties.osm_id))
  // 外環西路/德民路：主慢分離（見 MAINLINE_ONLY_ROADS）——
  // 主線合併成 2+2＋機車道＋快慢分隔島（寬度可編輯），再吸收慢車道 way
  for (const ids of CUEIHUA_MAINLINE_PAIRS) {
    roads = mergeCouplets(roads, new Set(['翠華路']), {
      ...SIMPLE_SECTION,
      motoF: true, motoB: true, motoSepF: 1.0, motoSepB: 1.0,
    }, nodeRemap, wayRemap, (r) => ids.has(r.properties.osm_id))
  }
  roads = absorbSideWays(roads, '翠華路', nodeRemap, wayRemap)
  for (const ids of JIANNAN_PAIRS) {
    roads = mergeCouplets(roads, new Set(['建楠路']), SIMPLE_SECTION,
      nodeRemap, wayRemap, (r) => ids.has(r.properties.osm_id))
  }
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
  // 分隔道路合併後，將人工確認的雙節點路口收斂成單一十字中心。
  collapseKnownIntersections(roads, nodeRemap)
  // 高雄大學路「不」做 couplet 合併：四線並排林蔭大道（主慢分離），
  // 分隔島由 medians.ts TWIN_ISLAND_PAIRS 顯式配對生成
  applyLantianSections(roads) // 745巷以東 = 東三西二、無中央帶
  // 依路口切塊：車道/中央帶/轉向編輯的最小單位 = 路口到路口（journal 區塊鍵）
  let blocks = splitAtIntersections(roads)
  blocks = blocks.filter((road) => !QINAN_TUKU_REMOVED_BLOCKS.has(blockKey(road)))
  for (const road of blocks) {
    if (HIDDEN_FLOATING_ROAD_LABEL_BLOCKS.has(blockKey(road))) {
      road.properties.hideRoadLabel = true
    }
  }
  blocks = removeUnnamedShortSpurs(blocks).roads
  collapseShortDeadEnds(blocks)
  // 高架旗標：地面車道級渲染（路面/分隔線/印字/單行箭頭）略過這些區塊，
  // 改由 elevated3d 的 3D 橋面全長取代（含近地爬升段）
  for (const r of blocks) {
    if (isElevated(r.properties)) r.properties.elevated = true
  }
  return { roads: blocks, nodeRemap, wayRemap }
}
