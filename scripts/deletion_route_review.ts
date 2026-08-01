// 刪除合法性複審 · 路徑法（node scripts/run_offline.mjs scripts/deletion_route_review.ts）
//
// 判準（使用者提出，取代先前錯誤的「兩端能否互達」）：
//   同一組起訖點，比較「把刪除還原」與「維持刪除」兩種狀態下的實際導航距離。
//   還原後明顯變短 → 那段承擔通行，刪除不合法，應加回來。
//   兩者一樣    → 確實是贅段，刪除合法。
//
// 為什麼先前的判準是錯的：我量的是「刪除區塊自己的兩個端點能否繞得到」。
// 路網裡幾乎每個中間區塊都是橋接段，移除後兩端當然互達不了——對照組顯示未被刪的
// 正常區塊有 90% 也會被判成「承擔通行」。那個數字沒有鑑別力。
//
// 起訖點取在刪除段兩側各往外延伸一段距離的實際道路上（跨過路口），對應使用者
// 「跨越路口測試導航」的做法。
//
//   --ts=<前綴>     只複審這批刪除（預設 2026-07-30T01:56）
//   --probe=<公尺>  起訖點往外延伸的距離（預設 60）
//   --ratio=<倍數>  還原後 / 維持刪除 的距離比，超過就判定不合法（預設 1.5）
//   --limit=<n>     只看前 n 筆（除錯用）
//   --apply=<檔案>  把判定為不合法的刪除寫成 deleted:0 還原
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges, type EnhancementRecord } from '../src/core/enhancements'
import { RoadGraph } from '../src/core/graph'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const TS_PREFIX = arg('ts', '2026-07-30T01:56')
const PROBE_M = Number(arg('probe', '60'))
const RATIO = Number(arg('ratio', '1.5'))
const LIMIT = Number(arg('limit', '0'))
const ONLY = arg('key', '')
const APPLY = arg('apply', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

function build(extraJournal: EnhancementRecord[]) {
  const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
  const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  const j = [...journal, ...extraJournal]
  applyToRoads(roads, foldJournal(j))
  applyRoadMerges(roads, j)
  const active = roads.filter((r) => !r.properties.deleted)
  return { roads, active, graph: new RoadGraph(active) }
}

const folded = foldJournal(journal)
const batchKeys = [...new Set(journal
  .filter((r) => Number(r.fields?.deleted) > 0 && String(r.ts).startsWith(TS_PREFIX))
  .map((r) => r.target.key))]
let targets = batchKeys.filter((k) => Number(folded.get(k)?.deleted) > 0)
if (ONLY) targets = targets.filter((k) => k === ONLY)
if (LIMIT > 0) targets = targets.slice(0, LIMIT)
console.log(`複審 ${targets.length} 筆刪除（ts ${TS_PREFIX}）｜起訖點外推 ${PROBE_M}m｜門檻 ${RATIO}×\n`)

// 「全部還原」的狀態：用來取被刪區塊的幾何、以及作為 A/B 的基準
const restoreAll: EnhancementRecord[] = targets.map((k, i) => ({
  seq: 0, ts: new Date(Date.now() + i).toISOString(), author: 'review', op: 'set',
  target: { type: 'road', key: k }, fields: { deleted: 0 },
}))
const withAll = build(restoreAll)
const current = build([])

/**
 * 沿路網從某節點往外走 PROBE_M，取一個實際落在道路上的探測點。
 *
 * **優先沿同名道路走**：這對應「在該條路上跨越路口測試導航」。若放任它挑最長的
 * 相鄰邊，探測點會跑到交會的幹道上（例：德民路缺口兩端都接高楠公路單行匝道），
 * 於是兩個探測點都落在別條路上，根本測不到這條路的缺口——那個 4.8m 的德民路缺口
 * 就是這樣被判成「贅段」漏掉的。
 */
function probeFrom(
  node: number, avoid: Set<number>, roads: RoadFeature[], preferName: string,
): [number, number] | null {
  let cur = node
  const seen = new Set<number>([...avoid, node])
  let walked = 0
  let pos: [number, number] | null = null
  for (let step = 0; step < 16 && walked < PROBE_M; step++) {
    let best: { node: number; pos: [number, number]; d: number; same: boolean } | null = null
    for (const r of roads) {
      const ns = r.properties.nodes
      const i = ns.indexOf(cur)
      if (i < 0) continue
      const same = (r.properties.name ?? '') === preferName
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= ns.length || seen.has(ns[j])) continue
        const cs = r.geometry.coordinates as [number, number][]
        const d = haversine(cs[i], cs[j])
        // 同名優先；同名之間再取較長的一段
        if (!best || (same && !best.same) || (same === best.same && d > best.d)) {
          best = { node: ns[j], pos: cs[j], d, same }
        }
      }
    }
    if (!best) break
    walked += best.d
    seen.add(best.node)
    cur = best.node
    pos = best.pos
  }
  return walked >= 15 ? pos : null
}

