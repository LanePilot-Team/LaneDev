// 導航指引線貼橋面審計（npm run audit:route-ribbon）：
// 藍色路線帶在高架段是由 ElevatedLayer.setRoute 建 3D 絲帶貼在橋面上，平面段才
// 交給 MapLibre 畫在地面。setRoute 逐點問「這個取樣點的橋面多高」，而它拿到的
// RoadFeature 來自「導航視圖」routingRoads——橋面與高度模型卻建在 renderRoads 上。
// buildRoadMergeViews 讓兩份視圖各自 clone，物件完全不共用，所以任何以物件為鍵的
// 查表都會 miss，高度一律回 0、整條藍線被判成平面段沉到橋面下（2026-08-05 實測
// 150/150 高架區塊全中）。本審計走完整條真實路徑，確認指引線真的在橋面上：
//   1. 與 app 相同接線：routingRoads 建路網圖、renderRoads 建高度模型與橋面
//   2. 對每座高架跑一條真實路線，呼叫真正的 setRoute
//   3. 斷言：span 落在高架上的取樣點必須被 3D 絲帶接手（不在回傳的平面段裡），
//      且高度等於橋面高度
// deck_audit 是另一件事——它比對 surfaceHeightAt 與橋面 mesh，而且讀的是舊的
// lanepilot shard，不會發現這裡的視圖錯配。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph, laneBand, laneChoiceAreas, spanAtDist } from '../src/core/graph'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { buildElevation, setActiveElevation } from '../src/core/elevation'
import { ElevatedLayer, setActiveElevatedLayer, surfaceHeightAt } from '../src/core/elevated3d'
import { foldJournal, applyToRoads } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback
const databasePath = argument('db', join(HERE, '../public/data/road_database.json'))

const db = JSON.parse(readFileSync(databasePath, 'utf8'))
const parsed = parseImported(db.segments.map((record: unknown) => JSON.stringify(record)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))

// app 的接線（mapCore.refreshRoadMergeViews）：導航吃 routingRoads，
// 高度模型與 3D 橋面吃 renderRoads
const view = buildRoadMergeViews(roads.filter((r) => !r.properties.deleted), journal)
const graph = new RoadGraph(view.routingRoads)
const model = buildElevation(view.renderRoads)
setActiveElevation(model)
const layer = new ElevatedLayer()
layer.setModel(model)
setActiveElevatedLayer(layer)

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) failures++
}
const label = (r: RoadFeature) =>
  `${r.properties.name ?? '(無名)'} way/${r.properties.osm_id}@b/${r.properties.nodes[0]}`

const elevatedRouting = view.routingRoads.filter((r) => r.properties.elevated)
console.log(`底圖：${roads.length} 區塊；導航視圖高架 ${elevatedRouting.length}`
  + `／渲染視圖高架 ${view.renderRoads.filter((r) => r.properties.elevated).length}`)
console.log('兩份視圖共用的高架物件：'
  + `${elevatedRouting.filter((r) => new Set(view.renderRoads).has(r)).length}`
  + `（0 = 物件不共用，任何以物件為鍵的查表都必須有 way id 退路）`)

// ── 1. 高度來源以「導航視圖的物件」查得到 ───────────────────────────────────
const MID = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs[Math.floor(cs.length / 2)]
}
const lost: string[] = []
for (const r of elevatedRouting) {
  const pos = MID(r)
  const viaRouting = surfaceHeightAt(r, pos)
  // 對照：同 way 同起點的渲染區塊——橋面真正的高度
  const twin = view.renderRoads.find((x) => x.properties.elevated
    && x.properties.osm_id === r.properties.osm_id
    && x.properties.nodes[0] === r.properties.nodes[0])
  const truth = twin ? surfaceHeightAt(twin, pos) : null
  if (truth !== null && truth > 0.05 && Math.abs(viaRouting - truth) > 0.1) {
    lost.push(`${label(r)} 導航視圖查得 ${viaRouting.toFixed(2)}m、橋面 ${truth.toFixed(2)}m`)
  }
}
check('用導航視圖的路段查橋面高度與渲染視圖一致', lost.length === 0,
  lost.length ? `${lost.length}/${elevatedRouting.length} 段不符\n   ${lost.slice(0, 10).join('\n   ')}`
    : `${elevatedRouting.length} 段全部一致`)

