import { requestCurrentPosition } from '../nav/geolocation.ts'
import { useRef, useState, useEffect, useEffectEvent } from 'react'
import { ManeuverList } from './ManeuverList.tsx'
import type { Planner } from './usePlanner.ts'
import type { MapCore } from '../app/mapCore.ts'
import { PlaceSearch } from '../places/PlaceSearch.tsx'
import { PlaceAddress } from '../places/PlaceAddress.tsx'
import { destinationLabel, type DestinationSelection } from '../places/destination.ts'

export function PlanPanel({ core, planner, onClose, startGpsNav, startSimDrive }: {
  core: MapCore; planner: Planner; onClose: () => void; startGpsNav: () => void
  /** dev ?sim 限定：模擬駕駛（prod 不傳） */
  startSimDrive?: () => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [stepsOpen, setStepsOpen] = useState(true)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState('')
  const pendingLocation = useRef<AbortController | null>(null)
  useEffect(() => () => pendingLocation.current?.abort(), [])
  async function useCurrentStart() {
    pendingLocation.current?.abort()
    const request = new AbortController()
    pendingLocation.current = request
    setLocating(true)
    setLocationError('')
    try {
      const result = await requestCurrentPosition({ signal: request.signal })
      if (!request.signal.aborted) planner.setCurrentStart(result.position)
    } catch (e) {
      if (!request.signal.aborted) setLocationError(e instanceof Error ? e.message : '無法定位')
    } finally {
      if (pendingLocation.current === request) pendingLocation.current = null
      if (!request.signal.aborted) setLocating(false)
    }
  }
  useEffect(() => {
    const stops = planner.stopsRef.current
    if (!stops[0]?.pos && stops.at(-1)?.pos) void useCurrentStart()
  }, [])
  const { stops, routeError, routeSummary, profile } = planner
  const label = (i: number) => i === 0 ? '起點' : i === stops.length - 1 ? '終點' : `停靠點 ${i}`
  function editStop(id: number) {
    if (id === planner.stopsRef.current[0]?.id) {
      pendingLocation.current?.abort()
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
  const simulatorStart = useEffectEvent((event: Event) => {
    if (import.meta.env.MODE !== 'ios-simulator') return
    const data = (event as CustomEvent).detail
    if (data?.type === 'simulatorControl' && data.action === 'start' && routeSummary && editing === null && !locating && planner.mapPickId === null) {
      startGpsNav()
    }
  })
  useEffect(() => {
    if (import.meta.env.MODE !== 'ios-simulator') return
    const control = (event: Event) => simulatorStart(event)
    window.addEventListener('lane-native', control)
    return () => {
      window.removeEventListener('lane-native', control)
      window.LaneSimulator?.planStatus(false, false)
    }
  }, [])
  useEffect(() => {
    if (import.meta.env.MODE === 'ios-simulator') {
      window.LaneSimulator?.planStatus(Boolean(routeSummary && editing === null && !locating && planner.mapPickId === null), true)
    }
  }, [routeSummary, editing, locating, planner.mapPickId])
  if (planner.mapPickId !== null) {
    const index = stops.findIndex(stop => stop.id === planner.mapPickId)
    return <section className="route-map-pick" aria-label="從地圖設定停靠點">
      <p role="status">點地圖設定{label(index)}</p>
      <button type="button" onClick={planner.cancelMapPick}>取消選點</button>
      {routeError && <p className="route-map-pick-error" role="alert">{routeError}</p>}
    </section>
  }
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
          {stops.map((stop, i) => (editing === null || editing === stop.id) && <div className={`route-stop route-stop-card${editing === stop.id ? ' is-editing' : ''}`} key={stop.id}
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
                onChooseStart={() => {}}>
                <div className="route-pick-options">
                  {i === 0 && <button type="button" className="location-suggestion" onClick={() => { setEditing(null); void useCurrentStart() }}>使用目前位置</button>}
                  <button type="button" className="location-suggestion" onClick={() => {
                    setEditing(null)
                    planner.pickStopOnMap(stop.id)
                  }}>在地圖上選{label(i)}</button>
                </div>
              </PlaceSearch>
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
            {editing !== stop.id && i > 0 && i < stops.length - 1 && <div className="route-via-actions">
              <button type="button" aria-label={`${label(i)}上移`} disabled={i === 1}
                onClick={() => planner.moveStop(stop.id, stops[i - 1].id)}>↑ 上移</button>
              <button type="button" aria-label={`${label(i)}下移`} disabled={i === stops.length - 2}
                onClick={() => planner.moveStop(stop.id, stops[i + 1].id)}>↓ 下移</button>
              <button type="button" className="mini route-via-remove" onClick={() => planner.removeStop(stop.id)}>移除</button>
            </div>}
          </div>)}
        </div>
        {editing === null && <button className="sp-add route-add-stop" onClick={() => setEditing(planner.addVia())}>＋ 新增停靠點</button>}
      </div>
      <div className="route-preview-secondary">
        {routeError && <div role="alert" className="sp-error route-status-error">{routeError}</div>}
        {editing === null && routeSummary && planner.routeRef.current && <details className="route-steps" open={stepsOpen}
          onToggle={event => setStepsOpen(event.currentTarget.open)}><summary>路線步驟・向下滑動查看更多</summary>
          <ManeuverList route={planner.routeRef.current} profile={profile} />
        </details>}
      </div>
    </div>
    {routeSummary && editing === null && <div className="route-preview-summary">
      <div className="route-preview-metrics"><span><b>{routeSummary.km.toFixed(1)}</b> 公里</span><span>約 {Math.max(1, Math.ceil(routeSummary.min))} 分鐘</span></div>
      <button className="route-start-button" disabled={locating} onClick={startGpsNav}>開始導航</button>
      {import.meta.env.DEV && startSimDrive && <button className="route-start-button" onClick={startSimDrive}>🧪 模擬駕駛</button>}
    </div>}
  </section>
}
