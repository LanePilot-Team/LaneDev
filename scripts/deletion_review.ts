// 刪除合法性複審（node scripts/run_offline.mjs scripts/deletion_review.ts [--apply=<out>]）
//
// 2026-07-30 的碎塊清理刪了 533 個區塊，連通性守門只看「元件總數不得增加」。
// 那個判準有漏洞：中間段被刪後，兩側仍各自透過側街連在路網上，元件數不變，
// **但那條路本身斷了**——德民路 way/75852429 就是這樣被切成兩截，導航繞不過去。
//
// 這裡改用會抓到的判準：對每個被刪區塊，量它兩端節點在「刪除後的路網」裡的
// 最短路徑。若遠大於區塊自身長度（或根本走不到），代表它是承擔通行的路段，
// 刪除不合法，應該加回來。
//
//   --ts=<前綴>      只複審這批刪除（預設 2026-07-30T01:56，即那次清理）
//   --factor=<倍數>  繞行倍率門檻（預設 5）
//   --floor=<公尺>   繞行絕對門檻，短段用（預設 60）
//   --apply=<檔案>   把判定為不合法的刪除寫成 deleted:0 還原
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges, type EnhancementRecord } from '../src/core/enhancements'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const TS_PREFIX = arg('ts', '2026-07-30T01:56')
const FACTOR = Number(arg('factor', '5'))
const FLOOR = Number(arg('floor', '60'))
const APPLY = arg('apply', '')
/** 繞行搜尋上限；超過就視為走不到，不必再算下去 */
const SEARCH_CAP_M = 600

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const lengthOf = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}

// 這批刪除涵蓋哪些鍵（同一個鍵可能被寫過多次，取這批的）
const batchKeys = new Set(journal
  .filter((r) => Number(r.fields?.deleted) > 0 && String(r.ts).startsWith(TS_PREFIX))
  .map((r) => r.target.key))
// 折疊後仍然是刪除狀態的才需要複審
const folded = foldJournal(journal)
const targets = [...batchKeys].filter((k) => Number(folded.get(k)?.deleted) > 0)
console.log(`這批（ts ${TS_PREFIX}）刪除 ${batchKeys.size} 個鍵｜目前仍為刪除狀態 ${targets.length}`)

// 刪除後的路網鄰接表
const adj = new Map<number, { to: number; d: number }[]>()
const link = (a: number, b: number, d: number) => {
  if (!adj.has(a)) adj.set(a, [])
  adj.get(a)!.push({ to: b, d })
}
for (const r of roads) {
  if (r.properties.deleted) continue
  const ns = r.properties.nodes
  const cs = r.geometry.coordinates as [number, number][]
  for (let i = 1; i < ns.length; i++) {
    const d = haversine(cs[i - 1], cs[i])
    link(ns[i - 1], ns[i], d)
    link(ns[i], ns[i - 1], d)
  }
}
/** 有上限的 Dijkstra：超過 SEARCH_CAP_M 就放棄，回傳 Infinity */
const shortest = (from: number, to: number): number => {
  if (from === to) return 0
  const dist = new Map<number, number>([[from, 0]])
  const queue: [number, number][] = [[0, from]]
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0])
    const [d, node] = queue.shift()!
    if (node === to) return d
    if (d > SEARCH_CAP_M) return Infinity
    if (d > (dist.get(node) ?? Infinity)) continue
    for (const e of adj.get(node) ?? []) {
      const nd = d + e.d
      if (nd >= (dist.get(e.to) ?? Infinity) || nd > SEARCH_CAP_M) continue
      dist.set(e.to, nd)
      queue.push([nd, e.to])
    }
  }
  return Infinity
}

interface Row { key: string; name: string; len: number; detour: number; ratio: number; verdict: string }
const rows: Row[] = []
for (const k of targets) {
  const block = roads.find((r) => key(r) === k)
  if (!block) { rows.push({ key: k, name: '?', len: 0, detour: 0, ratio: 0, verdict: 'gone' }); continue }
  const ns = block.properties.nodes
  const a = ns[0]; const b = ns[ns.length - 1]
  const len = lengthOf(block)
  const detour = shortest(a, b)
  const ratio = detour === Infinity ? Infinity : detour / Math.max(len, 1)
  const broken = detour === Infinity || (detour > FLOOR && ratio > FACTOR)
  rows.push({ key: k, name: block.properties.name ?? '未命名', len, detour, ratio,
    verdict: broken ? 'load_bearing' : 'safe' })
}
const bad = rows.filter((r) => r.verdict === 'load_bearing')
const gone = rows.filter((r) => r.verdict === 'gone')
console.log(`\n判定：合法 ${rows.length - bad.length - gone.length}`
  + `｜不合法（承擔通行，應還原）${bad.length}｜區塊已不存在 ${gone.length}\n`)
bad.sort((x, y) => (y.ratio === Infinity ? 1e9 : y.ratio) - (x.ratio === Infinity ? 1e9 : x.ratio))
for (const r of bad) {
  console.log(`   ✖ ${r.key}｜${r.name}｜長度 ${r.len.toFixed(1)}m`
    + `｜刪除後兩端繞行 ${r.detour === Infinity ? '走不到' : `${r.detour.toFixed(0)}m（${r.ratio.toFixed(0)}×）`}`)
}

if (!APPLY) { console.log('\n（複審模式，未寫檔。加 --apply=<路徑> 才會還原）'); process.exit(0) }
for (const r of bad) {
  journal.push({
    seq: 0, ts: new Date().toISOString(), author: 'anna', op: 'set',
    target: { type: 'road', key: r.key }, fields: { deleted: 0 },
  })
}
db.editor.journal = journal.map((r, i) => ({ ...r, seq: i + 1 }))
db.editor.updated_at = new Date().toISOString()
db.updated_at = db.editor.updated_at
writeFileSync(APPLY, `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已寫入 ${APPLY}：還原 ${bad.length} 個區塊`)
