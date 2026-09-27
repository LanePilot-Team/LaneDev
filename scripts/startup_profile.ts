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
import {
  buildTurnBays, buildRightLanes, buildMotoBoxes, buildStopLines,
  buildChannelization, buildSpecifiedWhiteMotoHatch, buildLaneArrows,
  buildLeftTurnWaitingAreas, baysToGeoJSON, buildMotoLaneEntryIcons,
  buildUnusedLaneGores,
} from '../src/core/turnbays'
import { buildRoadSurfaces, buildDividers, roadsForRendering } from '../src/core/roads'
import { groundMarkingPolygons } from '../src/core/groundMarkings'
import { cleanIntersectionFeatures } from '../src/core/intersectionCleanup'
import { buildRoadTexts } from '../src/core/roadtext'

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

const RENDER_ONLY = process.argv.includes('--render-only')
for (let i = 0; i < (RENDER_ONLY ? 0 : RUNS); i++) {
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

if (RENDER_ONLY) {
  // 只跑幾何生成段，避免第一段留下的堆積壓力污染量測
} else if (AS_JSON) {
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

// ── 第二段：路網圖之後的「幾何生成」階段 ────────────────────────────────
// 前面量的只到「路網圖可用」，但使用者要看到地圖還得等這一段跑完。
// 這裡複製 mapCore.refreshBays() 的呼叫序列（含它內部會再建一次 RoadGraph）。
if (process.argv.includes('--render') || process.argv.includes('--render-only')) {
  const db2 = JSON.parse(text)
  const parsed2 = parseImportedRecords(db2.segments as Record<string, unknown>[])
  if (parsed2.kind !== 'map') throw new Error('bad')
  const { roads: prepared2 } = prepareBaseRoads(roadsFromGeoJSON(parsed2.fc))
  applyToRoads(prepared2, foldJournal(db2.editor.journal))
  const view2 = buildRoadMergeViews(prepared2, db2.editor.journal)
  const journal2 = db2.editor.journal
  const r: Record<string, number> = {}
  const scopeAt: Record<string, number> = {}
  const snapScope = (k: string) => { scopeAt[k] = RoadGraph.scopeStats.calls }
  let t = ms()

  const renderGraph = new RoadGraph(view2.renderRoads)
  r['R1_第二次建圖(renderGraph)'] = ms() - t

  t = ms(); const bays = buildTurnBays(renderGraph, journal2); r['R2_buildTurnBays'] = ms() - t
  t = ms(); const rl = buildRightLanes(renderGraph, journal2); r['R3_buildRightLanes'] = ms() - t
  // 2026-09-27 起 mapCore 先算停等格（資料面），車道級繪圖延後到 zoom ≥ 14.5
  // --old-order：停等格排回停止線之後（09-27 以前的順序），用來對拍調序是否影響輸出
  const OLD_ORDER = process.argv.includes('--old-order')
  let boxes!: ReturnType<typeof buildMotoBoxes>
  const runBoxes = () => {
    t = ms(); boxes = buildMotoBoxes(renderGraph, bays, rl, journal2); r['R7_buildMotoBoxes'] = ms() - t
  }
  if (!OLD_ORDER) runBoxes()
  t = ms()
  const channel = [...buildChannelization(renderGraph, bays),
    ...buildSpecifiedWhiteMotoHatch(renderGraph)]
  r['R4_buildChannelization'] = ms() - t
  snapScope('before_stopLines')
  t = ms(); const stops = buildStopLines(renderGraph, bays, rl, journal2); r['R5_buildStopLines'] = ms() - t
  snapScope('after_stopLines')
  t = ms(); const waits = buildLeftTurnWaitingAreas(renderGraph, bays); r['R6_leftTurnWaitAreas'] = ms() - t
  if (OLD_ORDER) runBoxes()
  t = ms(); const arrows = buildLaneArrows(renderGraph, bays, rl, boxes.dirs, journal2, stops); r['R8_buildLaneArrows'] = ms() - t
  t = ms()
  const fc = baysToGeoJSON(bays, [...channel, ...stops, ...waits], arrows, rl, boxes.boxes)
  fc.features.push(...buildMotoLaneEntryIcons(renderGraph, journal2).features,
    ...buildUnusedLaneGores(renderGraph, bays).features)
  r['R9_baysToGeoJSON'] = ms() - t
  t = ms(); const cleaned = cleanIntersectionFeatures(fc); r['R10_cleanIntersection'] = ms() - t
  t = ms()
  groundMarkingPolygons(cleaned, (p) => p?.kind === 'line' ? (p.color === 'stop' ? 0.45 : 0.15) : null)
  r['R11_groundMarkingPolygons'] = ms() - t
  t = ms(); const rr = roadsForRendering(view2.renderRoads); r['R12_roadsForRendering'] = ms() - t
  t = ms(); buildRoadSurfaces(rr); r['R13_buildRoadSurfaces'] = ms() - t
  t = ms(); const dividerLines = buildDividers(rr); r['R14_buildDividers'] = ms() - t
  // mapCore.paintRoads 的後半：分隔線轉貼地多邊形（虛線切段）。09-27 以前 harness 漏量這段
  t = ms(); const dividerClean = cleanIntersectionFeatures(dividerLines); r['R14a_dividerCleanup'] = ms() - t
  t = ms()
  const dividerMarkings = groundMarkingPolygons(
    dividerClean,
    (p) => p?.kind === 'center' ? 0.3
      : p?.kind === 'tunnel-edge' ? 0.12
      : ['lane', 'center-double', 'moto'].includes(String(p?.kind)) ? 0.15 : null,
    (p) => p?.kind === 'lane' || p?.kind === 'tunnel-edge',
  )
  r['R14b_dividerMarkings'] = ms() - t
  t = ms(); buildRoadTexts(renderGraph, bays); r['R15_buildRoadTexts'] = ms() - t

  const sum = Object.values(r).reduce((a, b) => a + b, 0)
  console.log('')
  console.log('=== scopeEdges 呼叫統計（整個幾何生成段）===')
  console.log(`  總呼叫次數        ${RoadGraph.scopeStats.calls}`)
  console.log(`  累計耗時          ${RoadGraph.scopeStats.ms.toFixed(1)} ms`)
  console.log(`  累計掃過的 edge   ${RoadGraph.scopeStats.edgesScanned.toLocaleString()}`)
  console.log(`  其中 buildStopLines 內   ${(scopeAt['after_stopLines'] ?? 0) - (scopeAt['before_stopLines'] ?? 0)} 次`)
  console.log('\n=== 第二段：幾何生成（refreshBays 等效序列）===')
  for (const [k, v] of Object.entries(r).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(32)} ${v.toFixed(1).padStart(8)} ms`)
  }
  console.log(`  ${'小計'.padEnd(31)} ${sum.toFixed(1).padStart(8)} ms`)

  // ── 幾何結果能不能存起來下次直接用？（IndexedDB 快取方向的可行性）──
  const { gzipSync } = await import('node:zlib')
  const surfaces = buildRoadSurfaces(rr)
  const dividers = buildDividers(rr)
  const payload = { turnbays: cleaned, surfaces, dividers }
  let t2 = ms(); const js = JSON.stringify(payload); const serMs = ms() - t2
  t2 = ms(); const back = JSON.parse(js); const deMs = ms() - t2
  const gz = gzipSync(Buffer.from(js), { level: 6 }).length
  console.log('')
  console.log('=== 幾何結果序列化可行性 ===')
  console.log(`  圖徵數            turnbays ${cleaned.features.length} / surfaces ${surfaces.features.length} / dividers ${dividers.features.length}`)
  console.log(`  JSON 大小         ${(Buffer.byteLength(js) / 1048576).toFixed(2)} MB（gzip ${(gz / 1048576).toFixed(2)} MB）`)
  console.log(`  序列化（只在第一次） ${serMs.toFixed(0)} ms`)
  console.log(`  反序列化（第二次起） ${deMs.toFixed(0)} ms`)
  console.log(`  對照：現算全部       ${sum.toFixed(0)} ms`)
  console.log(`  比值               ${(sum / deMs).toFixed(1)}×`)
  void back

  // ── 輸出指紋：最佳化前後逐 byte 比對，證明無損 ──
  if (process.argv.includes('--hash')) {
    const { createHash } = await import('node:crypto')
    const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)
    console.log('')
    console.log('=== 輸出指紋（sha1 前 12 碼）===')
    const parts: Record<string, unknown> = { stops, arrows, boxes, bays, rl, cleaned, surfaces, dividers, dividerMarkings }
    for (const [k, v] of Object.entries(parts)) console.log(`  ${k.padEnd(10)} ${sha(v)}`)
  }
}
