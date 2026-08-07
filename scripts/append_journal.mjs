// 把一批 journal 紀錄追加到唯一靜態資料庫（public/data/road_database.json）。
//
// journal 是「只增不減」的歷程（見 core/editorMerge.ts）：要改回舊值就追加一筆新的
// set，不要去修改或刪除既有紀錄。這支負責配好 seq／ts／author 並先備份再落盤。
//
//   node scripts/append_journal.mjs --records=<檔案.json> [--author=…] [--apply]
//
// --records 檔案是一個陣列，每筆 { op, target: { type, key }, fields }。
// 不給 --apply 時只做 dry-run。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = resolve(arg('db', resolve(ROOT, 'public/data/road_database.json')))
const RECORDS_PATH = arg('records', '')
const AUTHOR = arg('author', 'anna')
const TAG = arg('tag', 'append-journal')
const APPLY = process.argv.includes('--apply')
if (!RECORDS_PATH) { console.error('請給 --records=<檔案.json>'); process.exit(2) }

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal = Array.isArray(db.editor?.journal) ? db.editor.journal : []
const drafts = JSON.parse(readFileSync(resolve(RECORDS_PATH), 'utf8'))
if (!Array.isArray(drafts) || !drafts.length) { console.error('紀錄檔要是非空陣列'); process.exit(2) }

const ts = new Date().toISOString()
let seq = journal.reduce((max, r) => Math.max(max, r.seq ?? 0), 0)
const added = drafts.map((draft) => {
  if (!draft.target?.type || !draft.target?.key) throw new Error(`紀錄缺 target：${JSON.stringify(draft)}`)
  return { op: draft.op ?? 'set', target: draft.target, fields: draft.fields ?? {}, seq: ++seq, ts, author: AUTHOR }
})

for (const r of added) {
  const before = [...journal].reverse().find((p) =>
    p.target?.type === r.target.type && p.target?.key === r.target.key)
  console.log(`+ seq ${r.seq} ${r.op} ${r.target.type} ${r.target.key}`)
  for (const [k, v] of Object.entries(r.fields)) {
    const old = before?.fields?.[k]
    if (JSON.stringify(old) !== JSON.stringify(v)) {
      console.log(`    ${k}: ${JSON.stringify(old)} → ${JSON.stringify(v)}`)
    }
  }
}

if (!APPLY) { console.log(`\n(dry-run，共 ${added.length} 筆；加 --apply 才寫入)`); process.exit(0) }

const backupDir = resolve(ROOT, '.lanedev-backups')
mkdirSync(backupDir, { recursive: true })
const backup = resolve(backupDir, `road_database.before-${TAG}-${Date.now()}.json`)
writeFileSync(backup, readFileSync(DB_PATH))
db.editor.journal = [...journal, ...added]
db.editor.updated_at = ts
db.updated_at = ts
// 落盤格式跟 vite 的 /api/static-road-database 一致（無縮排＋結尾換行），
// 否則每次腳本寫入都會讓整份 8MB 檔案的格式跟 app 寫的版本互相打架。
writeFileSync(DB_PATH, `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已寫入 ${added.length} 筆（備份 ${backup}）`)
