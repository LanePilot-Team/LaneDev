// 路線帶/車輛上橋稽核（npm run audit:route-deck）
//
// 2026-08-12「藍線在地面不在橋上」「車跑底下了」的回歸防線。
//
// 根因是**雙視圖的物件身分**：道路捏合把底圖拆成兩份——路網圖用 routingRoads、
// 繪圖用 renderRoads，後者是前者的完整複製（roadMerge.replayRoadMerges 的
// roads.map(cloneRoad)），兩份沒有任何共用物件。高度模型與橋面剖面建在
// renderRoads 上（mapCore rebuildElevation(renderRoadsRef)），但路線帶與車輛
// 拿到的是路網圖那份的 RoadFeature。查表以物件參考當 key 就一定 miss，
// heightAtPos 回 0 → 整條藍線留在地面、導航自車與放置車輛也留在地面。
//
// 既有稽核抓不到這個：它們都只建**一份**底圖，物件自然對得上。所以這支刻意
// 照 mapCore 的順序接兩份視圖，再從「路網圖那份」問高度。
//
// 檢查三件事：
//   1. 兩份視圖確實是不同物件（前提成立，否則這支就失去意義）
//   2. 拿路網圖的高架區塊問 surfaceHeightAt / deckHeightAt 查得到高度
//   3. 跨橋路線的路線帶在高架段確實抬起來（落地端邊界點允許貼地）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildElevation, setActiveElevation } from '../src/core/elevation'
import { ElevatedLayer, setActiveElevatedLayer, surfaceHeightAt } from '../src/core/elevated3d'
import { RoadGraph, spanAtDist, laneBand, type Profile } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { cumulative, pointAlong } from '../src/core/geo'

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

const HERE = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported((db.segments as unknown[]).map((r) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const base = roads.filter((r) => !r.properties.deleted)

// ── 照 mapCore.refreshRoadMergeViews 的順序接線 ──
const view = buildRoadMergeViews(base, journal)
const routingRoads = view.routingRoads
const renderRoads = view.renderRoads
const graph = new RoadGraph(routingRoads)
const model = buildElevation(renderRoads)
setActiveElevation(model)
const layer = new ElevatedLayer()
layer.setModel(model)
setActiveElevatedLayer(layer)

const shared = routingRoads.filter((r) => renderRoads.includes(r)).length
check('兩份視圖是不同物件（這支稽核的前提）', shared === 0,
  `routing ${routingRoads.length}／render ${renderRoads.length}／共用 ${shared}`)

// ── 2. 拿路網圖那份的高架區塊問高度 ──
const routingDecks = routingRoads.filter((r) => r.properties.elevated)
check('路網圖那份有高架區塊', routingDecks.length > 0, `${routingDecks.length} 區塊`)
let zeroDeck = 0
let nullProfile = 0
for (const r of routingDecks) {
  const cs = r.geometry.coordinates as [number, number][]
  if (cs.length < 2) continue
  const cum = cumulative(cs)
  const lenM = cum[cum.length - 1]
  if (lenM < 20) continue // 太短的區塊整段都在落地漸變裡，本來就可能是 0
  const mid = pointAlong(cs, cum, lenM / 2).pos as [number, number]
  if (surfaceHeightAt(r, mid) <= 0.05) zeroDeck++
  if (layer.deckHeightAt(r, mid) === null) nullProfile++
}
check('路網圖的高架區塊查得到橋面剖面（deckHeightAt 非 null）',
  nullProfile === 0, `${nullProfile} 個查不到`)
check('路網圖的高架區塊查得到高度（surfaceHeightAt > 0）',
  zeroDeck === 0, `${zeroDeck} 個回傳 0`)

// ── 3. 跨橋路線的路線帶要抬起來 ──
const midOf = (osmId: number, frac = 0.5): [number, number] | null => {
  const r = routingRoads.find((x) => x.properties.osm_id === osmId)
  if (!r) return null
  const cs = r.geometry.coordinates as [number, number][]
  const cum = cumulative(cs)
  return pointAlong(cs, cum, cum[cum.length - 1] * frac).pos as [number, number]
}
const CASES: { name: string; from: number; to: number; bridge: number; profile: Profile }[] = [
  { name: '高楠陸橋（高楠公路南→北）', from: 268219245, to: 280277105, bridge: 23939182, profile: 'car' },
  { name: '楠陽高架橋（楠陽路）', from: 1495039673, to: 103678997, bridge: 103678964, profile: 'car' },
  { name: '德民新橋（Demo 路線會經過）', from: 280277090, to: 271982129, bridge: 126247872, profile: 'car' },
]
for (const c of CASES) {
  const from = midOf(c.from), to = midOf(c.to)
  if (!from || !to) { check(`${c.name}：找得到起訖路段`, false, `way/${c.from} 或 way/${c.to} 不存在`); continue }
  const route = graph.route(from, to, c.profile)
  if (!route) { check(`${c.name}：規劃得出路線`, false); continue }
  const band = laneBand(route)
  let onBridge = 0, lifted = 0, max = 0
  for (let i = 0; i < band.coords.length; i++) {
    const road: RoadFeature | undefined = spanAtDist(route, band.routeD[i])?.road
    if (road?.properties.osm_id !== c.bridge) continue
    onBridge++
    const h = surfaceHeightAt(road, band.coords[i])
    max = Math.max(max, h)
    if (h > 0.05) lifted++
  }
  if (!onBridge) { check(`${c.name}：路線有走上 way/${c.bridge}`, false, '沒走上去'); continue }
  // 兩端落地漸變允許貼地，抓「整段沒抬起來」這種失效
  check(`${c.name}：路線帶抬到橋面上`, lifted >= onBridge - 3,
    `${lifted}/${onBridge} 點抬起，最高 ${max.toFixed(1)}m`)
}

console.log(fails === 0
  ? '\n全部通過——路線帶與車輛在雙視圖下仍查得到橋面高度'
  : `\n${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
