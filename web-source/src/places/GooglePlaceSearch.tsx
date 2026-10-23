import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { loadGooglePlacesLibrary } from './googleMapsLoader.ts'

export type GooglePlaceSearchState = 'idle' | 'loading' | 'ready' | 'error'

export interface GooglePlaceSearchHandle {
  /** 使用者明確提交後才呼叫；輸入過程不得自動搜尋。 */
  search: (query: string, center?: [number, number]) => Promise<void>
  reset: () => void
}

export interface GooglePlaceSearchProps {
  visible?: boolean
  selectable?: boolean
  onSelect: (place: google.maps.places.Place, submittedQuery: string) => void
  onStateChange?: (state: GooglePlaceSearchState, message?: string) => void
}

interface ComponentState {
  status: GooglePlaceSearchState
  message?: string
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (/REQUEST_DENIED|not authorized|ApiNotActivated|billing|referer|referrer/i.test(message)) {
    return 'Google Places 請求被拒絕：請確認已啟用 Maps JavaScript API 與 Places API (New)，且 API Key 的限制允許 WebView。'
  }
  if (/could not load|載入器|network|failed to fetch/i.test(message)) {
    return 'Google Maps 載入失敗：請確認手機網路、API Key 與 Maps JavaScript API 設定。'
  }
  return message ? `Google Places 搜尋失敗：${message}` : 'Google Places 暫時無法載入'
}

export const GooglePlaceSearch = forwardRef<
  GooglePlaceSearchHandle,
  GooglePlaceSearchProps
>(function GooglePlaceSearch({
  visible = true,
  selectable = true,
  onSelect,
  onStateChange,
}, forwardedRef) {
  const mountedRef = useRef(false)
  const initializePromiseRef = useRef<Promise<typeof google.maps.places.Place> | null>(null)
  const placeClassRef = useRef<typeof google.maps.places.Place | null>(null)
  const submittedQueryRef = useRef('')
  const onSelectRef = useRef(onSelect)
  const onStateChangeRef = useRef(onStateChange)
  const [places, setPlaces] = useState<google.maps.places.Place[]>([])
  const [componentState, setComponentState] = useState<ComponentState>({ status: 'idle' })

  onSelectRef.current = onSelect
  onStateChangeRef.current = onStateChange

  function updateState(status: GooglePlaceSearchState, message?: string) {
    if (!mountedRef.current) return
    setComponentState({ status, message })
    onStateChangeRef.current?.(status, message)
  }

  async function initialize(): Promise<typeof google.maps.places.Place> {
    if (placeClassRef.current) return placeClassRef.current
    if (initializePromiseRef.current) return initializePromiseRef.current

    initializePromiseRef.current = (async () => {
      const library = await loadGooglePlacesLibrary()
      if (typeof library.Place?.searchByText !== 'function') {
        throw new Error('目前的 Google Maps JavaScript API 不支援 Text Search (New)')
      }
      placeClassRef.current = library.Place
      return library.Place
    })().catch((error: unknown) => {
      initializePromiseRef.current = null
      throw error
    })

    return initializePromiseRef.current
  }

  useImperativeHandle(forwardedRef, () => ({
    async search(query, center) {
      const submittedQuery = query.trim()
      if (!submittedQuery) {
        updateState('error', '請先輸入要搜尋的地點')
        return
      }

      updateState('loading')
      try {
        const Place = await initialize()
        const request: google.maps.places.SearchByTextRequest = {
          textQuery: submittedQuery,
          fields: ['id', 'displayName', 'formattedAddress', 'location'],
          maxResultCount: 5,
          language: 'zh-TW',
          region: 'TW',
        }
        if (center && center.every(Number.isFinite)) {
          request.locationBias = { lng: center[0], lat: center[1] }
        }

        const response = await Place.searchByText(request)
        if (!mountedRef.current) return
        submittedQueryRef.current = submittedQuery
        const nextPlaces = Array.isArray(response.places) ? response.places : []
        setPlaces(nextPlaces)
        updateState('ready', nextPlaces.length ? undefined : `找不到符合「${submittedQuery}」的 Google 地點`)
      } catch (error) {
        setPlaces([])
        updateState('error', errorMessage(error))
      }
    },
    reset() {
      submittedQueryRef.current = ''
      setPlaces([])
      updateState('idle')
    },
  }))

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      placeClassRef.current = null
      initializePromiseRef.current = null
    }
  }, [])

  return (
    <div className="google-place-search" hidden={!visible}>
      <div className="google-place-search-results" role="listbox" aria-label="Google Places 搜尋結果">
        {componentState.status === 'ready' && places.length === 0 && (
          <div className="place-message">{componentState.message || '找不到符合條件的 Google 地點'}</div>
        )}
        {places.map((place, index) => {
          const name = place.displayName?.trim() || '未命名地點'
          const address = place.formattedAddress?.trim() || '地址未提供'
          return (
            <button
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`${name}，${address}`}
              className="place-result"
              key={`${place.id || 'google-place'}-${index}`}
              disabled={!selectable}
              onClick={() => onSelectRef.current(place, submittedQueryRef.current)}
            >
              <span className="place-pin" aria-hidden="true">●</span>
              <span className="place-result-copy">
                <b>{name}</b>
                <small className="place-address">{address}</small>
              </span>
            </button>
          )
        })}
        {places.length > 0 && <div className="place-attribution">Powered by Google</div>}
      </div>
      <div className={`google-place-search-status ${componentState.status}`}
        role={componentState.status === 'error' ? 'alert' : 'status'}
        aria-live="polite">
        {componentState.status === 'loading' && '正在載入 Google Places…'}
        {componentState.status === 'error' && componentState.message}
      </div>
    </div>
  )
})
