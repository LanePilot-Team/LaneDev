// 疊合路段稽核（node scripts/run_offline.mjs scripts/stack_audit.ts）
//
// overlap_audit 找的是「同一條 way 自己的破碎短段」；這支找的是**不同 way 幾乎完全
// 重合**的情形——高楠公路的主線（hw=primary）與側車道（hw=service）中心線一模一樣，
// 畫出來完全疊在一起。編輯器只取 queryRenderedFeatures 的 hit[0]，所以被壓在下面的
// 那條不論點哪裡都選不到；src/edit/stackPick.ts 的輪選就是為這批路段做的。
//
//   --all             全圖掃描（預設）
//   --name=高楠公路    只看名稱含此字串的路段
//   --at=lat,lng      列出某座標附近的所有路段（--radius= 公尺，預設 25）
//   --med=<公尺>      判定重合的取樣點中位距上限（預設 8）
//   --minlen=<公尺>   只列出兩段都夠長的組（預設 0 = 全列；破碎短段請改用 overlap_audit）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges } from '../src/core/enhancements'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const NAME = arg('name', '')
const AT = arg('at', '')
const RADIUS = Number(arg('radius', '25'))
const MED_MAX = Number(arg('med', '8'))
const MIN_LEN = Number(arg('minlen', '0'))

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor.journal))
applyRoadMerges(roads, db.editor.journal)

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const cds = (r: RoadFeature) => r.geometry.coordinates as [number, number][]
const lengthOf = (r: RoadFeature) => {
  const cs = cds(r)
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}
const describe = (r: RoadFeature) => {
  const p = r.properties
  return `${key(r)}｜${p.name ?? '未命名'}｜${lengthOf(r).toFixed(0)}m`
    + `｜車道 ${p.lanesForward}+${p.lanesBackward}｜${p.highway}`
    + `${p.elevated ? '｜[高架]' : ''}${p.deleted ? '｜[已刪除]' : ''}`
}

/** a 的取樣點到 b 的最近距離：中位數（整體貼合程度）與 12m 內比例（重合長度） */
function overlapStats(a: RoadFeature, b: RoadFeature) {
  const bc = cds(b)
  const ds = cds(a).map((p) => {
    let best = Infinity
    for (const q of bc) best = Math.min(best, haversine(p, q))
    return best
  })
  ds.sort((x, y) => x - y)
  return { med: ds[Math.floor(ds.length / 2)], within12: ds.filter((d) => d < 12).length / ds.length }
}

const live = roads.filter((r) => !r.properties.deleted)

if (AT) {
  const [lat, lng] = AT.split(',').map(Number)
  const rows = live
    .map((r) => ({ r, d: Math.min(...cds(r).map((c) => haversine(c, [lng, lat]))) }))
    .filter((x) => x.d <= RADIUS)
    .sort((a, b) => a.d - b.d)
  console.log(`${lat},${lng} ${RADIUS}m 內共 ${rows.length} 段：`)
  for (const { r, d } of rows) console.log(`  ${d.toFixed(1).padStart(6)}m  ${describe(r)}`)
  process.exit(0)
}

// 空間格網（約 30m）只比對鄰近的路段，全圖 11k 區塊才跑得動
const CELL = 3e-4
const grid = new Map<string, RoadFeature[]>()
const cellsOf = (r: RoadFeature) => {
  const out = new Set<string>()
  for (const [lng, lat] of cds(r)) out.add(`${Math.round(lng / CELL)},${Math.round(lat / CELL)}`)
  return out
}
for (const r of live) {
  for (const c of cellsOf(r)) {
    const list = grid.get(c) ?? []
    list.push(r)
    grid.set(c, list)
  }
}

const pool = NAME ? live.filter((r) => (r.properties.name ?? '').includes(NAME)) : live
console.log(`比對池：${pool.length} 段${NAME ? `（名稱含「${NAME}」）` : '（全圖）'}`)
console.log(`判準：取樣點中位距 ≤ ${MED_MAX}m 且 80% 以上落在對方 12m 內\n`)

const seen = new Set<string>()
const groups: string[] = []
let sameWayCount = 0
let crossWayCount = 0
let skippedShort = 0
for (const a of pool) {
  const near = new Set<RoadFeature>()
  for (const c of cellsOf(a)) for (const b of grid.get(c) ?? []) near.add(b)
  for (const b of near) {
    if (a === b) continue
    const pk = [key(a), key(b)].sort().join(' :: ')
    if (seen.has(pk)) continue
    seen.add(pk)
    const ab = overlapStats(a, b)
    const ba = overlapStats(b, a)
    // 雙向都算：短段整段疊在長段上時，長段的中位距會很大
    const best = ab.med <= ba.med ? ab : ba
    if (best.within12 < 0.8 || best.med > MED_MAX) continue
    const sameWay = a.properties.osm_id === b.properties.osm_id
    if (sameWay) sameWayCount++
    else crossWayCount++
    if (Math.min(lengthOf(a), lengthOf(b)) < MIN_LEN) { skippedShort++; continue }
    groups.push(`重合 ${(best.within12 * 100).toFixed(0)}%｜中位距 ${best.med.toFixed(1)}m`
      + `${sameWay ? '｜同 way（overlap_audit 的破碎短段）' : ''}\n`
      + `   A ${describe(a)}\n   B ${describe(b)}`)
  }
}
for (const g of groups) console.log(g)
console.log(`\n重合組數：${sameWayCount + crossWayCount}`
  + `（同 way ${sameWayCount}／不同 way ${crossWayCount}）`)
if (MIN_LEN > 0) console.log(`其中兩段都 ≥ ${MIN_LEN}m 的：${groups.length}（略過 ${skippedShort} 組短段）`)
