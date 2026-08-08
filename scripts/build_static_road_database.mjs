import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSegments } from './segment_dedupe.mjs'

const root = resolve(import.meta.dirname, '..')
const data = resolve(root, 'public/data')
const lanePilot = resolve(data, 'lanepilot')
const allRegions = [
  { area_id: 'area/4212599', name: '楠梓區', file: 'area_4212599.segments.jsonl' },
  { area_id: 'area/4212533', name: '左營區', file: 'area_4212533.segments.jsonl' },
]

export function parseJsonl(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

function stableJson(value) {
  const json = JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current
    return Object.fromEntries(Object.keys(current).sort().map((key) => [key, current[key]]))
  })
  if (json === undefined) throw new TypeError('stableJsonHash 需要可 JSON 序列化的值。')
  return json
}

export function stableJsonHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function buildCanonicalEditor(editor) {
  const journal = Array.isArray(editor?.journal) ? editor.journal : []
  const preservedJournal = journal.filter((record) => record.author !== 'lanepilot')
  return {
    editor: {
      ...editor,
      journal: preservedJournal,
    },
    removedLanePilotJournalCount: journal.length - preservedJournal.length,
  }
}

function argumentValue(name, args = process.argv.slice(2)) {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)
}

async function loadSegments(regions) {
  const loaded = (await Promise.all(regions.map(async ({ file }) => {
    const text = await readFile(resolve(lanePilot, file), 'utf8')
    const out = []
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return
      out.push({ record: JSON.parse(line), source: file, line: index + 1 })
    })
    return out
  }))).flat()
  return { loaded, ...prepareSegments(loaded) }
}

async function loadEditor() {
  try {
    return JSON.parse(await readFile(resolve(data, 'road_database.json'), 'utf8')).editor
  } catch {
    let journal = []
    try {
      journal = JSON.parse(await readFile(resolve(data, 'seed_journal.json'), 'utf8'))
    } catch {
      // A missing seed is valid; browser edits will populate the canonical editor.
    }
    return {
      updated_at: '',
      journal,
      waiting_zones: [],
      deleted_waiting_zone_ids: [],
    }
  }
}

async function promoteCandidate(candidateArgument, auditArgument) {
  const candidatePath = resolve(candidateArgument)
  const auditPath = resolve(auditArgument)
  const canonicalPath = resolve(data, 'road_database.json')
  const audit = JSON.parse(await readFile(auditPath, 'utf8'))
  const candidateText = await readFile(candidatePath, 'utf8')
  const candidateHash = stableJsonHash(JSON.parse(candidateText))

  if (!audit.candidate_sha256 || audit.candidate_sha256 !== candidateHash) {
    throw new Error('候選檔 SHA-256 與 base audit 不一致；未執行 promotion。')
  }

  const backupPath = resolve(
    root,
    '.lanedev-backups',
    `road_database.pre-promotion-${new Date().toISOString().replaceAll(':', '-')}.json`,
  )
  await mkdir(dirname(backupPath), { recursive: true })
  await copyFile(canonicalPath, backupPath)
  await copyFile(candidatePath, canonicalPath)
  console.log(JSON.stringify({
    promoted_candidate: candidatePath,
    base_audit: auditPath,
    candidate_sha256: candidateHash,
    backup: backupPath,
  }, null, 2))
}

export async function main(args = process.argv.slice(2)) {
  const promoteCandidateArgument = argumentValue('--promote-candidate', args)
  const baseAuditArgument = argumentValue('--base-audit', args)
  if (promoteCandidateArgument || baseAuditArgument) {
    if (!promoteCandidateArgument || !baseAuditArgument) {
      throw new Error('promotion 需要同時提供 --promote-candidate=<path> 與 --base-audit=<path>。')
    }
    await promoteCandidate(promoteCandidateArgument, baseAuditArgument)
    return
  }

  if (args.includes('--write-canonical')) {
    throw new Error('不可在建置時寫入 canonical；請使用 --promote-candidate=<path> 與 --base-audit=<path>。')
  }

  const nanzihOnly = args.includes('--nanzih-only')
  const reverseRegions = args.includes('--reverse-regions')
  const selected = nanzihOnly ? allRegions.slice(0, 1) : allRegions
  const regions = reverseRegions ? [...selected].reverse() : selected
  const { loaded, segments, exactDuplicates, conflicts } = await loadSegments(regions)
  const annotations = parseJsonl(await readFile(resolve(lanePilot, 'annotations.jsonl'), 'utf8'))
  const { editor, removedLanePilotJournalCount } = buildCanonicalEditor(await loadEditor())
  const output = {
    format: 'lanedev-static-road-database-v1',
    updated_at: new Date().toISOString(),
    regions: regions.map(({ area_id, name }) => ({ area_id, name })),
    segments,
    annotations,
    editor,
  }

  const explicitOut = argumentValue('--out', args)
  const defaultCandidate = resolve(root, '.lanedev-backups/road_database.candidate.json')
  const outPath = explicitOut ? resolve(explicitOut) : defaultCandidate
  const reportPath = resolve(argumentValue('--report', args) ?? `${outPath}.dedup-report.json`)
  const blockingErrors = conflicts.map((conflict) => ({
    type: 'segment_identity_conflict',
    ...conflict,
  }))
  const report = {
    format: 'lanedev-segment-dedup-report-v1',
    generated_at: new Date().toISOString(),
    regions: regions.map((region) => region.file),
    input_count: loaded.length,
    unique_count: segments.length,
    exact_duplicate_count: exactDuplicates.length,
    conflict_count: conflicts.length,
    manual_review_required: conflicts.length > 0,
    exact_duplicate_samples: exactDuplicates.slice(0, 5),
    conflicts,
    annotation_count: annotations.length,
    removed_lanepilot_journal_count: removedLanePilotJournalCount,
    preserved_editor_sha256: stableJsonHash(editor),
    candidate_sha256: stableJsonHash(output),
    blocking_errors: blockingErrors,
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
    journal: output.editor.journal.length,
    removedLanePilotJournalCount,
  }, null, 2))
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
}
