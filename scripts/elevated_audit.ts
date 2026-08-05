// 高架清單審計（npm run audit:elevated）：ELEVATED_WAY_IDS 是人工清單，漏一條 way
// 就會在橋中央留下「橋面斷在半空、該段照畫地面標線、導航貼地穿過橋墩」的破口
// （way/103679008 高楠陸橋南端、way/230213636 等機車高架續行段都是這樣被發現的）。
// 三項檢查：
//   A. 橋面中斷——高架區塊的端節點接到「自己也是 bridge/layer 卻沒被抬」的區塊：
//      同一座橋被 OSM 切成多條 way 而清單只收了幾條。漏列最直接的症狀，主檢查。
//   B. 疑似漏列——bridge=yes/layer>0 但不在清單，且底下真的有別條路穿過
//      （檔頭判準：跨河橋與路面同高，不能只看 bridge 標籤；「底下有路穿過」
//      才是立體交叉的證據）。只穿越 motorway 的不算——國道被無條件抬成高架，
//      層級關係本來就無法用 layer 表達（例：中路巷 way/297229540 跨越中山高）。
//   C. 清單失效——清單裡的 way id 在底圖找不到（OSM 更新或 couplet 合併換 id）。
//   D. 橋面路段殘留地面圖徵——高架的標線由 elevated3d 畫在橋面上，任何 builder
//      若沒擋 p.elevated，就會在橋「底下」多鋪一份中央島/停等格/箭頭，導航時
//      看起來像一條錯位的底層道路（buildCenterIslands、buildMotoBoxes 實例）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import {
  buildDividers, buildRoadSurfaces, roadsForRendering, roadsFromGeoJSON, type RoadFeature,
} from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import {
  buildChannelization, buildLaneArrows, buildLeftTurnWaitingAreas, buildMotoBoxes,
  buildMotoLaneEntryIcons, buildRightLanes, buildSpecifiedWhiteMotoHatch, buildStopLines,
  buildTurnBays,
} from '../src/core/turnbays'
import {
  buildCenterIslands, buildMedians, buildMotoSepIslands, buildTwinIslands,
} from '../src/core/medians'
import { buildRoadLabelLines, buildRoadTexts, roadTextObstacles } from '../src/core/roadtext'
import {
  AT_GRADE_BRIDGE_WAY_IDS, buildElevation, ELEVATED_WAY_IDS, isElevated,
} from '../src/core/elevation'
import { cumulative } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback
const databasePath = argument('db', join(HERE, '../public/data/road_database.json'))

const db = JSON.parse(readFileSync(databasePath, 'utf8'))
const parsed = parseImported(db.segments.map((record: unknown) => JSON.stringify(record)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads, wayRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const model = buildElevation(roads)

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) failures++
}
const key = (r: RoadFeature) =>
  `way/${r.properties.osm_id}@b/${r.properties.nodes[0]}`
const label = (r: RoadFeature) =>
  `${r.properties.name ?? '(無名)'} ${key(r)}`

const elevated = roads.filter((r) => r.properties.elevated)
const ground = roads.filter((r) => !r.properties.elevated)
console.log(`底圖：${roads.length} 區塊，其中高架 ${elevated.length}`)

// ── A. 橋面中斷 ─────────────────────────────────────────────────────────────
// 高架區塊的端節點接到一個「自己也是 bridge/layer 但沒被抬」的區塊 ⇒ 同一座橋
// 在 OSM 被切成多條 way，清單只收了其中幾條。真正的落地端接的是無 bridge 標籤的
// 引道，所以這個訊號幾乎沒有誤判。兩種現象都由它涵蓋：
//   高度 > 0 → 橋面斷在半空（way/103679008 漏列時 node/1196964578 是 6m 對 0m）
//   高度 = 0 → 橋提早接地、續行段照畫地面標線（way/230213636 那條機車高架）
const bridgeTagged = (r: RoadFeature) =>
  r.properties.bridge === 'yes' || r.properties.bridge === 'viaduct' || r.properties.layer > 0
