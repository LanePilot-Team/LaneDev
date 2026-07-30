// 被切斷的捏合接點是不是真的變成孤島？
// （node scripts/run_offline.mjs scripts/severed_route_audit.ts）
//
// 判準不是「拓撲上連不連」，而是「導航實際走得到嗎、繞多遠」：
//   1. 從主路正向的上游 → 側街：應該是一個右轉就到（T 字路口）
//   2. 從主路反向的上游 → 側街：應該是就近路口迴轉再回來，不是繞一大圈
// 繞行倍率 = 實際路徑長 ÷ 直線距離。孤島的特徵就是這個倍率爆掉（或根本無路徑）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges } from '../src/core/enhancements'
import { RoadGraph } from '../src/core/graph'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
/** 繞行倍率超過這個值就算「實質上到不了」 */
const DETOUR_LIMIT = Number(arg('limit', '6'))

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)
const active = roads.filter((r) => !r.properties.deleted)
const graph = new RoadGraph(active)

const nodePos = new Map<number, [number, number]>()
for (const r of active) {
  r.properties.nodes.forEach((n, i) => {
    if (!nodePos.has(n)) nodePos.set(n, r.geometry.coordinates[i] as [number, number])
  })
}
const endpointsOf = (r: RoadFeature) => [
  r.properties.nodes[0], r.properties.nodes[r.properties.nodes.length - 1],
]

// 找出被切斷的接點：主路上的捏合負節點，附近有別條路的端點但不共用節點
interface Severed { road: RoadFeature; node: number; pos: [number, number]; side: RoadFeature }
const severed: Severed[] = []
const seen = new Set<string>()
for (const r of active) {
  for (let i = 1; i < r.properties.nodes.length - 1; i++) {
    const node = r.properties.nodes[i]
    if (node > -1_000_000) continue
    const pos = r.geometry.coordinates[i] as [number, number]
    for (const other of active) {
      if (other === r || other.properties.osm_id === r.properties.osm_id) continue
      if (other.properties.nodes.includes(node)) continue
      for (const end of endpointsOf(other)) {
        const p = nodePos.get(end)
        if (!p || haversine(pos, p) >= 15) continue
        const k = `${node}|${other.properties.osm_id}`
        if (seen.has(k)) continue
        seen.add(k)
        severed.push({ road: r, node, pos, side: other })
      }
    }
  }
}

console.log(`被切斷的接點：${severed.length}\n`)

/** 側街遠端（離接點最遠的那一端）當終點——確保真的要進入側街 */
const farEndOf = (side: RoadFeature, at: [number, number]) => {
  const cs = side.geometry.coordinates as [number, number][]
  return haversine(cs[0], at) > haversine(cs[cs.length - 1], at) ? cs[0] : cs[cs.length - 1]
}
/** 沿主路取上游／下游一點的位置，模擬「從正向來」「從反向來」 */
const alongMain = (road: RoadFeature, node: number, back: boolean) => {
  const idx = road.properties.nodes.indexOf(node)
  const cs = road.geometry.coordinates as [number, number][]
  const step = back ? 1 : -1
  let j = idx
  let walked = 0
  while (j + step >= 0 && j + step < cs.length && walked < 120) {
    walked += haversine(cs[j], cs[j + step])
    j += step
  }
  return { pos: cs[j], distM: walked }
}

let islands = 0
const rows: string[] = []
for (const s of severed) {
  const target = farEndOf(s.side, s.pos)
  const line: string[] = [
    `${s.road.properties.name ?? '未命名'}（way/${s.road.properties.osm_id}）`
    + ` node=${s.node} → ${s.side.properties.name ?? '未命名'}`
    + `（way/${s.side.properties.osm_id}）`,
  ]
  let worst = 0
  for (const back of [false, true]) {
    const from = alongMain(s.road, s.node, back)
    if (!from.pos) continue
    const straight = haversine(from.pos, target)
    const r = graph.route(from.pos, target, 'car')
    const label = back ? '反向來' : '正向來'
    if (!r) {
      line.push(`   ${label}：❌ 無路徑（直線 ${straight.toFixed(0)}m）`)
      worst = Infinity
      continue
    }
    const ratio = r.lengthM / Math.max(straight, 1)
    worst = Math.max(worst, ratio)
    line.push(`   ${label}：${r.lengthM.toFixed(0)}m ／直線 ${straight.toFixed(0)}m`
      + ` = 繞行 ${ratio.toFixed(1)}×`)
  }
  const bad = worst > DETOUR_LIMIT
  if (bad) islands++
  rows.push(`${bad ? '❌' : '✅'} ${line.join('\n')}`)
}
for (const r of rows) console.log(`${r}\n`)

console.log(`繞行 >${DETOUR_LIMIT}× 或無路徑的接點：${islands}/${severed.length}`)
console.log(islands === 0
  ? '✅ 每個接點都走得到，沒有實質孤島'
  : `❌ ${islands} 個接點實質上是孤島，導航到不了或要繞一大圈`)
process.exit(islands === 0 ? 0 : 1)
