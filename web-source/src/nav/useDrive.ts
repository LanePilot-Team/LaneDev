// Android GPS 導航：把 App.tsx 裡「行駛中」相關的 state/refs/函式集中在這裡，
// App.tsx 只留「模式機 + 畫面組裝」。地圖/路網/停靠點等跨功能共用的狀態仍由 App.tsx
// 持有，透過參數傳進來（這裡不重複定義 ref，避免兩邊各存一份不同步）。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl'
import {
  RoadGraph,
  laneBand,
  laneChoiceAreas,
  type LaneRoutePolicy,
  type RouteResult,
  type Profile,
} from '../core/graph'
import { activeElevatedLayer } from '../core/elevated3d'
import type { DriveState } from './drive'
import { clientState, ensureLocation, nativeCommand } from '../native/client'
import { GpsDriver } from './gpsNav'
import { VehicleModelLayer } from '../core/models3d'
import { angleDelta, cumulative } from '../core/geo'
import type { Mode } from '../app/mapCore'
import type { Stop } from '../plan/usePlanner'
import { activeNavigationOcclusion } from '../core/occlusion'
import { isZoneEnabled, type Zone } from '../core/zones'
import { routeFailureText } from '../plan/routeFailure'
import {
  matchCamerasToRoute, speedCameraAlertAt, speedCameraAnnouncement,
  type RouteCamera, type SpeedCamera, type SpeedCameraAlert,
} from '../core/speedCameras'
import { SpeedCameraVoice } from './speedCameraVoice'

/** 接近待轉區時的高亮距離。 */
const ZONE_HIGHLIGHT_RANGE_M = 160
/** 導航、置中及重規劃使用已儲存視距；與 GPS 速度和動畫計時無關。 */
const navCamera = () => ({ zoom: clientState().zoom, pitch: 50 })

/**
 * 上高架時鏡頭要跟著抬同樣的高度，不能沿用平面的鏡頭高度——否則車在橋面上、
 * 鏡頭還瞄著地面，車模會離鏡頭更近而被放大並往畫面上緣飄。
 *
 * MapLibre 的 `CameraOptions.elevation` 就是「中心點的海拔」，但預設
 * `centerClampedToGround = true` 會把它壓回地面，所以導航期間要先關掉。
 * 實測 elevation 0 → 15 時相機海拔剛好 +15m，地面的投影位置不變，
 * 也就是橋面上的車會維持在原本的畫面位置與大小。
 */
function setNavCameraClamp(map: MLMap, clamped: boolean) {
  if (map.getCenterClampedToGround() !== clamped) map.setCenterClampedToGround(clamped)
}

export type DecisionKind = 'left' | 'straight' | 'right'

export interface UseDriveParams {
  mode: Mode
  setMode: (m: Mode) => void
  mapRef: RefObject<MLMap | null>
  routeRef: RefObject<RouteResult | null>
  graphRef: RefObject<RoadGraph | null>
  zonesRef: RefObject<Zone[]>
  /** 測速執法設置點（mapCore 載入的警政署開放資料）；空陣列＝沒有測速提示 */
  speedCamerasRef: RefObject<SpeedCamera[]>
  profileRef: RefObject<Profile>
  routePolicy: LaneRoutePolicy
  stopsRef: RefObject<Stop[]>
  vehicleLayerRef: RefObject<VehicleModelLayer | null>
  lastGestureRef: RefObject<number>
  /** mapCore 註冊點：使用者拖曳/旋轉/傾斜地圖時通知這裡交還鏡頭 */
  onUserCameraTakeoverRef: RefObject<(() => void) | null>
  /** 路線建好/重建後標記兩段式左轉旗標（journal 待轉區判斷邏輯在 App.tsx，這裡直接借用） */
  annotateTwoStage: (route: RouteResult) => void
  setZoneHighlight: (id: string | null) => void
}

export interface UseDriveResult {
  drive: DriveState | null
  gpsMsg: string | null
  /** 目前該顯示的測速照相提示（沒有就是 null） */
  cameraAlert: SpeedCameraAlert | null
  startGpsNav: () => void
  /** 停止目前的 GPS 導航並清空行駛相關 state；給 endDrive/clearAllRoute 共用 */
  stopAllDrivers: () => void
  /** 鏡頭是否正在跟隨車輛；false = 使用者自己滑走了，正在自由瀏覽 */
  following: boolean
  /** 「回到目前位置」：重新跟隨並復原導航視角 */
  recenter: () => void
}