const groundBridgeByNode = new Map<number, RoadFeature[]>()
for (const r of ground) {
  if (!bridgeTagged(r)) continue
  for (const n of r.properties.nodes) {
    if (!groundBridgeByNode.has(n)) groundBridgeByNode.set(n, [])
    groundBridgeByNode.get(n)!.push(r)
  }
}
const truncations: string[] = []
for (const r of elevated) {
  const cum = cumulative(r.geometry.coordinates as [number, number][])
  const lenM = cum[cum.length - 1]
  const ends = [
    { n: r.properties.nodes[0], d: 0, side: '起' },
    { n: r.properties.nodes[r.properties.nodes.length - 1], d: lenM, side: '迄' },
  ]
  for (const e of ends) {
    for (const g of groundBridgeByNode.get(e.n) ?? []) {
      truncations.push(
        `${label(r)} ${e.side}端 node/${e.n}（橋面 ${model.heightAt(r, e.d).toFixed(1)}m）`
        + ` → 續行 ${label(g)} bridge=${g.properties.bridge ?? '-'} layer=${g.properties.layer} 未列`)
    }
  }
}
check('橋面沒有在「續行段也是橋」的地方中斷', truncations.length === 0,
  truncations.length ? `${truncations.length} 處\n   ${truncations.join('\n   ')}` : '0 處')

// ── B. 疑似漏列 ─────────────────────────────────────────────────────────────
const isCandidate = (r: RoadFeature) => !isElevated(r.properties) &&
  !AT_GRADE_BRIDGE_WAY_IDS.has(r.properties.osm_id) && bridgeTagged(r)
const properCross = (
  a: [number, number], b: [number, number], c: [number, number], d: [number, number],
) => {
  const side = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  const s1 = side(a, b, c), s2 = side(a, b, d), s3 = side(c, d, a), s4 = side(c, d, b)
  return s1 !== s2 && s3 !== s4 && s1 !== 0 && s2 !== 0 && s3 !== 0 && s4 !== 0
}
const boxOf = (r: RoadFeature) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of r.geometry.coordinates as [number, number][]) {
    x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1])
    x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1])
  }
  return [x0, y0, x1, y1] as const
}
const boxes = new Map(roads.map((r) => [r, boxOf(r)]))
const suspects: string[] = []
for (const c of roads.filter(isCandidate)) {
  const cb = boxes.get(c)!
  const cn = new Set(c.properties.nodes)
  const cc = c.geometry.coordinates as [number, number][]
  const under = new Set<string>()
  for (const g of roads) {
    if (g === c || g.properties.layer >= c.properties.layer) continue
    // 國道被無條件抬高，layer 關係無法表達 → 不能當立體交叉的證據
    if (g.properties.highway === 'motorway' || g.properties.highway === 'motorway_link') continue
    const gb = boxes.get(g)!
    if (gb[0] > cb[2] || gb[2] < cb[0] || gb[1] > cb[3] || gb[3] < cb[1]) continue
    if (g.properties.nodes.some((n) => cn.has(n))) continue
    const gc = g.geometry.coordinates as [number, number][]
    outer: for (let i = 1; i < cc.length; i++) for (let j = 1; j < gc.length; j++) {
      if (properCross(cc[i - 1], cc[i], gc[j - 1], gc[j])) { under.add(label(g)); break outer }
    }
  }
  if (under.size) suspects.push(`${label(c)} layer=${c.properties.layer} 底下：${[...under].join('、')}`)
}
check('bridge/layer 路段沒有「底下有路穿過卻不在清單」的', suspects.length === 0,
  suspects.length ? `${suspects.length} 條\n   ${suspects.join('\n   ')}` : '0 條')

// ── C. 清單失效 ─────────────────────────────────────────────────────────────
// couplet 合併的 drop 側整條併入 keep 幾何、osm_id 從底圖消失，這是預期的
// （檔頭：「掉出清單也無妨」），所以用 wayRemap 認回來，只有兩邊都查無的才算失效。
const present = new Set(roads.map((r) => r.properties.osm_id))
const stale = [...ELEVATED_WAY_IDS].filter((id) =>
  !present.has(id) && !(wayRemap.get(id)?.keepIds ?? []).some((keep) => present.has(keep)))
check('清單裡的 way 都還在底圖上（couplet drop 側以 keep 側認定）', stale.length === 0,
  stale.length ? `失效 ${stale.length} 筆：${stale.join(', ')}` : `${ELEVATED_WAY_IDS.size} 筆全在`)