// ── 2. 真實路線：跨橋取樣點必須被 3D 絲帶接手且貼在橋面上 ──────────────────
// 每座高架取一條「起點前 → 終點後」的路線，跑真正的 setRoute。
const structures = new Map<number, RoadFeature[]>()
for (const r of elevatedRouting) {
  const id = r.properties.osm_id
  if (!structures.has(id)) structures.set(id, [])
  structures.get(id)!.push(r)
}
let planned = 0
let sampledOnDeck = 0
const sunk: string[] = []
const mismatched: string[] = []
for (const [, blocks] of structures) {
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const from = (first.geometry.coordinates as [number, number][])[0]
  const toCs = last.geometry.coordinates as [number, number][]
  const to = toCs[toCs.length - 1]
  const route = graph.route(from, to, 'car')
  if (!route) continue
  const band = laneBand(route)
  if (band.coords.length < 2) continue
  planned++
  const ground = layer.setRoute(route, band)
  // 回傳的平面段折線點集合——落在這裡代表 MapLibre 會把它畫在地面
  const groundPts = new Set(ground.flat().map((c) => `${c[0]},${c[1]}`))
  for (let i = 0; i < band.coords.length; i++) {
    const span = spanAtDist(route, band.routeD[i])
    const road = span?.road
    if (!road?.properties.elevated) continue
    // 「這裡的橋面多高」由渲染視圖的孿生區塊回答（橋面 mesh 就建在它上面）——
    // 不能拿受測的導航視圖查詢當基準，否則它壞掉時整批取樣點會被判成「在地面」
    // 而悄悄跳過，審計就永遠是綠的
    const twin = view.renderRoads.find((x) => x.properties.elevated
      && x.properties.osm_id === road.properties.osm_id
      && x.properties.nodes[0] === road.properties.nodes[0])
    if (!twin) continue
    const truth = surfaceHeightAt(twin, band.coords[i])
    if (truth <= 0.05) continue // 接地爬升段，本來就在地面
    sampledOnDeck++
    const viaRouting = surfaceHeightAt(road, band.coords[i]) // setRoute 實際用的值
    if (groundPts.has(`${band.coords[i][0]},${band.coords[i][1]}`) && sunk.length < 8) {
      sunk.push(`${label(road)} 取樣點 ${i} 橋面 ${truth.toFixed(2)}m`
        + `／指引線查得 ${viaRouting.toFixed(2)}m，被丟給平面圖層`)
    }
    if (Math.abs(viaRouting - truth) > 0.1 && mismatched.length < 8) {
      mismatched.push(`${label(road)} 指引線 ${viaRouting.toFixed(2)}m vs 橋面 ${truth.toFixed(2)}m`)
    }
  }
  layer.setRoute(null)
}
check('跑得出跨高架的路線（否則本審計沒有量測到東西）', planned > 0 && sampledOnDeck > 0,
  `${planned} 條路線、橋面上取樣 ${sampledOnDeck} 點`)
check('橋面上的指引線取樣點沒有被丟回平面圖層（沉到橋下）', sunk.length === 0,
  sunk.length ? `${sunk.length} 點\n   ${sunk.join('\n   ')}` : '0 點')
check('指引線高度等於橋面高度', mismatched.length === 0,
  mismatched.length ? `${mismatched.length} 點\n   ${mismatched.join('\n   ')}` : '全部相符')

