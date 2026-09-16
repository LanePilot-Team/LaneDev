// LaneDev（開發版）App：模式機 + 點擊分派 + 畫面組裝。
// 功能實作都在 app/（地圖核心、匯入）、plan/（規劃）、nav/（導航）、browse/（瀏覽）、
// edit/（編輯，LaneDev 專屬）——除 edit/ 外皆與 LaneNav 共用（npm run sync-lanenav 鏡像）。
import { useEffect, useRef, useState } from 'react'
import { useMapCore, type Mode } from './app/mapCore'

import { usePlanner } from './plan/usePlanner'
import { PlanPanel } from './plan/PlanPanel'
import { queryRoadInfoAt, RoadInfoCard } from './browse/RoadInfoCard'
import { useDrive } from './nav/useDrive'
import { DriveHUD } from './nav/DriveHUD'
import { ClientSettings } from './native/ClientSettings'
import { LocateControl } from './native/LocateControl'
import { PlaceSearch } from './places/PlaceSearch'
import {
  POI_LAYER_IDS,
  placeFromPoiFeature,
} from './places/places'
import {
  destinationLabel,
  localDestination,
  type DestinationSelection,
} from './places/destination'

import './App.css'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode, setModeState] = useState<Mode>('browse')
  const modeRef = useRef<Mode>('browse')
  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m) }

  const [roadInfo, setRoadInfo] = useState<Record<string, unknown> | null>(null)
  const [selectedDestination, setSelectedDestination] = useState<DestinationSelection | null>(null)


  // ── 點擊分派 ──
  const { core, loading, zoneCount, zoneTick, vehicleCount, selectedVehicle } =
    useMapCore(containerRef, (e, map) => {
      const m = modeRef.current
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
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
    drive, gpsMsg, cameraAlert,
    startGpsNav, stopAllDrivers,
    following, recenter,
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

  function endDrive() {
    planner.clearAllRoute() // 內部已呼叫 stopAllDrivers()
    clearDestinationSelection()
    setMode('browse')
    core.mapRef.current?.setLayoutProperty('oneway-arrow', 'visibility', 'visible')
    core.mapRef.current?.setLayoutProperty('road-label', 'visibility', 'visible')
    core.mapRef.current?.easeTo({ pitch: 0, bearing: 0, padding: { top: 0 } })
  }

  function switchMode(m: Mode) {
    if (modeRef.current === 'drive') endDrive()
    if (m !== 'pick') planner.clearAllRoute()
    if (m !== 'browse' || modeRef.current === 'pick') clearDestinationSelection()
    setRoadInfo(null)
    core.refreshZones()
    core.refreshVehicles()
    setMode(m)
  }

  function startPick() {
    planner.clearAllRoute()
    clearDestinationSelection()
    setMode('pick')
    planner.startPick()
  }

  function startPlacePick(destination: DestinationSelection) {
    setRoadInfo(null)
    core.refreshZones()
    core.refreshVehicles()
    setMode('pick')
    planner.startPlacePick({
      id: destination.id,
      label: destinationLabel(destination),
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

  function startPlaceFromCurrentLocation(
    destination: DestinationSelection,
    position: [number, number],
  ) {
    setRoadInfo(null)
    core.refreshZones()
    core.refreshVehicles()
    setMode('pick')
    planner.startPlaceFromCurrentLocation({
      id: destination.id,
      label: destinationLabel(destination),
      position: destination.position,
      provider: destination.provider,
    }, position)
  }

  function activeRoutePickLabel() {
    const index = planner.stops.findIndex((stop) => stop.id === planner.activeStop)
    if (index === planner.stops.length - 1) return '目的地'
    if (index > 0) return `停靠點 ${index}`
    return '起點'
  }

  function focusDistrict(district: 'nanzih' | 'zuoying') {
    const center: [number, number] = district === 'zuoying'
      ? [120.294, 22.686]
      : [120.303, 22.739]
    core.mapRef.current?.flyTo({
      center,
      zoom: 13.6,
      pitch: 0,
      bearing: 0,
    })
  }

  return (
    <div className="app" data-zone-tick={zoneTick} data-mode={mode}>
      <div ref={containerRef} className="map" />

      <ClientSettings navigating={mode === 'drive'} />
      <LocateControl core={core} loading={loading} navigating={mode === 'drive'} />
      {loading && <div className="loading">載入楠梓＋左營路網中…</div>}

      {mode === 'browse' && (
        <PlaceSearch
          core={core}
          mapLoading={loading}
          selected={selectedDestination}
          onSelect={showDestinationSelection}
          onClear={clearDestinationSelection}
          onChooseStart={startPlacePick}
          onUseCurrentLocation={startPlaceFromCurrentLocation}
        />
      )}

      {/* ── 導航 HUD ── */}
      {mode === 'drive' && (
        <DriveHUD
          drive={drive} twoStage={planner.isTwoStage(drive?.next ?? null)}
          profile={planner.profile} gpsMsg={gpsMsg}
          cameraAlert={cameraAlert}
          destinationName={destinationName} following={following} onRecenter={recenter}
          onEnd={endDrive}
        />
      )}

      {/* ── 工具列 ── */}
      {mode !== 'drive' && (
        <div className="toolbar">
          <button className={mode === 'browse' ? 'on' : ''} onClick={() => switchMode('browse')}>瀏覽</button>
          <button disabled={loading} className={mode === 'pick' ? 'on' : ''} onClick={() => startPick()}>規劃路線</button>
          <button onClick={() => focusDistrict('nanzih')}>楠梓區</button>
          <button onClick={() => focusDistrict('zuoying')}>左營區</button>
          <button className="profile" onClick={() => planner.toggleProfile(modeRef.current)}>
            {planner.profile === 'car' ? '🚗 汽車' : '🛵 機車'}
          </button>
        </div>
      )}

      {/* ── 側面板：路線規劃 ── */}
      {mode === 'pick' && planner.activeStop !== null &&
        planner.stops.some((stop) => stop.placeId) && (
        <div className="hint route-pick-hint">
          <span aria-hidden="true">◎</span> 點選地圖上的{activeRoutePickLabel()}
          <button className="mini" onClick={() => switchMode('browse')}>取消</button>
        </div>
      )}
      {mode === 'pick' && (
        <PlanPanel planner={planner} onClose={() => switchMode('browse')}
          startGpsNav={startGpsNav} />
      )}

      {/* ── 路段資訊卡（瀏覽模式）── */}
      {mode === 'browse' && roadInfo && (
        <RoadInfoCard info={roadInfo} onClose={() => setRoadInfo(null)} />
      )}
    </div>
  )
}
