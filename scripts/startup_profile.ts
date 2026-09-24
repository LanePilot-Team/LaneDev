// 啟動路徑分階段剖析。perf-lab 的主要量測工具。
//   node scripts/run_offline.mjs scripts/startup_profile.ts [--runs=3] [--json]
//
// 量的是「從讀檔到路網圖可用」這條主執行緒路徑，拆成可獨立最佳化的階段。
// prepareBaseRoads 內部再由 setPrepareProfiler 回報子階段。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, parseImportedRecords } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads, setPrepareProfiler } from '../src/core/pipeline'
import { coupletStats, resetCoupletStats } from '../src/core/couplet'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const RUNS = Number(arg('runs', '3'))
const AS_JSON = process.argv.includes('--json')
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))

const ms = () => performance.now()
type Sample = Record<string, number>
const samples: Sample[] = []
const phaseSamples: Record<string, number>[] = []

// 讀檔只做一次（磁碟快取影響大，不是我們要量的變因）
const text = readFileSync(DB_PATH, 'utf8')

for (let i = 0; i < RUNS; i++) {
  const s: Sample = {}
  const phases: Record<string, number> = {}

  let t = ms()
  const db = JSON.parse(text)
  s['1_JSON.parse'] = ms() - t

  t = ms()
  const viaString = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  s['2a_parse舊路徑(stringify往返)'] = ms() - t

  t = ms()
  const parsed = parseImportedRecords(db.segments as Record<string, unknown>[])
  s['2b_parse新路徑(物件)'] = ms() - t
  if (parsed.kind !== 'map' || viaString.kind !== 'map') throw new Error('格式錯誤')
  if (parsed.fc.features.length !== viaString.fc.features.length) {
    throw new Error('兩條 parse 路徑結果不一致')
  }

  t = ms()
  const rawRoads = roadsFromGeoJSON(parsed.fc)
  s['3_roadsFromGeoJSON'] = ms() - t

  resetCoupletStats()
  setPrepareProfiler((name, dur) => { phases[name] = (phases[name] ?? 0) + dur })
  t = ms()
  const { roads } = prepareBaseRoads(rawRoads)
  s['4_prepareBaseRoads'] = ms() - t
  setPrepareProfiler(undefined)
  phases['couplet合併(全部呼叫累計)'] = coupletStats.ms
  phases['couplet呼叫次數'] = coupletStats.calls

  t = ms()
  const folded = foldJournal(db.editor.journal)
  applyToRoads(roads, folded)
  s['5_foldJournal+applyToRoads'] = ms() - t

  t = ms()
  const view = buildRoadMergeViews(roads, db.editor.journal)
  s['6_buildRoadMergeViews'] = ms() - t

  t = ms()
  const graph = new RoadGraph(view.renderRoads)
  s['7_new RoadGraph'] = ms() - t
  void graph

  s['總計(新路徑)'] = s['1_JSON.parse'] + s['2b_parse新路徑(物件)'] + s['3_roadsFromGeoJSON']
    + s['4_prepareBaseRoads'] + s['5_foldJournal+applyToRoads']
    + s['6_buildRoadMergeViews'] + s['7_new RoadGraph']
  samples.push(s)
  phaseSamples.push(phases)
}

const med = (v: number[]) => {
  const a = v.slice().sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)]
}
const agg = (list: Record<string, number>[]) => {
  const keys = [...new Set(list.flatMap((x) => Object.keys(x)))]
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = Math.round(med(list.map((x) => x[k] ?? 0)) * 10) / 10
  return out
}
const main = agg(samples)
const sub = agg(phaseSamples)

if (AS_JSON) {
  console.log(JSON.stringify({ runs: RUNS, main, prepareSubPhases: sub }, null, 2))
} else {
  const total = main['總計(新路徑)']
  console.log(`=== 啟動路徑分階段（${RUNS} 次取中位數，Node）===`)
  for (const [k, v] of Object.entries(main)) {
    if (k.startsWith('總計')) continue
    const pct = k.startsWith('2a') ? '' : `  ${(v / total * 100).toFixed(1).padStart(5)}%`
    console.log(`  ${k.padEnd(34)} ${String(v).padStart(8)} ms${pct}`)
  }
  console.log(`  ${'總計（新路徑）'.padEnd(32)} ${String(total).padStart(8)} ms`)
  console.log(`\n=== prepareBaseRoads 子階段 ===`)
  const entries = Object.entries(sub).filter(([k]) => k !== 'couplet呼叫次數')
    .sort((a, b) => b[1] - a[1])
  for (const [k, v] of entries) {
    console.log(`  ${k.padEnd(34)} ${String(v).padStart(8)} ms`)
  }
  console.log(`  couplet 呼叫次數                    ${String(sub['couplet呼叫次數']).padStart(8)}`)
}
