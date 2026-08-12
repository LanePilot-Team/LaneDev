// 楠梓區「尚未人工標記」路段稽核
//   node scripts/run_offline.mjs scripts/nanzih_unmarked_audit.ts [--min=3] [--json]
//
// 走與 app 相同的管線（切塊 → 折疊 journal → couplet 合併），因此：
//   - 被 couplet 吸收的對向 way 不會因為「journal 鍵記在存活那條上」而被誤判成未標記
//   - 車道數是畫面上真正採用的值（journal > fixups > OSM lanes > 道路等級預設）
//
// 判準：
//   區域   = way 出現在 public/data/lanepilot/area_4212599.segments.jsonl（楠梓區 shard）
//   已標記 = 折疊後的 journal 有 way 級 `way/W` 或區塊級 `way/W@b/N` 鍵
//            （turn_bay / moto_box / right_lane 等附掛物件另計，只當補充資訊）
//   車道   = lanesForward + lanesBackward（機車道 motoCountF/B 不計入）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const SHARD = arg('shard', join(HERE, '../public/data/lanepilot/area_4212599.segments.jsonl'))
const MIN_LANES = Number(arg('min', '3')) // 正+反 > 2
const AS_JSON = process.argv.includes('--json')

// ── 楠梓區 way 集合
const nanzihWays = new Set<number>()
for (const line of readFileSync(SHARD, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const id = JSON.parse(line).object_identity?.source_osm?.osm_id
  if (typeof id === 'number') nanzihWays.add(id)
}

// ── 管線
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor?.journal ?? []
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const folded = foldJournal(journal)
applyToRoads(roads, folded)
const view = buildRoadMergeViews(roads.filter((r) => !r.properties.deleted), journal)

// ── journal 覆蓋
const markedRoadKeys = new Set([...folded.keys()])
/** 附掛物件（停等格/左轉道/右轉道）也代表這條路被人工處理過 */
const attachedWays = new Map<number, Set<string>>()
for (const rec of journal) {
  if (rec.target.type === 'road' || rec.target.type === 'road_merge') continue
  const m = /^way\/(-?\d+)/.exec(rec.target.key)
  if (!m) continue
  const id = Number(m[1])
  if (!attachedWays.has(id)) attachedWays.set(id, new Set())
  attachedWays.get(id)!.add(rec.target.type)
}

const roadMarked = (r: RoadFeature) => {
  const p = r.properties
  const ids = new Set<number>([p.osm_id, ...p.sourceSegments.map((s) => s.osmId)])
  for (const id of ids) {
    if (markedRoadKeys.has(`way/${id}`)) return true
    if (markedRoadKeys.has(`way/${id}@b/${p.blockNode}`)) return true
  }
  // 合併後 blockNode 換人：本段內部（不含末端 node）曾當過區塊鍵錨點就算標記過。
  // 末端 node 必須排除——它同時是同 way 下一個區塊的 blockNode，算進來會讓
  // 「隔壁區塊標過」冒充成本區塊標過。
  const nodes = new Set(p.nodes.slice(0, -1))
  for (const key of markedRoadKeys) {
    const m = /^way\/(-?\d+)@b\/(-?\d+)$/.exec(key)
    if (m && ids.has(Number(m[1])) && nodes.has(Number(m[2]))) return true
  }
  return false
}

const lengthM = (r: RoadFeature) => {
  const c = r.geometry.coordinates as [number, number][]
  let d = 0
  for (let i = 1; i < c.length; i++) d += haversine(c[i - 1], c[i])
  return d
}

// ── 篩選
type Row = {
  wayIds: number[]; name: string; highway: string; oneway: string
  f: number; b: number; total: number; motoF: number; motoB: number
  len: number; blockNode: number; merged: boolean
  attached: string[]; at: string
}
const midpoint = (r: RoadFeature) => {
  const c = r.geometry.coordinates as [number, number][]
  const [lng, lat] = c[Math.floor(c.length / 2)]
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}
const rows: Row[] = []
const stats = { render: 0, nanzih: 0, wide: 0, marked: 0, unmarked: 0 }

for (const r of view.renderRoads) {
  const p = r.properties
  stats.render++
  const ids = [...new Set([p.osm_id, ...p.sourceSegments.map((s) => s.osmId)])]
  if (!ids.some((id) => nanzihWays.has(id))) continue
  stats.nanzih++
  const total = p.lanesForward + p.lanesBackward
  if (total < MIN_LANES) continue
  stats.wide++
  if (roadMarked(r)) { stats.marked++; continue }
  stats.unmarked++
  const attached = new Set<string>()
  for (const id of ids) for (const t of attachedWays.get(id) ?? []) attached.add(t)
  rows.push({
    wayIds: ids.filter((id) => id > 0),
    name: p.name ?? '(無名)',
    highway: p.highway,
    oneway: p.oneway,
    f: p.lanesForward, b: p.lanesBackward, total,
    motoF: p.motoCountF, motoB: p.motoCountB,
    len: Math.round(lengthM(r)),
    blockNode: p.blockNode,
    merged: !!p.coupletMerged,
    attached: [...attached],
    at: midpoint(r),
  })
}

rows.sort((a, b) => b.len - a.len)

if (AS_JSON) {
  console.log(JSON.stringify({ stats, rows }, null, 1))
} else {
  console.log(`渲染路段 ${stats.render}｜楠梓區 ${stats.nanzih}｜`
    + `車道正+反 ≥ ${MIN_LANES}：${stats.wide}（已標記 ${stats.marked}、未標記 ${stats.unmarked}）\n`)
  const byName = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, [])
    byName.get(r.name)!.push(r)
  }
  const groups = [...byName.entries()]
    .sort((a, b) => b[1].reduce((s, r) => s + r.len, 0) - a[1].reduce((s, r) => s + r.len, 0))
  for (const [name, list] of groups) {
    const total = Math.round(list.reduce((s, r) => s + r.len, 0))
    console.log(`■ ${name}（${list.length} 段，共 ${total} m）`)
    for (const r of list) {
      const moto = r.motoF || r.motoB ? `　機車道 ${r.motoF}/${r.motoB}` : ''
      const extra = [
        r.merged ? 'couplet 合併' : '',
        r.attached.length ? `已有 ${r.attached.join('+')}` : '',
      ].filter(Boolean).join('，')
      console.log(`   way/${r.wayIds.join('+')}　${r.highway}`
        + `　${r.oneway === 'yes' ? '單行' : '雙向'} ${r.f}+${r.b}=${r.total}${moto}`
        + `　${r.len} m　@b/${r.blockNode}　${r.at}${extra ? `　[${extra}]` : ''}`)
    }
  }
}
