// 大眾運輸資料稽核：確認 public/data/transit.json 真的對得上底圖。
//
// 跟 build_transit.mjs 的差別很重要：build script 用 road_database 的**原始** segment
// 做範圍篩選（快、穩定、不受前處理版本影響），這支則跑**與 App 相同的前處理管線**
// （prepareBaseRoads + journal），所以量到的是「App 實際看到的路網」。
// 兩者不一致的地方（couplet 合併、退化清理改掉的路段）正是我們要抓的東西。
//
// 回答 docs/tdx-transit-plan.md §5 的四個問題：
//   1. 站點有沒有落在路網上
//   2. 公車站牌的行向與左右側判不判得出來（§3-A 的前提）
//   3. TDX 路線線型跟底圖差多少（量化「示意線型不可當底圖」）
//   4. 資料規模
//
// 用法：node scripts/run_offline.mjs scripts/transit_audit.ts [--list-far]
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import {
  buildPolylineIndex, resolveBusStopPlacement, snapToPolylines, RAIL_SYSTEM_LABEL,
  type BusShapeFile, type TransitDataset,
} from '../src/core/transit'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST_FAR = process.argv.includes('--list-far')

// ── 底圖：與 App 相同的前處理管線 ──
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const folded = foldJournal(db.editor?.journal ?? [])
const roadFeatures = [...prepared.roads, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
applyToRoads(roadFeatures, folded)
const active = roadFeatures.filter((r) => !r.properties.deleted)
const polylines = active.map((r) => r.geometry.coordinates as [number, number][])
const index = buildPolylineIndex(polylines)

const dataset = JSON.parse(
  readFileSync(join(HERE, '../public/data/transit.json'), 'utf8'),
) as TransitDataset
const shapes = JSON.parse(
  readFileSync(join(HERE, '../public/data/transit_bus_shapes.json'), 'utf8'),
) as BusShapeFile

const pct = (n: number, total: number) => `${((100 * n) / (total || 1)).toFixed(1)}%`
const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN
const kb = (p: string) => `${(statSync(p).size / 1024).toFixed(0)} KB`

console.log('=== 大眾運輸資料稽核 ===')
console.log(`底圖（前處理後）${active.length} 段`)
console.log(`資料來源：${dataset.source.platform}，同步時間 ${dataset.source.fetchedAt}`)
console.log(`收錄門檻：公車站牌 ${dataset.scope.busStopProximityM}m／其他站點`
  + ` ${dataset.scope.placeProximityM}m\n`)

let failures = 0

// ── 1+2. 公車站牌：落點、行向、左右側 ──
console.log('── 公車站牌落點與側別（§3-A 前提）──')
const placements = dataset.busStops.map((stop) =>
  resolveBusStopPlacement(stop, polylines, index, dataset.scope.busStopProximityM))
const snapped = placements.filter((p) => p !== null)
const lost = dataset.busStops.length - snapped.length
const withTravel = snapped.filter((p) => p!.travelBearing !== undefined)
const right = snapped.filter((p) => p!.side === 'right')
const left = snapped.filter((p) => p!.side === 'left')
const unknownSide = snapped.filter((p) => p!.side === 'unknown')
const offsets = snapped.map((p) => p!.offsetM).sort((a, b) => a - b)

console.log(`站牌 ${dataset.busStops.length} 筆`)
console.log(`  snap 成功        ${snapped.length}（${pct(snapped.length, dataset.busStops.length)}）`
  + `　垂距 中位 ${quantile(offsets, 0.5).toFixed(1)}m／p90 ${quantile(offsets, 0.9).toFixed(1)}m`)
console.log(`  可判行車方向      ${withTravel.length}（${pct(withTravel.length, snapped.length)}）`)
console.log(`  側別 右 ${right.length}／左 ${left.length}／判不出來 ${unknownSide.length}`
  + `　→ 可用於車道提示 ${right.length + left.length}（${pct(right.length + left.length, snapped.length)}）`)

// build script 用原始 segment 篩、這裡用前處理後的路網量，兩者本來就會有一點落差：
// couplet 合併會把成對道路併成一條，中心線因此橫向位移數公尺，貼在原路邊的站牌
// 就可能掉出門檻。這是刻意的取捨（build 的篩選要穩定、不隨前處理版本跳動），
// 所以少量落差是正常的，只有**大量**掉點才代表前處理出了回歸。
const LOST_ALERT_RATIO = 0.01
if (lost > 0) {
  const overBudget = lost > dataset.busStops.length * LOST_ALERT_RATIO
  console.log(`  ${overBudget ? '❌' : '⚠'} 有 ${lost} 筆`
    + `（${pct(lost, dataset.busStops.length)}）在原始 segment 上 snap 得到、套用前處理後掉出門檻`)
  console.log('     少量屬正常（couplet 合併會讓中心線橫向位移）；'
    + `超過 ${LOST_ALERT_RATIO * 100}% 才代表前處理有回歸`)
  if (overBudget) failures++
}
// 台灣靠右行駛，站牌絕大多數應該在行進方向的右側。左側過多＝方向判斷有系統性錯誤
const leftRatio = left.length / Math.max(1, right.length + left.length)
if (leftRatio > 0.2) {
  console.log(`  ❌ 左側站牌佔 ${pct(left.length, right.length + left.length)}——台灣靠右行駛，`
    + '這個比例代表行向或側別判斷有系統性錯誤')
  failures++
} else {
  console.log(`  ✅ 左側佔比 ${pct(left.length, right.length + left.length)}（靠右行駛下屬合理範圍，`
    + '多為港灣式站台或分隔島設站）')
}

// ── 1. 其他站點落點 ──
console.log('\n── 其他站點落點 ──')
for (const [label, rows] of [
  ['YouBike 站', dataset.bikeStations],
  ['軌道車站', dataset.railStations],
] as const) {
  const ds = rows.map((r) => snapToPolylines(r.pos, polylines, index, 500))
    .map((h) => h?.distM ?? Infinity).sort((a, b) => a - b)
  // 同上：門檻是拿原始 segment 篩的，這裡量前處理後的路網，邊緣幾筆會超出一點點
  const far = ds.filter((d) => d > dataset.scope.placeProximityM).length
  console.log(`${label}（${rows.length} 筆）：垂距 中位 ${quantile(ds, 0.5).toFixed(1)}m`
    + `／p90 ${quantile(ds, 0.9).toFixed(1)}m／最遠 ${ds[ds.length - 1]?.toFixed(1)}m`
    + `${far ? `　⚠ 前處理後有 ${far} 筆略超門檻（不影響顯示，站點是點位不需 snap）` : ''}`)
}
for (const system of ['KRTC', 'KLRT', 'TRA', 'THSR'] as const) {
  const rows = dataset.railStations.filter((s) => s.system === system)
  if (rows.length) {
    console.log(`  ${RAIL_SYSTEM_LABEL[system]}：${rows.map((s) => s.name).join('、')}`)
  }
}

if (LIST_FAR) {
  console.log('\n  離路網最遠的 10 個站點：')
  const rows = [...dataset.bikeStations.map((b) => ({ name: b.name, pos: b.pos, kind: 'YouBike' })),
    ...dataset.railStations.map((r) => ({ name: r.name, pos: r.pos, kind: r.system }))]
  rows.map((r) => ({ ...r, d: snapToPolylines(r.pos, polylines, index, 500)?.distM ?? Infinity }))
    .sort((a, b) => b.d - a.d).slice(0, 10)
    .forEach((r) => console.log(`    ${r.d.toFixed(0).padStart(4)}m  ${r.kind.padEnd(8)} ${r.name}`))
}

// ── 3. TDX 線型 vs 底圖（量化「示意線型不可當底圖」）──
console.log('\n── TDX 路線線型與底圖的偏差 ──')
for (const [label, lines] of [
  ['公車路線線型', shapes.routes.map((r) => r.coords)],
  ['軌道線型', dataset.railLines.map((l) => l.coords)],
] as const) {
  const samples: number[] = []
  for (const coords of lines) {
    // 每條線抽樣 20 點就夠看分布，全點量沒有更多資訊卻慢很多
    const step = Math.max(1, Math.floor(coords.length / 20))
    for (let i = 0; i < coords.length; i += step) {
      const hit = snapToPolylines(coords[i], polylines, index, 200)
      if (hit) samples.push(hit.distM)
    }
  }
  samples.sort((a, b) => a - b)
  console.log(`${label}（${lines.length} 段、抽樣 ${samples.length} 點）：`
    + `中位 ${quantile(samples, 0.5).toFixed(1)}m／p90 ${quantile(samples, 0.9).toFixed(1)}m`
    + `／最大 ${samples[samples.length - 1]?.toFixed(1)}m`)
}
console.log('  ↑ 這就是「示意中心線」的實際精度。車道寬 3.2m——偏差已經是好幾個車道，')
console.log('    所以 TDX 線型只能當疊加圖層，不可用來推導車道或當底圖（計畫書 §1.3）。')

// ── 3b. 軌道線型連通性 ──
// 踩過的坑：原本用「離道路多遠」裁切線型，捷運紅線穿過半屏山那段（世運↔左營）
// 整整 1.1 km 被丟掉——山裡沒有路。畫面上就是一條斷掉的紅線。
// 這裡用拓撲檢查：每一段線的端點，是不是接得到另一段線；接不到、又不在地圖邊界上，
// 就是畫面上看得到的斷點。
console.log('\n── 軌道線型連通性 ──')
{
  const roadBox = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity }
  for (const cs of polylines) for (const [lng, lat] of cs) {
    roadBox.minLng = Math.min(roadBox.minLng, lng); roadBox.maxLng = Math.max(roadBox.maxLng, lng)
    roadBox.minLat = Math.min(roadBox.minLat, lat); roadBox.maxLat = Math.max(roadBox.maxLat, lat)
  }
  // 線走到地圖邊界被切斷是正常的，不算斷點
  const nearEdge = (p: [number, number]) => {
    const mLng = 111320 * Math.cos((p[1] * Math.PI) / 180)
    return Math.min(
      (p[0] - roadBox.minLng) * mLng, (roadBox.maxLng - p[0]) * mLng,
      (p[1] - roadBox.minLat) * 110540, (roadBox.maxLat - p[1]) * 110540,
    ) < 500
  }
  for (const system of ['KRTC', 'KLRT'] as const) {
    const lines = dataset.railLines.filter((l) => l.system === system)
    if (!lines.length) continue
    const dangling: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const others = lines.filter((_, j) => j !== i).map((l) => l.coords)
      if (!others.length) continue
      const otherIndex = buildPolylineIndex(others)
      for (const ep of [lines[i].coords[0], lines[i].coords[lines[i].coords.length - 1]]) {
        const hit = snapToPolylines(ep, others, otherIndex, 300)
        if ((!hit || hit.distM > 50) && !nearEdge(ep)) {
          dangling.push(`${lines[i].id} @ ${ep.map((v) => v.toFixed(4)).join(',')}`)
        }
      }
    }
    const ok = dangling.length === 0
    if (!ok) failures++
    console.log(`${ok ? '✅' : '❌'} ${RAIL_SYSTEM_LABEL[system]}（${lines.length} 段）：`
      + `${ok ? '線是連通的' : `${dangling.length} 個懸空線端 → 畫面上會看到斷線`}`)
    for (const d of dangling.slice(0, 5)) console.log(`     ${d}`)
  }
}

