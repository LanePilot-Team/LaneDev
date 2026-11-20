import test from 'node:test'
import assert from 'node:assert/strict'
import { searchNativeGooglePlace } from './nativeGooglePlaces.ts'

const events = new EventTarget(), sent = []
globalThis.window = {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  LaneNative: { postMessage: text => sent.push(JSON.parse(text)) },
}
function receive(detail) { events.dispatchEvent(new CustomEvent('lane-native', { detail })) }

test('iOS missing key does not send a native search; local UI can remain active', async () => {
  window.LaneGooglePlacesAvailable = false
  await assert.rejects(searchNativeGooglePlace('高雄', undefined, new AbortController().signal), /未設定 iOS 金鑰/)
  assert.equal(sent.length, 0)
})

test('iOS bridge scopes selection replies and keeps only ID, validated coordinates and query', async () => {
  window.LaneGooglePlacesAvailable = true
  const result = searchNativeGooglePlace('  高雄  ', [120, 22], new AbortController().signal)
  const command = sent.at(-1)
  assert.equal(command.type, 'googlePlaceSearch')
  assert.equal(command.longitude, 120)
  receive({ type: 'googlePlaceResult', id: 'old', error: 'old' })
  receive({ type: 'googlePlaceResult', id: command.id, placeID: 'place', longitude: 120, latitude: 22, name: 'extra' })
  assert.deepEqual(await result, { provider: 'google-ui-kit', id: 'place', position: [120, 22], queryLabel: '高雄' })
})

test('cancelling an iOS search dismisses its native sheet and discards late results', async () => {
  window.LaneGooglePlacesAvailable = true
  const controller = new AbortController()
  const result = searchNativeGooglePlace('高雄', undefined, controller.signal)
  const { id } = sent.at(-1)
  controller.abort()
  assert.deepEqual(sent.at(-1), { type: 'googlePlaceCancel', id })
  receive({ type: 'googlePlaceResult', id, longitude: 120, latitude: 22 })
  await assert.rejects(result, { name: 'AbortError' })
})
