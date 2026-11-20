import { nativeCommand } from '../native/client.ts'
import { nativeRequestId } from '../native/platform.ts'
import { googleCoordinateDestination, type DestinationSelection } from './destination.ts'

declare global {
  interface Window { LaneGooglePlacesAvailable?: boolean }
}

export const IOS_GOOGLE_PLACES_UNCONFIGURED = 'Google Places 未設定 iOS 金鑰，本地搜尋仍可使用。'

export function searchNativeGooglePlace(
  query: string, center: [number, number] | undefined, signal: AbortSignal,
): Promise<DestinationSelection | null> {
  if (!window.LaneGooglePlacesAvailable) return Promise.reject(new Error(IOS_GOOGLE_PLACES_UNCONFIGURED))
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = nativeRequestId()
    function cleanup() {
      window.removeEventListener('lane-native', receive)
      signal.removeEventListener('abort', cancel)
    }
    function cancel() {
      cleanup()
      nativeCommand('googlePlaceCancel', { id })
      reject(signal.reason)
    }
    function receive(event: Event) {
      const data = (event as CustomEvent).detail
      if (data?.type !== 'googlePlaceResult' || data.id !== id) return
      cleanup()
      if (data.error) { reject(new Error(data.error)); return }
      if (data.cancelled) { resolve(null); return }
      const result = googleCoordinateDestination(data.placeID, data.longitude, data.latitude, query)
      if (result) resolve(result)
      else reject(new Error('這筆 Google 地點沒有可用的座標。'))
    }
    window.addEventListener('lane-native', receive)
    signal.addEventListener('abort', cancel, { once: true })
    nativeCommand('googlePlaceSearch', { id, query, longitude: center?.[0], latitude: center?.[1] })
  })
}
