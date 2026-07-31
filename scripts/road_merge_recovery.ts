import {
  resolveRoadMerges, type RoadMergeReplayRow,
} from '../src/core/roadMerge.ts'
import type { EnhancementRecord } from '../src/core/enhancements'
import type { RoadFeature } from '../src/core/roads'

type ReplayStatus = RoadMergeReplayRow['status']

export interface RoadMergeRecoveryReport {
  format: 'lanedev-road-merge-recovery-v2'
  generatedAt: string
  databasePath: string
  totals: Record<ReplayStatus, number>
  rows: RoadMergeReplayRow[]
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
  sourceDatabaseSha256: string
  totals: Record<ReplayStatus, number>
  rows: RoadMergeRecoveryReportRow[]
  migrationCandidateCount: number
}

const blockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

export function buildReviewReport(
  report: RoadMergeRecoveryReport,
  sourceDatabaseSha256: string,
): RoadMergeReviewReport {
  return {
    format: report.format,
    generatedAt: report.generatedAt,
    databasePath: report.databasePath,
    sourceDatabaseSha256,
    totals: report.totals,
    rows: report.rows.map((row) => ({
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
    })),
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
): EnhancementRecord[] {
  const resolved = row.resolved
  if (!resolved) return []
  const author = 'road-merge-recovery-v2'
  return [
    {
      seq: startSeq + 1,
      ts: generatedAt,
      author,
      op: 'delete',
      target: { type: 'road_merge', key: row.mergeKey },
      fields: { supersedes_seq: resolved.sourceSeq ?? 0 },
    },
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
      },
    },
  ]
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
  let nextSeq = journal.reduce((max, record) => Math.max(max, record.seq), 0)
  const migrationCandidates: EnhancementRecord[] = []
  for (const row of rows) {
    const records = buildMigrationCandidate(row, nextSeq, generatedAt)
    migrationCandidates.push(...records)
    nextSeq += records.length
  }
  return {
    format: 'lanedev-road-merge-recovery-v2',
    generatedAt,
    databasePath,
    totals,
    rows,
    migrationCandidates,
  }
}
