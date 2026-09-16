import test from 'node:test'
import assert from 'node:assert/strict'

const events = new EventTarget()
const messages = []
globalThis.window = {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  setTimeout, clearTimeout,
  LaneNative: { postMessage: text => messages.push(JSON.parse(text)) },
}
const storage = new Map()
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) }
const client = await import('./client.ts')

test('語音開關會停止正在播放的語音，關閉後不傳送播報', () => {
  messages.length = 0
  client.setVoice(true)
  client.speak('前方一百公尺，請靠最右側車道進入待轉區')
  assert.equal(messages.at(-1).text, '前方一百公尺，請靠最右側車道進入待轉區')
  client.setVoice(false)
  assert.equal(messages.at(-1).type, 'stopSpeech')
  const count = messages.length
  client.speak('不應播放')
  assert.equal(messages.length, count)
})

test('視距限制在有效範圍，與速度無關並保存設定', () => {
  client.setZoom(19)
  assert.equal(client.clientState().zoom, 19)
  assert.equal(storage.get('client.zoom'), '19')
  assert.equal(client.validZoom(NaN), 20)
  assert.equal(client.validZoom(100), 22)
  assert.equal(client.validZoom(0), 16)
})

test('只有相符的定位請求回覆才解鎖 GPS', async () => {
  const waiting = client.ensureLocation()
  const request = messages.at(-1)
  let done = false
  waiting.then(() => { done = true })
  events.dispatchEvent(new CustomEvent('lane-native', { detail: { type: 'locationResult', id: 'wrong' } }))
  await Promise.resolve()
  assert.equal(done, false)
  events.dispatchEvent(new CustomEvent('lane-native', { detail: { type: 'locationResult', id: request.id } }))
  await waiting
  assert.equal(done, true)
})

test('手機 GPS 關閉會回傳可操作的錯誤', async () => {
  const waiting = client.ensureLocation()
  const id = messages.at(-1).id
  events.dispatchEvent(new CustomEvent('lane-native', { detail: { type: 'locationResult', id, error: '手機定位已關閉' } }))
  await assert.rejects(waiting, /手機定位已關閉/)
})

test('不可靠方向不會被當成有效朝向', () => {
  events.dispatchEvent(new CustomEvent('lane-native', { detail: { type: 'heading', value: 123 } }))
  assert.equal(client.deviceHeading(), 123)
  events.dispatchEvent(new CustomEvent('lane-native', { detail: { type: 'heading', value: null } }))
  assert.equal(client.deviceHeading(), null)
})
