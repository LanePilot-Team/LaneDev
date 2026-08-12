import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements.ts'
import { parseImported } from '../src/core/importmap.ts'
import {
  applyLaneBaseToRoads,
  buildLaneBaseIndex,
  extractLaneBase,
  remapLaneBase,
} from '../src/core/laneBase.ts'
import { newRoadsFromFolded } from '../src/core/newroads.ts'
import { prepareBaseRoads } from '../src/core/pipeline.ts'
import { buildRoadMergeViews } from '../src/core/roadMerge.ts'
import { roadsFromGeoJSON } from '../src/core/roads.ts'

export interface LaneBaseAuditFacts {
  candidateSha256: string
  sourceAnnotations: number
  accountedSourceKeys: Iterable<string>
  remappedSourceKeys: Iterable<string>
  laneProfileSourceKeys: Iterable<string>
  movementRuleSourceKeys: Iterable<string>
  retiredSourceKeys?: Iterable<string>
  explicitUnmappedSourceKeys?: Iterable<string>
  conflicts?: string[]
  expectedHumanEditorSha256?: string
  candidateHumanEditorSha256: string
  replayErrors?: string[]
  unappliedLaneSourceKeys?: Iterable<string>
}

export interface LaneBaseCandidateAudit {
  format: 'lanedev-lane-base-candidate-audit-v1'
  generated_at: string
  candidate_sha256: string
  source_annotations: number
  accounted_annotations: number
  lane_profiles: number
  movement_rule_records: number
  retired_annotations: string[]
  unmapped_count: number
  unmapped: string[]
  conflicts: string[]
  expected_human_editor_sha256?: string
  candidate_human_editor_sha256: string
  human_editor_hash_match: boolean
  replay_errors: string[]
  unapplied_lane_sources: string[]
  blocking_errors: Array<{ type: string; detail: string }>
}

const sortedUnique = (values: Iterable<string> = []) =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b))

export function buildLaneBaseCandidateAudit(
  facts: LaneBaseAuditFacts,
): LaneBaseCandidateAudit {
  const accounted = new Set(facts.accountedSourceKeys)
  const remapped = new Set(facts.remappedSourceKeys)
  const retired = new Set(facts.retiredSourceKeys ?? [])
  const unmapped = new Set(facts.explicitUnmappedSourceKeys ?? [])
  for (const sourceKey of accounted) {
    if (!remapped.has(sourceKey) && !retired.has(sourceKey)) unmapped.add(sourceKey)
  }

  const conflicts = sortedUnique(facts.conflicts)
  const replayErrors = sortedUnique(facts.replayErrors)
  const unappliedLaneSources = sortedUnique(facts.unappliedLaneSourceKeys)
  const expectedHash = facts.expectedHumanEditorSha256
  const humanEditorHashMatch = !!expectedHash && expectedHash === facts.candidateHumanEditorSha256
  const blockingErrors: Array<{ type: string; detail: string }> = []
  for (const sourceKey of sortedUnique(unmapped)) {
    blockingErrors.push({ type: 'unmapped_annotation', detail: sourceKey })
  }
  for (const detail of conflicts) blockingErrors.push({ type: 'lane_base_conflict', detail })
  for (const detail of replayErrors) blockingErrors.push({ type: 'editor_replay_error', detail })
  if (!humanEditorHashMatch) {
    blockingErrors.push({
      type: 'human_editor_hash_mismatch',
      detail: expectedHash
        ? `expected ${expectedHash}, received ${facts.candidateHumanEditorSha256}`
        : 'build report did not provide preserved_editor_sha256',
    })
  }

  const unmappedList = sortedUnique(unmapped)
  return {
    format: 'lanedev-lane-base-candidate-audit-v1',
    generated_at: new Date().toISOString(),
    candidate_sha256: facts.candidateSha256,
    source_annotations: facts.sourceAnnotations,
    accounted_annotations: Math.max(0, facts.sourceAnnotations - unmappedList.length),
    lane_profiles: new Set(facts.laneProfileSourceKeys).size,
    movement_rule_records: new Set(facts.movementRuleSourceKeys).size,
    retired_annotations: sortedUnique(retired),
    unmapped_count: unmappedList.length,
    unmapped: unmappedList,
    conflicts,
    ...(expectedHash ? { expected_human_editor_sha256: expectedHash } : {}),
    candidate_human_editor_sha256: facts.candidateHumanEditorSha256,
    human_editor_hash_match: humanEditorHashMatch,
    replay_errors: replayErrors,
    unapplied_lane_sources: unappliedLaneSources,
    blocking_errors: blockingErrors,
  }
}

export const laneBaseAuditExitCode = (audit: Pick<LaneBaseCandidateAudit, 'blocking_errors'>) =>
  audit.blocking_errors.length ? 2 : 0

const stableJson = (value: unknown) => JSON.stringify(value, (_key, current) => {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return current
  return Object.fromEntries(Object.keys(current).sort().map((key) => [key, current[key]]))
})

const stableJsonHash = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex')

const argumentValue = (name: string, args: string[]) =>
  args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)

