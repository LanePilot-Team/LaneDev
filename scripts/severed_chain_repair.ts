// 斷鏈修復（node scripts/run_offline.mjs scripts/severed_chain_repair.ts [--apply=<out>]）
//
// 背景：cleanup_fragments 的「疊壞碎塊」判準用的是**頂點對頂點 12m 距離**，而碎塊
// 長度上限是 25m。一段只有兩個頂點、10m 長、單純接在長區塊後面的正常路段，它的
// 兩個頂點離長區塊端點都 <12m，於是 overlapRatio 算出 100%——被誤判成「疊在主線上
// 的殘留」。連通性守門只看 union-find 元件數，而缺口兩側往往還能繞小巷相通，元件數
// 不變，於是誤刪照樣通過。結果是主幹道中間出現 10m 缺口：畫面上完全看不出來，
// A* 卻只能鑽側巷或迴轉繞過去。
//
// 本腳本的判準是**拓撲**而非距離：一個區塊若在原始切塊鏈中是「中間環節」
// （起點是同 way 另一段的終點、終點是同 way 另一段的起點），刪掉它就會把那條路
// 從中間切斷，除非還有別的現存道路提供同一組節點相鄰關係。
//
//   --apply=<檔案>  寫出還原後的資料庫（新增 deleted:0 紀錄）
//   --overlap=<m>   還原後的重疊自檢門檻（預設 3m）
import { readFileSync, writeFileSync } from 'node:fs'
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
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const APPLY = arg('apply', '')
const OVERLAP_M = Number(arg('overlap', '3'))

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((r) => !r.properties.deleted)
const deleted = roads.filter((r) => r.properties.deleted)
console.log(`切塊 ${roads.length}｜現存 ${active.length}｜已刪 ${deleted.length}`)

/** 節點相鄰關係：某條現存道路把 a、b 直接連起來。 */
const adjacency = new Set<string>()
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const addAdjacency = (r: RoadFeature) => {
  const ns = r.properties.nodes
  for (let i = 1; i < ns.length; i++) adjacency.add(pairKey(ns[i - 1], ns[i]))
}
for (const r of active) addAdjacency(r)

/** 節點是否仍被現存道路使用（判斷刪除後端點會不會變成孤點）。 */
const liveNodes = new Set<number>()
for (const r of active) for (const n of r.properties.nodes) liveNodes.add(n)

/** 點到折線的最短距離（公尺，近似平面）——真正的「疊在上面」要看垂距。 */
function pointToPolyline(p: [number, number], line: [number, number][]): number {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const mx = Math.cos((p[1] * Math.PI) / 180)
    const px = (p[0] - ax) * mx
    const py = p[1] - ay
    const dx = (bx - ax) * mx
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
    const cx = ax + (dx * t) / (mx || 1)
    const cy = ay + dy * t
    best = Math.min(best, haversine(p, [cx, cy]))
  }
  return best
}

interface Candidate {
  block: RoadFeature
  key: string
  name: string
  lengthM: number
  brokenPairs: [number, number][]
}

const candidates: Candidate[] = []
for (const block of deleted) {
  const ns = block.properties.nodes
  const cs = block.geometry.coordinates as [number, number][]
  const brokenPairs: [number, number][] = []
  for (let i = 1; i < ns.length; i++) {
    if (!adjacency.has(pairKey(ns[i - 1], ns[i]))) brokenPairs.push([ns[i - 1], ns[i]])
  }
  if (!brokenPairs.length) continue // 相鄰關係已由別條現存道路提供
  candidates.push({
    block,
    key: key(block),
    name: block.properties.name ?? '(無名)',
    lengthM: cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0),
    brokenPairs,
  })
}

// 缺口要**整段**看，不能逐塊判定。連著刪掉好幾段時（疊圖 way 的兩份都被刪，
// 例：德中路／援中路 那 14m），中間節點已經沒有任何現存道路使用，於是每一塊
// 單獨看都「有一端是死的」，逐塊判定會全部漏掉——實際上那是主幹道上的一個洞。
// 所以先把「缺口」串成連通段（經由已無人使用的節點相連），再看整段有沒有接回
// 兩個以上仍在路網上的節點：有，就是路網中間的洞，要補；只碰到 0～1 個，
// 那是死路末端，刪除合法。
const parent = new Map<number, number>()
const find = (x: number): number => {
  if (!parent.has(x)) { parent.set(x, x); return x }
  let root = x
  while (parent.get(root) !== root) root = parent.get(root)!
  let cur = x
  while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next }
  return root
}
const union = (a: number, b: number) => {
  const ra = find(a); const rb = find(b)
  if (ra !== rb) parent.set(ra, rb)
}
for (const c of candidates) for (const [a, b] of c.brokenPairs) union(a, b)

