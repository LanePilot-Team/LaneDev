export type LocationAuthorization = 'checking' | 'notDetermined' | 'denied' | 'restricted' | 'reduced' | 'full' | 'servicesDisabled'

export interface LocationSource extends Pick<Geolocation, 'watchPosition' | 'clearWatch'> {
  getCurrentPosition(...args: Parameters<Geolocation['getCurrentPosition']>): void | (() => void)
  getAuthorization?(): LocationAuthorization
}

/** Native iOS supplies one source; Android/browser keeps its provider. */
declare global {
  interface Window {
    LanePlatform?: 'ios'
    LaneGeolocation?: LocationSource
    // Temporary iOS Simulator Debug hook. Delete at the physical-iPhone milestone.
    LaneSimulator?: {
      prepare(coords: [number, number][]): void
      planStatus(ready: boolean, picking: boolean): void
      noteReroute(): void
      arrive(): void
      timing(wallTimestamp: number): { motionTimestamp: number; playbackRate: 1 | 3 | 8 } | undefined
    }
  }
}

export function locationProvider(): LocationSource | null {
  if (typeof window !== 'undefined' && window.LanePlatform === 'ios') {
    return window.LaneGeolocation ?? null
  }
  return typeof navigator !== 'undefined' && 'geolocation' in navigator ? navigator.geolocation : null
}

// WKWebView custom origins have getRandomValues but may lack randomUUID.
export function nativeRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
}

export async function responseSHA256(response: Response, bytes: ArrayBuffer): Promise<string> {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
  }
  // Only the read-only iOS bundle handler generates this header, from the response bytes.
  // It uses CryptoKit; ordinary network responses must still use WebCrypto.
  const hash = response.headers.get('X-Lane-SHA256')
  if (typeof window !== 'undefined' && window.LanePlatform === 'ios'
    && location.protocol === 'lanedev:' && location.host === 'app'
    && /^[a-f0-9]{64}$/.test(hash ?? '')) return hash!
  throw new Error('此環境無法驗證導航資料')
}
