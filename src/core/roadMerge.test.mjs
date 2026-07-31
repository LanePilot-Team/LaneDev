import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoadMerges } from './roadMerge.ts'

const coordinate = (node) => [120 + node / 1_000_000, 22]

const road = ({
  osmId, blockNode, nodes, sourceSegments, name = '測試路',
}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: nodes.map(coordinate) },
  properties: {
    osm_id: osmId,
    blockNode,
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    name,
    nodes: [...nodes],
    sourceSegments: sourceSegments ?? [{
      osmId,
      navSegmentKey: `way/${osmId}`,
      splitIndex: 0,
      nodeRefs: [...nodes],
    }],
  },
})

const mergeRecord = ({
  primary = 'way/100@b/1', secondary = 'way/100@b/2',
  secondaryNodes, seq = 1, op = 'set',
} = {}) => ({
  seq,
  ts: `2026-07-31T00:00:0${seq}.000Z`,
  author: 'anna',
  op,
  target: { type: 'road_merge', key: `merge/${primary}+${secondary}` },
  fields: op === 'delete' ? undefined : {
    primary,
    secondary,
    ...(secondaryNodes ? { secondary_nodes: JSON.stringify(secondaryNodes) } : {}),
  },
})

test('精確 block key 可依日誌追溯', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })

  const result = resolveRoadMerges([primary, secondary], [mergeRecord()])

  assert.equal(result.resolved.length, 1)
  assert.equal(result.rows[0].status, 'replayable')
  assert.equal(result.resolved[0].resolvedBy, 'exact')
  assert.equal(result.resolved[0].sourceAuthor, 'anna')
})

test('次段被 couplet drop 後可由 sourceSegments 找回', () => {
  const keep = road({
    osmId: 900,
    blockNode: 1,
    nodes: [1, 2, 3],
    sourceSegments: [
      { osmId: 100, navSegmentKey: 'way/100', splitIndex: 0, nodeRefs: [1, 2] },
      { osmId: 267715892, navSegmentKey: 'way/267715892', splitIndex: 0,
        nodeRefs: [2, 3] },
    ],
  })
  const record = mergeRecord({
    primary: 'way/100@b/1',
    secondary: 'way/267715892@b/2',
    secondaryNodes: [2, 3],
  })

  const result = resolveRoadMerges([keep], [record])

  assert.equal(result.resolved.length, 1)
  assert.equal(result.rows[0].status, 'recoverable_via_provenance')
  assert.equal(result.resolved[0].resolvedBy, 'already-absorbed')
  assert.equal(result.resolved[0].junctionNodeId, 2)
})

test('連鎖捏合依原始時序重播，不用最終快照誤判較早次段', () => {
  const blocks = [
    road({ osmId: 100, blockNode: 1, nodes: [1, 2] }),
    road({ osmId: 100, blockNode: 2, nodes: [2, 3] }),
    road({ osmId: 100, blockNode: 3, nodes: [3, 4] }),
  ]
  const journal = [
    mergeRecord({ primary: 'way/100@b/1', secondary: 'way/100@b/2', seq: 1 }),
    mergeRecord({ primary: 'way/100@b/1', secondary: 'way/100@b/3', seq: 2 }),
  ]

  const result = resolveRoadMerges(blocks, journal)

  assert.deepEqual(result.rows.map((row) => row.status), ['replayable', 'replayable'])
  assert.equal(result.resolved.length, 2)
})

test('delete tombstone 會停用舊捏合但保留日誌原文', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const set = mergeRecord({ seq: 1 })
  const del = mergeRecord({ seq: 2, op: 'delete' })

  const result = resolveRoadMerges([primary, secondary], [set, del])

  assert.equal(result.rows.length, 0)
  assert.equal(result.resolved.length, 0)
  assert.equal(set.op, 'set')
})

test('sourceSegments 找到多個候選時不猜測並列入人工確認', () => {
  const source = {
    osmId: 267715892,
    navSegmentKey: 'way/267715892',
    splitIndex: 0,
    nodeRefs: [2, 3],
  }
  const candidates = [
    road({ osmId: 900, blockNode: 1, nodes: [1, 2], sourceSegments: [source] }),
    road({ osmId: 901, blockNode: 4, nodes: [4, 2], sourceSegments: [source] }),
  ]
  const record = mergeRecord({
    primary: 'way/267715892@b/2',
    secondary: 'way/267715892@b/3',
    secondaryNodes: [2, 3],
  })

  const result = resolveRoadMerges(candidates, [record])

  assert.equal(result.resolved.length, 0)
  assert.equal(result.rows[0].status, 'needs_manual_review')
  assert.match(result.rows[0].detail, /候選不唯一/)
})
