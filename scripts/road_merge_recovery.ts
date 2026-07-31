import {
  resolveRoadMerges, type RoadMergeReplayRow,
} from '../src/core/roadMerge.ts'
import type { EnhancementRecord } from '../src/core/enhancements'
import type { RoadFeature } from '../src/core/roads'

type ReplayStatus = RoadMergeReplayRow['status']
type MigrationOutcome = 'upgraded' | 'rolled_back' | 'already_v2'

export interface RoadMergeOutcomeRow {
  mergeKey: string
  roadName: string
  sourceSeq: number
  status: ReplayStatus
  outcome: MigrationOutcome
  detail: string
  primaryKey: string
  secondaryKey: string
}

export interface RoadMergeRecoveryReport {
  format: 'lanedev-road-merge-recovery-v3'
  generatedAt: string
  databasePath: string
  totals: Record<ReplayStatus, number>
  rows: RoadMergeReplayRow[]
  outcomes: {
    upgraded: RoadMergeOutcomeRow[]
    rolledBack: RoadMergeOutcomeRow[]
    alreadyV2: RoadMergeOutcomeRow[]
  }
  migrationCandidates: EnhancementRecord[]
}

export interface RoadMergeRecoveryReportRow {
  mergeKey: string
  primaryKey: string
  secondaryKey: string
  status: ReplayStatus
  detail: string
  resolved?: {
    junctionNodeId: number
    primaryBlockKey: string
    secondaryBlockKey: string
    resolvedBy: string
    sourceSeq?: number
    sourceTs?: string
    sourceAuthor?: string
  }
}

export interface RoadMergeReviewReport {
  format: RoadMergeRecoveryReport['format']
  generatedAt: string
  databasePath: string
  sourceCommit: string
  sourceDatabaseSha256: string
  outputDatabaseSha256?: string
  summary: {
    total: number
    upgraded: number
    rolledBack: number
    alreadyV2: number
  }
  totals: Record<ReplayStatus, number>
  upgraded: RoadMergeOutcomeRow[]
  rolledBack: RoadMergeOutcomeRow[]
  alreadyV2: RoadMergeOutcomeRow[]
  rows: RoadMergeRecoveryReportRow[]
  migrationCandidateCount: number
}

const blockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

const compactRow = (row: RoadMergeReplayRow): RoadMergeRecoveryReportRow => ({
  mergeKey: row.mergeKey,
  primaryKey: row.primaryKey,
  secondaryKey: row.secondaryKey,
  status: row.status,
  detail: row.detail,
  ...(row.resolved ? {
    resolved: {
      junctionNodeId: row.resolved.junctionNodeId,
      primaryBlockKey: blockKey(row.resolved.primary),
      secondaryBlockKey: blockKey(row.resolved.secondary),
      resolvedBy: row.resolved.resolvedBy,
      sourceSeq: row.resolved.sourceSeq,
      sourceTs: row.resolved.sourceTs,
      sourceAuthor: row.resolved.sourceAuthor,
    },
  } : {}),
})

export function buildReviewReport(
  report: RoadMergeRecoveryReport,
  sourceDatabaseSha256: string,
  sourceCommit = '',
): RoadMergeReviewReport {
  return {
    format: report.format,
    generatedAt: report.generatedAt,
    databasePath: report.databasePath,
    sourceCommit,
    sourceDatabaseSha256,
    summary: {
      total: report.rows.length,
      upgraded: report.outcomes.upgraded.length,
      rolledBack: report.outcomes.rolledBack.length,
      alreadyV2: report.outcomes.alreadyV2.length,
    },
    totals: report.totals,
    upgraded: report.outcomes.upgraded,
    rolledBack: report.outcomes.rolledBack,
    alreadyV2: report.outcomes.alreadyV2,
    rows: report.rows.map(compactRow),
    migrationCandidateCount: report.migrationCandidates.length,
  }
}

export const reviewRowsSignature = (rows: RoadMergeRecoveryReportRow[]) =>
  JSON.stringify(rows.map((row) => [
    row.mergeKey, row.primaryKey, row.secondaryKey, row.status, row.detail,
    row.resolved?.junctionNodeId,
    row.resolved?.primaryBlockKey,
    row.resolved?.secondaryBlockKey,
    row.resolved?.resolvedBy,
  ]))

const sourceSnapshot = (road: RoadFeature) => JSON.stringify({
  osmId: road.properties.osm_id,
  navSegmentKey: road.properties.navSegmentKey,
  splitIndex: road.properties.splitIndex,
  blockNode: road.properties.blockNode,
  nodeRefs: road.properties.nodes,
  sourceSegments: road.properties.sourceSegments,
})

