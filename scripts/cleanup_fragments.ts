// 碎塊清理（node scripts/run_offline.mjs scripts/cleanup_fragments.ts [--apply=<out>]）
//
// 刪除「幾乎整段疊在同 way 較長區塊上」的短碎塊。這些是 OSM 原始資料的殘留，
// 實地上不存在獨立路段；它們各自帶著自己的中央帶／車道設定疊在主線上，畫出來
// 就是交叉白線與雙重黃線。
//
// 硬約束：**不得讓任何路段變成無法連接／無法使用**。
// 刪除是以「連通元件數不得增加」為準——刪完之後重建導航圖，若有任何道路因此
// 脫離主要路網，就把造成脫離的碎塊放回去，反覆收斂到連通性完全不變為止。
//
// 光靠連通元件數是不夠的（2026-07-30 的批次就是這樣誤刪了 64 段）：主幹道中間
// 少掉一段，兩側往往還能繞小巷相通，元件數不變，A* 卻只剩「鑽側巷或迴轉」這條路。
// 所以另外加了兩道守門：
//   1. 重疊要看**垂距**。原本比的是頂點對頂點 12m，而碎塊長度上限是 25m——
//      一段 10m、只有兩個頂點、單純接在長區塊後面的正常路段，兩個頂點離長區塊
//      端點都 <12m，重疊率算出來就是 100%。
//   2. 中間環節不得刪。區塊的節點相鄰關係若沒有別條現存道路接手，而且兩端節點
//      刪除後仍被其他道路使用，那它就是路網的中間環節，刪掉等於把路從中間切斷。
//
//   --maxlen=<公尺>  碎塊長度上限（預設 25）
//   --apply=<檔案>   寫出結果；不給就只預演
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
const MAXLEN = Number(arg('maxlen', '25'))
const APPLY = arg('apply', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const lengthOf = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}

function build(extraDeleted: Set<string>) {
  const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
  const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads, foldJournal(journal))
  applyRoadMerges(roads, journal)
  for (const r of roads) if (extraDeleted.has(key(r))) r.properties.deleted = true
  return roads.filter((r) => !r.properties.deleted)
}

/**
 * 路網連通元件。直接用道路的節點串做 union-find：一條路把自己的節點連起來，
 * 共用節點的道路自然併入同一元件。這正是「哪條路脫離了路網」的判準。
 * 回傳元件數 ＋ 最大元件（主要路網）涵蓋的道路數。
 */
function components(active: RoadFeature[]) {
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
  for (const r of active) {
    const ns = r.properties.nodes
    for (let i = 1; i < ns.length; i++) union(ns[i - 1], ns[i])
  }
  const size = new Map<number, number>()
  for (const r of active) {
    const root = find(r.properties.nodes[0])
    size.set(root, (size.get(root) ?? 0) + 1)
  }
  const biggest = Math.max(0, ...size.values())
  return { count: size.size, biggest, find }
}

// ── 1. 找出候選碎塊 ─────────────────────────────────────────────────────────
const base = build(new Set())
const byWay = new Map<number, RoadFeature[]>()
for (const r of base) {
  const list = byWay.get(r.properties.osm_id) ?? []
  list.push(r)
  byWay.set(r.properties.osm_id, list)
}
/** 點到折線的最短距離（公尺）。近似平面投影，這個尺度下誤差可忽略。 */
const pointToPolyline = (p: [number, number], line: [number, number][]) => {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const mx = Math.cos((p[1] * Math.PI) / 180)
    const dx = (bx - ax) * mx
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0
      : Math.max(0, Math.min(1, (((p[0] - ax) * mx * dx) + ((p[1] - ay) * dy)) / len2))
    best = Math.min(best, haversine(p, [ax + (dx * t) / (mx || 1), ay + dy * t]))
  }
  return best
}
/**
 * 「這段是不是疊在那段上面」。用**垂距**而不是頂點距離：頂點距離會把「首尾相接
 * 的正常續行段」也算成 100% 重疊（碎塊只有兩個頂點，兩端各離長區塊端點幾公尺）。
 * 共用節點本來就重合，計算時要排除，否則接縫處永遠算命中。
 */
const OVERLAP_M = 4
const overlapRatio = (small: RoadFeature, big: RoadFeature) => {
  const sc = small.geometry.coordinates as [number, number][]
  const bc = big.geometry.coordinates as [number, number][]
  const shared = new Set(big.properties.nodes)
  const probes = sc.filter((_, i) => !shared.has(small.properties.nodes[i]))
  if (!probes.length) return 0 // 節點全共用＝同一條鏈上的續行段，不是疊圖
  const inside = probes.filter((p) => pointToPolyline(p, bc) < OVERLAP_M).length
  return inside / probes.length
}
// 被捏合紀錄引用的區塊絕對不能刪。2026-07-29 的清理少了這道檢查，刪掉了 5 組
// 軍校路捏合的組成區塊，使用者的捏合當場失效——看起來就像「紀錄又消失了」。
// 幾何上疊在主線裡不代表它是垃圾：使用者可能正是把這些碎塊捏合成一段。
const mergeReferenced = new Set<string>()
for (const [k, f] of foldJournal(journal)) {
  if (!k.startsWith('merge/')) continue
  mergeReferenced.add(String(f.primary ?? ''))
  mergeReferenced.add(String(f.secondary ?? ''))
}

