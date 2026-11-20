// LaneDev Android 用戶端 App：模式機（瀏覽／規劃／導航）+ 點擊分派 + 畫面組裝。
// 功能實作在 app/（地圖核心）、plan/（規劃）、nav/（導航）、browse/（路段資訊）、places/（搜尋）、
// native/（Android 原生橋接）。道路資料唯讀，沒有編輯功能。
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useMapCore, type Mode } from './app/mapCore.ts'

import { usePlanner } from './plan/usePlanner.ts'
import { PlanPanel } from './plan/PlanPanel.tsx'
import { queryRoadInfoAt, RoadInfoCard } from './browse/RoadInfoCard.tsx'
import { useDrive } from './nav/useDrive.ts'
import { DriveHUD, RecenterButton } from './nav/DriveHUD.tsx'
import { ClientSettings } from './native/ClientSettings.tsx'
import { LocateControl } from './native/LocateControl.tsx'
import { PlaceSearch } from './places/PlaceSearch.tsx'
import { lookupAddress } from './places/PlaceAddress.tsx'
import {
  SAVED_PLACE_META,
  cancelSavedPlacePick,
  savedPlacesState,
  setSavedPlace,
  useSavedPlaces,
} from './places/savedPlaces.ts'
import {
  POI_LAYER_IDS,
  placeFromPoiFeature,
} from './places/places.ts'
import {
  destinationLabel,
  localDestination,
  type DestinationSelection,
} from './places/destination.ts'

import { SIM, SimControls } from './dev/index.ts'

import './App.css'