// ── 4. 資料完整性與規模 ──
console.log('\n── 完整性與規模 ──')
const stopIds = new Set(dataset.busStops.map((s) => s.id))
const danglingRouteStops = dataset.busRoutes
  .flatMap((r) => r.stopIds).filter((id) => !stopIds.has(id))
const routeIds = new Set(dataset.busRoutes.map((r) => r.id))
const danglingStopRoutes = dataset.busStops
  .flatMap((s) => s.routeIds).filter((id) => !routeIds.has(id))
const orphanStops = dataset.busStops.filter((s) => s.routeIds.length === 0)
console.log(`路線→站牌 斷鏈 ${danglingRouteStops.length}　站牌→路線 斷鏈 ${danglingStopRoutes.length}`
  + `　無路線停靠的站牌 ${orphanStops.length}`)
if (danglingRouteStops.length || danglingStopRoutes.length) {
  console.log('  ❌ 站牌與路線互指不一致，資料檔要重建')
  failures++
}
console.log(`transit.json             ${kb(join(HERE, '../public/data/transit.json'))}`)
console.log(`transit_bus_shapes.json  ${kb(join(HERE, '../public/data/transit_bus_shapes.json'))}`)

console.log(`\n${failures ? `❌ ${failures} 項未通過` : '✅ 全部通過'}`)
process.exit(failures ? 1 : 0)