export function auditLaneBaseCandidate(options: {
  candidatePath: string
  buildReportPath: string
}): LaneBaseCandidateAudit {
  const candidate = JSON.parse(readFileSync(options.candidatePath, 'utf8'))
  const buildReport = JSON.parse(readFileSync(options.buildReportPath, 'utf8'))
  const conflicts: string[] = []
  const replayErrors: string[] = []

  const candidateSha256 = stableJsonHash(candidate)
  if (buildReport.candidate_sha256 !== candidateSha256) {
    conflicts.push(
      `candidate hash mismatch: build report ${String(buildReport.candidate_sha256)}; candidate ${candidateSha256}`,
    )
  }
  for (const error of buildReport.blocking_errors ?? []) {
    conflicts.push(`segment build: ${JSON.stringify(error)}`)
  }

  const annotations = Array.isArray(candidate.annotations) ? candidate.annotations : []
  const extraction = extractLaneBase(annotations)
  conflicts.push(...extraction.errors)

  const parsed = parseImported(
    (Array.isArray(candidate.segments) ? candidate.segments : [])
      .map((record: unknown) => JSON.stringify(record)).join('\n'),
  )
  if (parsed.kind !== 'map') throw new Error('candidate segments are not a valid map')
  const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  const remapped = remapLaneBase(extraction.records, {
    existingWayIds: new Set(prepared.roads.map((road) => road.properties.osm_id)),
    nodeRemap: prepared.nodeRemap,
    wayRemap: prepared.wayRemap,
    wayApproachNodes: prepared.roads.reduce((index, road) => {
      const nodes = index.get(road.properties.osm_id) ?? {
        forward: new Set<number>(), backward: new Set<number>(),
      }
      nodes.forward.add(road.properties.nodes.at(-1)!)
      if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
      index.set(road.properties.osm_id, nodes)
      return index
    }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
  })
  conflicts.push(...remapped.errors)
  const index = buildLaneBaseIndex(remapped.records)
  conflicts.push(...index.movementRuleErrors)

  const applyReport = applyLaneBaseToRoads(prepared.roads, index)
  const laneProfileSourceKeys = new Set(remapped.records
    .filter((record) => record.laneCount !== undefined ||
      record.laneMovements !== undefined || record.motorcycleAccessByLane !== undefined)
    .map((record) => record.sourceKey))
  const movementRuleSourceKeys = new Set(remapped.records
    .filter((record) => record.movementRules.length > 0)
    .map((record) => record.sourceKey))
  const unappliedLaneSourceKeys = applyReport.unresolvedSourceKeys
    .filter((sourceKey) => laneProfileSourceKeys.has(sourceKey))

  try {
    const journal = (candidate.editor?.journal ?? []) as EnhancementRecord[]
    const nonLanePilot = journal.filter((record) => record.author !== 'lanepilot')
    if (nonLanePilot.length !== journal.length) {
      replayErrors.push('candidate editor still contains author=lanepilot journal records')
    }
    const folded = foldJournal(nonLanePilot)
    const roadsAll = [
      ...prepared.roads,
      ...newRoadsFromFolded(folded, prepared.nodeRemap),
    ]
    applyToRoads(roadsAll, folded)
    const mergeViews = buildRoadMergeViews(
      roadsAll.filter((road) => !road.properties.deleted),
      nonLanePilot,
    )
    for (const row of mergeViews.rows) {
      if (!row.resolved) replayErrors.push(`${row.mergeKey}: ${row.detail}`)
    }
  } catch (error) {
    replayErrors.push(error instanceof Error ? error.message : String(error))
  }

  return buildLaneBaseCandidateAudit({
    candidateSha256,
    sourceAnnotations: annotations.length,
    accountedSourceKeys: extraction.accountedSourceKeys,
    remappedSourceKeys: new Set(remapped.records.flatMap((record) =>
      record.sourceKeys ?? [record.sourceKey])),
    laneProfileSourceKeys,
    movementRuleSourceKeys,
    retiredSourceKeys: [
      ...extraction.ignoredSourceKeys,
      ...remapped.retiredSourceKeys,
    ],
    explicitUnmappedSourceKeys: remapped.unmappedSourceKeys,
    conflicts,
    expectedHumanEditorSha256: buildReport.preserved_editor_sha256,
    candidateHumanEditorSha256: stableJsonHash(candidate.editor),
    replayErrors,
    unappliedLaneSourceKeys,
  })
}

export function main(args = process.argv.slice(2)): number {
  const root = process.cwd()
  const candidatePath = resolve(
    argumentValue('--candidate', args) ?? '.lanedev-backups/road_database.candidate.json',
  )
  const buildReportPath = resolve(
    argumentValue('--build-report', args) ?? `${candidatePath}.dedup-report.json`,
  )
  const outputPath = resolve(
    argumentValue('--out', args) ?? '.lanedev-backups/road_database.candidate.audit.json',
  )
  const audit = auditLaneBaseCandidate({ candidatePath, buildReportPath })
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...audit, output: outputPath, root }, null, 2))
  return laneBaseAuditExitCode(audit)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && !process.argv.includes('--test-mode')) process.exitCode = main()
