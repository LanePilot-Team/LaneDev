import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { asset } from '../core/asset'
import { EMPTY_FC, type MapCore } from '../app/mapCore'
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

export function PlaceSearch({ core, mapLoading }: {
  core: MapCore
  mapLoading: boolean
}) {
  const [places, setPlaces] = useState<PlaceRecord[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<PlaceRecord | null>(null)
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'error'>('loading')
  const results = useMemo(() => searchPlaces(places, query), [places, query])

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
    if (!mapLoading && core.mapRef.current?.getSource('placeSelection')) {
      core.src('placeSelection').setData(EMPTY_FC as never)
    }
    setSelected(null)
  }

  function clearSearch() {
    setQuery('')
    clearMarker()
  }

  function showPlace(place: PlaceRecord) {
    const map = core.mapRef.current
    if (!map || mapLoading || !map.getSource('placeSelection')) return
    const data: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          id: place.id,
          name: place.name,
          source: place.source,
          category: place.category,
        },
        geometry: { type: 'Point', coordinates: place.position },
      }],
    }
    core.src('placeSelection').setData(data as never)
    map.flyTo({
      center: place.position,
      zoom: Math.max(map.getZoom(), 17),
      pitch: 0,
      bearing: 0,
      essential: true,
    })
    setSelected(place)
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
            setSelected(null)
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

      {hasQuery && (
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
              aria-selected={selected?.id === place.id}
              className={`place-result${selected?.id === place.id ? ' selected' : ''}`}
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
    </section>
  )
}
