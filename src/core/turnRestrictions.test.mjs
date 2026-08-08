import test from 'node:test'
import assert from 'node:assert/strict'
import { profileTurnAllowed } from './turnRestrictions.ts'

const road = (osmId, blockNode) => ({
  properties: { osm_id: osmId, blockNode },
})

const incoming = road(1464614119, 1400036034)
const forbiddenLeft = road(1464614121, 1400036034)
const uturnEntry = road(230071783, 2385998116)

test('楠梓路指定左轉只對機車封鎖', () => {
  assert.equal(profileTurnAllowed(
    'moto', 1400036034, incoming, true, forbiddenLeft, false), false)
  assert.equal(profileTurnAllowed(
    'car', 1400036034, incoming, true, forbiddenLeft, false), true)
})

test('機車仍可使用指定迴轉道及其他轉向', () => {
  assert.equal(profileTurnAllowed(
    'moto', 1400036034, incoming, true, uturnEntry, false), true)
  assert.equal(profileTurnAllowed(
    'moto', 999, incoming, true, forbiddenLeft, false), true)
})

test('機車不可在楠梓路一般分段端點原地折返', () => {
  const ordinaryTurnback = road(268219239, 2264502074)
  assert.equal(profileTurnAllowed(
    'moto', 2264502074, ordinaryTurnback, true, ordinaryTurnback, false), false)
  assert.equal(profileTurnAllowed(
    'car', 2264502074, ordinaryTurnback, true, ordinaryTurnback, false), true)
})
