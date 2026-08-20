import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { asset } from '../core/asset'
import type { MapCore } from '../app/mapCore'
import {
  geolocationUnavailableMessage,
  requestCurrentPosition,
} from '../nav/geolocation'
import {
  GooglePlaceSearch,
  type GooglePlaceSearchHandle,
  type GooglePlaceSearchState,
} from './GooglePlaceSearch'
import {
  CATEGORY_LABELS,
  searchPlaces,
  type PlaceDatabase,
  type PlaceRecord,
} from './places'
import {
  destinationLabel,
  googleDestination,
  localDestination,
  type DestinationSelection,
} from './destination'

function sourceInfo(place: PlaceRecord) {
  const references = place.sourceRefs?.length ? place.sourceRefs : [{ source: place.source }]
  const sources = [...new Set(references
    .map((reference) => reference.source))]
  return {
    label: sources.map((source) => source === 'osm' ? 'OSM' : 'TDX').join('＋'),
    className: sources.length > 1 ? 'mixed' : sources[0],
  }
}

type SearchProvider = 'local' | 'google'
type CurrentLocationState = 'idle' | 'loading' | 'error'

export function PlaceSearch({
  core,
  mapLoading,
  selected,
  onSelect,
  onClear,
  onChooseStart,
  onUseCurrentLocation,
}: {
  core: MapCore
  mapLoading: boolean
  selected: DestinationSelection | null
  onSelect: (destination: DestinationSelection) => void
  onClear: () => void
  onChooseStart: (destination: DestinationSelection) => void
  onUseCurrentLocation: (
    destination: DestinationSelection,
    position: [number, number],
  ) => void
}) {
  const [places, setPlaces] = useState<PlaceRecord[]>([])
  const [query, setQuery] = useState('')
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [provider, setProvider] = useState<SearchProvider>('local')
  const [googleState, setGoogleState] = useState<GooglePlaceSearchState>('idle')
  const [googleSubmittedQuery, setGoogleSubmittedQuery] = useState('')
  const [googleSelectionError, setGoogleSelectionError] = useState<string | null>(null)
  const [currentLocationState, setCurrentLocationState] = useState<CurrentLocationState>('idle')
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(null)
  const googleSearchRef = useRef<GooglePlaceSearchHandle>(null)
  const currentLocationRequestRef = useRef(0)
  const results = useMemo(() => searchPlaces(places, query), [places, query])
  const resolvedSelected = useMemo(() => {
    if (!selected) return null
    if (selected.provider === 'google-ui-kit') return selected
    const place = places.find((candidate) => candidate.id === selected.id) ?? selected.place
    return localDestination(place)
  }, [places, selected])
  const selectedKey = selected ? `${selected.provider}:${selected.id}` : ''
  const selectedKeyRef = useRef(selectedKey)
  selectedKeyRef.current = selectedKey
  const currentLocationUnavailable = geolocationUnavailableMessage()

  useEffect(() => {
    let active = true
    fetch(asset('/data/places/places.json'))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<PlaceDatabase>
      })
      .then((database) => {
        if (!active) return
        setPlaces(Array.isArray(database.places) ? database.places : [])
        setDataState('ready')
      })
      .catch((error) => {
        console.warn('地標資料載入失敗', error)
        if (active) setDataState('error')
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    currentLocationRequestRef.current += 1
    setCurrentLocationState('idle')
    setCurrentLocationError(null)
  }, [selectedKey])

  useEffect(() => () => {
    currentLocationRequestRef.current += 1
  }, [])

  function cancelCurrentLocationRequest() {
    currentLocationRequestRef.current += 1
    setCurrentLocationState('idle')
    setCurrentLocationError(null)
  }

  function clearMarker() {
    cancelCurrentLocationRequest()
    setGoogleSelectionError(null)
    onClear()
  }

  function clearSearch() {
    setQuery('')
    setProvider('local')
    setGoogleSubmittedQuery('')
    setGoogleSelectionError(null)
    googleSearchRef.current?.reset()
    clearMarker()
  }

  function returnToLocalResults() {
    setProvider('local')
    setGoogleSubmittedQuery('')
    setGoogleSelectionError(null)
    googleSearchRef.current?.reset()
  }

  async function searchWithGoogle() {
    const submittedQuery = query.trim()
    if (!submittedQuery || googleState === 'loading') return

    const center = core.mapRef.current?.getCenter()
    setProvider('google')
    setGoogleSubmittedQuery(submittedQuery)
    setGoogleSelectionError(null)
    await googleSearchRef.current?.search(
      submittedQuery,
      center ? [center.lng, center.lat] : undefined,
    )
  }

  function showDestination(destination: DestinationSelection) {
    const map = core.mapRef.current
    if (!map || mapLoading || !map.getSource('placeSelection')) return
    cancelCurrentLocationRequest()
    onSelect(destination)
    map.flyTo({
      center: destination.position,
      zoom: Math.max(map.getZoom(), 17),
      pitch: 0,
      bearing: 0,
      essential: true,
    })
  }

  function showPlace(place: PlaceRecord) {
    showDestination(localDestination(place))
  }

  function showGooglePlace(
    place: google.maps.places.Place,
    submittedQuery: string,
  ) {
    const destination = googleDestination(place, submittedQuery)
    if (!destination) {
      setGoogleSelectionError('這個 Google 地點缺少可導航位置，請選擇其他結果')
      return
    }
    setGoogleSelectionError(null)
    showDestination(destination)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (provider === 'google') {
      void searchWithGoogle()
      return
    }
    if (results[0]) showPlace(results[0])
  }

  async function useCurrentLocation() {
    const destination = resolvedSelected
    if (!destination || mapLoading || currentLocationState === 'loading') return

    const requestId = ++currentLocationRequestRef.current
    const requestedSelectedKey = selectedKey
    setCurrentLocationState('loading')
    setCurrentLocationError(null)
    try {
      // 必須由 click handler 直接呼叫，瀏覽器才會把權限要求視為使用者操作。
      const location = await requestCurrentPosition()
      if (currentLocationRequestRef.current !== requestId ||
        selectedKeyRef.current !== requestedSelectedKey) return
      onUseCurrentLocation(destination, location.position)
    } catch (error) {
      if (currentLocationRequestRef.current !== requestId ||
        selectedKeyRef.current !== requestedSelectedKey) return
      const message = error instanceof Error && error.message
        ? error.message
        : '無法取得目前位置'
      setCurrentLocationState('error')
      setCurrentLocationError(`${message}，可再試一次或改用地圖選擇起點。`)
    }
  }

  function chooseStartOnMap(destination: DestinationSelection) {
    cancelCurrentLocationRequest()
    onChooseStart(destination)
  }

  const hasQuery = query.trim().length > 0

  return (
    <section className="place-search" aria-label="地標搜尋">
      <form className="place-search-form" onSubmit={submit}>
        <span className="place-search-icon" aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value
            setQuery(nextQuery)
            if (!nextQuery.trim()) {
              setProvider('local')
              setGoogleSubmittedQuery('')
              setGoogleSelectionError(null)
              googleSearchRef.current?.reset()
            }
            if (selected) clearMarker()
          }}
          aria-label="搜尋地標"
          placeholder="搜尋地點、車站或地址"
          autoComplete="off"
        />
        {hasQuery && (
          <button type="button" className="place-clear" onClick={clearSearch} aria-label="清除搜尋">
            ✕
          </button>
        )}
        <button type="submit" className="place-submit"
          disabled={!hasQuery || googleState === 'loading' ||
            (provider === 'local' && (!results.length || mapLoading))}>
          {provider === 'google' ? 'Google 搜尋' : '搜尋'}
        </button>
      </form>

      {hasQuery && provider === 'local' && !resolvedSelected && (
        <div className="place-results" role="listbox" aria-label="搜尋結果">
          {dataState === 'loading' && <div className="place-message">載入地標資料中…</div>}
          {dataState === 'error' && (
            <div className="place-message error">無法載入地標資料，請先執行手動更新腳本。</div>
          )}
          {dataState === 'ready' && results.length === 0 && (
            <div className="place-message">找不到符合「{query.trim()}」的地點</div>
          )}
          {results.map((place) => {
            const source = sourceInfo(place)
            return <button
              type="button"
              role="option"
              aria-selected={false}
              className="place-result"
              key={place.id}
              onClick={() => showPlace(place)}
            >
              <span className="place-pin" aria-hidden="true">●</span>
              <span className="place-result-copy">
                <b>{place.name}</b>
                <small>{place.address || CATEGORY_LABELS[place.category]}</small>
              </span>
              <span className={`place-source ${source.className}`}>{source.label}</span>
            </button>
          })}
          {results.length > 0 && (
            <div className="place-attribution">共顯示 {results.length} 筆 · © OpenStreetMap contributors · 交通部 TDX</div>
          )}
          {dataState !== 'loading' && (
            <div className={`place-provider-switch${results.length === 0 ? ' prominent' : ''}`}>
              <span>{results.length > 0 ? '沒有你要的地點？' : 'OSM＋TDX 沒有這個地點？'}</span>
              <button type="button" onClick={() => void searchWithGoogle()}
                disabled={!hasQuery || googleState === 'loading'}>
                使用 Google Places 搜尋
              </button>
            </div>
          )}
        </div>
      )}

      <div className="place-results google-provider-results"
        hidden={!hasQuery || provider !== 'google' || Boolean(resolvedSelected)}
        aria-label="Google Places 搜尋結果">
        <div className="google-place-header">
          <span>
            <b>Google Places</b>
            <small>搜尋「{googleSubmittedQuery || query.trim()}」</small>
          </span>
          <button type="button" onClick={returnToLocalResults}>返回本地結果</button>
        </div>
        <GooglePlaceSearch
          ref={googleSearchRef}
          visible={hasQuery && provider === 'google' && !resolvedSelected}
          selectable={!mapLoading}
          onSelect={showGooglePlace}
          onStateChange={setGoogleState}
        />
        {googleSelectionError && (
          <div className="google-selection-error" role="alert">{googleSelectionError}</div>
        )}
      </div>

      {resolvedSelected && (
        <div className="place-route-choice"
          aria-label={`導航至${destinationLabel(resolvedSelected)}`}>
          <div className="place-route-target">
            <span className="place-route-pin" aria-hidden="true">●</span>
            <span>
              <small>{resolvedSelected.provider === 'local' ? '目的地' : 'Google Places 目的地'}</small>
              <b>{destinationLabel(resolvedSelected)}</b>
              <em>{resolvedSelected.provider === 'local'
                ? resolvedSelected.place.address || CATEGORY_LABELS[resolvedSelected.place.category]
                : '使用 Google 搜尋結果的位置'}</em>
            </span>
            <button type="button" onClick={clearMarker}>變更</button>
          </div>
          <p>選擇出發方式</p>
          <div className="place-route-methods">
            <button type="button"
              className={`${currentLocationUnavailable ? '' : 'active'}${
                currentLocationState === 'loading' ? ' locating' : ''}`}
              disabled={mapLoading || currentLocationState === 'loading' ||
                Boolean(currentLocationUnavailable)}
              aria-busy={currentLocationState === 'loading'}
              aria-describedby={(currentLocationError || currentLocationUnavailable)
                ? 'place-current-location-message'
                : undefined}
              title={currentLocationUnavailable ?? ''}
              onClick={() => void useCurrentLocation()}>
              <span aria-hidden="true">⌖</span>
              <b>從我的位置出發</b>
              <small>{currentLocationState === 'loading'
                ? '正在取得位置…'
                : currentLocationState === 'error'
                  ? '重新取得位置'
                  : currentLocationUnavailable
                    ? '定位目前不可用'
                    : '使用裝置定位'}</small>
            </button>
            <button type="button" className="active" disabled={mapLoading}
              onClick={() => chooseStartOnMap(resolvedSelected)}>
              <span aria-hidden="true">◎</span>
              <b>選擇起點</b>
              <small>在地圖上點選</small>
            </button>
          </div>
          {(currentLocationError || currentLocationUnavailable) && (
            <div id="place-current-location-message"
              className="place-current-location-message"
              role={currentLocationError ? 'alert' : 'status'}
              aria-live="polite">
              {currentLocationError ?? currentLocationUnavailable}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
