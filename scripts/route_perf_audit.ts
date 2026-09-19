// A* 路徑規劃效能稽核：量測展開節點數、產生狀態數與耗時。
//   node scripts/run_offline.mjs scripts/route_perf_audit.ts [--runs=5] [--profile=car|moto]
//
// 回答「狀態空間會不會爆炸」——本專案的 A* 狀態是三元組
// （節點, 進入邊, 進入車道），理論上限是 節點數 × 入邊數 × 車道數，
// 但實際展開數遠低於此，因為狀態是 lazy 建立且有 closed 剪枝。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, parseImportedRecords } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const RUNS = Number(arg('runs', '5'))
const PROFILE = arg('profile', 'car') as 'car' | 'moto'

const t0 = Date.now()
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const tParse = Date.now() - t0

// A/B：舊路徑（stringify → join → 逐行 parse）vs 新路徑（直接吃物件陣列）
const t1a = Date.now()
const viaString = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
const tViaString = Date.now() - t1a

const t1b = Date.now()
const parsed = parseImportedRecords(db.segments as Record<string, unknown>[])
const tViaRecords = Date.now() - t1b

if (parsed.kind !== 'map' || viaString.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
if (parsed.fc.features.length !== viaString.fc.features.length) {
  throw new Error(`兩條路徑結果不一致：${parsed.fc.features.length} vs ${viaString.fc.features.length}`)
}
const tRoundTrip = tViaRecords

const t2 = Date.now()
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor.journal))
const view = buildRoadMergeViews(roads, db.editor.journal)
const tPrepare = Date.now() - t2

const t3 = Date.now()
const graph = new RoadGraph(view.renderRoads)
const tGraph = Date.now() - t3

console.log('=== 載入階段耗時（Node，非瀏覽器）===')
console.log(`  JSON.parse(road_database.json)   ${tParse} ms`)
console.log(`  舊：stringify→join→逐行 parse    ${tViaString} ms`)
console.log(`  新：parseImportedRecords(物件)    ${tViaRecords} ms   ← 節省 ${tViaString - tViaRecords} ms`)
console.log(`  prepareBaseRoads + 套用標註      ${tPrepare} ms`)
console.log(`  new RoadGraph(建圖)              ${tGraph} ms`)
console.log(`  合計                             ${tParse + tRoundTrip + tPrepare + tGraph} ms`)

// 路網規模
const nodes = new Set<number>()
for (const r of view.renderRoads) for (const n of (r.properties.nodes ?? [])) nodes.add(n)
console.log(`\n=== 路網規模 ===`)
console.log(`  路段（renderRoads）              ${view.renderRoads.length}`)
console.log(`  相異節點                         ${nodes.size}`)

// Demo 路線：高雄大學 → 楠梓車站
const CASES: Array<{ name: string; from: [number, number]; to: [number, number] }> = [
  { name: 'Demo 高雄大學→楠梓車站', from: [120.2870, 22.7336], to: [120.3268, 22.7276] },
  { name: '短程（楠梓路口內）', from: [120.3215, 22.7276], to: [120.3198, 22.7331] },
  { name: '長程（左營→楠梓北）', from: [120.3043, 22.6701], to: [120.3213, 22.7285] },
]

console.log(`\n=== A* 搜尋統計（profile=${PROFILE}，每案 ${RUNS} 次取中位數）===`)
console.log('  案例                        展開     產生    耗時ms   路線長度')
for (const c of CASES) {
  const ex: number[] = []; const ge: number[] = []; const ms: number[] = []
  let lenM = 0; let ok = false
  for (let i = 0; i < RUNS; i++) {
    const s = Date.now()
    const r = graph.routeDetailed(c.from, c.to, PROFILE)
    ms.push(Date.now() - s)
    ex.push(RoadGraph.searchStats.expanded)
    ge.push(RoadGraph.searchStats.generated)
    if (r.route) {
      ok = true
      const cs = r.route.coords as [number, number][]
      lenM = cs.slice(1).reduce((a, p, k) => a + haversine(cs[k], p), 0)
    }
  }
  const med = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)]
  console.log(
    `  ${c.name.padEnd(24)} ${String(med(ex)).padStart(7)} ${String(med(ge)).padStart(8)}`
    + ` ${String(med(ms)).padStart(8)}   ${ok ? (lenM / 1000).toFixed(2) + ' km' : '無路線'}`,
  )
}

const theoretical = nodes.size * 4 * 4
console.log(`\n  理論狀態上限粗估（節點 × 入邊~4 × 車道~4）≈ ${theoretical.toLocaleString()}`)
console.log('  實際展開數遠低於此：狀態 lazy 建立 + closed 剪枝 + bestGoal 提前結束。')
