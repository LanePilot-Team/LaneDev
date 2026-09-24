// 實驗：prepareBaseRoads 在同一個程序內連續執行，輸出是否一致？
//   node scripts/run_offline.mjs scripts/pipeline_determinism_probe.ts
//
// 起因：E6 快照實驗發現「第 1 次的輸出」與「第 7 次的輸出」不相等。
// 可能原因有二，這支腳本要分辨是哪一種：
//   (a) 管線本身不具決定性（同樣輸入、不同輸出）
//   (b) 管線會就地修改輸入，使第 2 次拿到的已是被改過的資料
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImportedRecords } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'

const HERE = dirname(fileURLToPath(import.meta.url))
const text = readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8')
const db = JSON.parse(text)
const segments = db.segments as Record<string, unknown>[]

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)

console.log('=== 實驗 E7：prepareBaseRoads 決定性 ===\n')

// ── 條件 1：共用同一份 segments（目前 App 的實際情形）──
const sharedBefore = sha(segments)
const shared: string[] = []
for (let i = 0; i < 3; i++) {
  const parsed = parseImportedRecords(segments)
  if (parsed.kind !== 'map') throw new Error('bad')
  const out = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  shared.push(sha(out.roads))
}
const sharedAfter = sha(segments)

console.log('條件 1：連續呼叫，共用同一份 db.segments')
shared.forEach((h, i) => console.log(`  第 ${i + 1} 次輸出 sha  ${h}`))
console.log(`  三次一致？            ${new Set(shared).size === 1 ? 'PASS' : 'FAIL'}`)
console.log(`  segments 是否被改動？  ${sharedBefore === sharedAfter ? '否（未被就地修改）' : '是（已被就地修改）'}`)
console.log(`    before ${sharedBefore}  after ${sharedAfter}`)

// ── 條件 2：每次都給全新的深拷貝輸入 ──
const fresh: string[] = []
for (let i = 0; i < 3; i++) {
  const copy = JSON.parse(JSON.stringify(segments)) as Record<string, unknown>[]
  const parsed = parseImportedRecords(copy)
  if (parsed.kind !== 'map') throw new Error('bad')
  const out = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  fresh.push(sha(out.roads))
}
console.log('\n條件 2：每次給全新深拷貝的 segments')
fresh.forEach((h, i) => console.log(`  第 ${i + 1} 次輸出 sha  ${h}`))
console.log(`  三次一致？            ${new Set(fresh).size === 1 ? 'PASS' : 'FAIL'}`)

console.log('\n=== 判讀 ===')
const detShared = new Set(shared).size === 1
const detFresh = new Set(fresh).size === 1
const mutated = sharedBefore !== sharedAfter
if (detFresh && !detShared) {
  console.log('  管線具決定性，但會污染輸入：同一份 segments 重複使用會得到不同結果。')
} else if (detFresh && detShared) {
  console.log('  管線具決定性，且不污染輸入。E6 的差異另有來源。')
} else if (!detFresh) {
  console.log('  管線本身不具決定性——同樣的全新輸入仍產生不同輸出。')
}
if (mutated) console.log('  且 db.segments 被就地修改（原始資料遭污染）。')
console.log(`\n  條件1一致=${detShared}  條件2一致=${detFresh}  輸入被改=${mutated}`)
