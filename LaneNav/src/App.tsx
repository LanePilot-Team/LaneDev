// LaneNav（發布版）App：瀏覽 + 規劃路線（含車種切換與轉彎步驟清單）+ 模擬行駛 +
// GPS 導航 + 匯入地圖（唯讀套用）。無編輯模式。
// src/core|app|plan|nav|browse 與 public/data 由 LaneDev 的 `npm run sync-lanenav`
// 鏡像產生——要改共用功能請改 LaneDev 再同步，不要直接改那些目錄。
import { useRef, useState } from 'react'
import { useMapCore, type Mode } from './app/mapCore'
import { importFiles } from './app/importFlow'
import { usePlanner } from './plan/usePlanner'
import { PlanPanel } from './plan/PlanPanel'
import { queryRoadInfoAt, RoadInfoCard } from './browse/RoadInfoCard'
import { useDrive } from './nav/useDrive'
import { DriveHUD } from './nav/DriveHUD'
import './App.css'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode, setModeState] = useState<Mode>('browse')
  const modeRef = useRef<Mode>('browse')
  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m) }

  const [roadInfo, setRoadInfo] = useState<Record<string, unknown> | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null) // 匯入地圖的檔案選擇器
  const [importMsg, setImportMsg] = useState<string | null>(null)

  // ── 點擊分派（LaneNav 沒有 edit 分支）──
  const { core, loading, zoneTick } =
    useMapCore(containerRef, (e, map) => {
      const m = modeRef.current
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      if (m === 'browse') setRoadInfo(queryRoadInfoAt(map, e.point))
      else if (m === 'pick') planner.handlePickClick(p)
    })
  const planner = usePlanner(core)

  const {
    drive, multiplier, gpsMsg, decisionOptions,
    startDrive, startGpsNav, stopAllDrivers, cycleMultiplier, takeAlternative, switchLane,
  } = useDrive({
    mode, setMode,
    mapRef: core.mapRef, routeRef: planner.routeRef, graphRef: core.graphRef,
    profileRef: planner.profileRef, stopsRef: planner.stopsRef,
    vehicleLayerRef: core.vehicleLayerRef, lastGestureRef: core.lastGestureRef,
    annotateTwoStage: planner.annotateTwoStage,
  })
  planner.stopAllDriversRef.current = stopAllDrivers

  function endDrive() {
    planner.clearAllRoute() // 內部已呼叫 stopAllDrivers()
    setMode('browse')
    core.mapRef.current?.setLayoutProperty('oneway-arrow', 'visibility', 'visible')
    core.mapRef.current?.setLayoutProperty('road-label', 'visibility', 'visible')
    core.mapRef.current?.easeTo({ pitch: 0, bearing: 0, padding: { top: 0 } })
  }

  function switchMode(m: Mode) {
    if (modeRef.current === 'drive') endDrive()
    if (m !== 'pick') planner.clearAllRoute()
    setRoadInfo(null)
    setMode(m)
  }

  function startPick() {
    planner.clearAllRoute()
    setMode('pick')
    planner.startPick(false)
  }

  return (
    <div className="app" data-zone-tick={zoneTick}>
      <div ref={containerRef} className="map" />

      {loading && <div className="loading">載入楠梓區路網中…</div>}

      {/* ── 導航 HUD ── */}
      {mode === 'drive' && (
        <DriveHUD
          drive={drive} twoStage={planner.isTwoStage(drive?.next ?? null)}
          profile={planner.profile} gpsMsg={gpsMsg} multiplier={multiplier}
          decisionOptions={decisionOptions}
          onEnd={endDrive} onCycleMultiplier={cycleMultiplier}
          onTakeAlternative={takeAlternative} onSwitchLane={switchLane}
        />
      )}

      {/* ── 工具列 ── */}
      {mode !== 'drive' && (
        <div className="toolbar">
          <button className={mode === 'browse' ? 'on' : ''} onClick={() => switchMode('browse')}>瀏覽</button>
          <button className={mode === 'pick' ? 'on' : ''} onClick={startPick}>規劃路線</button>
          <button onClick={() => importInputRef.current?.click()}>匯入地圖</button>
          <input ref={importInputRef} type="file" accept=".jsonl,.json,.geojson" multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files
              if (fs?.length) importFiles(core, { switchMode, setImportMsg }, [...fs])
              e.target.value = '' // 允許重選同一個檔
            }} />
          {importMsg && <span className="import-msg">{importMsg}</span>}
        </div>
      )}

      {/* ── 側面板：路線規劃（含 🚗/🛵 車種切換與轉彎步驟清單）── */}
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