export function useDrive(p: UseDriveParams): UseDriveResult {
  const gpsDriverRef = useRef<GpsDriver | null>(null)
  const lastDriveRef = useRef<DriveState | null>(null)
  const activeZoneIdRef = useRef<string | null>(null)
  const routeCamerasRef = useRef<RouteCamera[]>([])
  const voiceRef = useRef<SpeedCameraVoice>(null as never)
  if (!voiceRef.current) voiceRef.current = new SpeedCameraVoice()
  const [drive, setDrive] = useState<DriveState | null>(null)
  const [gpsMsg, setGpsMsg] = useState<string | null>(null)
  const [cameraAlert, setCameraAlert] = useState<SpeedCameraAlert | null>(null)
  // 鏡頭跟隨開關。ref 給每幀的跟隨迴圈讀（state 在 callback 內是舊值），state 給按鈕重繪。
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)

  const sessionRef = useRef(0)
  useEffect(() => {
    const onZoom = () => {
      if (p.mode === 'drive') p.mapRef.current?.jumpTo({ zoom: clientState().zoom })
    }
    window.addEventListener('navigation-zoom', onZoom)
    return () => window.removeEventListener('navigation-zoom', onZoom)
  }, [p.mode])
  useEffect(() => () => {
    sessionRef.current++
    gpsDriverRef.current?.stop()
    voiceRef.current.reset()
    nativeCommand('navigation', { active: false })
  }, [])

  function setFollow(on: boolean) {
    followingRef.current = on
    setFollowing(on)
  }

  /**
   * 使用者自己動了鏡頭 → 停止跟隨，改成自由瀏覽（Google 地圖的行為）。
   * 原本是「手勢後 250ms 就自動搶回鏡頭」，在手機上等於滑不動地圖，
   * 每次都被拉回車子——那 250ms 只保留給縮放（讓 scrollZoom 的慣性跑完）。
   */
  useEffect(() => {
    if (p.mode !== 'drive') return
    p.onUserCameraTakeoverRef.current = () => setFollow(false)
    return () => { p.onUserCameraTakeoverRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode])

  /** 回到目前位置：重新跟隨，並把使用者瀏覽時改掉的縮放/俯角拉回導航視角 */
  function recenter() {
    const map = p.mapRef.current
    const s = lastDriveRef.current
    setFollow(true)
    if (!map) return
    if (!s) { map.easeTo({ ...navCamera(), duration: 400 }); return }
    map.easeTo({
      center: s.pos, bearing: s.bearing, ...navCamera(),
      padding: { top: Math.round(map.getContainer().clientHeight * 0.45) },
      elevation: s.elevM ?? 0,
      duration: 400,
    })
  }

  const src = (id: string) => p.mapRef.current!.getSource(id) as GeoJSONSource

  /** 重畫路線帶：高架段交給 elevated3d 3D 絲帶，MapLibre 只畫平面段（與 usePlanner 同規則） */
  function drawRouteLine(route: RouteResult) {
    const band = laneBand(route)
    const choices = laneChoiceAreas(route)
    const elevated = activeElevatedLayer()
    const ground = elevated?.setRoute(route, band) ?? [band.coords]
    const groundChoices = elevated?.addRouteChoiceAreas(route, choices) ?? choices
    src('route').setData({
      type: 'FeatureCollection',
      features: [
        ...ground.filter((cs) => cs.length >= 2).map((cs) => ({
          type: 'Feature', properties: { role: 'primary' },
          geometry: { type: 'LineString', coordinates: cs },
        })),
        ...groundChoices.filter((choice) => choice.ring.length >= 4).map((choice) => ({
          type: 'Feature',
          properties: { role: 'choice-area', laneIndices: choice.laneIndices.join(','),
            primaryLaneIndex: choice.primaryLaneIndex },
          geometry: { type: 'Polygon', coordinates: [choice.ring] },
        })),
      ],
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

  /**
   * 換路線時重算「這趟會遇到的測速照相」。方向過濾在這裡就做掉（比對路線在該點的
   * 行向與相機拍攝方向），所以導航中每幀只要比里程，不用再算幾何。
   * reroute／路口決策的暫時路線也走這裡——不重算的話會拿舊路線的里程去對新路線。
   */
  function armSpeedCameras(route: RouteResult) {
    const cameras = p.speedCamerasRef.current
    routeCamerasRef.current = cameras.length
      ? matchCamerasToRoute(cameras, route.coords, route.cum)
      : []
    voiceRef.current.reset()
    setCameraAlert(null)
    if (import.meta.env.DEV && routeCamerasRef.current.length) {
      console.info('本趟測速照相：', routeCamerasRef.current.map((rc) =>
        `${Math.round(rc.alongM)}m ${rc.camera.address}（速限 ${rc.camera.speedLimitKph}）`))
    }
  }

  /** 依目前里程/車速更新測速提示＋語音。距離每變 10m 才換 state，免得整個 HUD 一直重畫。 */
  function updateSpeedCameraAlert(s: DriveState) {
    if (routeCamerasRef.current.length === 0) return
    const next = s.arrived ? null : speedCameraAlertAt(routeCamerasRef.current, s.traveledM, s.speedKmh)
    voiceRef.current.say(speedCameraAnnouncement(next))
    setCameraAlert((prev) => {
      if (prev === next) return prev
      if (prev && next
        && prev.camera.id === next.camera.id
        && prev.phase === next.phase
        && prev.overLimit === next.overLimit
        && Math.round(prev.distanceM / 10) === Math.round(next.distanceM / 10)) return prev
      return next
    })
  }

  function stopAllDrivers() {
    sessionRef.current++
    nativeCommand('navigation', { active: false })
    gpsDriverRef.current?.stop()
    gpsDriverRef.current = null
    setGpsMsg(null)
    setDrive(null)
    lastDriveRef.current = null
    setFollow(true) // 下一趟導航從「跟隨」開始
    routeCamerasRef.current = []
    voiceRef.current.reset()
    setCameraAlert(null)
    p.vehicleLayerRef.current?.setNav(null)
    activeNavigationOcclusion()?.clear()
    updateZoneHighlight(null)
    // 回到瀏覽模式：鏡頭高度交還給地面，免得停在高架上時整張圖都還吊在半空。
    // clearAllRoute 在瀏覽模式下也會走到這裡，所以只在導航真的抬過鏡頭時才復原，
    // 不要平白送出一次相機事件。
    const map = p.mapRef.current
    if (map && !map.getCenterClampedToGround()) {
      map.jumpTo({ elevation: 0 })
      setNavCameraClamp(map, true)
    }
  }

  function runGpsNav(resume: boolean) {
    const route = p.routeRef.current
    const map = p.mapRef.current
    if (!route || !map) return
    p.setMode('drive')
    nativeCommand('navigation', { active: true })
    map.setLayoutProperty('oneway-arrow', 'visibility', 'none')
    map.setLayoutProperty('road-label', 'visibility', 'none')
    setNavCameraClamp(map, false)
    if (!resume) setFollow(true)
    if (followingRef.current) map.jumpTo(navCamera()) // 跟模擬駕駛對齊的導航視角
    if (!resume) setGpsMsg('取得 GPS 位置中…（手機請允許定位權限）')
    armSpeedCameras(route)
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
        // 使用者滑走地圖後就不再跟隨（要按「回到目前位置」才恢復）；
        // 縮放手勢仍只是暫時讓路 250ms，不會中斷跟隨。
        if (followingRef.current && performance.now() - p.lastGestureRef.current > 250) {
          map.jumpTo({
            center: s.pos, bearing: s.bearing, padding: camPadding,
            elevation: s.elevM ?? 0, // 高架上鏡頭跟著抬同樣高度
          })
        }
        setGpsMsg(null)
        setDrive(s)
        updateSpeedCameraAlert(s)
      },
      (pos) => rerouteFrom(pos),
      (msg) => setGpsMsg(msg),
    )
    gpsDriverRef.current = gps
    gps.start()
  }

  /** 重新規劃：從目前（可能已偏離）位置到終點重算路線並接續導航。共用給鍵盤橫移/路口決策/GPS 離線等各種偏離觸發情境。 */
  /** 對外的「開始導航」入口——包一層是為了不把 click 事件物件當成 resume 參數 */
  async function startGpsNav() {
    const session = ++sessionRef.current
    p.setMode('drive')
    setDrive(null)
    setGpsMsg('正在確認定位權限…')
    try {
      await ensureLocation()
      if (session === sessionRef.current) runGpsNav(false)
    } catch (e) {
      if (session === sessionRef.current) setGpsMsg(e instanceof Error ? e.message : '無法啟動定位')
    }
  }

  function rerouteFrom(pos: [number, number]) {
    const to = p.stopsRef.current[p.stopsRef.current.length - 1]?.pos
    const g = p.graphRef.current
    if (!to || !g) return
    const result = g.routeDetailed(pos, to, p.profileRef.current, p.routePolicy)
    const route = result.route
    if (!route) {
      setGpsMsg(routeFailureText(result.failure, 1))
      return
    }
    setGpsMsg(null)
    p.annotateTwoStage(route)
    p.routeRef.current = route
    drawRouteLine(route)
    // 目前是 GPS 導航中就繼續用 GPS 接續，否則走模擬（鍵盤橫移/路口決策都是模擬觸發）
    if (gpsDriverRef.current) runGpsNav(true)
  }

  return { drive, gpsMsg, cameraAlert, startGpsNav, stopAllDrivers, following, recenter }
}
