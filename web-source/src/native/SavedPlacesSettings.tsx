import { useEffect, useMemo, useState } from 'react'
import { asset } from '../core/asset.ts'
import { searchPlaces, type PlaceDatabase, type PlaceRecord } from '../places/places.ts'
import {
  SAVED_PLACE_KINDS, SAVED_PLACE_META, resetSavedPlace, setSavedPlace, startSavedPlacePick, useSavedPlaces,
  type SavedPlaceKind,
} from '../places/savedPlaces.ts'

let placesPromise: Promise<PlaceRecord[]> | null = null
function loadPlaces() {
  placesPromise ??= fetch(asset('/data/places/places.json'))
    .then(r => r.ok ? r.json() as Promise<PlaceDatabase> : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(db => Array.isArray(db.places) ? db.places : [])
    .catch(() => { placesPromise = null; return [] })
  return placesPromise
}

/** 設定面板「常用地點」：住家／學校／公司，可輸入地址（比對本地地標）或到地圖上標記。 */
export function SavedPlacesSettings({ onPickOnMap }: { onPickOnMap: () => void }) {
  const { places } = useSavedPlaces()
  const [editing, setEditing] = useState<SavedPlaceKind | null>(null)
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<PlaceRecord[]>([])
  useEffect(() => { if (editing) void loadPlaces().then(setRecords) }, [editing])
  const matches = useMemo(() => query.trim() ? searchPlaces(records, query).slice(0, 5) : [], [records, query])

  function beginEdit(kind: SavedPlaceKind) {
    setEditing(kind)
    setQuery(places[kind].address)
  }
  function choose(kind: SavedPlaceKind, place: PlaceRecord) {
    setSavedPlace({ kind, name: place.name, address: place.address ?? '', position: place.position })
    setEditing(null)
  }
  function saveText(kind: SavedPlaceKind) {
    // 只改地址文字、位置沿用原本的；位置要準請用「在地圖上標」
    setSavedPlace({ ...places[kind], address: query.trim() })
    setEditing(null)
  }

  return <details className="settings-section settings-subsection">
    <summary>常用地點</summary>
    <div className="settings-subsection-body saved-place-settings">
      {SAVED_PLACE_KINDS.map(kind => {
        const place = places[kind]
        const meta = SAVED_PLACE_META[kind]
        return <div className="saved-place-item" key={kind}>
          <div className="saved-place-head">
            <span className="saved-place-icon" aria-hidden="true">{meta.icon}</span>
            <span className="saved-place-copy">
              <b>{meta.label}{place.name ? `・${place.name}` : ''}</b>
              <small>{place.address || `座標 ${place.position[1].toFixed(5)}, ${place.position[0].toFixed(5)}`}</small>
            </span>
            {editing !== kind && <button type="button" onClick={() => beginEdit(kind)}>編輯</button>}
          </div>
          {editing === kind && <div className="saved-place-editor">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="輸入地址或地點名稱"
              aria-label={`${meta.label}地址`} autoFocus />
            {matches.length > 0 && <div className="saved-place-matches">
              {matches.map(p => <button type="button" key={p.id} onClick={() => choose(kind, p)}>
                <b>{p.name}</b>{p.address && <small>{p.address}</small>}
              </button>)}
            </div>}
            <div className="settings-actions">
              <button type="button" onClick={() => { startSavedPlacePick(kind); setEditing(null); onPickOnMap() }}>在地圖上標</button>
              <button type="button" onClick={() => saveText(kind)} disabled={!query.trim()}>只存地址文字</button>
              <button type="button" onClick={() => { resetSavedPlace(kind); setEditing(null) }}>還原預設</button>
              <button type="button" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>}
        </div>
      })}
    </div>
  </details>
}
