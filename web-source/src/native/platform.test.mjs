import test from 'node:test'
import assert from 'node:assert/strict'
import { locationProvider, responseSHA256, nativeRequestId } from './platform.ts'

test('browser provider stays selected unless an explicit native iOS provider is present', () => {
  const browser = { watchPosition() {} }, native = { watchPosition() {} }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: browser } })
  globalThis.window = { LaneGeolocation: native }
  assert.equal(locationProvider(), browser)
  window.LanePlatform = 'ios'
  assert.equal(locationProvider(), native)
  delete window.LaneGeolocation
  assert.equal(locationProvider(), null, 'iOS must not fall back to browser GPS')
  delete globalThis.window
  delete globalThis.navigator
})

test('network/runtime checks compute SHA-256 from bytes rather than trusting a header', async () => {
  const bytes = new TextEncoder().encode('abc').buffer
  const response = new Response(bytes, { headers: { 'X-Lane-SHA256': 'f'.repeat(64) } })
  assert.equal(await responseSHA256(response, bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(nativeRequestId(), nativeRequestId())
})

test('custom origin accepts only native CryptoKit hashes and fails closed elsewhere', async () => {
  const original = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: original.getRandomValues.bind(original) } })
  try {
    globalThis.window = { LanePlatform: 'ios' }
    globalThis.location = { protocol: 'lanedev:', host: 'app' }
    const bytes = new ArrayBuffer(0), response = new Response(bytes, { headers: { 'X-Lane-SHA256': 'a'.repeat(64) } })
    assert.equal(await responseSHA256(response, bytes), 'a'.repeat(64))
    assert.match(nativeRequestId(), /^[0-9a-f]{32}$/)
    location.protocol = 'https:'
    await assert.rejects(responseSHA256(response, bytes), /無法驗證/)
    location.protocol = 'lanedev:'
    await assert.rejects(responseSHA256(new Response(bytes), bytes), /無法驗證/)
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original })
    delete globalThis.window; delete globalThis.location
  }
})
