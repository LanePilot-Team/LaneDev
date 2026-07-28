// 模擬駕駛 + 真 GPS 導航：把 App.tsx 裡「行駛中」相關的 state/refs/函式集中在這裡，
// App.tsx 只留「模式機 + 畫面組裝」。地圖/路網/停靠點等跨功能共用的狀態仍由 App.tsx
// 持有，透過參數傳進來（這裡不重複定義 ref，避免兩邊各存一份不同步）。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl'
import { RoadGraph, laneBand, type RouteResult, type Profile } from '../core/graph'
import { activeElevatedLayer } from '../core/elevated3d'
import { Driver, type DriveState } from './drive'
import { GpsDriver } from './gpsNav'
import { VehicleModelLayer } from '../core/models3d'
import { angleDelta, cumulative } from '../core/geo'
import type { Mode } from '../app/mapCore'
import type { Stop } from '../plan/usePlanner'
import { activeNavigationOcclusion } from '../core/occlusion'
import { isZoneEnabled, type Zone } from '../core/zones'

/** 路口決策：接近下個轉彎多近（公尺）才顯示「不照指引走」按鈕 */
const DECISION_BUTTON_RANGE_M = 30
/** 路口決策：選了替代道路後，沿其真實幾何最多取多遠（公尺）當作暫時路線 */
const DETOUR_LOOKAHEAD_M = 150
/** 路口決策：沿替代道路走了多遠（公尺）後才觸發 reroute */
const DETOUR_REROUTE_M = 40
const ZONE_HIGHLIGHT_RANGE_M = 160

export type DecisionKind = 'left' | 'straight' | 'right'

export interface UseDriveParams {
  mode: Mode
  setMode: (m: Mode) => void
  mapRef: RefObject<MLMap | null>
  routeRef: RefObject<RouteResult | null>
  graphRef: RefObject<RoadGraph | null>
  zonesRef: RefObject<Zone[]>
  profileRef: RefObject<Profile>
  stopsRef: RefObject<Stop[]>
  vehicleLayerRef: RefObject<VehicleModelLayer | null>
  lastGestureRef: RefObject<number>
  /** 路線建好/重建後標記兩段式左轉旗標（journal 待轉區判斷邏輯在 App.tsx，這裡直接借用） */
  annotateTwoStage: (route: RouteResult) => void
  setZoneHighlight: (id: string | null) => void
}

export interface UseDriveResult {
  drive: DriveState | null
  multiplier: number
  gpsMsg: string | null
  /** 接近路口時可選的「不照指引走」出口（已排除指引本身那個方向） */
  decisionOptions: { kind: DecisionKind }[]
  startDrive: () => void
  startGpsNav: () => void
  /** 模擬到達後「再跑一次」：用出發當下的原始路線重播（reroute/detour 改過的不算）；GPS 導航無此功能 */
  replayDrive: () => void
  canReplay: boolean
  /** 停掉目前在跑的 Driver/GpsDriver（不管哪一種）並清空行駛相關 state；給 endDrive/clearAllRoute 共用 */
  stopAllDrivers: () => void
  cycleMultiplier: () => void
  takeAlternative: (kind: DecisionKind) => void
  /** 換車道按鈕：dir -1=左、1=右 */
  switchLane: (dir: -1 | 1) => void
}

