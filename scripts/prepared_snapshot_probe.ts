// 實驗：把 prepareBaseRoads 的輸出預先算好並序列化，量「改讀快照」能省多少。
//   node scripts/run_offline.mjs scripts/prepared_snapshot_probe.ts [--runs=7] [--warmup=2]
//
// 前提：prepareBaseRoads 只吃 db.segments（Base Layer），與 journal 無關——
// journal 是在它之後由 applyToRoads 套用的。所以只要 segments 沒變，
// 它的輸出就固定，可在建置期算好隨 APK／靜態站一起出貨。
//
// ── 量測方法（為了對抗本機的大幅變異）──
//   1. 暖身若干輪後才開始計時，排除 JIT 分層編譯的影響
//   2. A/B 交錯執行（ABAB…），讓 CPU 降頻／背景負載對兩者影響相同
//   3. 回報 min / median / max，不只中位數——絕對值在本機不可靠，
//      同一程序內的 A/B 比值才是穩定訊號
//   4. 每輪之間 global.gc()（有 --expose-gc 時）降低 GC 時點的干擾
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImportedRecords } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const RUNS = Number(arg('runs', '7'))
const WARMUP = Number(arg('warmup', '2'))
const OUT = join(HERE, '../.perf-prepared-snapshot.json')

const ms = () => performance.now()
const gc = () => { const g = (globalThis as { gc?: () => void }).gc; if (g) g() }
const stats = (v: number[]) => {
  const a = v.slice().sort((x, y) => x - y)
  const r = (n: number) => Math.round(n * 10) / 10
  return { min: r(a[0]), med: r(a[Math.floor(a.length / 2)]), max: r(a[a.length - 1]) }
}

const text = readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8')
const db = JSON.parse(text)
const segments = db.segments as Record<string, unknown>[]

// ⚠ 管線會就地修改輸入（importmap.ts:108 直接共用 rec.geometry 物件，
//   couplet 合併移動節點座標時就寫回了來源）。見 E7 決定性實驗。
//   因此每一輪都必須給全新的深拷貝，否則第 2 輪之後量的是「被污染的資料」，
//   兩個條件就不是在比同一件事。深拷貝成本在計時區間之外。
function freshSegments(): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(segments)) as Record<string, unknown>[]
}

/** A：現行路徑——每次啟動都重跑 prepareBaseRoads */
function runLive(src: Record<string, unknown>[]) {
  const parsed = parseImportedRecords(src)
  if (parsed.kind !== 'map') throw new Error('格式錯誤')
  const raw = roadsFromGeoJSON(parsed.fc)
  const t = ms()
  const out = prepareBaseRoads(raw)
  return { ms: ms() - t, out }
}

// 先產生一份快照（建置期才會做的事，不計入啟動成本）
const seed = runLive(freshSegments())
const snapshot = {
  format: 'lanedev-prepared-base-v1',
  sourceCount: segments.length,          // 來源指紋：變了就必須重算
  sourceUpdatedAt: db.updated_at,
  roads: seed.out.roads,
  nodeRemap: [...seed.out.nodeRemap.entries()],
  wayRemap: [...seed.out.wayRemap.entries()],
}
const tSer = ms()
const json = JSON.stringify(snapshot)
const serMs = ms() - tSer
writeFileSync(OUT, json, 'utf8')
const bytes = statSync(OUT).size
const gzBytes = gzipSync(Buffer.from(json), { level: 6 }).length

/** B：快照路徑——啟動時只 parse 快照並還原 Map */
function runSnapshot() {
  const t = ms()
  const s = JSON.parse(json)
  const out = {
    roads: s.roads as RoadFeature[],
    nodeRemap: new Map<number, number>(s.nodeRemap),
    wayRemap: new Map(s.wayRemap),
  }
  return { ms: ms() - t, out }
}

// 暖身（不計時）
for (let i = 0; i < WARMUP; i++) { runLive(freshSegments()); runSnapshot(); gc() }

// A/B 交錯量測
const liveT: number[] = []
const snapT: number[] = []
let lastLive = seed.out
let lastSnap = runSnapshot().out
for (let i = 0; i < RUNS; i++) {
  const a = runLive(freshSegments()); liveT.push(a.ms); lastLive = a.out; gc()
  const b = runSnapshot(); snapT.push(b.ms); lastSnap = b.out; gc()
}

const L = stats(liveT)
const S = stats(snapT)
const ratios = liveT.map((v, i) => v / snapT[i])
const R = stats(ratios)

// 無損驗證：快照還原的結果與現算結果逐欄位相同
const lossless = JSON.stringify(lastLive.roads) === JSON.stringify(lastSnap.roads)
const remapOk = lastLive.nodeRemap.size === lastSnap.nodeRemap.size
  && lastLive.wayRemap.size === lastSnap.wayRemap.size

console.log('=== 實驗 E6：預先計算 prepareBaseRoads 輸出 ===')
console.log(`  量測設定    暖身 ${WARMUP} 輪、計時 ${RUNS} 輪、A/B 交錯、每輪後 gc()`)
console.log(`  gc() 可用   ${(globalThis as { gc?: unknown }).gc ? '是' : '否（未加 --expose-gc）'}`)
console.log()
console.log('  條件                          min      med      max')
console.log(`  A 現行：每次啟動重算    ${String(L.min).padStart(9)}${String(L.med).padStart(9)}${String(L.max).padStart(9)} ms`)
console.log(`  B 快照：JSON.parse 還原 ${String(S.min).padStart(9)}${String(S.med).padStart(9)}${String(S.max).padStart(9)} ms`)
console.log(`  A/B 比值                ${String(R.min.toFixed(1)).padStart(9)}${String(R.med.toFixed(1)).padStart(9)}${String(R.max.toFixed(1)).padStart(9)} ×`)
console.log()
console.log('=== 快照成本 ===')
console.log(`  路段數                       ${seed.out.roads.length}`)
console.log(`  序列化耗時（僅建置期）        ${Math.round(serMs)} ms`)
console.log(`  檔案大小                     ${(bytes / 1048576).toFixed(2)} MB`)
console.log(`  gzip 後                      ${(gzBytes / 1048576).toFixed(2)} MB`)
console.log(`  對照 road_database.json      ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB`
  + `（gzip ${(gzipSync(Buffer.from(text), { level: 6 }).length / 1048576).toFixed(2)} MB）`)
console.log()
console.log('=== 正確性 ===')
console.log(`  roads 無損還原               ${lossless ? 'PASS 完全一致' : 'FAIL 有差異'}`)
console.log(`  nodeRemap / wayRemap         ${remapOk ? 'PASS 一致' : 'FAIL 不一致'}`
  + `  (${lastLive.nodeRemap.size} / ${lastLive.wayRemap.size})`)

unlinkSync(OUT)
