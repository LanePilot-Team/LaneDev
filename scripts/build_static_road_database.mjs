import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSegments } from './segment_dedupe.mjs'

const root = resolve(import.meta.dirname, '..')
const data = resolve(root, 'public/data')
const lanePilot = resolve(data, 'lanepilot')
const canonicalPath = resolve(data, 'road_database.json')
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

function normalizeComparablePath(path) {
  const resolvedPath = resolve(path)
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

async function realDestinationPath(path) {
  const resolvedPath = resolve(path)
  try {
    return await realpath(resolvedPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const parent = dirname(resolvedPath)
    if (parent === resolvedPath) return resolvedPath
    return resolve(await realDestinationPath(parent), basename(resolvedPath))
  }
}

export async function destinationIdentity(path) {
  const resolvedPath = resolve(path)
  const canonicalizedPath = normalizeComparablePath(await realDestinationPath(resolvedPath))
  try {
    const fileStat = await stat(resolvedPath)
    return {
      canonicalizedPath,
      exists: true,
      dev: fileStat.dev,
      ino: fileStat.ino,
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { canonicalizedPath, exists: false, dev: null, ino: null }
  }
}

function sameDestinationIdentity(left, right) {
  if (left.canonicalizedPath === right.canonicalizedPath) return true
  return left.exists && right.exists
    && left.ino !== 0 && right.ino !== 0
    && left.dev === right.dev && left.ino === right.ino
}

export async function assertDistinctDestinations(destinations) {
  const entries = Object.entries(destinations)
  const identities = await Promise.all(entries.map(async ([name, path]) => [
    name,
    await destinationIdentity(path),
  ]))
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const [leftName, leftIdentity] = identities[leftIndex]
      const [rightName, rightIdentity] = identities[rightIndex]
      if (sameDestinationIdentity(leftIdentity, rightIdentity)) {
        throw new Error(`${leftName} 與 ${rightName} 指向相同檔案；拒絕在任一目的地寫入。`)
      }
    }
  }
}

function validateEditor(editor, source) {
  if (!editor || typeof editor !== 'object' || Array.isArray(editor)
    || typeof editor.updated_at !== 'string'
    || !Array.isArray(editor.journal)
    || !Array.isArray(editor.waiting_zones)
    || !Array.isArray(editor.deleted_waiting_zone_ids)) {
    throw new Error(`${source} 的 editor 結構無效；拒絕以空資料繼續建置。`)
  }
  return editor
}

async function readJsonIfPresent(path, source) {
  try {
    return { found: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { found: false, value: null }
    throw new Error(`${source} 無法讀取或不是有效 JSON；拒絕繼續建置。`, { cause: error })
  }
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
  const canonical = await readJsonIfPresent(canonicalPath, 'canonical road_database.json')
  if (canonical.found) {
    return validateEditor(canonical.value?.editor, 'canonical road_database.json')
  }

  const seedJournal = await readJsonIfPresent(resolve(data, 'seed_journal.json'), 'seed_journal.json')
  if (seedJournal.found && !Array.isArray(seedJournal.value)) {
    throw new Error('seed_journal.json 必須是 journal 陣列；拒絕繼續建置。')
  }
  return validateEditor({
    updated_at: '',
    journal: seedJournal.found ? seedJournal.value : [],
    waiting_zones: [],
    deleted_waiting_zone_ids: [],
  }, '初始 editor')
}

function validatePromotionAudit(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error('base audit 結構無效；未執行 promotion。')
  }
  if (!Array.isArray(audit.blocking_errors) || audit.blocking_errors.length !== 0) {
    throw new Error('base audit 的 blocking_errors 必須是空陣列；未執行 promotion。')
  }

  const hasUnmappedCount = Object.hasOwn(audit, 'unmapped_count')
  const hasUnmapped = Object.hasOwn(audit, 'unmapped')
  if (!hasUnmappedCount && !hasUnmapped) {
    throw new Error('base audit 必須提供 unmapped_count 或 unmapped；未執行 promotion。')
  }
  if (hasUnmappedCount
    && (!Number.isInteger(audit.unmapped_count) || audit.unmapped_count < 0)) {
    throw new Error('base audit 的 unmapped_count 必須是非負整數；未執行 promotion。')
  }
  if (hasUnmapped && !Array.isArray(audit.unmapped)) {
    throw new Error('base audit 的 unmapped 必須是陣列；未執行 promotion。')
  }
  if (hasUnmappedCount && hasUnmapped && audit.unmapped_count !== audit.unmapped.length) {
    throw new Error('base audit 的 unmapped_count 與 unmapped 長度不一致；未執行 promotion。')
  }
  if ((hasUnmappedCount && audit.unmapped_count !== 0)
    || (hasUnmapped && audit.unmapped.length !== 0)) {
    throw new Error('base audit 必須明確記錄 unmapped 為 0；未執行 promotion。')
  }
}

export async function promoteValidatedCandidateText({ canonicalPath, backupPath, candidateText }) {
  await mkdir(dirname(backupPath), { recursive: true })
  await copyFile(canonicalPath, backupPath)
  await writeFile(canonicalPath, candidateText, 'utf8')
}

async function promoteCandidate(candidateArgument, auditArgument) {
  const candidatePath = resolve(candidateArgument)
  const auditPath = resolve(auditArgument)
  const audit = JSON.parse(await readFile(auditPath, 'utf8'))
  const candidateText = await readFile(candidatePath, 'utf8')
  const candidateHash = stableJsonHash(JSON.parse(candidateText))

  if (!audit.candidate_sha256 || audit.candidate_sha256 !== candidateHash) {
    throw new Error('候選檔 SHA-256 與 base audit 不一致；未執行 promotion。')
  }
  validatePromotionAudit(audit)

  const backupPath = resolve(
    root,
    '.lanedev-backups',
    `road_database.pre-promotion-${new Date().toISOString().replaceAll(':', '-')}.json`,
  )
  await promoteValidatedCandidateText({ canonicalPath, backupPath, candidateText })
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

  const explicitOut = argumentValue('--out', args)
  const defaultCandidate = resolve(root, '.lanedev-backups/road_database.candidate.json')
  const outPath = explicitOut ? resolve(explicitOut) : defaultCandidate
  const reportPath = resolve(argumentValue('--report', args) ?? `${outPath}.dedup-report.json`)
  await assertDistinctDestinations({ candidate: outPath, report: reportPath, canonical: canonicalPath })

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
