// 從舊快照把「曾經有、現在完全不見」的 journal 紀錄補回唯一靜態資料庫。
//
// 2026-07-27 的整包覆蓋（editor 用單一時間戳比大小、輸的一方整包被丟棄）一次讓
// 166 個鍵消失。那個成因已經在 core/editorMerge.ts 修掉了，這支腳本負責把已經
// 掉出去的資料撿回來。
//
// 只補「目標鍵在目前 journal 裡完全不存在」的紀錄——目前版本已經有的鍵一律不碰，
// 避免用舊值蓋掉你後來的修改。補回來的紀錄保留原始 ts，依時間排回歷程裡，所以
// 就算之後同一個鍵又被編輯過，較新的那筆仍然勝出。
//
//   node scripts/restore_journal.mjs [--out=<檔案>] [--db=<檔案>] [--from=<額外來源>]
//
// 不給 --out 時只做 dry-run。
// ⚠ 本腳本自報的「可補回 N 個鍵」曾經比實際寫入多，套用後務必用 coverage_audit 驗收。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = resolve(arg('db', resolve(ROOT, 'public/data/road_database.json')))
const OUT = arg('out', '')

const snapshotPaths = []
const dataDir = resolve(ROOT, 'public/data')
for (const f of readdirSync(dataDir)) {
  const p = resolve(dataDir, f)
  if (f.startsWith('road_database') && p !== DB_PATH) snapshotPaths.push(p)
}
const backupDir = resolve(ROOT, '.lanedev-backups')
try {
  for (const f of readdirSync(backupDir)) snapshotPaths.push(resolve(backupDir, f))
} catch { /* 還沒有捏合備份 */ }
// 手動匯出的 Enhancement 檔（exportEnhancements 產物）也是有效來源，journal 在最外層。
for (const dir of [resolve(ROOT, 'backups'), resolve(ROOT, '../backups')]) {
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) snapshotPaths.push(resolve(dir, f))
    }
  } catch { /* 沒有這個目錄 */ }
}
for (const extra of process.argv.filter((a) => a.startsWith('--from='))) {
  snapshotPaths.push(resolve(extra.slice('--from='.length)))
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const current = Array.isArray(db.editor?.journal) ? db.editor.journal : []
const currentKeys = new Set(current.map((r) => `${r.target?.type}|${r.target?.key}`))

const fingerprint = (r) => JSON.stringify([
  r.ts, r.author, r.op, r.target?.type, r.target?.key, r.fields ?? null,
])
const seen = new Set(current.map(fingerprint))

const snapshots = snapshotPaths.map((p) => {
  try {
    const snap = JSON.parse(readFileSync(p, 'utf8'))
    const journal = snap.editor?.journal ?? snap.journal ?? []
    return { p, at: snap.editor?.updated_at ?? snap.exported_at ?? snap.updated_at ?? '', j: journal }
  } catch { return null }
}).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))

const recovered = []
const sources = new Map()
for (const snap of snapshots) {
  for (const record of snap.j) {
    const key = `${record.target?.type}|${record.target?.key}`
    if (currentKeys.has(key)) continue // 目前版本已有這個鍵，不用舊值去碰它
    const fp = fingerprint(record)
    if (seen.has(fp)) continue
    seen.add(fp)
    recovered.push(record)
    sources.set(key, snap.p.split(/[\\/]/).pop())
  }
}

const byType = {}
const keys = new Set()
for (const r of recovered) {
  byType[r.target?.type ?? '?'] = (byType[r.target?.type ?? '?'] ?? 0) + 1
  keys.add(`${r.target?.type}|${r.target?.key}`)
}
console.log(`掃描 ${snapshots.length} 份快照`)
console.log(`目前 journal：${current.length} 筆 / ${currentKeys.size} 個鍵`)
console.log(`可補回：${recovered.length} 筆，涵蓋 ${keys.size} 個目前完全不存在的鍵`)
console.log(`  依型別：${JSON.stringify(byType)}`)
for (const [k, src] of [...sources].slice(0, 12)) console.log(`   ${k}  ← ${src}`)
if (sources.size > 12) console.log(`   …還有 ${sources.size - 12} 個鍵`)

if (!OUT) {
  console.log('\n（dry-run：未寫檔。加 --out=<路徑> 才會寫入）')
  process.exit(0)
}

db.editor.journal = [...current, ...recovered]
  .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))
  .map((record, index) => ({ ...record, seq: index + 1 }))
db.editor.updated_at = new Date().toISOString()
db.updated_at = db.editor.updated_at
writeFileSync(resolve(OUT), `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已寫入 ${resolve(OUT)}：journal ${current.length} → ${db.editor.journal.length} 筆`)
