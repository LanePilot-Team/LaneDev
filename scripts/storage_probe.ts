// 儲存策略探針：檢查「捏合過的負節點」是否在載入管線被 collapseKnownIntersections
// 還原成共用正節點（＝捏合在畫面上自動失效），以及 journal 區塊鍵的孤兒狀況。
//   node scripts/run_offline.mjs scripts/storage_probe.ts [--name=藍昌路]
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const NAME = arg('name', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8')) as {
  segments: any[]
  editor?: { journal?: EnhancementRecord[]; updated_at?: string }
}

// ── 1. 靜態檔裡的「捏合痕跡」 ────────────────────────────────────────────────
const negRefs: { key: string; name: string; node: number; coord: [number, number] }[] = []
const oseSegs: { key: string; name: string; nodes: number[] }[] = []
for (const s of db.segments) {
  const key = String(s.object_identity?.nav_segment_key ?? '?')
  const name = String(s.lane_nav_tags?.road_name ?? '')
  const refs: number[] = s.node_refs ?? []
  const coords: [number, number][] = s.geometry?.coordinates ?? []
  refs.forEach((n, i) => {
    if (Number(n) < 0) negRefs.push({ key, name, node: Number(n), coord: coords[i] })
  })
  const ose = s.lane_nav_tags?.one_side_entry_nodes
  if (Array.isArray(ose) && ose.length) oseSegs.push({ key, name, nodes: ose.map(Number) })
}
console.log(`靜態檔捏合痕跡：負節點 ${negRefs.length} 個／one_side_entry_nodes 標記 ${oseSegs.length} 段`)

// 同座標是否還有別條路的正節點 → collapseKnownIntersections 會把捏合還原
const coordKey = (c: [number, number]) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`
const positiveAt = new Map<string, Set<number>>()
for (const s of db.segments) {
  const refs: number[] = s.node_refs ?? []
  const coords: [number, number][] = s.geometry?.coordinates ?? []
  refs.forEach((n, i) => {
    if (Number(n) <= 0 || !coords[i]) return
    const k = coordKey(coords[i])
    if (!positiveAt.has(k)) positiveAt.set(k, new Set())
    positiveAt.get(k)!.add(Number(n))
  })
}
let reverted = 0
for (const r of negRefs) {
  if (!r.coord) continue
  const matches = [...(positiveAt.get(coordKey(r.coord)) ?? [])]
  const willRevert = matches.length === 1
  if (willRevert) reverted++
  console.log(`  ${willRevert ? '↩︎ 會被還原' : '✔ 保持捏合'} ${r.key}（${r.name}）`
    + ` node=${r.node} 同座標正節點=${JSON.stringify(matches)}`)
}
console.log(`→ ${reverted}/${negRefs.length} 個捏合會在每次載入時被 collapseKnownIntersections 還原\n`)

// ── 2. 跑一次 app 管線，看 journal 鍵有多少變孤兒 ────────────────────────────
const parsed = parseImported(db.segments.map((r) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const liveKeys = new Set(roads.map(blockKey))
const folded = foldJournal(journal)
const orphans = [...folded].filter(([k]) => /^way\/-?\d+@b\/-?\d+$/.test(k) && !liveKeys.has(k))
console.log(`journal：${journal.length} 筆；折疊後 ${folded.size} 個鍵；`
  + `區塊鍵孤兒 ${orphans.length} 個（其中 deleted=1：`
  + `${orphans.filter(([, v]) => Number(v.deleted) > 0).length}）`)
for (const [k, v] of orphans) console.log(`  孤兒 ${k} ${JSON.stringify(v).slice(0, 100)}`)

const wayLevel = journal.filter((r) => r.target.type === 'road'
  && /^way\/-?\d+$/.test(r.target.key)).length
const blockLevel = journal.filter((r) => r.target.type === 'road'
  && r.target.key.includes('@b/')).length
console.log(`road 覆寫：way 級 ${wayLevel} 筆／區塊級 ${blockLevel} 筆`
  + '（way 級 = 捏合 API 壓平後的產物，會整條路吃同一組設定）')

// ── 3. 指定道路的區塊現況 ───────────────────────────────────────────────────
if (NAME) {
  const hit = roads.filter((r) => (r.properties.name ?? '').includes(NAME))
  console.log(`\n「${NAME}」活躍區塊 ${hit.filter((r) => !r.properties.deleted).length}`
    + `／總區塊 ${hit.length}`)
  for (const r of hit) {
    console.log(`  ${blockKey(r)}${r.properties.deleted ? ' [已刪除]' : ''}`
      + ` couplet=${r.properties.coupletMerged ? 'yes' : 'no'}`
      + ` nodes=${r.properties.nodes.length}`
      + ` ose=${JSON.stringify(r.properties.oneSideEntryNodes ?? [])}`)
  }
}