// ── 3. 候選車道區（半透明車道平面）在橋面上也要有 ─────────────────────────
// 指引線與候選車道區是兩條各自獨立的路徑：setRoute 建藍帶、addRouteChoiceAreas 建
// 半透明平面。前者綠燈不代表後者也在——2 的斷言完全碰不到候選車道區。
// 這裡同樣跑真正的 addRouteChoiceAreas，並且檢查它真的產出**可繪製**的 mesh：
// 只要有一個頂點是 NaN，three 的 bounding sphere 就是 NaN，整個 mesh 會被視錐
// 剔除——畫面上是整片不見，而且不會有任何錯誤訊息。
interface LayerInternals {
  routeGroup: { children: { geometry?: { boundingSphere?: { radius: number } | null;
    computeBoundingSphere?: () => void; getAttribute: (n: string) => { count: number } } }[] }
}
const internals = layer as unknown as LayerInternals
let choiceRoutes = 0
let choiceOnDeck = 0
let choiceMeshes = 0
let choiceVerts = 0
const choiceSunk: string[] = []
const nanMeshes: string[] = []
for (const [, blocks] of structures) {
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const from = (first.geometry.coordinates as [number, number][])[0]
  const toCs = last.geometry.coordinates as [number, number][]
  const to = toCs[toCs.length - 1]
  const route = graph.route(from, to, 'car')
  if (!route) continue
  const band = laneBand(route)
  if (band.coords.length < 2) continue
  const choices = laneChoiceAreas(route)
  if (choices.length === 0) continue
  layer.setRoute(route, band)
  const before = internals.routeGroup.children.length
  const groundChoices = layer.addRouteChoiceAreas(route, choices)
  const added = internals.routeGroup.children.slice(before)
  // 這條路線的候選車道區有沒有取樣點落在橋面上
  let onDeck = 0
  for (const choice of choices) {
    for (let i = 0; i < choice.routeD.length; i++) {
      const road = spanAtDist(route, choice.routeD[i])?.road
      if (!road?.properties.elevated) continue
      const twin = view.renderRoads.find((x) => x.properties.elevated
        && x.properties.osm_id === road.properties.osm_id
        && x.properties.nodes[0] === road.properties.nodes[0])
      if (!twin) continue
      const mid: [number, number] = [
        (choice.left[i][0] + choice.right[i][0]) / 2,
        (choice.left[i][1] + choice.right[i][1]) / 2,
      ]
      if (surfaceHeightAt(twin, mid) <= 0.05) continue
      onDeck++
      // 落在回傳的平面區裡 = 被丟回 MapLibre，會畫在橋下的地面上
      if (groundChoices.some((g) => g.routeD.includes(choice.routeD[i]))
        && choiceSunk.length < 8) {
        choiceSunk.push(`${label(road)} 候選車道區取樣點 ${i} 在橋面上卻被丟給平面圖層`)
      }
    }
  }
  if (onDeck > 0) {
    choiceRoutes++
    choiceOnDeck += onDeck
    choiceMeshes += added.length
    for (const mesh of added) {
      const geometry = mesh.geometry
      if (!geometry) continue
      choiceVerts += geometry.getAttribute('position')?.count ?? 0
      geometry.computeBoundingSphere?.()
      const radius = geometry.boundingSphere?.radius
      if (!(typeof radius === 'number' && Number.isFinite(radius)) && nanMeshes.length < 8) {
        nanMeshes.push(`${label(first)} 候選車道區 mesh 的 bounding sphere = ${radius}（會被整片剔除）`)
      }
    }
  }
  layer.setRoute(null)
}
check('跑得出「候選車道區落在橋面上」的路線（否則本節沒量到東西）',
  choiceRoutes > 0 && choiceOnDeck > 0,
  `${choiceRoutes} 條路線、橋面上取樣 ${choiceOnDeck} 點`)
check('橋面上的候選車道區沒有被丟回平面圖層', choiceSunk.length === 0,
  choiceSunk.length ? `${choiceSunk.length} 點\n   ${choiceSunk.join('\n   ')}` : '0 點')
check('候選車道區真的建出可繪製的 3D mesh（頂點無 NaN）',
  choiceMeshes > 0 && nanMeshes.length === 0,
  nanMeshes.length ? `${nanMeshes.length} 片壞掉\n   ${nanMeshes.join('\n   ')}`
    : `${choiceMeshes} 片、${choiceVerts} 個頂點`)

console.log(failures ? `\n❌ ${failures} 項未通過` : '\n✅ 全數通過')
process.exit(failures ? 1 : 0)
