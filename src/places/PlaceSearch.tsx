import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { asset } from '../core/asset'
import type { MapCore } from '../app/mapCore'
import {
  CATEGORY_LABELS,
  searchPlaces,
  type PlaceDatabase,
  type PlaceRecord,
} from './places'

function sourceInfo(place: PlaceRecord) {
  const references = place.sourceRefs?.length ? place.sourceRefs : [{ source: place.source }]
  const sources = [...new Set(references
    .map((reference) => reference.source))]
  return {
    label: sources.map((source) => source === 'osm' ? 'OSM' : 'TDX').join('＋'),
    className: sources.length > 1 ? 'mixed' : sources[0],
  }
}

export function PlaceSearch({
  core,
  mapLoading,
  selected,
  onSelect,
  onClear,
  onChooseStart,
}: {
  core: MapCore
  mapLoading: boolean
  selected: PlaceRecord | null
  onSelect: (place: PlaceRecord) => void
  onClear: () => void
  onChooseStart: (place: PlaceRecord) => void
}) {
  const [places, setPlaces] = useState<PlaceRecord[]>([])
  const [query, setQuery] = useState('')
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'error'>('loading')
  const results = useMemo(() => searchPlaces(places, query), [places, query])
  const selectedPlace = useMemo(() => {
    if (!selected) return null
    return places.find((place) => place.id === selected.id) ?? selected
  }, [places, selected])

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

  function clearMarker() {
    onClear()
  }

  function clearSearch() {
    setQuery('')
    clearMarker()
  }

  function showPlace(place: PlaceRecord) {
    const map = core.mapRef.current
    if (!map || mapLoading || !map.getSource('placeSelection')) return
    onSelect(place)
    map.flyTo({
      center: place.position,
      zoom: Math.max(map.getZoom(), 17),
      pitch: 0,
      bearing: 0,
      essential: true,
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (results[0]) showPlace(results[0])
  }

  const hasQuery = query.trim().length > 0

  return (
    <section className="place-search" aria-label="地標搜尋">
      <form className="place-search-form" onSubmit={submit}>
        <span className="place-search-icon" aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            if (selected) onClear()
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
        <button type="submit" className="place-submit" disabled={!results.length || mapLoading}>
          搜尋
        </button>
      </form>

      {hasQuery && !selectedPlace && (
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
        </div>
      )}

      {selectedPlace && (
        <div className="place-route-choice" aria-label={`導航至${selectedPlace.name}`}>
          <div className="place-route-target">
            <span className="place-route-pin" aria-hidden="true">●</span>
            <span>
              <small>目的地</small>
              <b>{selectedPlace.name}</b>
              <em>{selectedPlace.address || CATEGORY_LABELS[selectedPlace.category]}</em>
            </span>
            <button type="button" onClick={clearMarker}>變更</button>
          </div>
          <p>選擇出發方式</p>
          <div className="place-route-methods">
            <button type="button" disabled title="目前位置導航將於下一階段開放">
              <span aria-hidden="true">⌖</span>
              <b>從我的位置出發</b>
              <small>即將推出</small>
            </button>
            <button type="button" className="active" disabled={mapLoading}
              onClick={() => onChooseStart(selectedPlace)}>
              <span aria-hidden="true">◎</span>
              <b>選擇起點</b>
              <small>在地圖上點選</small>
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