const candidates: string[] = []
let skippedByMerge = 0
for (const [, list] of byWay) {
  for (const small of list) {
    if (lengthOf(small) > MAXLEN) continue
    if (mergeReferenced.has(key(small))) { skippedByMerge++; continue }
    for (const big of list) {
      if (big === small || lengthOf(big) <= lengthOf(small) * 1.5) continue
      if (overlapRatio(small, big) < 0.9) continue
      candidates.push(key(small))
      break
    }
  }
}
const unique = [...new Set(candidates)]
console.log(`活躍區塊 ${base.length}｜疊壞碎塊候選 ${unique.length}`
  + `｜因被捏合引用而跳過 ${skippedByMerge}`)

// ── 2. 連通性守門：逐個試刪，只收下「刪了也不影響連通」的 ──────────────────
//
// 批次刪除行不通：573 個一起刪會讓元件 20 → 60，代表有數十群道路變成孤島。
// 這些碎塊雖然幾何上疊在主線裡，卻有不少是側街接上路網的**唯一通路**。
//
// 切塊結果是固定的，刪除只是把區塊移出活躍集合，所以不必每次重跑管線——
// 直接對「目前活躍集合扣掉候選」重算 union-find 即可，快上兩個數量級。
// 貪婪累積：每個候選都跟「已接受的刪除集合」一起檢查，避免個別安全但合起來
// 會切斷路網的組合。
const before = components(base)
console.log(`刪除前連通元件 ${before.count}｜最大元件含 ${before.biggest} 條道路`)

/**
 * 刪掉這個區塊會不會把路從中間切斷？
 * 判準：區塊帶的每組節點相鄰關係，若沒有任何**現存**道路接手，而且該組兩端節點
 * 刪除後仍被其他道路使用，那這段就是路網的中間環節。連通元件數看不出這件事——
 * 缺口兩側繞小巷照樣相通，元件數不變，但主幹道上就是多了一個 A* 過不去的洞。
 */
const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
function seversChain(block: RoadFeature, active: RoadFeature[]): boolean {
  const adjacency = new Set<string>()
  const liveNodes = new Set<number>()
  for (const r of active) {
    if (key(r) === key(block)) continue
    const ns = r.properties.nodes
    for (let i = 0; i < ns.length; i++) {
      liveNodes.add(ns[i])
      if (i > 0) adjacency.add(pairKey(ns[i - 1], ns[i]))
    }
  }
  const ns = block.properties.nodes
  for (let i = 1; i < ns.length; i++) {
    if (adjacency.has(pairKey(ns[i - 1], ns[i]))) continue
    if (liveNodes.has(ns[i - 1]) && liveNodes.has(ns[i])) return true
  }
  return false
}

const accepted = new Set<string>()
const protectedKeys: string[] = []
let severingSkipped = 0
let checked = 0
for (const k of unique) {
  checked++
  const trial = new Set(accepted)
  trial.add(k)
  const active = base.filter((r) => !trial.has(key(r)))
  const block = base.find((r) => key(r) === k)!
  if (seversChain(block, active)) { severingSkipped++; protectedKeys.push(k); continue }
  const comp = components(active)
  // 元件數不得增加；孤立碎塊本身被刪掉會讓元件變少，那是好事
  if (comp.count <= before.count) accepted.add(k)
  else protectedKeys.push(k)
  if (checked % 100 === 0) {
    console.log(`   進度 ${checked}/${unique.length}｜已接受 ${accepted.size}｜保護 ${protectedKeys.length}`)
  }
}

const doomed = accepted
const finalActive = base.filter((r) => !doomed.has(key(r)))
const finalComp = components(finalActive)
// 實際移除的「物件」數會比「鍵」數多：重複鍵仍存在，一個鍵可能對到多個物件。
// 最大元件的縮減量必須剛好等於移除的物件數——多縮一個就代表有道路被切離了。
const removedObjects = base.length - finalActive.length
const componentsOk = finalComp.count <= before.count
const noDetached = finalComp.biggest >= before.biggest - removedObjects
console.log(`\n最終：刪除 ${doomed.size} 個碎塊鍵（${removedObjects} 個物件）`
  + `｜保護 ${protectedKeys.length} 個（其中中間環節 ${severingSkipped} 個、唯一通路`
  + ` ${protectedKeys.length - severingSkipped} 個）`)
console.log(`活躍區塊 ${base.length} → ${finalActive.length}`)
console.log(`連通元件 ${before.count} → ${finalComp.count}`
  + `｜最大元件 ${before.biggest} → ${finalComp.biggest}`
  + `（預期 ≥ ${before.biggest - removedObjects}）`
  + (componentsOk && noDetached ? '  ✅ 沒有任何道路被切離' : '  ❌ 有道路被切離，不可套用'))

if (!componentsOk || !noDetached) process.exit(1)
if (!APPLY) {
  console.log('\n（預演，未寫檔。加 --apply=<路徑> 才會寫入）')
  process.exit(0)
}
const live = new Set(base.map(key))
let added = 0
for (const k of doomed) {
  if (!live.has(k)) continue
  journal.push({
    seq: journal.length + 1,
    ts: new Date().toISOString(),
    author: 'anna',
    op: 'set',
    target: { type: 'road', key: k },
    fields: { deleted: 1 },
  })
  added++
}
db.editor.journal = journal.map((r, i) => ({ ...r, seq: i + 1 }))
db.editor.updated_at = new Date().toISOString()
db.updated_at = db.editor.updated_at
writeFileSync(APPLY, `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已寫入 ${APPLY}：新增 ${added} 筆 deleted:1`)
