import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { prepareSegments } from './segment_dedupe.mjs'

const root = resolve(import.meta.dirname, '..')
const data = resolve(root, 'public/data')
const lanePilot = resolve(data, 'lanepilot')
const allRegions = [
  { area_id: 'area/4212599', name: '楠梓區', file: 'area_4212599.segments.jsonl' },
  { area_id: 'area/4212533', name: '左營區', file: 'area_4212533.segments.jsonl' },
]
const nanzihOnly = process.argv.includes('--nanzih-only')
// 驗收用：反轉 regions 順序後，輸出的 segments／node_refs／統計必須完全相同。
// 若不同，代表 first-wins 仍在影響資料正確性而不只是決定順序。
const reverseRegions = process.argv.includes('--reverse-regions')
const selected = nanzihOnly ? allRegions.slice(0, 1) : allRegions
const regions = reverseRegions ? [...selected].reverse() : selected

function parseJsonl(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

// 載入時保留出處（shard 檔名 + JSONL 行號），衝突報告要靠它指出人工該去看哪一行。
const loaded = (await Promise.all(regions.map(async ({ file }) => {
  const text = await readFile(resolve(lanePilot, file), 'utf8')
  const out = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    out.push({ record: JSON.parse(line), source: file, line: index + 1 })
  })
  return out
}))).flat()

// 補齊 + 去重的實作在 segment_dedupe.mjs（純函式，有獨立測試）。
const { segments, exactDuplicates, conflicts } = prepareSegments(loaded)
if (exactDuplicates.length) {
  console.warn(`[dedupe] 跨 shard 完全相同的分段 ${exactDuplicates.length} 個已合併`
    + `（${loaded.length} → ${segments.length}）`)
  console.warn(`[dedupe] 例：${exactDuplicates.slice(0, 5).map((d) => d.key).join(', ')}`)
}
if (conflicts.length) {
  // 一定要出聲。靜默吃掉差異正是這個問題藏這麼久的原因。
  console.warn(`[dedupe] ⚠ 同 identity 但內容不同 ${conflicts.length} 個`
    + `——候選已採 first-wins，但需人工複核，且不得直接寫入 canonical`)
  for (const c of conflicts.slice(0, 5)) {
    console.warn(`[dedupe]   ${c.key}｜差異欄位 ${c.differing_fields.join(', ')}`)
  }
}

// annotations.jsonl 已在匯入階段具體化為 editor.journal 與 waiting_zones。
// 執行時不再需要重複攜帶近 9 MB 的原始標註；唯一生效來源仍是同一份
// road_database.json 內的 segments + editor。
const annotations = []

let existingEditor = null
try {
  existingEditor = JSON.parse(
    await readFile(resolve(data, 'road_database.json'), 'utf8'),
  ).editor
} catch {
  // First build has no canonical database yet.
}

if (existingEditor && nanzihOnly) {
  const allowedWays = new Set(segments.map((segment) =>
    Number(segment.object_identity?.source_osm?.osm_id
      ?? String(segment.object_identity?.nav_segment_key ?? '').match(/^way\/(-?\d+)/)?.[1]
      ?? segment.osm_id)).filter(Number.isFinite))
  const allowedNodes = new Set(segments.flatMap((segment) =>
    Array.isArray(segment.node_refs) ? segment.node_refs.map(Number) : []))
  existingEditor = {
    ...existingEditor,
    journal: existingEditor.journal.filter((record) => {
      const wayIds = [...String(record.target?.key ?? '').matchAll(/way\/(-?\d+)/g)]
        .map((match) => Number(match[1]))
      return wayIds.length === 0 || wayIds.every((wayId) => allowedWays.has(wayId))
    }),
    waiting_zones: existingEditor.waiting_zones.filter((zone) =>
      allowedNodes.has(Number(zone.intersectionId))),
  }
}

let journal = []
try {
  journal = JSON.parse(await readFile(resolve(data, 'seed_journal.json'), 'utf8'))
} catch {
  // A missing seed is valid; browser edits will populate the canonical editor.
}

const output = {
  format: 'lanedev-static-road-database-v1',
  updated_at: new Date().toISOString(),
  regions: regions.map(({ area_id, name }) => ({ area_id, name })),
  segments,
  annotations,
  editor: existingEditor ?? {
    updated_at: '',
    journal,
    waiting_zones: [],
    deleted_waiting_zone_ids: [],
  },
}

// ── 輸出：canonical 需要明確核准 ────────────────────────────────────────────
//
// 預設只產候選檔。寫入唯一資料庫必須明確加 --write-canonical，而且 conflict 存在
// 時連 --write-canonical 都不夠，還要 --allow-conflicts——因為 conflict 代表兩份
// shard 對同一段路的描述不一致，該由人決定留哪一份，不是由載入順序決定。
const canonicalPath = resolve(data, 'road_database.json')
const explicitOut = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
const writeCanonical = process.argv.includes('--write-canonical')
const allowConflicts = process.argv.includes('--allow-conflicts')
const defaultCandidate = resolve(root, '.lanedev-backups/road_database.candidate.json')
const outPath = explicitOut
  ? resolve(explicitOut)
  : (writeCanonical ? canonicalPath : defaultCandidate)
const reportPath = resolve(
  process.argv.find((a) => a.startsWith('--report='))?.slice('--report='.length)
    ?? `${outPath}.dedup-report.json`,
)

if (resolve(outPath) === canonicalPath && !writeCanonical) {
  console.error('拒絕寫入 canonical road_database.json：請加 --write-canonical')
  process.exit(2)
}
if (resolve(outPath) === canonicalPath && conflicts.length && !allowConflicts) {
  console.error(`拒絕寫入 canonical：有 ${conflicts.length} 個 conflict 未經人工確認`
    + `（報告見 ${reportPath}）。確認後再加 --allow-conflicts`)
  process.exit(2)
}

const report = {
  format: 'lanedev-segment-dedup-report-v1',
  generated_at: new Date().toISOString(),
  regions: regions.map((r) => r.file),
  input_count: loaded.length,
  unique_count: segments.length,
  exact_duplicate_count: exactDuplicates.length,
  conflict_count: conflicts.length,
  manual_review_required: conflicts.length > 0,
  // exact duplicate 只留樣本：逐筆列出 57 筆只是噪音，真正要人看的是 conflicts
  exact_duplicate_samples: exactDuplicates.slice(0, 5),
  conflicts,
}

await mkdir(dirname(outPath), { recursive: true })
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(outPath, `${JSON.stringify(output)}\n`, 'utf8')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  output: outPath,
  report: reportPath,
  input: loaded.length,
  segments: segments.length,
  exactDuplicates: exactDuplicates.length,
  conflicts: conflicts.length,
  manualReviewRequired: report.manual_review_required,
  annotations: annotations.length,
  // 摘要要報實際輸出的 journal，不是 seed_journal 的長度
  journal: output.editor.journal.length,
}, null, 2))
