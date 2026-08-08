// 一次性遷移：清掉「單一機車道」殘留的機車道箭頭真值。
//
// 2026-08-06 之前 buildLaneArrows 的機車道箭頭有 `motoCount >= 2` 這道閘門，
// 單一機車道**永遠不畫**。但面板的 resizeTurnLanes 會把 moto_turn_lanes 補成
// 'through'，所以每次開面板存檔都留下一個沒有任何視覺效果的值——全圖累積了
// 210 個行向。開放單一機車道畫箭頭之後，這些殘值會一次冒出 210 支沒人要求的
// 箭頭，所以先歸零：它們從來沒畫出來過，不帶任何使用者意圖。
//
// 之後面板改用 resizeMotoTurnLanes（單一機車道補 ''），並在箭頭下拉選單提供
// 「無」，使用者要箭頭就自己選，選了就會畫。
//
//   node scripts/migrate_single_moto_arrows.mjs [--apply]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = resolve(arg('db', resolve(ROOT, 'public/data/road_database.json')))
const APPLY = process.argv.includes('--apply')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal = db.editor.journal

// 折疊出每個鍵目前生效的欄位（way 級與區塊級各自折疊，區塊級勝出）
const folded = new Map()
for (const record of journal) {
  if (record.target?.type !== 'road') continue
  if (record.op === 'delete') { folded.delete(record.target.key); continue }
  folded.set(record.target.key, { ...folded.get(record.target.key), ...record.fields })
}
const wayFields = new Map()
for (const [key, fields] of folded) {
  if (!key.includes('@b/')) wayFields.set(key, fields)
}

const drafts = []
for (const [key, blockFields] of folded) {
  const wayKey = `way/${key.match(/^way\/(-?\d+)/)?.[1] ?? ''}`
  const fields = { ...wayFields.get(wayKey), ...blockFields }
  const oneway = String(fields.oneway ?? '')
  const patch = {}
  for (const [dir, countKey, tlKey] of [
    ['f', 'moto_forward', 'moto_turn_lanes_forward'],
    ['b', 'moto_backward', 'moto_turn_lanes_backward'],
  ]) {
    if (dir === 'b' && oneway === 'yes') continue
    const count = Number(fields[countKey] ?? 0)
    const stored = fields[tlKey]
    if (count !== 1 || stored === undefined) continue
    // 單一機車道只會有一格；非空就是那個沒有效果的殘值
    if (!String(stored).split('|')[0]?.trim()) continue
    patch[tlKey] = ''
  }
  if (Object.keys(patch).length) drafts.push({ key, patch })
}

console.log(`要歸零的鍵：${drafts.length}`)
for (const { key, patch } of drafts.slice(0, 12)) {
  console.log(`  ${key} ← ${JSON.stringify(patch)}`)
}
if (drafts.length > 12) console.log(`  …其餘 ${drafts.length - 12} 筆`)
if (!drafts.length) process.exit(0)
if (!APPLY) { console.log('\n(dry-run，加 --apply 才寫入)'); process.exit(0) }

const ts = new Date().toISOString()
let seq = journal.reduce((max, r) => Math.max(max, r.seq ?? 0), 0)
const added = drafts.map(({ key, patch }) => ({
  op: 'set', target: { type: 'road', key }, fields: patch,
  seq: ++seq, ts, author: 'migrate-single-moto-arrows',
}))
const backupDir = resolve(ROOT, '.lanedev-backups')
mkdirSync(backupDir, { recursive: true })
const backup = resolve(backupDir, `road_database.before-single-moto-arrows-${Date.now()}.json`)
writeFileSync(backup, readFileSync(DB_PATH))
db.editor.journal = [...journal, ...added]
db.editor.updated_at = ts
db.updated_at = ts
writeFileSync(DB_PATH, `${JSON.stringify(db)}\n`, 'utf8')
console.log(`\n已寫入 ${added.length} 筆（備份 ${backup}）`)
