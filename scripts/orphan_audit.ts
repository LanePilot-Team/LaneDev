// 孤立型失效稽核（node scripts/run_offline.mjs scripts/orphan_audit.ts）
//
// 「孤立型」＝紀錄還在 journal 裡，但它的鍵指不到任何現存區塊，所以覆寫靜默失效。
// 區塊鍵是 `way/W@b/N`，N = 該區塊第一個節點。只要區塊邊界移動（底圖重建、路口
// 增刪、couplet 重新配對），N 就換人做，舊鍵當場變孤兒——資料沒丟，但不生效。
//
// ⚠ 判準重點：**「次段消失」是捏合成功的樣子，不是失效**。
// 捏合會把次段併進保留段並移出活躍集合，於是次段的區塊鍵必然找不到。舊版判準把
// 這種情形一律算成 unresolved，實測 46 筆「失效」裡有三十幾筆其實是正常的，真正
// 需要人工處理的那幾筆反而被淹沒。分類必須先扣掉這一類。
//
//   --json=<path>  額外輸出機器可讀的分類報告
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, applyRoadMerges } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const JSON_OUT = arg('json', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const mergeView = buildRoadMergeViews(
  roads.filter((road: RoadFeature) => !road.properties.deleted),
  journal,
)
// Orphan-key counts retain the legacy destructive view so historical road-field
// targets are compared with the same post-merge block layout as older reports.
// Merge validity itself comes from mergeView above, which understands V2 source snapshots.
applyRoadMerges(roads, journal)
const auditRoads = roads

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const live = new Map(auditRoads.map((r) => [blockKey(r), r]))
const folded = foldJournal(journal)
const nameOf = (r?: RoadFeature) => r?.properties.name ?? '未命名'
const parseKey = (k: string) => {
  const m = k.match(/^way\/(-?\d+)@b\/(-?\d+)$/)
  return m ? { wayId: Number(m[1]), blockNode: Number(m[2]) } : null
}

// ── 1. 捏合紀錄：先分出「已生效」，才有可信的失敗清單 ──────────────────────
interface MergeRow {
  key: string; primary: string; secondary: string
  status: 'applied' | 'absorbed' | 'failed'; detail: string
}
const merges: MergeRow[] = []
/** 被捏合吸收掉的次段鍵——這些鍵變孤兒是預期行為，不該算失效 */
const absorbedKeys = new Set<string>()
for (const row of mergeView.rows) {
  if (row.resolved) {
    const absorbed = !live.has(row.secondaryKey)
    if (absorbed) absorbedKeys.add(row.secondaryKey)
    merges.push({
      key: row.mergeKey,
      primary: row.primaryKey,
      secondary: row.secondaryKey,
      status: absorbed ? 'absorbed' : 'applied',
      detail: `由 ${row.resolved.resolvedBy} 來源重播成功`,
    })
  } else {
    merges.push({
      key: row.mergeKey,
      primary: row.primaryKey,
      secondary: row.secondaryKey,
      status: 'failed',
      detail: row.detail,
    })
  }
}
const mergeFailed = merges.filter((m) => m.status === 'failed')
console.log(`捏合紀錄 ${merges.length} 組`
  + `｜已生效 ${merges.filter((m) => m.status !== 'failed').length}`
  + `（其中次段已吸收 ${merges.filter((m) => m.status === 'absorbed').length}）`
  + `｜失敗 ${mergeFailed.length}`)
for (const m of mergeFailed) console.log(`   ✖ ${m.primary} + ${m.secondary}\n        ${m.detail}`)

// ── 2. 區塊鍵孤兒分類 ───────────────────────────────────────────────────────
interface OrphanRow {
  key: string
  klass: 'absorbed_by_merge' | 'candidate_remap_needs_review' | 'unresolved'
  deleted: boolean
  fields: number
  detail: string
  new_target?: string
  old_road?: string
  new_road?: string
}
const orphans: OrphanRow[] = []
for (const [key, fields] of folded) {
  if (!/^way\/-?\d+@b\/-?\d+$/.test(key) || live.has(key)) continue
  const deleted = Number(fields.deleted) > 0
  const n = Object.keys(fields).length
  if (absorbedKeys.has(key)) {
    orphans.push({ key, klass: 'absorbed_by_merge', deleted, fields: n,
      detail: '次段已被捏合吸收，鍵失效屬預期' })
    continue
  }
  const p = parseKey(key)!
  const host = auditRoads.find((r) => r.properties.osm_id === p.wayId
    && r.properties.nodes.includes(p.blockNode))
  if (host) {
    orphans.push({ key, klass: 'candidate_remap_needs_review', deleted, fields: n,
      new_target: blockKey(host), new_road: nameOf(host),
      detail: '同 way 有區塊含此節點，可能是它——道路名稱不同時務必人工確認' })
  } else {
    const anyWay = auditRoads.some((r) => r.properties.osm_id === p.wayId)
    orphans.push({ key, klass: 'unresolved', deleted, fields: n,
      detail: anyWay ? 'way 還在，但舊 blockNode 已不在任何區塊裡' : '整條 way 已不存在' })
  }
}
const by = (k: OrphanRow['klass']) => orphans.filter((o) => o.klass === k)
console.log(`\njournal ${journal.length} 筆／折疊 ${folded.size} 個鍵／區塊鍵孤兒 ${orphans.length}`)
console.log(`   absorbed_by_merge（預期，不需處理）        ${by('absorbed_by_merge').length}`)
console.log(`   candidate_remap_needs_review（需人工複核） ${by('candidate_remap_needs_review').length}`)
console.log(`   unresolved（找不到對應）                   ${by('unresolved').length}`)

// deleted:1 失效會讓被刪的路段重新出現，一定要單獨列出
const deletedOrphans = orphans.filter((o) => o.deleted && o.klass !== 'absorbed_by_merge')
console.log(`\n⚠ 失效的 deleted:1（可能讓已刪路段重新出現）：${deletedOrphans.length}`)
for (const o of deletedOrphans) {
  console.log(`   ${o.key}｜${o.klass}`
    + (o.new_target ? `\n        → 候選 ${o.new_target}（${o.new_road}）` : `\n        ${o.detail}`))
}

for (const o of by('candidate_remap_needs_review')) {
  if (o.deleted) continue
  console.log(`   ✔ ${o.key}（${o.fields} 個欄位）→ ${o.new_target}（${o.new_road}）`)
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({
    format: 'lanedev-journal-orphan-report-v1',
    generated_at: new Date().toISOString(),
    journal_count: journal.length,
    folded_target_count: folded.size,
    merges: {
      total: merges.length,
      applied: merges.filter((m) => m.status === 'applied').length,
      absorbed: merges.filter((m) => m.status === 'absorbed').length,
      failed: mergeFailed.length,
      failures: mergeFailed,
    },
    orphans: {
      total: orphans.length,
      absorbed_by_merge: by('absorbed_by_merge').length,
      candidate_remap_needs_review: by('candidate_remap_needs_review').length,
      unresolved: by('unresolved').length,
      deleted_affected: deletedOrphans.length,
      rows: orphans,
    },
  }, null, 2)}\n`, 'utf8')
  console.log(`\n已寫入報告 ${JSON_OUT}`)
}
