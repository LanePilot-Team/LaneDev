// 刪除現況清點（node scripts/run_offline.mjs scripts/deletion_status.ts）
//
// 回答「journal 裡還生效的刪除，每一筆現在是什麼狀態」——特別是 2026-07-30
// 那次批次刪除有沒有把該還原的都還原回來。分類：
//   不存在   鍵對不到現在的切塊（舊資料庫版本留下的紀錄，對路網無影響）
//   已接手   節點相鄰關係另有現存道路提供（疊圖重複段，刪掉是對的）
//   死路末端 只接回 ≤1 個仍在路網上的節點（刪掉不影響通行）
//   ❌中間環節 路網中間的洞（必須還原）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const db = JSON.parse(readFileSync(
  arg('db', join(HERE, '../public/data/road_database.json')), 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((r) => !r.properties.deleted)
const deleted = roads.filter((r) => r.properties.deleted)
const known = new Set(roads.map(key))

const folded = foldJournal(journal)
const effective = [...folded].filter(([, f]) => Number(f.deleted) > 0).map(([k]) => k)

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const adjacency = new Set<string>()
const liveNodes = new Set<number>()
for (const r of active) {
  const ns = r.properties.nodes
  for (let i = 0; i < ns.length; i++) {
    liveNodes.add(ns[i])
    if (i > 0) adjacency.add(pairKey(ns[i - 1], ns[i]))
  }
}

const brokenOf = (r: RoadFeature) => {
  const ns = r.properties.nodes
  const out: [number, number][] = []
  for (let i = 1; i < ns.length; i++) {
    if (!adjacency.has(pairKey(ns[i - 1], ns[i]))) out.push([ns[i - 1], ns[i]])
  }
  return out
}

// 缺口串成連通段（同 severed_chain_repair 的判準）
const parent = new Map<number, number>()
const find = (x: number): number => {
  if (!parent.has(x)) { parent.set(x, x); return x }
  let root = x
  while (parent.get(root) !== root) root = parent.get(root)!
  let cur = x
  while (parent.get(cur) !== root) { const n = parent.get(cur)!; parent.set(cur, root); cur = n }
  return root
}
const gaps = deleted.map((r) => ({ r, pairs: brokenOf(r) })).filter((g) => g.pairs.length)
for (const g of gaps) for (const [a, b] of g.pairs) {
  const ra = find(a); const rb = find(b)
  if (ra !== rb) parent.set(ra, rb)
}
const runLive = new Map<number, Set<number>>()
for (const g of gaps) {
  const root = find(g.pairs[0][0])
  const s = runLive.get(root) ?? new Set<number>()
  for (const [a, b] of g.pairs) { if (liveNodes.has(a)) s.add(a); if (liveNodes.has(b)) s.add(b) }
  runLive.set(root, s)
}

const classify = (k: string) => {
  if (!known.has(k)) return '不存在'
  const r = deleted.find((x) => key(x) === k)
  if (!r) return '未刪除'
  const pairs = brokenOf(r)
  if (!pairs.length) return '已接手'
  return (runLive.get(find(pairs[0][0]))?.size ?? 0) >= 2 ? '❌中間環節' : '死路末端'
}

const tally = new Map<string, string[]>()
for (const k of effective) {
  const c = classify(k)
  tally.set(c, [...(tally.get(c) ?? []), k])
}
console.log(`journal 裡仍生效的 deleted:1：${effective.length} 個區塊鍵`)
for (const [c, list] of [...tally].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${c}：${list.length}`)
}

// 2026-07-30 批次的專屬清點
const BATCH = arg('batch', '2026-07-30T01:56')
const batchKeys = [...new Set(journal
  .filter((r) => Number(r.fields?.deleted) > 0 && String(r.ts).startsWith(BATCH))
  .map((r) => r.target.key))]
const stillDeleted = batchKeys.filter((k) => effective.includes(k))
console.log(`\n=== ${BATCH} 批次：${batchKeys.length} 個鍵 ===`)
console.log(`  後來已還原：${batchKeys.length - stillDeleted.length}`)
console.log(`  仍維持刪除：${stillDeleted.length}`)
const batchTally = new Map<string, string[]>()
for (const k of stillDeleted) {
  const c = classify(k)
  batchTally.set(c, [...(batchTally.get(c) ?? []), k])
}
for (const [c, list] of [...batchTally].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  └ ${c}：${list.length}`)
  if (c !== '不存在') {
    for (const k of list) {
      const r = deleted.find((x) => key(x) === k)
      const cs = (r?.geometry.coordinates ?? []) as [number, number][]
      const len = cs.slice(1).reduce((s, c2, i) => s + haversine(cs[i], c2), 0)
      console.log(`      ${k}｜${r?.properties.name ?? '(無名)'}｜${len.toFixed(1)}m`)
    }
  }
}
const bad = [...tally.get('❌中間環節') ?? []]
console.log(`\n${bad.length === 0
  ? '✅ 沒有任何生效中的刪除是路網中間的環節'
  : `❌ ${bad.length} 個刪除仍把路網從中間切斷`}`)
process.exitCode = bad.length === 0 ? 0 : 1
