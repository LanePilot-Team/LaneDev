import { requestCurrentPosition } from '../nav/geolocation'
import { useRef, useState, useEffect } from 'react'
import { ManeuverList } from './ManeuverList'
import type { Planner } from './usePlanner'
import type { MapCore } from '../app/mapCore'
import { PlaceSearch } from '../places/PlaceSearch'
import { PlaceAddress } from '../places/PlaceAddress'
import { destinationLabel, type DestinationSelection } from '../places/destination'

export function PlanPanel({ core, planner, onClose, startGpsNav }: {
  core: MapCore; planner: Planner; onClose: () => void; startGpsNav: () => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState('')
  const requestId = useRef(0)
  useEffect(() => () => { requestId.current++ }, [])
  async function useCurrentStart() {
    const id = ++requestId.current
    setLocating(true)
    setLocationError('')
    try {
      const result = await requestCurrentPosition()
      if (id === requestId.current) planner.setCurrentStart(result.position)
    } catch (e) {
      if (id === requestId.current) setLocationError(e instanceof Error ? e.message : '無法定位')
    } finally { if (id === requestId.current) setLocating(false) }
  }
  useEffect(() => {
    if (!planner.stopsRef.current[0]?.pos) void useCurrentStart()
  }, [])
  const { stops, routeError, routeSummary, profile } = planner
  const label = (i: number) => i === 0 ? '起點' : i === stops.length - 1 ? '終點' : `停靠點 ${i}`
  function editStop(id: number) {
    if (id === planner.stopsRef.current[0]?.id) {
      requestId.current++
      setLocating(false)
    }
    planner.selectStop(id)
    setEditing(id)
  }
  function selectPlace(id: number, destination: DestinationSelection) {
    const accepted = planner.setStopDestination(id, {
      id: destination.id, label: destinationLabel(destination), position: destination.position,
      provider: destination.provider,
      address: destination.provider === 'local' ? destination.place.address : undefined,
    })
    if (!accepted) return
    setEditing(null)
    if (id === planner.stopsRef.current[0]?.id) setLocationError('')
  }
  return <section className="side-panel route-search-panel" aria-label="搜尋與路線規劃">
    <div className="sp-head"><b>路線</b><button className="sp-close" aria-label="關閉路線" onClick={onClose}>✕</button></div>
    <div className="sp-vehicle">
      <button className={`mini${profile === 'car' ? ' on' : ''}`} onClick={() => profile !== 'car' && planner.toggleProfile('pick')}>🚗 汽車</button>
      <button className={`mini${profile === 'moto' ? ' on' : ''}`} onClick={() => profile !== 'moto' && planner.toggleProfile('pick')}>🛵 機車</button>
    </div>
    {locating && <p role="status">正在取得目前位置…</p>}
    {locationError && <p role="alert" className="sp-error">{locationError}；可直接搜尋起點。</p>}
    {stops.map((stop, i) => <div className="route-stop" key={stop.id}>
      <label htmlFor={`stop-${stop.id}`}>{label(i)}</label>
      {editing === stop.id ? <div>
        <PlaceSearch key={stop.id} core={core} mapLoading={false} selected={null} picker
          initialQuery="" searchLabel={`搜尋${label(i)}地點或地址`}
          onSelect={destination => selectPlace(stop.id, destination)} onClear={() => {}}
          onChooseStart={() => {}} />
        {i === 0 && <button className="location-suggestion" onClick={() => { setEditing(null); void useCurrentStart() }}>⌖ 目前位置</button>}
        <button className="mini" onClick={() => setEditing(null)}>取消搜尋</button>
      </div> : <input id={`stop-${stop.id}`} aria-label={label(i)} readOnly
        value={stop.label || (stop.pos ? `${stop.pos[1].toFixed(5)}, ${stop.pos[0].toFixed(5)}` : '')}
        placeholder={`搜尋${label(i)}地點或地址`} onFocus={() => editStop(stop.id)} onClick={() => editStop(stop.id)} />}
      {editing !== stop.id && stop.placePosition && <PlaceAddress place={{ address: stop.address, position: stop.placePosition }} />}
      {i > 0 && i < stops.length - 1 && <button className="mini" onClick={() => planner.removeStop(stop.id)}>移除停靠點</button>}
    </div>)}
    <button className="sp-add" onClick={() => { planner.addVia(); setEditing(null) }}>＋ 新增停靠點</button>
    {routeError && <div role="alert" className="sp-error">{routeError}</div>}
    {routeSummary && <div className="sp-summary">
      <b>{routeSummary.km.toFixed(1)} 公里</b> · 約 {Math.max(1, Math.round(routeSummary.min))} 分鐘
      <button className="mini go" disabled={editing !== null || locating} onClick={startGpsNav}>開始導航</button>
    </div>}
    {routeSummary && planner.routeRef.current && <details><summary>路線步驟</summary>
      <ManeuverList route={planner.routeRef.current} profile={profile} />
    </details>}
  </section>
}
