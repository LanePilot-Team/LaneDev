import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractLaneGuidance, writeLaneGuidance } from './build_lane_guidance.mjs'

const line = (identity, profile) => JSON.stringify({
  object_identity: identity,
  lane_nav_tags: { lane_detail_tags: { lane_profiles: [profile] } },
})

test('extracts intersection and segment contexts deterministically', () => {
  const jsonl = [
    line({
      object_type: 'nav_context_annotation',
      nav_segment_key: 'way/20',
      context_scope: 'segment_direction',
      approach_direction: 'backward',
      source_osm: { osm_id: 20 },
    }, {
      direction: 'backward',
      lane_count: 2,
      lane_movements: ['left', 'through'],
    }),
    line({
      object_type: 'nav_context_annotation',
      nav_segment_key: 'way/10',
      context_scope: 'intersection_approach',
      applies_to_intersection_key: 'node/99',
      approach_direction: 'forward',
      source_osm: { osm_id: 10 },
    }, {
      direction: 'forward',
      lane_count: 3,
      lane_movements: ['left;through', 'through', 'unknown'],
    }),
  ].join('\n')

  assert.deepEqual(extractLaneGuidance(jsonl), [
    {
      wayId: 10,
      direction: 'forward',
      scope: 'intersection_approach',
      intersectionNodeId: 99,
      laneCount: 3,
      laneMovements: ['left;through', 'through', 'unknown'],
    },
    {
      wayId: 20,
      direction: 'backward',
      scope: 'segment_direction',
      laneCount: 2,
      laneMovements: ['left', 'through'],
    },
  ])
})

test('rejects an approach context without an intersection node', () => {
  const jsonl = line({
    object_type: 'nav_context_annotation',
    nav_segment_key: 'way/10',
    context_scope: 'intersection_approach',
    approach_direction: 'forward',
    source_osm: { osm_id: 10 },
  }, {
    direction: 'forward',
    lane_count: 1,
    lane_movements: ['through'],
  })

  assert.throws(() => extractLaneGuidance(jsonl), /intersection node.*way\/10/i)
})

test('rejects duplicate records that would create an ambiguous key', () => {
  const duplicate = line({
    object_type: 'nav_context_annotation',
    nav_segment_key: 'way/10',
    context_scope: 'intersection_approach',
    applies_to_intersection_key: 'node/99',
    approach_direction: 'forward',
    source_osm: { osm_id: 10 },
  }, {
    direction: 'forward',
    lane_count: 1,
    lane_movements: ['through'],
  })

  assert.throws(
    () => extractLaneGuidance(`${duplicate}\n${duplicate}`),
    /duplicate.*way\/10/i,
  )
})

test('writes compact deterministic JSON with one trailing newline', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lane-guidance-'))
  const inputPath = path.join(directory, 'annotations.jsonl')
  const outputPath = path.join(directory, 'lane-guidance.json')
  writeFileSync(inputPath, line({
    object_type: 'nav_segment_annotation',
    nav_segment_key: 'way/10',
    source_osm: { osm_id: 10 },
  }, {
    direction: 'forward',
    lane_count: 1,
    lane_movements: ['through'],
  }))

  writeLaneGuidance({ inputPath, outputPath })

  const output = readFileSync(outputPath, 'utf8')
  assert.equal(output.endsWith('\n'), true)
  assert.equal(output.slice(0, -1).includes('\n'), false)
})
