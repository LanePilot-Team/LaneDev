import test from 'node:test'
import assert from 'node:assert/strict'
import { cumulative } from '../core/geo.ts'
import { Driver, SIMULATION_MULTIPLIERS } from './drive.ts'

const coords = [[120.3, 22.7], [120.32, 22.7]]
const cum = cumulative(coords)
const route = {
  coords,
  cum,
  lengthM: cum.at(-1),
  timeS: cum.at(-1) / 10,
  spans: [{ toIdx: 1, offM: 0, leftM: 0, rightM: 0 }],
  maneuvers: [{ distM: cum.at(-1), kind: 'arrive', lanesForward: 1 }],
  diverges: [],
  weaves: [],
}

test('uses the requested development multipliers and can pause/resume', () => {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  let pending = null
  globalThis.requestAnimationFrame = callback => { pending = callback; return 1 }
  globalThis.cancelAnimationFrame = () => { pending = null }
  try {
    assert.deepEqual(SIMULATION_MULTIPLIERS, [1, 2, 4, 8])
    const states = []
    const driver = new Driver(route, state => states.push(state))
    driver.start()
    const startedAt = performance.now()
    pending(startedAt + 16)
    assert.equal(states.at(-1).speedKmh, 40)

    driver.setMultiplier(4)
    pending(startedAt + 32)
    assert.equal(states.at(-1).speedKmh, 160)

    driver.pause()
    assert.equal(driver.isPaused, true)
    assert.equal(pending, null)
    driver.resume()
    assert.equal(driver.isPaused, false)
    assert.notEqual(pending, null)
  } finally {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  }
})