const loadSteps = ['初始化地圖', '驗證並讀取導航路網', '載入道路、建築與地圖圖層']

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode, setModeState] = useState<Mode>('browse')
  const modeRef = useRef<Mode>('browse')
  const pickRevision = useRef(0)
  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m) }

  const [roadInfo, setRoadInfo] = useState<Record<string, unknown> | null>(null)
  const [selectedDestination, setSelectedDestination] = useState<DestinationSelection | null>(null)
  const savingKind = useSavedPlaces().picking


  // ── 點擊分派 ──
  const { core, loading, loadStep, loadError, zoneTick } =
    useMapCore(containerRef, (e, map) => {
      const m = modeRef.current
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      const savingKind = savedPlacesState().picking
      if (savingKind && m !== 'drive') {
        cancelSavedPlacePick()
        const fallback = `座標 ${p[1].toFixed(5)}, ${p[0].toFixed(5)}`
        setSavedPlace({ kind: savingKind, address: fallback, position: p })
        // 有原生反查地址就補上門牌；瀏覽器開發環境沒有，維持座標
        void lookupAddress(p).then(address => {
          const current = savedPlacesState().places[savingKind]
          if (address && current.position === p) setSavedPlace({ ...current, address })
        })
        return
      }
      // dev ?sim：點地圖依序設起點 → 終點（第三下重來），取代瀏覽模式的點選
      if (import.meta.env.DEV && SIM && (m === 'browse' || m === 'pick')) {
        if (m === 'browse' || planner.stopsRef.current.every((s) => s.pos)) {
          clearDestinationSelection()
          setRoadInfo(null)
          planner.startPick()
          setMode('pick')
        }
        planner.handlePickClick(p)
        return
      }
      if (m === 'browse') {
        const placeFeature = map.queryRenderedFeatures(e.point, { layers: [...POI_LAYER_IDS] })[0]
        const place = placeFeature ? placeFromPoiFeature(placeFeature) : null
        if (place) {
          showDestinationSelection(localDestination(place))
          return
        }
        clearDestinationSelection()
        setRoadInfo(queryRoadInfoAt(map, e.point))
      }
      else if (m === 'pick') planner.handlePickClick(p)
    })
  const planner = usePlanner(core)
  const {
    drive, gpsMsg, canRetry, cameraAlert, nextStop,
    startGpsNav, stopAllDrivers,
    following, recenter,
    startSimDrive, sim,
  } = useDrive({
    mode, setMode,
    mapRef: core.mapRef, routeRef: planner.routeRef, graphRef: core.graphRef,
    zonesRef: core.zonesRef, speedCamerasRef: core.speedCamerasRef,
    profileRef: planner.profileRef, stopsRef: planner.stopsRef,
    routePolicy: planner.routePolicy,
    vehicleLayerRef: core.vehicleLayerRef, lastGestureRef: core.lastGestureRef,
    onUserCameraTakeoverRef: core.onUserCameraTakeoverRef,
    annotateTwoStage: planner.annotateTwoStage,
    setZoneHighlight: core.setZoneHighlight,
  })
  planner.stopAllDriversRef.current = stopAllDrivers

  // 目的地名稱（最後一個停靠點的標籤）——抵達卡與收尾語音要講得出「到哪了」，
  // 只用「已抵達目的地」在實機上分不出系統到底有沒有認出自己到了。
  const destinationName = planner.stops[planner.stops.length - 1]?.label


  function showDestinationSelection(destination: DestinationSelection) {
    const map = core.mapRef.current
    if (!map?.getSource('placeSelection')) return
    core.src('placeSelection').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          id: destination.id,
          name: destinationLabel(destination),
          provider: destination.provider,
          source: destination.provider === 'local' ? destination.place.source : 'google-ui-kit',
          category: destination.provider === 'local' ? destination.place.category : 'other',
        },
        geometry: { type: 'Point', coordinates: destination.position },
      }],
    } as never)
    setSelectedDestination(destination)
    setRoadInfo(null)
  }

  function clearDestinationSelection() {
    if (core.mapRef.current?.getSource('placeSelection')) {
      core.src('placeSelection').setData({ type: 'FeatureCollection', features: [] } as never)
    }
    setSelectedDestination(null)
  }

  /** 導航還沒真正開始（定位失敗）就按結束：退回規劃畫面、保留路線，讓使用者處理權限後再開始 */
  function cancelDriveStart() {
    stopAllDrivers()
    restoreBrowseMap()
    setMode('pick')
  }

  function restoreBrowseMap() {
    core.mapRef.current?.setLayoutProperty('oneway-arrow', 'visibility', 'visible')
    core.mapRef.current?.setLayoutProperty('road-label', 'visibility', 'visible')
    core.mapRef.current?.easeTo({ pitch: 0, bearing: 0, padding: { top: 0 } })
  }

  function endDrive() {
    planner.clearAllRoute() // 內部已呼叫 stopAllDrivers()
    clearDestinationSelection()
    setMode('browse')
    restoreBrowseMap()
  }

  const simulatorControl = useEffectEvent((event: Event) => {
    if (import.meta.env.MODE !== 'ios-simulator' || loading) return
    const data = (event as CustomEvent).detail
    if (data?.type !== 'simulatorControl') return
    if (data.action === 'pick' && mode !== 'drive') {
      pickRevision.current++
      clearDestinationSelection()
      setRoadInfo(null)
      planner.startPick()
      setMode('pick')
    }
    if (data.action === 'end' && mode === 'drive') endDrive()
  })
  useEffect(() => {
    if (import.meta.env.MODE !== 'ios-simulator') return
    const control = (event: Event) => simulatorControl(event)
    window.addEventListener('lane-native', control)
    return () => window.removeEventListener('lane-native', control)
  }, [])

  function switchMode(m: Mode) {
    if (modeRef.current === 'drive') endDrive()
    if (m !== 'pick') planner.clearAllRoute()
    if (m !== 'browse' || modeRef.current === 'pick') clearDestinationSelection()
    setRoadInfo(null)
    core.refreshZones()
    setMode(m)
  }

  function startPlacePick(destination: DestinationSelection) {
    clearDestinationSelection()
    setRoadInfo(null)
    core.refreshZones()
    setMode('pick')
    planner.startPlacePick({
      id: destination.id,
      label: destinationLabel(destination),
      address: destination.provider === 'local' ? destination.place.address : undefined,
      position: destination.position,
      provider: destination.provider,
    })
    core.mapRef.current?.flyTo({
      center: destination.position,
      zoom: 13.6,
      pitch: 0,
      bearing: 0,
      essential: true,
    })
  }

  return (
    <div className="app" data-zone-tick={zoneTick} data-mode={mode}>
      <div ref={containerRef} className="map" />

      <div className={`map-actions${mode === 'drive' ? ' navigating' : ''}`}>
        {mode === 'drive' && !following && <RecenterButton onClick={recenter} />}
        <LocateControl core={core} loading={loading} navigating={mode === 'drive'} />
        <ClientSettings navigating={mode === 'drive'} />
      </div>
      {savingKind && mode !== 'drive' && (
        <div className="saved-place-pick-banner" role="status">
          <span>點地圖設定「{SAVED_PLACE_META[savingKind].label}」位置</span>
          <button type="button" onClick={cancelSavedPlacePick}>取消</button>
        </div>
      )}
      {loading && <div className="loading" role={loadError ? 'alert' : undefined}>
        <div className="map-load-panel">
          {loadError ? <>
            <div><strong>無法載入地圖</strong><p>{loadError}</p></div>
            <button onClick={() => location.reload()}>重新載入</button>
          </> : <>
            <p role="status">{loadSteps[loadStep - 1]}（{loadStep}/{loadSteps.length}）</p>
            <progress aria-label="地圖載入階段" max={loadSteps.length} value={loadStep} />
          </>}
        </div>
      </div>}

      {mode === 'browse' && (
        <PlaceSearch
          core={core}
          mapLoading={loading}
          selected={selectedDestination}
          onSelect={showDestinationSelection}
          onClear={clearDestinationSelection}
          onChooseStart={startPlacePick}
        />
      )}

      {/* ── 導航 HUD ── */}
      {mode === 'drive' && (
        <DriveHUD
          drive={drive} twoStage={planner.isTwoStage(drive?.next ?? null)}
          profile={planner.profile} gpsMsg={gpsMsg}
          canRetry={canRetry}
          cameraAlert={cameraAlert} nextStop={nextStop}
          destinationName={destinationName}
          onEnd={!drive && canRetry ? cancelDriveStart : endDrive}
          onRetry={startGpsNav}
        />
      )}

      {/* ── 側面板：路線規劃 ── */}
      {mode === 'pick' && (
        <PlanPanel key={import.meta.env.MODE === 'ios-simulator' ? pickRevision.current : 0}
          core={core} planner={planner} onClose={() => switchMode('browse')}
          startGpsNav={startGpsNav} startSimDrive={startSimDrive} />
      )}
      {import.meta.env.DEV && sim && <SimControls sim={sim} driving={mode === 'drive'} />}

      {/* ── 路段資訊卡（瀏覽模式）── */}
      {mode === 'browse' && roadInfo && (
        <RoadInfoCard info={roadInfo} onClose={() => setRoadInfo(null)} />
      )}
    </div>
  )
}
