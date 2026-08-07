// 從鄰區 LanePilot shard 挑指定的 way 併進唯一靜態資料庫。
//
// build_static_road_database.mjs 的 allRegions 只收楠梓＋左營兩區，但楠梓區邊界上的
// 路常有一半落在鄰區 shard 裡。最典型的是楠梓路北段：往北的 way 在楠梓 shard、
// 往南那半（623054558 / 205318263 / 799115399）只在橋頭 shard，於是資料庫裡北段
// 看起來是單向路，couplet 也配不成對。整區重建會把 1300 條無關的路一起拉進來
// （還會重寫 segments，見 lanedev-storage-split），所以這支只搬指定的幾條。
//
//   node scripts/import_shard_ways.mjs --shard=area_4212683 --ways=623054558,… [--apply]
//
// 不給 --apply 時只做 dry-run。node_refs 必須與座標數相符（shard 缺 node_refs 的
// 分段要走 segment_dedupe 的補齊流程，這支一律拒絕）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = resolve(arg('db', resolve(ROOT, 'public/data/road_database.json')))
const SHARD = arg('shard', '')
const WAYS = arg('ways', '').split(',').map((w) => Number(w.trim())).filter(Number.isFinite)
const APPLY = process.argv.includes('--apply')
if (!SHARD || !WAYS.length) {
  console.error('請給 --shard=area_XXXXXXX 與 --ways=id1,id2,…')
  process.exit(2)
}

const shardPath = resolve(ROOT, `public/data/lanepilot/${SHARD}.segments.jsonl`)
const shard = readFileSync(shardPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim()).map((line) => JSON.parse(line))
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))

const identity = (s) =>
  `${s.object_identity?.nav_segment_key ?? s.osm_id}#${s.object_identity?.split_index ?? 0}`
const existing = new Set(db.segments.map(identity))
const existingNodes = new Map()
for (const s of db.segments) {
  for (const node of s.node_refs ?? []) {
    if (!existingNodes.has(node)) existingNodes.set(node, [])
    existingNodes.get(node).push(s.lane_nav_tags?.road_name ?? '未命名')
  }
}

const picked = []
for (const wayId of WAYS) {
  const matches = shard.filter((s) => s.object_identity?.source_osm?.osm_id === wayId)
  if (!matches.length) {
    console.error(`✖ shard ${SHARD} 內找不到 way/${wayId}`)
    process.exitCode = 1
    continue
  }
  for (const s of matches) {
    const coordinates = s.geometry?.coordinates ?? []
    if (!Array.isArray(s.node_refs) || s.node_refs.length !== coordinates.length) {
      console.error(`✖ way/${wayId} 的 node_refs 與座標數不符`
        + `（${s.node_refs?.length ?? 0} vs ${coordinates.length}）——需先跑 node_refs 補齊`)
      process.exitCode = 1
      continue
    }
    if (existing.has(identity(s))) {
      console.log(`− way/${wayId} 已在資料庫裡，略過`)
      continue
    }
    picked.push(s)
    const first = coordinates[0], last = coordinates[coordinates.length - 1]
    const shared = s.node_refs.filter((n) => existingNodes.has(n))
    console.log(`+ way/${wayId}｜${s.lane_nav_tags?.road_name ?? '未命名'}`
      + `｜${s.osm_selected_tags?.highway ?? '?'}`
      + `${s.osm_selected_tags?.oneway === 'yes' ? '｜單向' : ''}`
      + `｜${coordinates.length} 點`
      + `｜lat ${first[1].toFixed(6)} → ${last[1].toFixed(6)}`)
    console.log(`    與現有資料共用節點 ${shared.length}/${s.node_refs.length}：`
      + (shared.length
        ? shared.map((n) => `${n}（${[...new Set(existingNodes.get(n))].join('/')}）`).join('、')
        : '無 —— 這條路會與現有路網不連通，請確認'))
  }
}

if (!picked.length) { console.log('\n沒有要新增的分段'); process.exit(process.exitCode ?? 0) }
if (process.exitCode) { console.error('\n有分段未通過檢查，未寫入'); process.exit(1) }
if (!APPLY) { console.log(`\n(dry-run，共 ${picked.length} 段；加 --apply 才寫入)`); process.exit(0) }

const backupDir = resolve(ROOT, '.lanedev-backups')
mkdirSync(backupDir, { recursive: true })
const backup = resolve(backupDir, `road_database.before-import-${SHARD}-${Date.now()}.json`)
writeFileSync(backup, readFileSync(DB_PATH))
db.segments.push(...picked)
db.updated_at = new Date().toISOString()
// 落盤格式跟 vite 的 /api/static-road-database 一致（無縮排＋結尾換行）
writeFileSync(DB_PATH, `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已新增 ${picked.length} 段（segments ${db.segments.length - picked.length}`
  + ` → ${db.segments.length}，備份 ${backup}）`)
