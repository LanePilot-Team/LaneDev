// 疊壞路段稽核（node scripts/run_offline.mjs scripts/overlap_audit.ts --key=way/W@b/N）
//
// 症狀：同一條 way 的某個端點附近，OSM 原始資料留下一小撮幾公尺長的破碎區塊，
// 與主區塊幾乎完全重疊。它們各自帶著自己的中央帶／車道設定，畫出來就是交叉的
// 白線與雙重黃線。實地上根本沒有這些路段。
//
//   --key=way/W@b/N   受檢區塊（會檢查它的兩端）
//   --radius=<公尺>   端點附近的搜尋半徑（預設 25）
//   --maxlen=<公尺>   判定為「破碎短段」的長度上限（預設 25）
//   --all             改為掃描全圖，列出所有符合此樣態的短段
import { readFileSync, writeFileSync } from 'node:fs'
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
const KEY = arg('key', '')
const RADIUS = Number(arg('radius', '25'))
const MAXLEN = Number(arg('maxlen', '25'))
const ALL = process.argv.includes('--all')
/** --delete=key1,key2  寫入 deleted:1 紀錄；需搭配 --out=<檔案>（不給就只預演） */
const DELETE = arg('delete', '').split(',').map((k) => k.trim()).filter(Boolean)
const OUT = arg('out', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor.journal))
applyRoadMerges(roads, db.editor.journal)

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const lengthOf = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}
const describe = (r: RoadFeature, d?: number) => {
  const p = r.properties
  return `${d !== undefined ? `${d.toFixed(1).padStart(5)}m  ` : ''}${key(r)}`
    + `｜${p.name ?? '未命名'}｜長度 ${lengthOf(r).toFixed(0)}m`
    + `｜車道 ${p.lanesForward}+${p.lanesBackward}`
    + `｜center_m=${p.centerM ?? 0}`
    + `${p.deleted ? '｜[已刪除]' : ''}`
}

/** 一段是否「幾乎整段疊在另一段上」：取樣點到對方線的距離都很小 */
const overlapRatio = (small: RoadFeature, big: RoadFeature) => {
  const sc = small.geometry.coordinates as [number, number][]
  const bc = big.geometry.coordinates as [number, number][]
  let inside = 0
  for (const p of sc) {
    let best = Infinity
    for (const q of bc) best = Math.min(best, haversine(p, q))
    if (best < 12) inside++
  }
  return inside / sc.length
}

if (ALL) {
  console.log(`全圖掃描：長度 ≤ ${MAXLEN}m 且幾乎整段疊在同 way 較長區塊上的短段\n`)
  const byWay = new Map<number, RoadFeature[]>()
  for (const r of roads) {
    const list = byWay.get(r.properties.osm_id) ?? []
    list.push(r)
    byWay.set(r.properties.osm_id, list)
  }
  let live = 0
  let done = 0
  for (const [, list] of byWay) {
    for (const small of list) {
      if (lengthOf(small) > MAXLEN) continue
      for (const big of list) {
        if (big === small || lengthOf(big) <= lengthOf(small) * 1.5) continue
        if (overlapRatio(small, big) < 0.9) continue
        if (small.properties.deleted) done++
        else { live++; console.log(`  ${describe(small)}\n      疊在 ${key(big)}（${lengthOf(big).toFixed(0)}m）上`) }
        break
      }
    }
  }
  console.log(`\n仍在顯示的疊壞短段：${live}｜已刪除：${done}`)
  process.exit(0)
}

if (DELETE.length) {
  const journal = db.editor.journal
  const live = new Set(roads.filter((r) => !r.properties.deleted).map(key))
  const added: string[] = []
  for (const k of DELETE) {
    if (!live.has(k)) { console.log(`跳過 ${k}：不存在或已刪除`); continue }
    journal.push({
      seq: journal.length + 1,
      ts: new Date().toISOString(),
      author: 'anna',
      op: 'set',
      target: { type: 'road', key: k },
      fields: { deleted: 1 },
    })
    added.push(k)
  }
  console.log(`將刪除 ${added.length} 個區塊：`)
  for (const k of added) console.log(`   ${k}`)
  if (!OUT) { console.log('（預演，未寫檔。加 --out=<路徑> 才會寫入）'); process.exit(0) }
  db.editor.journal = journal.map((r: { seq: number }, i: number) => ({ ...r, seq: i + 1 }))
  db.editor.updated_at = new Date().toISOString()
  db.updated_at = db.editor.updated_at
  writeFileSync(OUT, `${JSON.stringify(db)}
`, 'utf8')
  console.log(`已寫入 ${OUT}`)
  process.exit(0)
}

if (!KEY) { console.error('請給 --key=way/W@b/N、--all 或 --delete=...'); process.exit(2) }
const target = roads.find((r) => key(r) === KEY)
if (!target) { console.error(`找不到區塊 ${KEY}`); process.exit(1) }
const cs = target.geometry.coordinates as [number, number][]
console.log(`受檢 ${describe(target)}`)
for (const [label, at] of [
  ['北端', cs[0][1] > cs[cs.length - 1][1] ? cs[0] : cs[cs.length - 1]],
  ['南端', cs[0][1] > cs[cs.length - 1][1] ? cs[cs.length - 1] : cs[0]],
] as [string, [number, number]][]) {
  console.log(`\n── ${label} ${at[1].toFixed(6)},${at[0].toFixed(6)} 的 ${RADIUS}m 內 ──`)
  const rows: { d: number; r: RoadFeature }[] = []
  for (const r of roads) {
    if (r === target) continue
    const rc = r.geometry.coordinates as [number, number][]
    let best = Infinity
    for (const c of rc) best = Math.min(best, haversine(c, at))
    if (best <= RADIUS) rows.push({ d: best, r })
  }
  rows.sort((a, b) => a.d - b.d)
  for (const { d, r } of rows) console.log(`   ${describe(r, d)}`)
  const suspects = rows.filter(({ r }) => !r.properties.deleted
    && r.properties.osm_id === target.properties.osm_id
    && lengthOf(r) <= MAXLEN)
  console.log(`   → 同 way、長度 ≤ ${MAXLEN}m、仍在顯示的疊壞候選：${suspects.length}`)
  for (const { r } of suspects) console.log(`      ${key(r)}`)
}
