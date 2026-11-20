import { useSyncExternalStore } from 'react'
import { nativeRequestId } from './platform.ts'

declare global {
  interface Window { LaneNative?: { postMessage(message: string): void } }
}

export function nativeCommand(type: string, values: Record<string, unknown> = {}) {
  window.LaneNative?.postMessage(JSON.stringify({ type, ...values }))
}
function stored(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
export function validZoom(value: number) {
  return Number.isFinite(value) ? Math.max(16, Math.min(22, value)) : 20
}
let state = {
  voice: stored('client.voice', 'true') !== 'false',
  zoom: validZoom(Number(stored('client.zoom', '20'))),
  tts: '正在檢查語音服務…',
  ttsReady: false,
  speech: '尚未播放',
  audio: '',
  location: '定位尚未授權',
  heading: null as number | null,
  headingAt: 0,
  compass: '正在檢查方向感測器…',
}
const listeners = new Set<() => void>()
function publish(patch: Partial<typeof state>) {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
}
export function clientState() { return state }
export function subscribeClientState(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function useClientState() {
  return useSyncExternalStore(subscribeClientState, clientState)
}
/**
 * 只訂閱單一欄位：羅盤每 200ms 推一次方向，訂閱整包狀態的元件（導航 HUD）會跟著每秒重繪 5 次。
 * selector 必須回傳原始值或穩定參考。
 */
export function useClientValue<T>(select: (s: typeof state) => T): T {
  return useSyncExternalStore(subscribeClientState, () => select(state))
}
export function setVoice(voice: boolean) {
  publish({ voice })
  try { localStorage.setItem('client.voice', String(voice)) } catch { /* preference only */ }
  if (!voice) stopSpeech()
}
export function setZoom(value: number) {
  const zoom = validZoom(value)
  publish({ zoom })
  try { localStorage.setItem('client.zoom', String(zoom)) } catch { /* preference only */ }
  window.dispatchEvent(new CustomEvent('navigation-zoom', { detail: zoom }))
}
export function speak(text: string, priority = false) {
  if (!state.voice) return
  // Navigation and speed camera speech share the native speech queue.
  nativeCommand('speak', window.LanePlatform === 'ios' ? { text, priority, issuedAt: Date.now() } : { text, priority })
}
export function stopSpeech() { nativeCommand('stopSpeech') }
export function deviceHeading() {
  return Date.now() - state.headingAt < 3000 ? state.heading : null
}
if (typeof window !== 'undefined') window.addEventListener('lane-native', ((event: CustomEvent) => {
  const data = event.detail
  if (data.type === 'status') publish({ tts: data.tts, ttsReady: Boolean(data.ttsReady), speech: data.speech || '', audio: data.audio || '', location: data.location, compass: data.compass })
  if (data.type === 'heading') publish({
    heading: typeof data.value === 'number' && Number.isFinite(data.value) ? data.value : null,
    headingAt: Date.now(),
  })
}) as EventListener)

export function ensureLocation(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (typeof window === 'undefined' || !window.LaneNative) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const id = nativeRequestId()
    const timeout = window.setTimeout(() => cancel(new Error('定位授權逾時，請重試')), 60000)
    function cleanup() {
      clearTimeout(timeout)
      window.removeEventListener('lane-native', handle)
      signal?.removeEventListener('abort', abort)
    }
    function cancel(error: unknown) {
      cleanup()
      if (window.LanePlatform === 'ios') nativeCommand('locationPermissionCancel', { id })
      reject(error)
    }
    function abort() { cancel(signal?.reason) }
    function handle(event: Event) {
      const data = (event as CustomEvent).detail
      if (data?.type !== 'locationResult' || data.id !== id) return
      cleanup()
      if (data.error) reject(new Error(data.error)); else resolve()
    }
    window.addEventListener('lane-native', handle)
    signal?.addEventListener('abort', abort, { once: true })
    nativeCommand('requestLocation', { id })
  })
}
