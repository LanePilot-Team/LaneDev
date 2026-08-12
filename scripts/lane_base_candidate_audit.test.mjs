import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLaneBaseCandidateAudit,
  laneBaseAuditExitCode,
} from './lane_base_candidate_audit.ts'

const baseFacts = (overrides = {}) => ({
  candidateSha256: 'candidate-hash',
  sourceAnnotations: 1,
  accountedSourceKeys: ['way/1#0'],
  remappedSourceKeys: ['way/1#0'],
  laneProfileSourceKeys: ['way/1#0'],
  movementRuleSourceKeys: [],
  expectedHumanEditorSha256: 'editor-hash',
  candidateHumanEditorSha256: 'editor-hash',
  ...overrides,
})

test('one unmapped approach blocks the audit and exits with code 2', () => {
  const audit = buildLaneBaseCandidateAudit(baseFacts({
    remappedSourceKeys: [],
    explicitUnmappedSourceKeys: ['way/1#0'],
  }))

  assert.equal(audit.source_annotations, 1)
  assert.equal(audit.accounted_annotations, 0)
  assert.deepEqual(audit.unmapped, ['way/1#0'])
  assert.equal(audit.blocking_errors.length, 1)
  assert.equal(audit.blocking_errors[0].type, 'unmapped_annotation')
  assert.equal(laneBaseAuditExitCode(audit), 2)
})

test('a mapped movement-only record counts as accounted and passes', () => {
  const audit = buildLaneBaseCandidateAudit(baseFacts({
    laneProfileSourceKeys: [],
    movementRuleSourceKeys: ['way/1#0'],
  }))

  assert.equal(audit.accounted_annotations, 1)
  assert.equal(audit.lane_profiles, 0)
  assert.equal(audit.movement_rule_records, 1)
  assert.deepEqual(audit.blocking_errors, [])
  assert.equal(laneBaseAuditExitCode(audit), 0)
})

test('changing one human editor field blocks promotion', () => {
  const audit = buildLaneBaseCandidateAudit(baseFacts({
    candidateHumanEditorSha256: 'changed-editor-hash',
  }))

  assert.equal(audit.human_editor_hash_match, false)
  assert.equal(audit.blocking_errors.length, 1)
  assert.equal(audit.blocking_errors[0].type, 'human_editor_hash_mismatch')
  assert.equal(laneBaseAuditExitCode(audit), 2)
})