const runLiveNodes = new Map<number, Set<number>>()
const runBlocks = new Map<number, Candidate[]>()
for (const c of candidates) {
  const root = find(c.brokenPairs[0][0])
  const list = runBlocks.get(root) ?? []
  list.push(c)
  runBlocks.set(root, list)
  const live = runLiveNodes.get(root) ?? new Set<number>()
  for (const [a, b] of c.brokenPairs) {
    if (liveNodes.has(a)) live.add(a)
    if (liveNodes.has(b)) live.add(b)
  }
  runLiveNodes.set(root, live)
}

const severingRuns = [...runBlocks].filter(([root]) => (runLiveNodes.get(root)?.size ?? 0) >= 2)
const stubRuns = [...runBlocks].filter(([root]) => (runLiveNodes.get(root)?.size ?? 0) < 2)
const severing = severingRuns.flatMap(([, list]) => list)
const stubs = stubRuns.flatMap(([, list]) => list)
console.log(`已刪且相鄰關係無人接手：${candidates.length}（缺口 ${runBlocks.size} 段）`)
console.log(`  ├ 路網中間的洞（應還原）：${severing.length} 區塊 / ${severingRuns.length} 段`)
console.log(`  └ 死路末端（刪除合法）：${stubs.length} 區塊 / ${stubRuns.length} 段\n`)

// 同一組節點相鄰關係可能有多條重複道路都被刪（區界 shard 重疊造成的疊圖 way）。
// 只還原其中一條就能恢復拓撲，其餘維持刪除，不要把疊圖又放回來。
// 優先挑「該 way 其餘部分還在路網上」的那一條，避免同一段走廊換了路名。
const activeBlocksByWay = new Map<number, number>()
for (const r of active) {
  const id = r.properties.osm_id
  activeBlocksByWay.set(id, (activeBlocksByWay.get(id) ?? 0) + 1)
}
// 手動刪除優先尊重：疊圖的兩份都被刪時（德中路／援中路），一份是人一筆一筆刪的、
// 另一份是批次腳本掃掉的。要補回來的應該是**批次那一份**——人選擇留下的是另一條。
// 批次的特徵是同一個時間戳蓋在一大票紀錄上。
const tsCount = new Map<string, number>()
for (const r of journal) {
  if (Number(r.fields?.deleted) > 0) tsCount.set(String(r.ts), (tsCount.get(String(r.ts)) ?? 0) + 1)
}
const lastDeleteTs = new Map<string, string>()
for (const r of journal) {
  if (r.target?.type === 'road' && Number(r.fields?.deleted) > 0) {
    lastDeleteTs.set(r.target.key, String(r.ts))
  }
}
const byBulk = (c: Candidate) => (tsCount.get(lastDeleteTs.get(c.key) ?? '') ?? 0) >= 5 ? 1 : 0

// 補洞以 **way 為單位**：同一個缺口能補的候選常常來自兩條疊圖 way，一塊挑一條
// 會讓同一段走廊中間換路名（也換車道配置）。所以每個缺口先選一條 way，
// 用它蓋掉能蓋的相鄰關係，剩下的再選下一條。
const restored: Candidate[] = []
const supplied = new Set<string>()
for (const [, list] of severingRuns) {
  const pending = new Set(list.flatMap((c) => c.brokenPairs.map(([a, b]) => pairKey(a, b))))
  while (pending.size) {
    const byWay = new Map<number, Candidate[]>()
    for (const c of list) {
      if (!c.brokenPairs.some(([a, b]) => pending.has(pairKey(a, b)))) continue
      const id = c.block.properties.osm_id
      byWay.set(id, [...(byWay.get(id) ?? []), c])
    }
    if (!byWay.size) break
    const score = (blocks: Candidate[]) => [
      new Set(blocks.flatMap((c) => c.brokenPairs
        .map(([a, b]) => pairKey(a, b)).filter((k) => pending.has(k)))).size,
      blocks.filter(byBulk).length,
      activeBlocksByWay.get(blocks[0].block.properties.osm_id) ?? 0,
    ]
    const best = [...byWay.values()].sort((a, b) => {
      const [sa, sb] = [score(a), score(b)]
      return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2]
    })[0]
    for (const c of best) {
      if (!c.brokenPairs.some(([a, b]) => pending.has(pairKey(a, b)))) continue
      restored.push(c)
      for (const [a, b] of c.brokenPairs) { supplied.add(pairKey(a, b)); pending.delete(pairKey(a, b)) }
    }
  }
}
const redundant = severing.filter((c) => !restored.includes(c))