export function buildMigrationCandidate(
  row: RoadMergeReplayRow,
  startSeq = 0,
  generatedAt = new Date().toISOString(),
  sourceSeq = row.resolved?.sourceSeq ?? 0,
): EnhancementRecord[] {
  const author = 'road-merge-recovery-v2'
  const tombstone: EnhancementRecord = {
    seq: startSeq + 1,
    ts: generatedAt,
    author,
    op: 'delete',
    target: { type: 'road_merge', key: row.mergeKey },
    fields: { supersedes_seq: sourceSeq },
  }
  const resolved = row.resolved
  if (!resolved) return [tombstone]
  return [
    tombstone,
    {
      seq: startSeq + 2,
      ts: generatedAt,
      author,
      op: 'set',
      target: { type: 'road_merge', key: row.mergeKey },
      fields: {
        schema_version: 2,
        primary: row.primaryKey,
        secondary: row.secondaryKey,
        junction_node: resolved.junctionNodeId,
        primary_source: sourceSnapshot(resolved.primary),
        secondary_source: sourceSnapshot(resolved.secondary),
        secondary_nodes: JSON.stringify(resolved.secondary.properties.nodes),
        supersedes_merge_key: row.mergeKey,
        supersedes_seq: sourceSeq,
      },
    },
  ]
}

const activeRoadMergeRecords = (journal: EnhancementRecord[]) => {
  const active = new Map<string, EnhancementRecord>()
  for (const record of journal) {
    if (record.target?.type !== 'road_merge') continue
    if (record.op === 'delete') active.delete(record.target.key)
    else if (record.op === 'set') active.set(record.target.key, record)
  }
  return active
}

const roadNameFor = (row: RoadMergeReplayRow, roads: RoadFeature[]) => {
  const exact = roads.find((road) =>
    blockKey(road) === row.primaryKey || blockKey(road) === row.secondaryKey)
  const sourceWayIds = [row.primaryKey, row.secondaryKey]
    .map((key) => Number(key.match(/^way\/(\d+)/)?.[1]))
    .filter(Number.isFinite)
  const provenance = roads.find((road) => road.properties.sourceSegments?.some(
    (source) => sourceWayIds.includes(source.osmId),
  ))
  return row.resolved?.primary.properties.name
    ?? exact?.properties.name
    ?? provenance?.properties.name
    ?? row.primaryKey
}

export function buildRecoveryReport(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
  databasePath: string,
  generatedAt = new Date().toISOString(),
): RoadMergeRecoveryReport {
  const { rows } = resolveRoadMerges(roads, journal)
  const totals: Record<ReplayStatus, number> = {
    replayable: 0,
    recoverable_via_provenance: 0,
    needs_manual_review: 0,
    legacy_destructive: 0,
    invalid: 0,
  }
  rows.forEach((row) => { totals[row.status]++ })

  const active = activeRoadMergeRecords(journal)
  const outcomes: RoadMergeRecoveryReport['outcomes'] = {
    upgraded: [], rolledBack: [], alreadyV2: [],
  }
  let nextSeq = journal.reduce((max, record) => Math.max(max, record.seq), 0)
  const migrationCandidates: EnhancementRecord[] = []

  for (const row of rows) {
    const sourceRecord = active.get(row.mergeKey)
    const sourceSeq = sourceRecord?.seq ?? row.resolved?.sourceSeq ?? 0
    const isV2 = Number(sourceRecord?.fields?.schema_version) === 2
    const safe = !!row.resolved
      && (row.status === 'replayable' || row.status === 'recoverable_via_provenance')
    const outcome: MigrationOutcome = isV2 ? 'already_v2' : safe ? 'upgraded' : 'rolled_back'
    const outcomeRow: RoadMergeOutcomeRow = {
      mergeKey: row.mergeKey,
      roadName: roadNameFor(row, roads),
      sourceSeq,
      status: row.status,
      outcome,
      detail: isV2 ? '已是 schema v2，不重複遷移' : row.detail,
      primaryKey: row.primaryKey,
      secondaryKey: row.secondaryKey,
    }
    if (outcome === 'already_v2') {
      outcomes.alreadyV2.push(outcomeRow)
      continue
    }
    if (outcome === 'upgraded') outcomes.upgraded.push(outcomeRow)
    else outcomes.rolledBack.push(outcomeRow)
    const records = buildMigrationCandidate(row, nextSeq, generatedAt, sourceSeq)
    migrationCandidates.push(...records)
    nextSeq += records.length
  }

  return {
    format: 'lanedev-road-merge-recovery-v3',
    generatedAt,
    databasePath,
    totals,
    rows,
    outcomes,
    migrationCandidates,
  }
}
