import test from 'node:test'
import assert from 'node:assert/strict'
import * as enhancements from './enhancements.ts'
import { humanWaitingZones } from './zoneimport.ts'

const zone = (id, extra = {}) => ({
  id, intersectionId: 99, center: [120, 22], bearing: 90, w: 5, d: 2.5,
  from: { name: 'from', bearing: 12 }, to: { name: 'to', bearing: 280 }, ...extra,
})

test('enhancement export and persistence exclude unchanged Lane Base derived zones', () => {
  assert.equal(typeof enhancements.buildEnhancementPayload, 'function')
  const base = zone('zone-lp-derived')
  const human = zone('zone-human', { center: [120.1, 22.1] })
  const visible = [base, human]

  assert.deepEqual(humanWaitingZones([base], visible), [human])
  const payload = enhancements.buildEnhancementPayload(
    [], visible, [], [], [], 'review-test', [base],
  )
  assert.deepEqual(payload.waiting_zones.map((item) => ({
    id: item.id, source: item.source,
  })), [{ id: 'zone-human', source: 'manual' }])
})
