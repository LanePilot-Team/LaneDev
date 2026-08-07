// couplet 夾心防呆稽核（node scripts/run_offline.mjs scripts/couplet_audit.ts）
//
// 成對單行合併把兩條 oneway 併成一條雙向路，中心線取兩線中點。若那兩條線其實是
// 「夾著別條路」的兩條側車道，合成的中心線就會整條壓在主線上——地圖上同一條路
// 畫兩份（清豐路實測全長 0.1～0.6m 重合、58 組重合區塊）。couplet.ts 的
// sandwichReport 用「中線有多少比例被別條路佔著」判定，這支負責證明門檻仍然
// 把兩群分得開：真正的成對單行只有橫向路口會掠過中線，被夾的主線是全長貼著。
//
//   --name=清豐路   只看某條路（預設全掃）
//   --verbose       連被判定為正常的 scope 也列出壓線來源
//
// ⚠ 這支只跑 applyFixups 後的原始路網，不重播 pipeline 那一長串「逐路依序合併」。
// 先合併的路會改動幾何，所以個別 scope 的覆蓋率可能與 prepareBaseRoads 當下不同
// （德民新橋機車道在這裡 39%、在 pipeline 裡 94%）。要看實際決策請讀
// prepareBaseRoads 的「couplet 合併中止」警告；這支負責的是門檻的鑑別力。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { applyFixups, REMOVED_WAY_IDS } from '../src/core/fixups'
import { coupletGrouping, sandwichReport } from '../src/core/couplet'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const ONLY = arg('name', '')
const VERBOSE = process.argv.includes('--verbose')
/** 判定「還沒踩線但已經很靠近門檻」的樣本數下限——3 個取樣點的比例沒有意義 */
const MIN_SAMPLES = 10
/** 合併的 scope 覆蓋率若逼近中止門檻，代表兩群快要疊在一起，要人工複核 */
const REVIEW_AT = 0.45

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const raw = roadsFromGeoJSON(parsed.fc)
applyFixups(raw)
const roads = raw.filter((r) => !REMOVED_WAY_IDS.has(r.properties.osm_id))

// pipeline 的泛用候選：同名 oneway ≥2 條。自訂斷面的路走各自的顯式呼叫，
// 但夾心風險一樣存在，所以這裡不排除它們——稽核要看得比 pipeline 廣。
const count = new Map<string, number>()
for (const r of roads) {
  const p = r.properties
  if (p.oneway !== 'yes' || !p.name) continue
  if (p.junction === 'roundabout' || p.nodes[0] === p.nodes[p.nodes.length - 1]) continue
  count.set(p.name, (count.get(p.name) ?? 0) + 1)
}
const names = [...count.keys()].filter((n) => count.get(n)! >= 2)
  .filter((n) => !ONLY || n.includes(ONLY)).sort()

interface Row {
  name: string
  samples: number
  coverage: number
  sandwiched: boolean
  legacy: boolean
  sameDirParallel: boolean
  blame: { road: RoadFeature; hits: number }[]
}
const rows: Row[] = []
for (const name of names) {
  const grouping = coupletGrouping(roads, new Set([name]))
  if (!grouping) continue
  if (grouping.sameDirParallelPair) {
    rows.push({ name, samples: 0, coverage: 0, sandwiched: false,
      legacy: false, sameDirParallel: true, blame: [] })
    continue
  }
  if (!grouping.drop.length) continue
  const report = sandwichReport(roads, grouping.keep, grouping.drop)
  if (!report) continue
  rows.push({
    name, samples: report.samples, coverage: report.coverage,
    sandwiched: report.sandwiched, legacy: report.legacyHit !== null,
    sameDirParallel: false, blame: report.blame,
  })
}

const sandwiched = rows.filter((r) => r.sandwiched)
const merged = rows.filter((r) => !r.sandwiched && !r.sameDirParallel)
const blameOf = (r: Row) => r.blame.slice(0, 3)
  .map((b) => `${b.hits}×way/${b.road.properties.osm_id}（${b.road.properties.name ?? '無名'}）`)
  .join('、')

console.log(`同名 oneway 候選 ${rows.length} 條`
  + `｜夾心中止 ${sandwiched.length}`
  + `｜同向並排中止 ${rows.filter((r) => r.sameDirParallel).length}`
  + `｜合併 ${merged.length}\n`)

console.log('── 判定為夾心（整路不合併）──')
for (const r of sandwiched.sort((a, b) => b.coverage - a.coverage)) {
  console.log(`  ${r.name.padEnd(14)} 覆蓋 ${(100 * r.coverage).toFixed(0).padStart(3)}%`
    + `（${String(r.samples).padStart(3)} 點）${r.legacy ? '［含舊規則］' : ''} ${blameOf(r)}`)
}

console.log('\n── 合併的 scope，覆蓋率最高的幾條 ──')
for (const r of merged.sort((a, b) => b.coverage - a.coverage).slice(0, VERBOSE ? 999 : 8)) {
  console.log(`  ${r.name.padEnd(14)} 覆蓋 ${(100 * r.coverage).toFixed(0).padStart(3)}%`
    + `（${String(r.samples).padStart(3)} 點）${blameOf(r)}`)
}

// 判準：兩群要分得開。取樣點太少的 scope 比例是雜訊，不列入。
const graded = merged.filter((r) => r.samples >= MIN_SAMPLES)
const worst = graded.reduce<Row | null>((a, b) => (!a || b.coverage > a.coverage ? b : a), null)
const lowestSandwich = sandwiched
  .reduce<Row | null>((a, b) => (!a || b.coverage < a.coverage ? b : a), null)
console.log(`\n合併中最高覆蓋：${worst ? `${worst.name} ${(100 * worst.coverage).toFixed(0)}%` : '—'}`
  + `（僅計 ≥${MIN_SAMPLES} 取樣點）`)
console.log(`夾心中最低覆蓋：${lowestSandwich
  ? `${lowestSandwich.name} ${(100 * lowestSandwich.coverage).toFixed(0)}%` : '—'}`)

const risky = graded.filter((r) => r.coverage >= REVIEW_AT)
if (risky.length) {
  console.log(`\n❌ ${risky.length} 條合併中的路已逼近夾心門檻（≥${100 * REVIEW_AT}%），請人工複核：`)
  for (const r of risky) console.log(`   ${r.name}：${(100 * r.coverage).toFixed(0)}% ${blameOf(r)}`)
} else {
  console.log('\n✅ 沒有合併中的路逼近夾心門檻——兩群仍分得開')
}
process.exitCode = risky.length ? 1 : 0
