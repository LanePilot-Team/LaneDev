// 路由禁行審計（npx tsx scripts/route_audit.ts）：
// 驗證 A* 對兩種車種都不會走進禁行路段：
//   汽車：motorcar=no（機車專用道路體，如高雄大學路機車道）或該方向汽車車道 0
//   機車：motorway/motorway_link 或 motorcycle=no
// 方法：底圖管線與 app 相同（prepareBaseRoads + seed journal），全路網隨機取
// N 對點路由，把路線的相鄰座標對與禁行邊的座標對比對（方向敏感）。
// 審計工具自我驗證：先確認機車路線「會」壓過 motorcar=no 邊（偵測機制有效），
// 再驗證汽車路線 0 命中——避免「比對永遠不中」的假陰性。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, mergeMaps } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph, carAllowed, motoAllowed, type RouteResult } from '../src/core/graph'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')

// ── 底圖管線（同 mapCore：shard → prepareBaseRoads → seed journal）──
const shards = ['lanepilot/area_4212599.segments.jsonl', 'lanepilot/area_4212683.segments.jsonl']
  .map((f) => parseImported(readFileSync(join(DATA, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: never }[]
const fc = mergeMaps(shards).fc
const { roads } = prepareBaseRoads(roadsFromGeoJSON(fc))
const seed: EnhancementRecord[] = JSON.parse(readFileSync(join(DATA, 'seed_journal.json'), 'utf8'))
applyToRoads(roads, foldJournal(seed))
const graph = new RoadGraph(roads)
console.log(`底圖：${roads.length} 區塊（含 seed journal ${seed.length} 筆）`)

// ── 禁行邊座標對索引（方向敏感）──
const key = (a: [number, number], b: [number, number]) =>
  `${a[0].toFixed(7)},${a[1].toFixed(7)}|${b[0].toFixed(7)},${b[1].toFixed(7)}`
const forbidCar = new Map<string, string>() // key → 描述（回報用）
const forbidMoto = new Map<string, string>()
let carBanBlocks = 0, motoBanBlocks = 0
for (const r of roads) {
  const p = r.properties
  const cs = r.geometry.coordinates as [number, number][]
  const fwdCarBan = p.motorcar === 'no' || p.lanesForward === 0
  const backCarBan = p.oneway === 'no' && (p.motorcar === 'no' || p.lanesBackward === 0)
  const motoBan = p.highway === 'motorway' || p.highway === 'motorway_link' || p.motorcycle === 'no'
  if (fwdCarBan || backCarBan) carBanBlocks++
  if (motoBan) motoBanBlocks++
  const desc = `${p.name ?? '(無名)'} way/${p.osm_id}` +
    ` [motorcar=${p.motorcar ?? '-'} f=${p.lanesForward} b=${p.lanesBackward} ${p.highway}]`
  for (let i = 0; i < cs.length - 1; i++) {
    if (fwdCarBan) forbidCar.set(key(cs[i], cs[i + 1]), desc)
    if (backCarBan) forbidCar.set(key(cs[i + 1], cs[i]), desc)
    if (motoBan) {
      forbidMoto.set(key(cs[i], cs[i + 1]), desc)
      forbidMoto.set(key(cs[i + 1], cs[i]), desc)
    }
  }
}
console.log(`汽車禁行區塊 ${carBanBlocks}（邊 ${forbidCar.size}）、機車禁行區塊 ${motoBanBlocks}（邊 ${forbidMoto.size}）`)
const kudaBan = roads.filter((r) => r.properties.name === '高雄大學路' && r.properties.motorcar === 'no')
console.log(`高雄大學路 motorcar=no 區塊：${kudaBan.length}（tag 有無被管線吃掉的直接證據）`)

// ── 路線檢查 ──
// 主要判定：span 身分比對（route.spans 帶每段的 road+方向，直接問 carAllowed/motoAllowed）。
// 座標對比對只當自我驗證用——重疊幾何（兩條路共用同一段節點鏈）會產生假警報。
function violations(route: RouteResult, profile: 'car' | 'moto'): string[] {
  const hits = new Set<string>()
  for (const sp of route.spans) {
    if (!sp.road) continue
    const ok = profile === 'moto' ? motoAllowed(sp.road) : carAllowed(sp.road, sp.back ?? false)
    if (!ok) {
      const p = sp.road.properties
      hits.add(`${p.name ?? '(無名)'} way/${p.osm_id}${sp.back ? '(逆向)' : ''}` +
        ` [motorcar=${p.motorcar ?? '-'} motorcycle=${p.motorcycle ?? '-'} f=${p.lanesForward} b=${p.lanesBackward} ${p.highway}]`)
    }
  }
  return [...hits]
}
function coordHits(coords: [number, number][], forbid: Map<string, string>): string[] {
  const hits = new Set<string>()
  for (let i = 0; i < coords.length - 1; i++) {
    const d = forbid.get(key(coords[i], coords[i + 1]))
    if (d) hits.add(d)
  }
  return [...hits]
}

// 取樣點：所有路口 + 每條路的中點（涵蓋非路口吸附）
const pts: [number, number][] = graph.intersections().map((i) => i.pos)
for (const r of roads) {
  const cs = r.geometry.coordinates as [number, number][]
  pts.push(cs[Math.floor(cs.length / 2)])
}
// 可重現的 LCG
let s = 42
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648

// ── 自我驗證：機車路線沿高雄大學路機車道走，必須命中 forbidCar 的偵測 ──
if (kudaBan.length > 0) {
  const cs = kudaBan[0].geometry.coordinates as [number, number][]
  const motoRoute = graph.route(cs[0], cs[cs.length - 1], 'moto')
  const wouldFlag = motoRoute ? coordHits(motoRoute.coords, forbidCar) : []
  console.log(`自我驗證（機車走機車道，car 禁行偵測應命中）：${wouldFlag.length > 0 ? 'OK 命中 ' + wouldFlag[0] : '❌ 未命中——比對機制失效或機車被繞開'}`)
  const carRoute = graph.route(cs[0], cs[cs.length - 1], 'car')
  if (carRoute) {
    const v = violations(carRoute, 'car')
    console.log(`定點案例（汽車沿機車道端點路由）：${v.length === 0 ? 'OK 汽車路線避開機車道' : '❌ ' + v.join('；')}`)
  } else console.log('定點案例：汽車無法成線（起終點吸附被禁行過濾後無入口）——可接受但要人工看一下')
}

// ── 大樣本隨機路由 ──
const N = 500
let carFail = 0, motoFail = 0, carNull = 0, motoNull = 0
const examples: string[] = []
for (let i = 0; i < N; i++) {
  const a = pts[Math.floor(rnd() * pts.length)]
  const b = pts[Math.floor(rnd() * pts.length)]
  if (a === b) continue
  const car = graph.route(a, b, 'car')
  if (!car) carNull++
  else {
    const v = violations(car, 'car')
    if (v.length) { carFail++; if (examples.length < 8) examples.push(`car ${a} → ${b}: ${v.join('；')}`) }
  }
  const moto = graph.route(a, b, 'moto')
  if (!moto) motoNull++
  else {
    const v = violations(moto, 'moto')
    if (v.length) { motoFail++; if (examples.length < 8) examples.push(`moto ${a} → ${b}: ${v.join('；')}`) }
  }
}
console.log(`隨機路由 ${N} 對：汽車違規 ${carFail}（無解 ${carNull}）、機車違規 ${motoFail}（無解 ${motoNull}）`)
for (const e of examples) console.log('  ' + e)
console.log(carFail === 0 && motoFail === 0 ? '✅ 全數通過' : '❌ 有違規，看上面例子')
