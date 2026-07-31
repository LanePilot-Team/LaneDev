import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMigrationCandidate, buildRecoveryReport, buildReviewReport,
} from './road_merge_recovery.ts'

const point = (node) => [120 + node / 100_000, 22]
const road = (osmId, blockNode, nodes, sourceSegments) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: nodes.map(point) },
  properties: {
    osm_id: osmId,
    blockNode,
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    name: '測試路',
    nodes,
    sourceSegments: sourceSegments ?? [{
      osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: nodes,
    }],
  },
})
const record = (primary, secondary, seq) => ({
  seq, ts: `2026-07-31T00:00:0${seq}Z`, author: 'anna', op: 'set',
  target: { type: 'road_merge', key: `merge/${primary}+${secondary}` },
  fields: { primary, secondary },
})

test('復原報告分類逐筆結果且不改輸入 journal', () => {
  const roads = [
    road(100, 1, [1, 2]), road(100, 2, [2, 3]),
    road(200, 10, [10, 11], [
      { osmId: 200, navSegmentKey: 'way/200', splitIndex: 0, nodeRefs: [10, 11] },
      { osmId: 299, navSegmentKey: 'way/299', splitIndex: 0, nodeRefs: [11, 12] },
    ]),
    road(300, 20, [20, 21], [
      { osmId: 399, navSegmentKey: 'way/399', splitIndex: 0, nodeRefs: [21, 22] },
    ]),
    road(301, 30, [30, 21], [
      { osmId: 399, navSegmentKey: 'way/399', splitIndex: 0, nodeRefs: [21, 32] },
    ]),
    road(400, 40, [40, 41]), road(400, 142, [142, 143]),
  ]
  const journal = [
    record('way/100@b/1', 'way/100@b/2', 1),
    record('way/200@b/10', 'way/299@b/11', 2),
    record('way/300@b/20', 'way/399@b/21', 3),
    record('way/400@b/40', 'way/400@b/142', 4),
  ]
  const before = JSON.stringify(journal)

  const report = buildRecoveryReport(roads, journal, 'fixture.json')

  assert.equal(report.totals.replayable, 1)
  assert.equal(report.totals.recoverable_via_provenance, 1)
  assert.equal(report.totals.needs_manual_review, 1)
  assert.equal(report.totals.invalid, 1)
  assert.equal(JSON.stringify(journal), before)
})

test('遷移候選只追加 tombstone 與 V2，不刪舊紀錄', () => {
  const roads = [road(100, 1, [1, 2]), road(100, 2, [2, 3])]
  const journal = [record('way/100@b/1', 'way/100@b/2', 1)]
  const row = buildRecoveryReport(roads, journal, 'fixture.json').rows[0]

  const candidate = buildMigrationCandidate(row, 10, '2026-07-31T00:00:00Z')

  assert.deepEqual(candidate.map((item) => item.op), ['delete', 'set'])
  assert.equal(candidate[1].fields.schema_version, 2)
  assert.equal(candidate[1].fields.supersedes_merge_key, row.mergeKey)
  assert.equal(candidate[0].seq, 11)
  assert.equal(candidate[1].seq, 12)
})

test('審核報告只保留可閱讀摘要，不內嵌道路與遷移候選', () => {
  const roads = [
    road(100, 1, [1, 2]),
    road(100, 2, [2, 3]),
  ]
  const report = buildRecoveryReport(roads, [
    record('way/100@b/1', 'way/100@b/2', 1),
  ], 'fixture.json')

  const review = buildReviewReport(report, 'abc123')
  const serialized = JSON.stringify(review)

  assert.equal(review.sourceDatabaseSha256, 'abc123')
  assert.equal(review.migrationCandidateCount, 2)
  assert.equal(review.rows[0].resolved.primaryBlockKey, 'way/100@b/1')
  assert.equal(serialized.includes('migrationCandidates'), false)
  assert.equal(serialized.includes('coordinates'), false)
})
