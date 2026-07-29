// 孤立型失效稽核（node scripts/run_offline.mjs scripts/orphan_audit.ts）
//
// 「孤立型」＝紀錄還在 journal 裡，但它的鍵指不到任何現存區塊，所以覆寫靜默失效。
// 區塊鍵是 `way/W@b/N`，N = 該區塊第一個節點。只要區塊邊界移動（底圖重建、路口
// 增刪、couplet 重新配對），N 就換人做，舊鍵當場變孤兒——資料沒丟，但不生效。
//
// 這支腳本列出所有孤兒，並判斷能不能自動指回去：
//   可修復 = 舊 blockNode 仍然存在於同一條 way 的某個現存區塊之中
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const live = new Map(roads.map((r) => [blockKey(r), r]))
const folded = foldJournal(journal)

const orphans = [...folded].filter(([k]) => /^way\/-?\d+@b\/-?\d+$/.test(k) && !live.has(k))
console.log(`journal ${journal.length} 筆／折疊 ${folded.size} 個鍵`)
console.log(`區塊鍵孤兒：${orphans.length}\n`)

let healable = 0
let lost = 0
for (const [key, fields] of orphans) {
  const m = key.match(/^way\/(-?\d+)@b\/(-?\d+)$/)!
  const wayId = Number(m[1])
  const oldBlockNode = Number(m[2])
  // 這條 way 現在哪個區塊「含有」當年那個 blockNode？
  const host = roads.find((r) => r.properties.osm_id === wayId
    && r.properties.nodes.includes(oldBlockNode))
  const tag = Object.keys(fields).length
  if (host) {
    healable++
    console.log(`  ✔ 可修復 ${key}（${host.properties.name ?? '未命名'}，${tag} 個欄位）`)
    console.log(`      → ${blockKey(host)}`)
  } else {
    lost++
    const anyWay = roads.some((r) => r.properties.osm_id === wayId)
    console.log(`  ✖ 無法自動修復 ${key}（${tag} 個欄位）`
      + `：${anyWay ? '該 way 還在，但舊 blockNode 已不在任何區塊裡' : '整條 way 已不存在'}`)
  }
  if (Number(fields.deleted) > 0) console.log('      ⚠ 這是 deleted:1——失效代表被刪的路段會復活')
}

console.log(`\n可自動指回去：${healable}／無法自動修復：${lost}`)
