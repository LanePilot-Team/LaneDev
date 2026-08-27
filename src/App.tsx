// LaneDev（開發版）App：模式機 + 點擊分派 + 畫面組裝。
// 功能實作都在 app/（地圖核心、匯入）、plan/（規劃）、nav/（導航）、browse/（瀏覽）、
// edit/（編輯，LaneDev 專屬）——除 edit/ 外皆與 LaneNav 共用（npm run sync-lanenav 鏡像）。
import { useEffect, useRef, useState } from 'react'
import { useMapCore, type Mode } from './app/mapCore'
import { importFiles } from './app/importFlow'
import { usePlanner } from './plan/usePlanner'
import { PlanPanel } from './plan/PlanPanel'
import { queryRoadInfoAt, RoadInfoCard } from './browse/RoadInfoCard'
import { useDrive } from './nav/useDrive'
import { DriveHUD } from './nav/DriveHUD'
import { useEditor, type EditRoadState } from './edit/useEditor'
import { consumeRoadMergeReloadState } from './core/roadMergeReload'
import { activeMergeForRoad } from './core/roadMerge'
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
import {
  EditHintBar, LaneEditPanel, ZonePanel, BayPanel, VehiclePanel, TwinIslandPanel,
  RoadDrawPanel,
} from './edit/EditPanels'
import './App.css'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode, setModeState] = useState<Mode>('browse')
  const modeRef = useRef<Mode>('browse')
  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m) }

  const [roadInfo, setRoadInfo] = useState<Record<string, unknown> | null>(null)
  const [selectedDestination, setSelectedDestination] = useState<DestinationSelection | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null) // 匯入地圖的檔案選擇器
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [transitOn, setTransitOn] = useState(false) // 大眾運輸疊加圖層（預設關）

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
      else if (m === 'edit') editor.handleEditClick(map, e, p)
      else if (m === 'pick') planner.handlePickClick(p)
    })
  const planner = usePlanner(core)
  const editor = useEditor(core, planner.profileRef, modeRef)

  useEffect(() => {
    if (loading) return
    const restored = consumeRoadMergeReloadState(window.sessionStorage)
    if (!restored) return
    core.mapRef.current?.jumpTo(restored.camera)
    setMode(restored.mode)
    editor.setEditTool(restored.editTool)
    const editRoad = restored.editRoad as EditRoadState | null
    editor.setEditRoad(editRoad)
    const road = editRoad
      ? core.roadsRef.current.find((candidate) =>
        candidate.properties.osm_id === editRoad.osmId
        && candidate.properties.blockNode === editRoad.blockNode)
      : null
    editor.setActiveRoadMerge(
      road ? activeMergeForRoad(core.mergeReplayRef.current, road) ?? null : null,
    )
    // The snapshot is one-shot and is consumed only after canonical data has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  const {
    drive, multiplier, gpsMsg, cameraAlert, decisionOptions,
    startDrive, startGpsNav, replayDrive, canReplay,
    stopAllDrivers, cycleMultiplier, takeAlternative, switchLane,
  } = useDrive({
    mode, setMode,
    mapRef: core.mapRef, routeRef: planner.routeRef, graphRef: core.graphRef,
    zonesRef: core.zonesRef, speedCamerasRef: core.speedCamerasRef,
    profileRef: planner.profileRef, stopsRef: planner.stopsRef,
    routePolicy: planner.routePolicy,
    vehicleLayerRef: core.vehicleLayerRef, lastGestureRef: core.lastGestureRef,
    annotateTwoStage: planner.annotateTwoStage,
    setZoneHighlight: core.setZoneHighlight,
  })
  planner.stopAllDriversRef.current = stopAllDrivers

  // 導航中關掉大眾運輸疊加圖層：3000 個站牌加標籤在每幀旋轉的地圖上會不停重排，
  // 跟 oneway-arrow／road-label 同理。使用者的開關狀態留著，結束導航自動復原。
  useEffect(() => {
    if (loading) return
    core.setTransitVisible(mode !== 'drive' && transitOn)
  }, [mode, transitOn, loading, core])

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
    editor.closeAll()
    core.refreshZones()
    core.refreshVehicles()
    setMode(m)
  }

  function startPick(demo: boolean) {
    planner.clearAllRoute()
    clearDestinationSelection()
    setMode('pick')
    planner.startPick(demo)
  }

  function startPlacePick(destination: DestinationSelection) {
    setRoadInfo(null)
    editor.closeAll()
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
    editor.closeAll()
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

  function flyToDemoArea() {
    core.mapRef.current?.flyTo({ center: [120.2790, 22.7300], zoom: 17.5, pitch: 58, bearing: 20 })
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
          profile={planner.profile} gpsMsg={gpsMsg} multiplier={multiplier}
          cameraAlert={cameraAlert} decisionOptions={decisionOptions}
          onEnd={endDrive} onReplay={canReplay ? replayDrive : undefined}
          onCycleMultiplier={cycleMultiplier}
          onTakeAlternative={takeAlternative} onSwitchLane={switchLane}
        />
      )}

      {/* ── 工具列 ── */}
      {mode !== 'drive' && (
        <div className="toolbar">
          <button className={mode === 'browse' ? 'on' : ''} onClick={() => switchMode('browse')}>瀏覽</button>
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => switchMode('edit')}>編輯地圖</button>
          <button className={mode === 'pick' ? 'on' : ''} onClick={() => startPick(false)}>規劃路線</button>
          <button className={transitOn ? 'on' : ''} onClick={() => {
            const next = !transitOn
            setTransitOn(next)
            core.setTransitVisible(next)
          }}>🚌 大眾運輸</button>
          <button onClick={() => focusDistrict('nanzih')}>楠梓區</button>
          <button onClick={() => focusDistrict('zuoying')}>左營區</button>
          <button onClick={() => startPick(true)}>Demo 路線</button>
          <button onClick={flyToDemoArea}>大學路口 3D</button>
          <button onClick={() => importInputRef.current?.click()}>匯入地圖</button>
          <input ref={importInputRef} type="file" accept=".jsonl,.json,.geojson" multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files
              if (fs?.length) importFiles(core, { switchMode, setImportMsg }, [...fs])
              e.target.value = '' // 允許重選同一個檔
            }} />
          <button className="profile" onClick={() => planner.toggleProfile(modeRef.current)}>
            {planner.profile === 'car' ? '🚗 汽車' : '🛵 機車'}
          </button>
          {importMsg && <span className="import-msg">{importMsg}</span>}
        </div>
      )}

      {/* ── 編輯工具提示列與面板（LaneDev 專屬）── */}
      {mode === 'edit' && (
        <EditHintBar core={core} editor={editor} profile={planner.profile}
          zoneCount={zoneCount} vehicleCount={vehicleCount} />
      )}
      {mode === 'edit' && <LaneEditPanel editor={editor} />}
      {mode === 'edit' && editor.editTool === 'lane' && <TwinIslandPanel editor={editor} />}
      {mode === 'edit' && editor.editTool === 'zone' && <ZonePanel core={core} editor={editor} />}
      {mode === 'edit' && editor.editTool === 'bay' && <BayPanel core={core} editor={editor} />}
      {mode === 'edit' && editor.editTool === 'road' && <RoadDrawPanel editor={editor} />}
      {mode === 'edit' && editor.editTool === 'vehicle' && (
        <VehiclePanel core={core} editor={editor}
          selectedVehicle={selectedVehicle} vehicleCount={vehicleCount} />
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
          startDrive={startDrive} startGpsNav={startGpsNav} />
      )}

      {/* ── 路段資訊卡（瀏覽模式）── */}
      {mode === 'browse' && roadInfo && (
        <RoadInfoCard info={roadInfo} onClose={() => setRoadInfo(null)} />
      )}
    </div>
  )
}
