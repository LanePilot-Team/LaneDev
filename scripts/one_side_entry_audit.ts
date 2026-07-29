// 單向進入涵蓋率稽核（node scripts/run_offline.mjs scripts/one_side_entry_audit.ts）
//
// 「捏合接點退化成 T 字路口」這條規則要對**所有**捏合路段成立。這支腳本走真實
// 載入管線，逐一檢查每個捏合接點是不是都拿到了 oneSideEntryNodes 限制，並且抓出
// 「側街被完全切斷」的舊捏合——那種接點連 T 字都不是，正向也進不去。
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

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const merges = applyRoadMerges(roads, journal)
const active = roads.filter((r) => !r.properties.deleted)
const graph = new RoadGraph(active)

console.log(`journal 捏合 ${merges} 組｜活躍區塊 ${active.length}\n`)

// ── 1. 帶有單向進入限制的接點 ──────────────────────────────────────────────
const restrictedRoads = active.filter((r) => (r.properties.oneSideEntryNodes ?? []).length)
let restrictedNodes = 0
let withSideStreet = 0
for (const r of restrictedRoads) {
  for (const node of r.properties.oneSideEntryNodes ?? []) {
    restrictedNodes++
    const others = active.filter((o) => o !== r
      && o.properties.osm_id !== r.properties.osm_id
      && o.properties.nodes.includes(node))
    if (others.length) withSideStreet++
  }
}
console.log(`已登記單向進入的道路 ${restrictedRoads.length} 條 / 接點 ${restrictedNodes} 個`)
console.log(`  其中該接點真的有側街可互動：${withSideStreet}`)
console.log(`  接點無側街（純樣式接合，無所謂進出）：${restrictedNodes - withSideStreet}\n`)

// ── 2. 側街被完全切斷的舊捏合 ───────────────────────────────────────────────
// 特徵：道路上有負節點，而同座標 15 公尺內另有別條路的端點，但兩者不共用節點。
const nodePos = new Map<number, [number, number]>()
for (const r of active) {
  r.properties.nodes.forEach((n, i) => {
    if (!nodePos.has(n)) nodePos.set(n, r.geometry.coordinates[i] as [number, number])
  })
}
const endpointsOf = (r: RoadFeature) => [
  r.properties.nodes[0], r.properties.nodes[r.properties.nodes.length - 1],
]
const severed: { road: RoadFeature; node: number; side: RoadFeature; d: number }[] = []
for (const r of active) {
  for (let i = 1; i < r.properties.nodes.length - 1; i++) {
    const node = r.properties.nodes[i]
    if (node > -1_000_000) continue // 只看捏合產生的大負數，不看建置補的 -1、-2
    const pos = r.geometry.coordinates[i] as [number, number]
    for (const other of active) {
      if (other === r || other.properties.osm_id === r.properties.osm_id) continue
      if (other.properties.nodes.includes(node)) continue
      for (const end of endpointsOf(other)) {
        const p = nodePos.get(end)
        if (!p) continue
        const d = haversine(pos, p)
        if (d < 15) severed.push({ road: r, node, side: other, d })
      }
    }
  }
}
const seen = new Set<string>()
const unique = severed.filter((s) => {
  const k = `${s.node}|${s.side.properties.osm_id}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
console.log(`側街被完全切斷的舊捏合接點：${unique.length}`)
for (const s of unique) {
  console.log(`  way/${s.road.properties.osm_id}（${s.road.properties.name ?? '未命名'}）`
    + ` node=${s.node} ↮ way/${s.side.properties.osm_id}`
    + `（${s.side.properties.name ?? '未命名'}）相距 ${s.d.toFixed(1)}m`)
}
if (!unique.length) {
  console.log('  無——所有捏合接點都保有拓撲，側街接得上')
}

// ── 3. 導航圖層面：限制接點確實還是路口 ────────────────────────────────────
const interIds = new Set(graph.intersections().map((i) => i.id))
let stillIntersection = 0
for (const r of restrictedRoads) {
  for (const node of r.properties.oneSideEntryNodes ?? []) {
    if (interIds.has(node)) stillIntersection++
  }
}
console.log(`\n限制接點在導航圖裡仍是路口：${stillIntersection}/${restrictedNodes}`)
console.log(unique.length === 0
  ? '\n✅ 沒有「完全不連接」的捏合接點'
  : `\n❌ ${unique.length} 個接點的側街被完全切斷，不是 T 字路口`)
process.exit(unique.length === 0 ? 0 : 1)