interface Row { key: string; name: string; len: number; before: number; after: number; ratio: number; verdict: string }
const rows: Row[] = []
for (const k of targets) {
  const block = withAll.roads.find((r) => key(r) === k)
  if (!block) { rows.push({ key: k, name: '?', len: 0, before: 0, after: 0, ratio: 0, verdict: 'gone' }); continue }
  const ns = block.properties.nodes
  const own = new Set(ns)
  const cs = block.geometry.coordinates as [number, number][]
  const len = cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
  const roadName = block.properties.name ?? ''
  const from = probeFrom(ns[0], own, withAll.active, roadName)
  const to = probeFrom(ns[ns.length - 1], own, withAll.active, roadName)
  if (!from || !to) {
    rows.push({ key: k, name: block.properties.name ?? '未命名', len, before: 0, after: 0, ratio: 0, verdict: 'no_probe' })
    continue
  }
  // 必須兩個方向都測，取較差的那一邊。
  // 缺口兩側常常各自連著單行道（例：德民路 way/280277090@b/258785797 的 4.8m 缺口，
  // 兩端都接高楠公路的單行匝道），於是一個方向照樣通、反方向要繞 621m。
  // 只測單一方向會把這種漏網段判成「贅段」。
  let before = 0
  let after = 0
  let ratio = 0
  let reachable = false
  for (const [f, t] of [[from, to], [to, from]] as [[number, number], [number, number]][]) {
    const bRoute = withAll.graph.route(f, t, 'car')
    const aRoute = current.graph.route(f, t, 'car')
    const bLen = bRoute?.lengthM ?? Infinity
    const aLen = aRoute?.lengthM ?? Infinity
    if (bLen === Infinity) continue // 還原後都不通，這個方向沒有比較基準
    reachable = true
    const rr = aLen === Infinity ? Infinity : aLen / Math.max(bLen, 1)
    if (rr > ratio) { ratio = rr; before = bLen; after = aLen }
  }
  const harmful = reachable && (after === Infinity || ratio > RATIO)
  rows.push({ key: k, name: block.properties.name ?? '未命名', len, before, after, ratio,
    verdict: harmful ? 'load_bearing' : (reachable ? 'safe' : 'no_probe') })
}

const bad = rows.filter((r) => r.verdict === 'load_bearing')
const safe = rows.filter((r) => r.verdict === 'safe')
const skipped = rows.filter((r) => r.verdict === 'no_probe' || r.verdict === 'gone')
console.log(`判定：贅段（刪除合法）${safe.length}`
  + `｜承擔通行（應還原）${bad.length}｜無法測（探測點取不到）${skipped.length}\n`)
bad.sort((x, y) => (y.ratio === Infinity ? 1e9 : y.ratio) - (x.ratio === Infinity ? 1e9 : x.ratio))
for (const r of bad.slice(0, 40)) {
  console.log(`   ✖ ${r.key}｜${r.name}｜${r.len.toFixed(1)}m`
    + `｜還原後 ${r.before.toFixed(0)}m → 現況 ${r.after === Infinity ? '不通' : `${r.after.toFixed(0)}m`}`
    + `（${r.ratio === Infinity ? '∞' : `${r.ratio.toFixed(1)}×`}）`)
}
if (bad.length > 40) console.log(`   …還有 ${bad.length - 40} 筆`)

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
