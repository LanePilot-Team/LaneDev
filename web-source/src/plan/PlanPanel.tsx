import { requestCurrentPosition } from '../nav/geolocation'
import { useRef, useState, useEffect } from 'react'
import { ManeuverList } from './ManeuverList'
import type { Planner } from './usePlanner'
import type { MapCore } from '../app/mapCore'
import { PlaceSearch } from '../places/PlaceSearch'
import { PlaceAddress } from '../places/PlaceAddress'
import { destinationLabel, type DestinationSelection } from '../places/destination'

export function PlanPanel({ core, planner, onClose, startGpsNav, startSimulation, simulationEnabled }: {
  core: MapCore; planner: Planner; onClose: () => void; startGpsNav: () => void
  startSimulation: () => void; simulationEnabled: boolean
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [stepsOpen, setStepsOpen] = useState(true)
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
  const routeStepsClass = routeSummary ? (stepsOpen ? ' route-steps-open' : ' route-steps-closed') : ''
  return <section className={`side-panel route-search-panel route-preview-card${editing !== null ? ' is-searching' : ''}${routeStepsClass}`} aria-label="搜尋與路線規劃">
    <div className="sp-head route-preview-head">
      <div className="route-preview-title">
        <span className="sp-kicker">路線預覽</span>
        <b>確認起終點後即可開始導航</b>
      </div>
      <div className="route-profile" role="group" aria-label="交通工具">
        <button type="button" className={`route-profile-option${profile === 'car' ? ' on' : ''}`}
          aria-label="汽車" title="汽車" aria-pressed={profile === 'car'}
          onClick={() => profile !== 'car' && planner.toggleProfile('pick')}>🚗 汽車</button>
        <button type="button" className={`route-profile-option${profile === 'moto' ? ' on' : ''}`}
          aria-label="機車" title="機車" aria-pressed={profile === 'moto'}
          onClick={() => profile !== 'moto' && planner.toggleProfile('pick')}>🛵 機車</button>
      </div>
      <button className="sp-close" aria-label="關閉路線" onClick={onClose}>✕</button>
    </div>
    <div className="route-preview-body">
      <div className="route-preview-primary">
        {locating && <p className="route-status" role="status">正在取得目前位置…</p>}
        {locationError && <p role="alert" className="sp-error route-status-error">{locationError}；可直接搜尋起點。</p>}
        <div className="route-stops">
          {stops.map((stop, i) => <div className={`route-stop route-stop-card${editing === stop.id ? ' is-editing' : ''}`} key={stop.id}
            onKeyDown={event => { if (event.key === 'Escape') setEditing(null) }}>
            {editing === stop.id ? <>
              <div className="route-stop-row route-stop-editing-head">
                <span className={`route-stop-dot ${i === 0 ? 'start' : i === stops.length - 1 ? 'end' : 'via'}`} aria-hidden="true" />
                <span className="route-stop-field"><span className="route-stop-label">{label(i)}</span><span className="route-stop-editing-copy">選取地點後套用</span></span>
                <button className="stop-edit-action" onClick={() => setEditing(null)}>取消</button>
              </div>
              <PlaceSearch key={stop.id} core={core} mapLoading={false} selected={null} picker
                inputId={`stop-${stop.id}`} initialQuery={stop.label === '我的位置' ? '' : stop.label ?? ''} searchLabel={`搜尋${label(i)}地點或地址`}
                onSelect={destination => selectPlace(stop.id, destination)} onClear={() => {}}
                onChooseStart={() => {}} />
              {i === 0 && <button className="location-suggestion" onClick={() => { setEditing(null); void useCurrentStart() }}>⌖ 目前位置</button>}
            </> : <>
              <div className="route-stop-row">
                <span className={`route-stop-dot ${i === 0 ? 'start' : i === stops.length - 1 ? 'end' : 'via'}`} aria-hidden="true" />
                <label className="route-stop-field" htmlFor={`stop-${stop.id}`}>
                  <span className="route-stop-label">{label(i)}</span>
                  <input id={`stop-${stop.id}`} className="route-stop-value" aria-label={label(i)} readOnly
                    value={stop.label || (stop.pos ? `${stop.pos[1].toFixed(5)}, ${stop.pos[0].toFixed(5)}` : '')}
                    placeholder={i === 0 ? '目前位置' : `搜尋${label(i)}地點或地址`}
                    onFocus={() => editStop(stop.id)} onClick={() => editStop(stop.id)} />
                </label>
                <button className="stop-edit-action" aria-label={`更換${label(i)}`} onClick={() => editStop(stop.id)}>更換</button>
              </div>
              {stop.placePosition && <PlaceAddress addressOnly place={{ address: stop.address, position: stop.placePosition }} />}
            </>}
            {i > 0 && i < stops.length - 1 && <button className="mini route-via-remove" onClick={() => planner.removeStop(stop.id)}>移除停靠點</button>}
          </div>)}
        </div>
        <button className="sp-add route-add-stop" onClick={() => { planner.addVia(); setEditing(null) }}>＋ 新增停靠點</button>
      </div>
      <div className="route-preview-secondary">
        {routeError && <div role="alert" className="sp-error route-status-error">{routeError}</div>}
        {routeSummary && <div className="route-preview-summary">
          <div className="route-preview-metrics"><span><b>{routeSummary.km.toFixed(1)}</b> 公里</span><span>約 {Math.max(1, Math.ceil(routeSummary.min))} 分鐘</span></div>
          <button className="route-start-button" disabled={editing !== null || locating} onClick={startGpsNav}>
            {editing !== null ? '請先選好地點' : '開始導航'}
          </button>
          {simulationEnabled && <button className="route-start-button simulation-start-button"
            disabled={editing !== null || locating} onClick={startSimulation}>
            {editing !== null ? '請先選好地點' : '開始模擬導航'}
          </button>}
        </div>}
        {routeSummary && planner.routeRef.current && <details className="route-steps" open={stepsOpen}
          onToggle={event => setStepsOpen(event.currentTarget.open)}><summary>路線步驟・向下滑動查看更多</summary>
          <ManeuverList route={planner.routeRef.current} profile={profile} />
        </details>}
      </div>
    </div>
  </section>
}
