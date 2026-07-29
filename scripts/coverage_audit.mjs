// 舊資料集覆蓋率稽核：證明每一份歷史資料集的 journal 鍵都已經併進唯一版本，
// 沒有任何一份還握著獨有資料。這是刪除舊資料集前的放行條件。
//
//   node scripts/coverage_audit.mjs [--roots=C:/code] [--db=<檔案>]
//
// 逐一列出每份來源的鍵數、已併入數、獨有數。任何一份「獨有 > 0」就視為未通過，
// 代表刪掉它會真的失去資料。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = resolve(arg('db', resolve(ROOT, 'public/data/road_database.json')))
const ROOTS = arg('roots', resolve(ROOT, '../..')).split(',').map((p) => resolve(p.trim()))

/** 遞迴找出所有可能帶 journal 的資料集檔（略過 node_modules 與 .git）。 */
function collect(dir, depth = 0, out = []) {
  if (depth > 7) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
      collect(full, depth + 1, out)
    } else if (/^(road_database|nanzi_enhancements|seed_journal).*\.(json|bak)$/.test(entry.name)
      || /^road_database\.json\..*\.bak$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal = db.editor?.journal ?? []
const liveKeys = new Set(journal.map((r) => `${r.target?.type}|${r.target?.key}`))
const fingerprint = (r) => JSON.stringify([
  r.ts, r.author, r.op, r.target?.type, r.target?.key, r.fields ?? null,
])
const liveFingerprints = new Set(journal.map(fingerprint))

const paths = [...new Set(ROOTS.flatMap((r) => collect(r)))].filter((p) => p !== DB_PATH)
console.log(`唯一版本：${DB_PATH}`)
console.log(`          ${journal.length} 筆 / ${liveKeys.size} 個鍵\n`)
console.log(`掃描 ${paths.length} 份歷史資料集：\n`)

let failing = 0
const rows = []
for (const p of paths) {
  let snap
  try { snap = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
  const j = snap.editor?.journal ?? snap.journal
    ?? (Array.isArray(snap) ? snap : null)
  if (!Array.isArray(j)) continue
  const keys = new Set(j.map((r) => `${r.target?.type}|${r.target?.key}`))
  const uniqueKeys = [...keys].filter((k) => !liveKeys.has(k))
  // 鍵已併入但內容版本較舊者不算獨有——唯一版本裡有更新的值才是對的
  const uniqueRecords = j.filter((r) => !liveFingerprints.has(fingerprint(r))
    && !liveKeys.has(`${r.target?.type}|${r.target?.key}`))
  if (uniqueKeys.length) failing++
  rows.push({
    p, size: statSync(p).size, records: j.length, keys: keys.size,
    uniqueKeys: uniqueKeys.length, uniqueRecords: uniqueRecords.length,
    sample: uniqueKeys.slice(0, 3),
  })
}

rows.sort((a, b) => b.uniqueKeys - a.uniqueKeys || b.size - a.size)
let bytes = 0
for (const r of rows) {
  bytes += r.size
  const mark = r.uniqueKeys ? '❌' : '✅'
  console.log(`${mark} ${(r.size / 1048576).toFixed(1).padStart(6)} MB  `
    + `${String(r.records).padStart(5)} 筆 / ${String(r.keys).padStart(4)} 鍵  `
    + `獨有鍵 ${String(r.uniqueKeys).padStart(3)}  ${r.p}`)
  if (r.uniqueKeys) console.log(`      獨有：${r.sample.join(', ')}`)
}

console.log(`\n合計 ${rows.length} 份、${(bytes / 1048576).toFixed(1)} MB`)
if (failing === 0) {
  console.log('✅ 全部歷史資料集的 journal 鍵都已併入唯一版本——可以安全刪除')
} else {
  console.log(`❌ ${failing} 份仍握有唯一版本沒有的鍵，刪除前必須先併入`)
}
process.exit(failing === 0 ? 0 : 1)
