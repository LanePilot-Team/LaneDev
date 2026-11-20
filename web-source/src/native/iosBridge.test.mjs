import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = await readFile(new URL('../../../ios/LaneDev/Bridge.js', import.meta.url), 'utf8')
function bridge() {
  const events = new EventTarget(), messages = [], timers = new Map(), active = new Set()
  let nextTimer = 0, now = 1795000000000
  const window = {
    addEventListener: events.addEventListener.bind(events),
    webkit: { messageHandlers: { LaneNative: { postMessage: message => {
      const command = JSON.parse(message)
      messages.push(command)
      if (command.type === 'locationStart') active.add(command.id)
      if (command.type === 'locationStop') active.delete(command.id)
    } } } },
  }
  window.top = window
  runInNewContext(source, { window, location: { protocol: 'lanedev:', host: 'app' }, crypto,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id), Date: { now: () => now } })
  const emit = detail => events.dispatchEvent(new CustomEvent('lane-native', { detail }))
  const auth = state => emit({ type: 'locationAuthorization', state })
  const fix = (extra = {}) => emit({ type: 'position', ids: [...active], timestamp: ++now,
    coords: { longitude: 120.2758, latitude: 22.7327, accuracy: 6, speed: 8, heading: 90 }, ...extra })
  const error = (code, reason, recoverable = false) =>
    emit({ type: 'positionError', ids: [...active], code, reason, message: reason, recoverable })
  auth('full')
  return { geo: window.LaneGeolocation, messages, timers, active, emit, auth, fix, error, events, now: () => now }
}

test('iOS adapter shares fixes across one-shot and navigation watches and stops only completed requests', () => {
  const b = bridge(), points = []
  b.geo.getCurrentPosition(p => points.push(p), assert.fail, { timeout: 15000 })
  const watch = b.geo.watchPosition(p => points.push(p), assert.fail, { timeout: 15000 })
  const [once, stream] = b.active
  b.fix()
  assert.equal(points.length, 2)
  assert.equal(points[0].coords.speed, 8)
  assert.equal(points[0].coords.heading, 90)
  assert.equal(points[0].timestamp, b.now())
  assert.deepEqual([...b.active], [stream])
  assert.deepEqual(b.messages.at(-1), { type: 'locationStop', id: once })
  b.fix()
  assert.equal(points.length, 3)
  b.geo.clearWatch(watch)
  b.fix()
  assert.equal(points.length, 3)
  assert.equal(b.timers.size, 0)
})

test('iOS adapter rejects stale, future, invalid, repeated and background fixes before resuming', () => {
  const b = bridge(), points = [], errors = []
  b.geo.watchPosition(p => points.push(p), e => errors.push(e), { timeout: 15000 })
  b.fix({ timestamp: b.now() - 60000 })
  b.fix({ timestamp: b.now() + 10000 })
  b.fix({ coords: { longitude: 500, latitude: 22, accuracy: 6 } })
  b.fix({ coords: { longitude: 120, latitude: 22, accuracy: -1 } })
  assert.equal(points.length, 0)
  b.fix()
  b.fix({ timestamp: points[0].timestamp })
  assert.equal(points.length, 1)
  b.emit({ type: 'lifecycle', active: false })
  assert.equal(errors.at(-1).reason, 'paused')
  assert.equal(b.timers.size, 0)
  b.fix()
  assert.equal(points.length, 1)
  b.emit({ type: 'lifecycle', active: true })
  assert.equal(b.timers.size, 1)
  b.fix({ timestamp: b.now() - 1 })
  assert.equal(points.length, 1)
  b.fix()
  assert.equal(points.length, 2)
})

test('iOS adapter scopes delayed errors and fixes across cancellation, pagehide, and new documents', () => {
  const previous = bridge(), next = bridge(), points = []
  const cancel = previous.geo.getCurrentPosition(assert.fail, assert.fail, { timeout: 100 })
  const [cancelled] = previous.active
  cancel()
  previous.geo.watchPosition(assert.fail, assert.fail, { timeout: 100 })
  const [oldWatch] = previous.active
  previous.events.dispatchEvent(new Event('pagehide'))
  assert.equal(previous.active.size, 0)
  assert.equal(previous.timers.size, 0)
  next.geo.watchPosition(p => points.push(p), assert.fail, { timeout: 100 })
  assert.notEqual([...next.active][0], oldWatch)
  next.fix({ ids: [cancelled, oldWatch] })
  next.emit({ type: 'positionError', ids: [cancelled, oldWatch], code: 1 })
  assert.equal(points.length, 0)
  next.fix()
  assert.equal(points.length, 1)
})

test('authorization loss fails one-shot requests and suspends navigation until precise fix recovery', () => {
  const b = bridge(), points = [], errors = [], once = []
  b.geo.watchPosition(p => points.push(p), e => errors.push(e), { timeout: 15000 })
  b.geo.getCurrentPosition(assert.fail, e => once.push(e), { timeout: 15000 })
  b.auth('reduced')
  b.error(1, 'reduced', true)
  assert.equal(b.geo.getAuthorization(), 'reduced')
  assert.equal(once[0].reason, 'reduced')
  assert.equal(b.active.size, 1)
  assert.equal(b.timers.size, 0)
  b.auth('servicesDisabled')
  b.error(1, 'servicesDisabled', true)
  b.fix()
  assert.equal(points.length, 0)
  assert.deepEqual(errors.map(e => e.reason), ['reduced', 'servicesDisabled'])
  b.auth('full')
  assert.equal(b.timers.size, 1)
  b.fix()
  assert.equal(points.length, 1)
})

test('one-shot timeout clears native watcher and returns browser-compatible code', () => {
  const b = bridge(), errors = []
  b.geo.getCurrentPosition(assert.fail, e => errors.push(e), { timeout: 1 })
  for (const fn of [...b.timers.values()]) fn()
  assert.equal(errors[0].code, 3)
  assert.equal(b.messages.at(-1).type, 'locationStop')
  assert.equal(b.timers.size, 0)
})
