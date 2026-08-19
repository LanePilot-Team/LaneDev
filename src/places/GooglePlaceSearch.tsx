import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { loadGooglePlacesLibrary } from './googleMapsLoader'

export type GooglePlaceSearchState = 'idle' | 'loading' | 'ready' | 'error'

export interface GooglePlaceSearchHandle {
  /** 使用者明確提交後才呼叫；輸入過程不得自動搜尋。 */
  search: (query: string, center?: [number, number]) => Promise<void>
  reset: () => void
}

export interface GooglePlaceSearchProps {
  visible?: boolean
  onSelect: (place: google.maps.places.Place, submittedQuery: string) => void
  onStateChange?: (state: GooglePlaceSearchState, message?: string) => void
}

interface ComponentState {
  status: GooglePlaceSearchState
  message?: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Google Places 暫時無法載入'
}

export const GooglePlaceSearch = forwardRef<
  GooglePlaceSearchHandle,
  GooglePlaceSearchProps
>(function GooglePlaceSearch({
  visible = true,
  onSelect,
  onStateChange,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)
  const initializePromiseRef = useRef<Promise<void> | null>(null)
  const searchElementRef = useRef<google.maps.places.PlaceSearchElement | null>(null)
  const requestElementRef = useRef<google.maps.places.PlaceTextSearchRequestElement | null>(null)
  const submittedQueryRef = useRef('')
  const cleanupListenersRef = useRef<(() => void) | null>(null)
  const onSelectRef = useRef(onSelect)
  const onStateChangeRef = useRef(onStateChange)
  const [componentState, setComponentState] = useState<ComponentState>({ status: 'idle' })

  onSelectRef.current = onSelect
  onStateChangeRef.current = onStateChange

  function updateState(status: GooglePlaceSearchState, message?: string) {
    if (!mountedRef.current) return
    setComponentState({ status, message })
    onStateChangeRef.current?.(status, message)
  }

  async function initialize() {
    if (searchElementRef.current && requestElementRef.current) return
    if (initializePromiseRef.current) return initializePromiseRef.current

    initializePromiseRef.current = (async () => {
      const library = await loadGooglePlacesLibrary()
      const host = hostRef.current
      if (!mountedRef.current || !host) throw new Error('Google 搜尋容器尚未就緒')

      const searchElement = new library.PlaceSearchElement({
        attributionPosition: 'BOTTOM',
        orientation: 'VERTICAL',
        selectable: true,
        truncationPreferred: true,
      })
      const contentConfig = new library.PlaceContentConfigElement()
      const address = new library.PlaceAddressElement()
      const type = new library.PlaceTypeElement()
      const attribution = new library.PlaceAttributionElement({
        lightSchemeColor: 'GRAY',
        darkSchemeColor: 'WHITE',
      })
      const request = new library.PlaceTextSearchRequestElement({
        maxResultCount: 5,
      })

      contentConfig.append(address, type, attribution)
      searchElement.append(contentConfig, request)

      const handleLoad: EventListener = () => updateState('ready')
      const handleError: EventListener = () => {
        updateState('error', 'Google Places 搜尋失敗，請稍後重試')
      }
      const handleSelect: EventListener = (event) => {
        const place = (event as google.maps.places.PlaceSelectEvent).place
        onSelectRef.current(place, submittedQueryRef.current)
      }

      searchElement.addEventListener('gmp-load', handleLoad)
      searchElement.addEventListener('gmp-error', handleError)
      searchElement.addEventListener('gmp-select', handleSelect)
      cleanupListenersRef.current = () => {
        searchElement.removeEventListener('gmp-load', handleLoad)
        searchElement.removeEventListener('gmp-error', handleError)
        searchElement.removeEventListener('gmp-select', handleSelect)
      }

      host.replaceChildren(searchElement)
      searchElementRef.current = searchElement
      requestElementRef.current = request
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
        await initialize()
        const request = requestElementRef.current
        if (!request) throw new Error('Google 搜尋元件尚未就緒')

        if (center && center.every(Number.isFinite)) {
          request.locationBias = { lng: center[0], lat: center[1] }
        } else {
          request.locationBias = null
        }

        // 相同關鍵字也允許由使用者明確重新搜尋。
        if (request.textQuery === submittedQuery) request.textQuery = null
        submittedQueryRef.current = submittedQuery
        request.textQuery = submittedQuery
      } catch (error) {
        updateState('error', errorMessage(error))
      }
    },
    reset() {
      submittedQueryRef.current = ''
      const request = requestElementRef.current
      if (request) {
        request.textQuery = null
        request.locationBias = null
      }
      updateState('idle')
    },
  }))

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cleanupListenersRef.current?.()
      cleanupListenersRef.current = null
      searchElementRef.current = null
      requestElementRef.current = null
      initializePromiseRef.current = null
      hostRef.current?.replaceChildren()
    }
  }, [])

  return (
    <div className="google-place-search" hidden={!visible}>
      <div ref={hostRef} className="google-place-search-results" />
      <div className={`google-place-search-status ${componentState.status}`}
        role={componentState.status === 'error' ? 'alert' : 'status'}
        aria-live="polite">
        {componentState.status === 'loading' && '正在載入 Google Places…'}
        {componentState.status === 'error' && componentState.message}
      </div>
    </div>
  )
})
