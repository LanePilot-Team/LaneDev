import test from 'node:test'
import assert from 'node:assert/strict'
import * as importmap from './importmap.ts'
import { extractLaneBase } from './laneBase.ts'

const context = (navContextKey, nodeId) => ({
  object_identity: {
    schema_version: 2, object_type: 'nav_context_annotation',
    nav_context_key: navContextKey, nav_segment_key: 'way/10', split_index: 0,
    source_osm: { osm_id: 10 }, context_scope: 'intersection_approach',
    applies_to_intersection_key: `node/${nodeId}`, approach_direction: 'forward',
  },
  lane_nav_tags: {
    lane_detail_tags: { lane_profiles: [{ direction: 'forward', lane_count: 2 }] },
    taiwan_motorcycle_tags: { movement_rules: [] },
  },
})

test('session import preserves nav_context_key for same-way same-split contexts in any order', () => {
  assert.equal(typeof importmap.toLaneBaseAnnotationInput, 'function')
  const first = context('way/10@node/99/forward', 99)
  const second = context('way/10@node/100/forward', 100)
  const sourceKeys = (records) => {
    const parsed = importmap.parseImported(records.map((record) => JSON.stringify(record)).join('\n'))
    assert.equal(parsed.kind, 'annotations')
    const extraction = extractLaneBase(importmap.toLaneBaseAnnotationInput(parsed.records))
    assert.deepEqual(extraction.errors, [])
    return extraction.records.map((record) => record.sourceKey).sort()
  }

  const expected = ['way/10@node/100/forward', 'way/10@node/99/forward'].sort()
  assert.deepEqual(sourceKeys([first, second]), expected)
  assert.deepEqual(sourceKeys([second, first]), expected)
})