/** 這個區塊是不是整段壓在某條現存道路上（真正的疊圖殘留，刪掉才是對的）。 */
const overlapsActive = (c: Candidate) => {
  const cs = c.block.geometry.coordinates as [number, number][]
  let worst = Infinity
  for (const other of active) {
    if (other.properties.osm_id === c.block.properties.osm_id) continue
    const oc = other.geometry.coordinates as [number, number][]
    if (haversine(oc[0], cs[0]) > 300 && haversine(oc[oc.length - 1], cs[0]) > 300) continue
    worst = Math.min(worst, Math.max(...cs.map((p) => pointToPolyline(p, oc))))
  }
  return worst
}

// 死路末端也要看是不是被誤刪。它不影響「經過」，但**終點就在那條路末端**時，
// 路線會停在 10m 外或根本吸附不到。原本的碎塊判準（頂點距離 12m）連這些正常的
// 路尾都判成疊圖，所以這裡照真正的判準（垂距）再篩一次：沒有壓在別條路上的，
// 就不是疊圖殘留，要放回去。
// 只還原**批次腳本**刪掉的路尾。人一筆一筆刪的是刻意的（例：那兩條上百公尺的
// service 道路），不能因為「它不是疊圖」就自動放回去。
const stubRestored: Candidate[] = []
const stubKept: Candidate[] = []
for (const [, list] of stubRuns) {
  for (const c of list) {
    if (!byBulk(c) || overlapsActive(c) < OVERLAP_M) stubKept.push(c)
    else stubRestored.push(c)
  }
}
restored.push(...stubRestored)

console.log(`=== 還原 ${restored.length} 個區塊`
  + `（路網中間的洞 ${restored.length - stubRestored.length}、誤刪的路尾 ${stubRestored.length}；`
  + `另有 ${redundant.length} 個重複疊圖、${stubKept.length} 個真疊圖路尾維持刪除）===`)
for (const c of restored) {
  const worstOverlap = overlapsActive(c)
  const flag = worstOverlap < OVERLAP_M ? `  ⚠ 疊在別條路上 ${worstOverlap.toFixed(1)}m` : ''
  const what = stubRestored.includes(c)
    ? '路尾'
    : `缺口 ${c.brokenPairs.map(([a, b]) => `${a}>${b}`).join(',')}`
  console.log(`  + ${c.key}｜${c.name}｜${c.lengthM.toFixed(1)}m｜${what}${flag}`)
}
if (stubKept.length) {
  console.log(`\n=== 維持刪除的路尾 ===`)
  for (const c of stubKept) {
    const overlap = overlapsActive(c)
    console.log(`  · ${c.name} ${c.key}（${c.lengthM.toFixed(1)}m）｜`
      + (!byBulk(c) ? '人工逐筆刪除，尊重原意' : `真的壓在別條路上 ${overlap.toFixed(1)}m`))
  }
}
if (redundant.length) {
  console.log(`\n=== 重複疊圖（同一缺口已由上面某段補回，維持刪除）===`)
  for (const c of redundant) console.log(`  - ${c.key}｜${c.name}｜${c.lengthM.toFixed(1)}m`)
}

if (!APPLY) {
  console.log('\n（複審模式，未寫檔。加 --apply=<路徑> 才會還原）')
  process.exitCode = restored.length === 0 ? 0 : 1
} else {
  for (const c of restored) {
    journal.push({
      seq: 0, ts: new Date().toISOString(), author: 'anna', op: 'set',
      target: { type: 'road', key: c.key }, fields: { deleted: 0 },
    })
  }
  db.editor.journal = journal.map((r: EnhancementRecord, i: number) => ({ ...r, seq: i + 1 }))
  db.editor.updated_at = new Date().toISOString()
  db.updated_at = db.editor.updated_at
  writeFileSync(APPLY, `${JSON.stringify(db)}\n`, 'utf8')
  console.log(`\n已寫入 ${APPLY}：還原 ${restored.length} 個區塊`)
}