// ── D. 橋面路段殘留地面圖徵 ─────────────────────────────────────────────────
// 與 mapCore.refreshBays 同一組 builder、同一組參數，逐項比對輸出的 key 是否
// 指向高架 way。key 一律含 `way/<id>`（median/way/W/k、way/W@node/N~m …）。
const graph = new RoadGraph(roads)
const bays = buildTurnBays(graph, journal)
const rightLanes = buildRightLanes(graph, journal)
const stopLines = buildStopLines(graph, bays, rightLanes, journal)
const motoBoxes = buildMotoBoxes(graph, bays, rightLanes, journal)
const laneArrows = buildLaneArrows(
  graph, bays, rightLanes, motoBoxes.dirs, journal, stopLines)
const motoEntry = buildMotoLaneEntryIcons(graph, journal)
const renderRoads = roadsForRendering(roads)
const texts = buildRoadTexts(graph, bays, rightLanes, roadTextObstacles({
  arrows: laneArrows, motoEntryIcons: motoEntry.features, stopLines, motoBoxes: motoBoxes.boxes,
}))
const elevatedWays = new Set(elevated.map((r) => r.properties.osm_id))
const wayOfKey = (k: unknown) => {
  const m = /way\/(\d+)/.exec(String(k ?? ''))
  return m ? Number(m[1]) : null
}
const surfaces: [string, unknown[]][] = [
  ['中央島 buildMedians', buildMedians(renderRoads).map((i) => i.key)],
  ['中央島 buildTwinIslands', buildTwinIslands(renderRoads, journal).map((i) => i.key)],
  ['快慢分隔島 buildMotoSepIslands', buildMotoSepIslands(graph).map((i) => i.key)],
  ['中央島 buildCenterIslands', buildCenterIslands(graph, bays).map((i) => i.key)],
  ['槽化 buildChannelization', buildChannelization(graph, bays).map((p) => p.ownerKey)],
  ['機車白斜紋 buildSpecifiedWhiteMotoHatch',
    buildSpecifiedWhiteMotoHatch(graph).map((p) => p.ownerKey)],
  ['停止線 buildStopLines', stopLines.map((p) => p.ownerKey)],
  ['左轉待轉區 buildLeftTurnWaitingAreas',
    buildLeftTurnWaitingAreas(graph, bays).map((p) => p.ownerKey)],
  ['機車停等格 buildMotoBoxes', motoBoxes.boxes.map((b) => (b as { key?: string }).key)],
  ['機車道入口 buildMotoLaneEntryIcons', motoEntry.features.map((f) => f.properties?.key)],
  ['偏心左轉道 buildTurnBays', bays.map((b) => (b as { key?: string }).key)],
  ['右轉專用道 buildRightLanes', rightLanes.map((r) => (r as { key?: string }).key)],
  ['路面印字 buildRoadTexts', texts.features.map((f) => f.properties?.key)],
  ['路名 buildRoadLabelLines',
    buildRoadLabelLines(renderRoads, []).features.map((f) => f.properties?.key)],
  ['路面 buildRoadSurfaces', buildRoadSurfaces(roads).features.map((f) => f.properties?.key)],
  ['分向線 buildDividers', buildDividers(roads).features.map((f) => f.properties?.key)],
]
const strays: string[] = []
for (const [name, keys] of surfaces) {
  const bad = keys.filter((k) => {
    const w = wayOfKey(k)
    return w !== null && elevatedWays.has(w)
  })
  if (bad.length) strays.push(`${name}：${bad.length}/${keys.length} 筆 ${[...new Set(bad)].slice(0, 4).join(' ')}`)
}
check('高架區塊沒有殘留地面圖徵', strays.length === 0,
  strays.length ? `${strays.length} 個 builder\n   ${strays.join('\n   ')}` : `${surfaces.length} 個 builder 全乾淨`)

// 對照組：量測有鑑別力——把清單清空後，A/B 兩項必須大量報錯
check('對照組確實抓得到問題（量測有鑑別力）',
  roads.some((r) => r.properties.bridge === 'yes' && !r.properties.elevated),
  '底圖存在「bridge=yes 但不抬」的路段（跨河平面橋），判準不是把 bridge 一律當高架')

console.log(failures ? `\n❌ ${failures} 項未通過` : '\n✅ 全數通過')
process.exit(failures ? 1 : 0)
