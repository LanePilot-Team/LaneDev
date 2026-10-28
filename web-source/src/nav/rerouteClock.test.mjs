import test from 'node:test'
import assert from 'node:assert/strict'
import { noteRerouteFinished, rerouteReady } from './rerouteClock.ts'

test('fresh clock allows the first reroute and fast searches keep the 5s floor', () => {
  const clock = { lastTs: 0 }
  assert.equal(rerouteReady(clock, Date.now()), true)
  noteRerouteFinished(clock, 300, 10000)
  assert.equal(clock.cooldownMs, 5000)
  assert.equal(rerouteReady(clock, 14000), false)
  assert.equal(rerouteReady(clock, 15001), true)
})

test('slow searches stretch the cooldown so the main thread is mostly free', () => {
  const clock = { lastTs: 0 }
  noteRerouteFinished(clock, 3000, 10000)
  assert.equal(clock.cooldownMs, 12000)
})

test('consecutive reroutes without returning to the route back off up to 30s', () => {
  const clock = { lastTs: 0 }
  const cooldowns = []
  for (let i = 0; i < 6; i++) {
    noteRerouteFinished(clock, 1000, 10000 * (i + 1))
    cooldowns.push(clock.cooldownMs)
  }
  assert.deepEqual(cooldowns, [5000, 10000, 20000, 30000, 30000, 30000])
  clock.streak = 0 // GpsDriver 在線上撐過冷卻後歸零
  noteRerouteFinished(clock, 1000, 100000)
  assert.equal(clock.cooldownMs, 5000)
})
