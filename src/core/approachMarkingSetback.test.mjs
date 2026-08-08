import test from 'node:test'
import assert from 'node:assert/strict'
import { applyManualApproachMarkingSetback } from './turnbays.ts'

const edge = (osmId, blockNode, back = false, endSetbackM = 15.6) => ({
  road: { properties: { osm_id: osmId, blockNode } },
  back,
  endSetbackM,
})

test('moves only the eastbound markings of way/383563022@b/313349834', () => {
  const target = edge(383563022, 313349834)
  const adjusted = applyManualApproachMarkingSetback(target)

  assert.notEqual(adjusted, target)
  assert.equal(adjusted.endSetbackM, 24.55)
  assert.equal(applyManualApproachMarkingSetback(edge(383563022, 313349834, true)).endSetbackM, 15.6)
  assert.equal(applyManualApproachMarkingSetback(edge(383563022, 999)).endSetbackM, 15.6)
  assert.equal(applyManualApproachMarkingSetback(edge(271982148, 1196964834)).endSetbackM, 15.6)
})

test('never advances a marking that already has a larger setback', () => {
  assert.equal(applyManualApproachMarkingSetback(
    edge(383563022, 313349834, false, 30),
  ).endSetbackM, 30)
})