export function useDrive(p: UseDriveParams): UseDriveResult {
  const driverRef = useRef<Driver | null>(null)
  const gpsDriverRef = useRef<GpsDriver | null>(null)
  const initialRouteRef = useRef<RouteResult | null>(null) // 模擬出發時的路線快照（重播用）
  const lastDriveRef = useRef<DriveState | null>(null)
  const activeZoneIdRef = useRef<string | null>(null)
  const [drive, setDrive] = useState<DriveState | null>(null)
  const [multiplier, setMultiplier] = useState(3)
  const [gpsMsg, setGpsMsg] = useState<string | null>(null)

  // 觸控/鍵盤共用同一個 multiplier state；Driver 實例則由這裡統一同步，兩種輸入來源都不用各自 assign
  useEffect(() => { if (driverRef.current) driverRef.current.multiplier = multiplier }, [multiplier])

  const src = (id: string) => p.mapRef.current!.getSource(id) as GeoJSONSource

  /** 重畫路線帶：高架段交給 elevated3d 3D 絲帶，MapLibre 只畫平面段（與 usePlanner 同規則） */
  function drawRouteLine(route: RouteResult) {
    const band = laneBand(route)
    const ground = activeElevatedLayer()?.setRoute(route, band) ?? [band.coords]
    src('route').setData({
      type: 'FeatureCollection',
      features: ground.filter((cs) => cs.length >= 2).map((cs) => ({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: cs },
      })),
    } as never)
  }

  function updateZoneHighlight(state: DriveState | null) {
    const maneuver = state?.next
    let nextId: string | null = null
    if (
      p.profileRef.current === 'moto'
      && maneuver?.twoStage
      && maneuver.nodeId !== undefined
      && maneuver.fromBearing !== undefined
      && (state?.nextDistM ?? Number.POSITIVE_INFINITY) <= ZONE_HIGHLIGHT_RANGE_M
    ) {
      nextId = p.zonesRef.current.find((zone) =>
        isZoneEnabled(zone)
        && zone.intersectionId === maneuver.nodeId
        && Math.abs(angleDelta(zone.from.bearing, maneuver.fromBearing!)) < 50
      )?.id ?? null
    }
    if (activeZoneIdRef.current === nextId) return
    activeZoneIdRef.current = nextId
    p.setZoneHighlight(nextId)
  }

  function stopAllDrivers() {
    driverRef.current?.stop()
    driverRef.current = null
    initialRouteRef.current = null
    gpsDriverRef.current?.stop()
    gpsDriverRef.current = null
    setGpsMsg(null)
    setDrive(null)
    p.vehicleLayerRef.current?.setNav(null)
    activeNavigationOcclusion()?.clear()
    updateZoneHighlight(null)
  }

  function runDriver(route: RouteResult, opts?: { autoRerouteAfterM?: number }) {
    const map = p.mapRef.current!
    const camPadding = { top: Math.round(map.getContainer().clientHeight * 0.45) }
    let lastHud = 0
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__route = route
    let frame = 0
    const driver = new Driver(route, (s) => {
      // 路口決策後沿替代道路走了一段（見 takeAlternative）：超過門檻視同偏離，重新規劃。
      // 也涵蓋替代道路是死路的情況——沒走到門檻就先「抵達」了，一樣視同偏離重新規劃，
      // 不能讓死路直接顯示「已抵達目的地」
      if (opts?.autoRerouteAfterM && (s.arrived || s.traveledM > opts.autoRerouteAfterM)) { rerouteFrom(s.pos); return }
      lastDriveRef.current = s
      updateZoneHighlight(s)
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__drive = s
      // 鏡頭/車模 30Hz 就夠順——jumpTo 觸發整張地圖重繪，是導航中最大的固定成本
      frame++
      if (frame % 2 === 0 || s.arrived) {
        p.vehicleLayerRef.current?.setNav(s.pos, s.bearing, p.profileRef.current, s.elevM ?? 0)
        activeNavigationOcclusion()?.update(s.pos, s.bearing, s.elevM ?? 0)
        // 不帶 zoom/pitch → 導航中可自由縮放（mvp 行為）；
        // 手勢後 250ms 內暫停跟隨，讓 scrollZoom 的平滑動畫跑完（車模照常更新）
        if (performance.now() - p.lastGestureRef.current > 250) {
          map.jumpTo({ center: s.pos, bearing: s.bearing, padding: camPadding })
        }
      }
      const now = performance.now()
      if (s.arrived || now - lastHud > 160) {
        lastHud = now
        setDrive(s)
      }
    })
    driver.multiplier = multiplier
    driverRef.current?.stop()
    driverRef.current = driver
    driver.start()
  }

  function startDrive() {
    const route = p.routeRef.current
    const map = p.mapRef.current
    if (!route || !map) return
    p.setMode('drive')
    initialRouteRef.current = route
    // 導航中地圖每幀旋轉，符號圖層會不停重排——關掉最吵的單行箭頭與路名省 CPU
    map.setLayoutProperty('oneway-arrow', 'visibility', 'none')
    map.setLayoutProperty('road-label', 'visibility', 'none')
    map.jumpTo({ zoom: 17.6, pitch: 60 })
    runDriver(route)
  }

  /** 再跑一次：回到出發時的原始路線從頭重播（中途 reroute/detour 換掉的路線不保留） */
  function replayDrive() {
    const route = initialRouteRef.current
    const map = p.mapRef.current
    if (!route || !map) return
    p.routeRef.current = route
    drawRouteLine(route)
    map.jumpTo({ zoom: 17.6, pitch: 60 }) // 到達後使用者可能縮放過，重播時重設鏡頭
    runDriver(route)
  }

  /** 開始導航（真 GPS）：watchPosition 邏輯在 gpsNav.ts，這裡只負責接上跟 startDrive 同一套 HUD/車模/鏡頭 */
  function startGpsNav() {
    const route = p.routeRef.current
    const map = p.mapRef.current
    if (!route || !map) return
    p.setMode('drive')
    initialRouteRef.current = null // 真 GPS 導航沒有「再跑一次」（人不會瞬移回起點）
    map.setLayoutProperty('oneway-arrow', 'visibility', 'none')
    map.setLayoutProperty('road-label', 'visibility', 'none')
    setGpsMsg('取得 GPS 位置中…（手機請允許定位權限）')
    const camPadding = { top: Math.round(map.getContainer().clientHeight * 0.45) }
    gpsDriverRef.current?.stop()
    const gps = new GpsDriver(
      route,
      (s) => {
        lastDriveRef.current = s
        updateZoneHighlight(s)
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__drive = s
        p.vehicleLayerRef.current?.setNav(s.pos, s.bearing, p.profileRef.current, s.elevM ?? 0)
        activeNavigationOcclusion()?.update(s.pos, s.bearing, s.elevM ?? 0)
        if (performance.now() - p.lastGestureRef.current > 250) {
          map.jumpTo({ center: s.pos, bearing: s.bearing, padding: camPadding })
        }
        setGpsMsg(null)
        setDrive(s)
      },
      (pos) => rerouteFrom(pos),
      (msg) => setGpsMsg(msg),
    )
    gpsDriverRef.current = gps
    gps.start()
  }

  /** 重新規劃：從目前（可能已偏離）位置到終點重算路線並接續導航。共用給鍵盤橫移/路口決策/GPS 離線等各種偏離觸發情境。 */
  function rerouteFrom(pos: [number, number]) {
    const to = p.stopsRef.current[p.stopsRef.current.length - 1]?.pos
    const g = p.graphRef.current
    if (!to || !g) return
    const route = g.route(pos, to, p.profileRef.current)
    if (!route) return
    p.annotateTwoStage(route)
    p.routeRef.current = route
    drawRouteLine(route)
    // 目前是 GPS 導航中就繼續用 GPS 接續，否則走模擬（鍵盤橫移/路口決策都是模擬觸發）
    if (gpsDriverRef.current) startGpsNav()
    else runDriver(route)
  }

  /**
   * 路口決策：不照指引走，改走同一路口的其他道路。先真的沿替代道路開一段
   * （DETOUR_LOOKAHEAD_M 內的真實道路幾何），超過 DETOUR_REROUTE_M 才觸發 reroute
   * ——比直接跳一個假位置更接近「駕駛沒照轉」的真實情境。
   */
  function takeAlternative(altKind: DecisionKind) {
    const s = lastDriveRef.current
    const g = p.graphRef.current
    const nodeId = s?.next?.nodeId
    if (!s || !g || nodeId === undefined) return
    const alt = g.alternativesAt(nodeId, s.next!.fromBearing ?? 0, p.profileRef.current)
      .find((a) => a.kind === altKind)
    if (!alt) return
    const acum = cumulative(alt.coords)
    let cut = alt.coords.length
    for (let i = 0; i < acum.length; i++) {
      if (acum[i] > DETOUR_LOOKAHEAD_M) { cut = i + 1; break }
    }
    const coords = [s.pos, ...alt.coords.slice(0, cut)]
    const cum = cumulative(coords)
    const detourRoute: RouteResult = {
      coords, cum, lengthM: cum[cum.length - 1], timeS: 0,
      maneuvers: [],
      spans: [{ toIdx: coords.length - 1, offM: 0, leftM: 0, rightM: 0 }],
      diverges: [], weaves: [],
    }
    p.routeRef.current = detourRoute
    drawRouteLine(detourRoute)
    runDriver(detourRoute, { autoRerouteAfterM: DETOUR_REROUTE_M })
  }

  function cycleMultiplier() {
    const next = multiplier === 1 ? 3 : multiplier === 3 ? 8 : 1
    setMultiplier(next)
    if (driverRef.current) driverRef.current.multiplier = next
  }

  /** 換車道按鈕（subway-surfer 式）：一次一車道，夾在目前路段的實際車道內，不會開出路面 */
  function switchLane(dir: -1 | 1) {
    driverRef.current?.laneStep(dir)
  }

  // 路口決策按鈕：接近下個轉彎時，列出「不照指引走」的其他出口（排除指引本身那個方向）
  const decisionOptions: { kind: DecisionKind }[] = []
  if (p.mode === 'drive' && drive?.next && drive.next.kind !== 'arrive' &&
    drive.nextDistM < DECISION_BUTTON_RANGE_M && drive.next.nodeId !== undefined && p.graphRef.current) {
    const planned: DecisionKind = drive.next.kind === 'left' || drive.next.kind === 'slight-left' || drive.next.kind === 'uturn'
      ? 'left' : drive.next.kind === 'right' || drive.next.kind === 'slight-right' ? 'right' : 'straight'
    const seen = new Set<string>()
    for (const a of p.graphRef.current.alternativesAt(drive.next.nodeId, drive.next.fromBearing ?? 0, p.profileRef.current)) {
      if (a.kind === planned || seen.has(a.kind)) continue
      seen.add(a.kind)
      decisionOptions.push(a)
    }
  }

  // ── 鍵盤變速：只在桌面（非觸控）+ 'drive' 模式生效，手機沒有實體鍵盤。
  // 換車道/路口決策改用畫面按鈕（見 App.tsx），不走鍵盤 ──
  useEffect(() => {
    if (p.mode !== 'drive') return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (window.matchMedia('(pointer: coarse)').matches) return
      if (ev.key === 'ArrowUp') setMultiplier((m) => Math.min(8, m + 1))
      else if (ev.key === 'ArrowDown') setMultiplier((m) => Math.max(1, m - 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [p.mode])

  return {
    drive, multiplier, gpsMsg, decisionOptions,
    startDrive, startGpsNav, replayDrive, canReplay: !!initialRouteRef.current,
    stopAllDrivers, cycleMultiplier, takeAlternative, switchLane,
  }
}
