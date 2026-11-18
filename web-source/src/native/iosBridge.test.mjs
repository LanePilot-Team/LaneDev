import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = await readFile(new URL('../../../ios/LaneDev/Bridge.js', import.meta.url), 'utf8')
function bridge() {
  const events = new EventTarget(), messages = [], timers = new Map()
  let nextTimer = 0
  const window = {
    addEventListener: events.addEventListener.bind(events),
    webkit: { messageHandlers: { LaneNative: { postMessage: message => messages.push(JSON.parse(message)) } } },
  }
  window.top = window
  runInNewContext(source, { window, location: { protocol: 'lanedev:', host: 'app' },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id), Date, Number, Map, Object, Infinity })
  const emit = detail => events.dispatchEvent(new CustomEvent('lane-native', { detail }))
  const fix = (extra = {}) => emit({ type: 'position', timestamp: Date.now(),
    coords: { longitude: 120.2758, latitude: 22.7327, accuracy: 6, speed: 8, heading: 90 }, ...extra })
  return { geo: window.LaneGeolocation, messages, timers, emit, fix }
}

test('iOS adapter shares fixes across one-shot and navigation watches and stops only completed requests', () => {
  const b = bridge(), points = []
  b.geo.getCurrentPosition(p => points.push(p), assert.fail, { timeout: 15000 })
  const watch = b.geo.watchPosition(p => points.push(p), assert.fail, { timeout: 15000 })
  b.fix()
  assert.equal(points.length, 2)
  assert.equal(b.messages.filter(m => m.type === 'locationStart').length, 2)
  assert.deepEqual(b.messages.filter(m => m.type === 'locationStop').map(m => m.id), [1])
  b.fix()
  assert.equal(points.length, 3)
  b.geo.clearWatch(watch)
  b.fix()
  assert.equal(points.length, 3)
  assert.equal(b.timers.size, 0)
})

test('iOS adapter rejects stale, invalid and background fixes; resumes only with fresh foreground fixes', () => {
  const b = bridge(), points = []
  b.geo.watchPosition(p => points.push(p), assert.fail, { timeout: 15000 })
  b.fix({ timestamp: Date.now() - 60000 })
  b.fix({ coords: { longitude: 500, latitude: 22, accuracy: 6 } })
  b.fix({ coords: { longitude: 120, latitude: 22, accuracy: -1 } })
  assert.equal(points.length, 0)
  b.emit({ type: 'lifecycle', active: false })
  assert.equal(b.timers.size, 0)
  b.fix()
  assert.equal(points.length, 0)
  b.emit({ type: 'lifecycle', active: true })
  assert.equal(b.timers.size, 1)
  b.fix()
  assert.equal(points.length, 1)
})

test('iOS permission denial clears subscriptions while GPS timeout remains retryable', () => {
  const b = bridge(), errors = []
  b.geo.watchPosition(assert.fail, e => errors.push(e), { timeout: 15000 })
  b.emit({ type: 'positionError', code: 2, message: 'GPS unavailable' })
  assert.equal(errors.at(-1).code, 2)
  assert.equal(b.messages.filter(m => m.type === 'locationStop').length, 0)
  b.emit({ type: 'positionError', code: 1, message: 'denied' })
  assert.equal(errors.at(-1).code, 1)
  assert.equal(b.messages.at(-1).type, 'locationStop')
  assert.equal(b.timers.size, 0)
})

test('one-shot timeout clears native watcher and returns browser-compatible code', () => {
  const b = bridge(), errors = []
  b.geo.getCurrentPosition(assert.fail, e => errors.push(e), { timeout: 1 })
  for (const fn of [...b.timers.values()]) fn()
  assert.equal(errors[0].code, 3)
  assert.equal(b.messages.at(-1).type, 'locationStop')
  assert.equal(b.timers.size, 0)
})
