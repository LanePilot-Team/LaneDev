import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import maplibregl, { Map as MLMap, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Polygon } from 'geojson'
import { buildStyle, makeIcons } from '../core/mapStyle'
import { asset } from '../core/asset'
import type { RoadFeature } from '../core/roads'
import type { DropRemap } from '../core/couplet'
import { RoadGraph } from '../core/graph'
import { type Zone } from '../core/zones'
import type { EnhancementRecord } from '../core/enhancements'
import type { RoadMergeReplayRow, RoadMergeViews } from '../core/roadMerge'
import type { RawWay } from '../core/zoneimport'
import { speedCamerasToGeoJson, type SpeedCamera, type SpeedCameraDataset } from '../core/speedCameras'
import type { TurnBay, RightLane, MotoBox } from '../core/turnbays'
import type { PlacedVehicle } from '../core/vehicles'
import { VehicleModelLayer } from '../core/models3d'
import { ElevationModel, setActiveElevation } from '../core/elevation'
import { ElevatedLayer, setActiveElevatedLayer, surfaceHeightAt } from '../core/elevated3d'
import { NANZI_CENTER } from '../core/geo'
import { NavigationOcclusion, setActiveNavigationOcclusion } from '../core/occlusion'
import { buildLaneBaseIndex, type LaneBaseApplyReport, type LaneBaseIndex, type LaneBaseRecord } from '../core/laneBase'
import { loadRuntimeData, runtimeAsset } from '../core/runtimeData'

export type Mode = 'browse' | 'edit' | 'pick' | 'drive'
export const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const
async function loadSpeedCameraDataset(): Promise<SpeedCameraDataset> {
  const res = await fetch(asset('/data/speed_cameras.json'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as SpeedCameraDataset
  if (!Array.isArray(data.cameras)) throw new Error('cameras 欄位缺失')
  return data
}


export interface MapCore {
  mapRef: RefObject<MLMap | null>
  /** 尚未套用 Lane Base／人工 journal 的 prepared roads，用於 session 匯入重建。 */
  preparedRoadsRef: RefObject<RoadFeature[]>
  roadsRef: RefObject<RoadFeature[]>
  renderRoadsRef: RefObject<RoadFeature[]>
  mergeReplayRef: RefObject<RoadMergeReplayRow[]>
  graphRef: RefObject<RoadGraph | null>
  laneBaseIndexRef: RefObject<LaneBaseIndex>
  zonesRef: RefObject<Zone[]>
  /** 每次 Lane Base 重建所得唯讀待轉區；不寫入 editor persistence。 */
  baseZonesRef: RefObject<Zone[]>
  selectedZoneRef: RefObject<string | null>
  highlightedZoneRef: RefObject<string | null>
  journalRef: RefObject<EnhancementRecord[]>
  baysRef: RefObject<TurnBay[]>
  /** 右轉附加車道（journal right_lane 折疊生成，refreshBays 重算） */
  rightLanesRef: RefObject<RightLane[]>
  /** 機車停等格（refreshBays 重算）——編輯面板讀 maxLanes/coveredLanes */
  motoBoxesRef: RefObject<MotoBox[]>
  intersectionsRef: RefObject<{ id: number; pos: [number, number] }[]>
  vehiclesRef: RefObject<PlacedVehicle[]>
  vehicleLayerRef: RefObject<VehicleModelLayer | null>
  selectedVehicleRef: RefObject<string | null>
  lastGestureRef: RefObject<number>
  /**
   * 使用者自己動了鏡頭（拖曳／旋轉／傾斜）時呼叫。導航跟隨用它來交還鏡頭控制權——
   * 事件註冊在這裡（地圖實例的擁有者），實際「要不要停止跟隨」由 nav/useDrive 決定。
   */
  onUserCameraTakeoverRef: RefObject<(() => void) | null>
  /** couplet 合併造成的 node id 重映射（原始 OSM node → 合併後 node） */
  nodeRemapRef: RefObject<Map<number, number>>
  /** 被合併（drop 側）way → keep way 對照（LanePilot 標註匯入重映射用） */
  wayRemapRef: RefObject<Map<number, DropRemap>>
  /** 前處理「之前」的原始 way 幾何快照（標註匯入的進入方位角後援：
   * couplet/退化清理清掉的 way 在底圖與 wayRemap 都查不到） */
  rawWaysRef: RefObject<Map<number, RawWay>>
  /** 測速執法設置點（警政署開放資料，楠梓＋左營）——導航提示與地圖圖層共用 */
  speedCamerasRef: RefObject<SpeedCamera[]>
  /** 測速資料的來源／最後同步時間（授權要求顯名，畫面要能標示） */
  speedCameraSourceRef: RefObject<SpeedCameraDataset['source'] | null>
  /** 大眾運輸資料（TDX，楠梓＋左營）；未載入完成前為 null */
  src: (id: string) => GeoJSONSource
  refreshZones: (persist?: boolean) => void
  setZoneHighlight: (id: string | null) => void
  refreshBays: () => void
  refreshVehicles: () => void
  /** 路面與車道分隔線重繪（journal 覆寫/標註匯入後） */
  redrawRoads: () => void
  /** 換 Base Layer：換路網、重建圖、重算 bay（匯入地圖用） */
  replaceBaseMap: (roads: RoadFeature[]) => boolean
  /** 以目前 prepared roads 重建 session-only Lane Base，再套用人工 journal。 */
  replaceSessionLaneBase: (records: LaneBaseRecord[]) => LaneBaseApplyReport
  /** 純預覽 journal 對捏合視圖的影響，不改動任何 ref。 */
  previewJournal: (journal: EnhancementRecord[]) => RoadMergeViews | null
  /** 以目前來源道路和 journal 原子重建導航／繪圖雙視圖。 */
  refreshRoadMergeViews: (
    journal?: EnhancementRecord[], preparedView?: RoadMergeViews,
  ) => boolean
}

export interface MapCoreState {
  core: MapCore
  loading: boolean
  loadError: string | null
  zoneCount: number
  zoneTick: number
  vehicleCount: number
  selectedVehicle: PlacedVehicle | null
}

export function useMapCore(
  containerRef: RefObject<HTMLDivElement | null>,
  onMapClick: (e: MapMouseEvent, map: MLMap) => void,
): MapCoreState {
  const mapRef = useRef<MLMap | null>(null)
  const preparedRoadsRef = useRef<RoadFeature[]>([])
  const roadsRef = useRef<RoadFeature[]>([])
  const renderRoadsRef = useRef<RoadFeature[]>([])
  const mergeReplayRef = useRef<RoadMergeReplayRow[]>([])
  const graphRef = useRef<RoadGraph | null>(null)
  const laneBaseIndexRef = useRef<LaneBaseIndex>(buildLaneBaseIndex([]))
  const zonesRef = useRef<Zone[]>([])
  const baseZonesRef = useRef<Zone[]>([])
  const selectedZoneRef = useRef<string | null>(null)
  const highlightedZoneRef = useRef<string | null>(null)
  const journalRef = useRef<EnhancementRecord[]>([])
  const baysRef = useRef<TurnBay[]>([])
  const rightLanesRef = useRef<RightLane[]>([])
  const motoBoxesRef = useRef<MotoBox[]>([])
  const intersectionsRef = useRef<{ id: number; pos: [number, number] }[]>([])
  const vehiclesRef = useRef<PlacedVehicle[]>([])
  const vehicleLayerRef = useRef<VehicleModelLayer | null>(null)
  const elevatedLayerRef = useRef<ElevatedLayer | null>(null)
  const selectedVehicleRef = useRef<string | null>(null)
  const lastGestureRef = useRef(0) // 最近一次滾輪/觸控手勢的時間戳（導航跟隨要讓路給縮放）
  const onUserCameraTakeoverRef = useRef<(() => void) | null>(null)
  const nodeRemapRef = useRef<Map<number, number>>(new Map())
  const wayRemapRef = useRef<Map<number, DropRemap>>(new Map())
  const rawWaysRef = useRef<Map<number, RawWay>>(new Map())
  const speedCamerasRef = useRef<SpeedCamera[]>([])
  const speedCameraSourceRef = useRef<SpeedCameraDataset['source'] | null>(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [zoneCount, setZoneCount] = useState(0)
  const [zoneTick, setZoneTick] = useState(0)
  const [vehicleCount, setVehicleCount] = useState(0)
  const [selectedVehicle, setSelectedVehicle] = useState<PlacedVehicle | null>(null)

  // 點擊分派由 App 組裝（LaneNav 沒有 edit 分支）；用 ref 存最新 closure，地圖 handler 只綁一次
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick

  const src = useCallback((id: string) => mapRef.current!.getSource(id) as GeoJSONSource, [])

  const zoneFeatureIdsRef = useRef(new Map<string, string[]>())
  const setZoneHighlight = useCallback((id: string | null) => {
    const map = mapRef.current
    if (!map || highlightedZoneRef.current === id) return
    for (const featureId of zoneFeatureIdsRef.current.get(highlightedZoneRef.current ?? '') ?? []) {
      map.setFeatureState({ source: 'zones', id: featureId }, { highlighted: false })
    }
    highlightedZoneRef.current = id
    for (const featureId of zoneFeatureIdsRef.current.get(id ?? '') ?? []) {
      map.setFeatureState({ source: 'zones', id: featureId }, { highlighted: true })
    }
  }, [])

  const refreshZones = useCallback((_persist = false) => {
    setZoneHighlight(null)
    setZoneCount(zonesRef.current.length)
    setZoneTick(t => t + 1)
  }, [setZoneHighlight])

  const refreshBays = () => { throw new Error('預計算資料為唯讀') }

  const refreshVehicles = useCallback(() => {
    // 車輛高度：把位置重新吸附回車道拿到「路段身分」，再問該路段的橋面高度。
    // 不能用純位置查最近高架——平面路從高架正下方穿過時會誤抬（elevation.ts）。
    // 吸附用的是放置時同一支 snapToLane，所以既有存檔的車也會被擺回正確高度。
    const elevOf = (v: PlacedVehicle) => {
      const snap = graphRef.current?.snapToLane(v.pos, v.type)
      return snap?.feature ? surfaceHeightAt(snap.feature, v.pos) : 0
    }
    vehicleLayerRef.current?.setVehicles(
      vehiclesRef.current, selectedVehicleRef.current, elevOf)
    void 0
    setVehicleCount(vehiclesRef.current.length)
    setSelectedVehicle(
      vehiclesRef.current.find((v) => v.id === selectedVehicleRef.current) ?? null)
  }, [])

  const redrawRoads = () => { throw new Error('預計算資料為唯讀') }

  /** 高架高度模型重建（底圖就緒/更換時）：渲染（橋面）與車輛 z 共用同一份 */
  const rebuildElevation = useCallback((data: ReturnType<ElevationModel['snapshot']>) => {
    const model = ElevationModel.fromSnapshot(data)
    setActiveElevation(model)
    elevatedLayerRef.current?.setModel(model)
  }, [])

  const readOnly = (): never => { throw new Error('Android 用戶端不允許修改道路資料') }

  const coreRef = useRef<MapCore>(null as never)
  if (!coreRef.current) {
    coreRef.current = {
      mapRef, preparedRoadsRef, roadsRef, renderRoadsRef, mergeReplayRef,
      graphRef, laneBaseIndexRef, zonesRef, baseZonesRef, selectedZoneRef, highlightedZoneRef,
      journalRef, baysRef,
      rightLanesRef, motoBoxesRef,
      intersectionsRef, vehiclesRef, vehicleLayerRef, selectedVehicleRef, lastGestureRef,
      onUserCameraTakeoverRef,
      nodeRemapRef, wayRemapRef, rawWaysRef,
      speedCamerasRef, speedCameraSourceRef,
      src, refreshZones, setZoneHighlight, refreshBays, refreshVehicles,
      redrawRoads, replaceBaseMap: readOnly, replaceSessionLaneBase: readOnly,
      previewJournal: () => null, refreshRoadMergeViews: readOnly,
    }
  }

  // ── 地圖初始化 ──
  useEffect(() => {
    const abort = new AbortController()
    let disposed = false
    // Begin reading navigation data while the map style and icons initialize.
    const runtimePromise = loadRuntimeData(abort.signal)
    void runtimePromise.catch(() => {})
    const bootTimeout = window.setTimeout(() => {
      if (disposed) return
      setLoadError('載入路網逾時，請重新載入；若持續失敗請重新安裝完整版本')
      abort.abort()
    }, 30000)
    let bootPhase = performance.now()
    function bootMeasure(name: string) {
      const end = performance.now()
      performance.measure('lanedev-boot:' + name, { start: bootPhase, end })
      console.info('[startup]', name, Math.round(end - bootPhase) + 'ms')
      bootPhase = end
    }
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: buildStyle(),
      center: NANZI_CENTER,
      zoom: 12.4,
      maxPitch: 70,
      // 內顯效能：把渲染像素密度上限鎖在 1.5×（高 DPI 螢幕的畫布像素數會翻倍以上）
      pixelRatio: Math.min(window.devicePixelRatio, 1.5),
      fadeDuration: 0, // 符號淡入淡出動畫關掉，省連續重繪
      attributionControl: {
        compact: true,
        customAttribution: '© OpenStreetMap contributors',
      },
      // 效能：MSAA 與 preserveDrawingBuffer 在內顯上很貴，只在 ?screenshot 時開
      canvasContextAttributes: false
        ? { antialias: true, preserveDrawingBuffer: true }
        : undefined,
      // 所有字形本機繪製，不等待外部字型服務。
      localIdeographFontFamily: '"Microsoft JhengHei", "PingFang TC", sans-serif',
    })
    mapRef.current = map
    map.touchZoomRotate.enableRotation()
    // 記錄縮放手勢時間：jumpTo 內部會 stop() 掉進行中的手勢動畫（handlers.stop），
    // 導航 30Hz 跟隨會把滾輪的平滑縮放掐死——跟隨迴圈靠這個時間戳暫時讓路
    map.on('wheel', () => { lastGestureRef.current = performance.now() })
    map.on('touchmove', () => { lastGestureRef.current = performance.now() })
    // 使用者「自己把鏡頭移開」＝要求自由瀏覽（Google 地圖的行為）。只認帶 originalEvent
    // 的事件——導航跟隨自己的 jumpTo 也會觸發 move/rotate，那不算使用者接管。
    // 縮放不算：導航中放大看路口是常態，不該因此中斷跟隨（滾輪另有 250ms 讓路）。
    const takeover = (ev: { originalEvent?: unknown }) => {
      if (!ev.originalEvent) return
      onUserCameraTakeoverRef.current?.()
    }
    map.on('dragstart', takeover)
    map.on('rotatestart', takeover)
    map.on('pitchstart', takeover)
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__map = map

    map.on('load', async () => {
      try {
      bootMeasure('map-style-load')
      const icons = makeIcons()
      for (const [name, img] of Object.entries(icons)) map.addImage(name, img)
      const loadSvg = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`無法載入路面標誌：${url}`))
        img.src = url
      })
      const [motorcycleIcon, bicycleIcon] = await Promise.all([
        loadSvg(asset('/assets/road-markings/motorcycle.svg')),
        loadSvg(asset('/assets/road-markings/bicycle.svg')),
      ])
      if (disposed || abort.signal.aborted) return
      bootMeasure('road-icon-decode')
      map.addImage('moto-box-motorcycle', motorcycleIcon)
      map.addImage('moto-box-bicycle', bicycleIcon)

      // 測速執法設置點：與路網載入解耦——這是行車提示不是底圖，資料抓不到
      // 只該少一個提示，不能讓整個導航起不來（資料指引第 4 節的「資料源短暫異常」）
      loadSpeedCameraDataset().then((dataset) => {
        if (disposed) return
        speedCamerasRef.current = dataset.cameras
        speedCameraSourceRef.current = dataset.source
        src('speedCameras').setData(speedCamerasToGeoJson(dataset.cameras) as never)
        console.info(`測速執法設置點 ${dataset.cameras.length} 筆（${dataset.districts.join('、')}）`
          + `，來源同步時間 ${dataset.source.fetchedAt}`)
      }).catch((cause) => {
        console.warn('測速執法設置點載入失敗，本次導航沒有測速提示：', cause)
      })

      const { manifest, navigation } = await runtimePromise
      if (disposed) return
      bootMeasure('read-precomputed-navigation')
      roadsRef.current = navigation.roads
      laneBaseIndexRef.current = navigation.laneBaseIndex
      zoneFeatureIdsRef.current = navigation.zoneFeatureIds
      zonesRef.current = navigation.zones
      baseZonesRef.current = navigation.zones
      baysRef.current = navigation.bays
      rightLanesRef.current = navigation.rightLanes
      motoBoxesRef.current = navigation.motoBoxes
      graphRef.current = RoadGraph.fromSnapshot(navigation.graph, navigation.roads)
      intersectionsRef.current = graphRef.current.intersections()
      setZoneCount(navigation.zones.length)
      setZoneTick(t => t + 1)
      bootMeasure('hydrate-routing-graph')
      // URL sources are parsed by MapLibre workers, not JSON.parse on the UI thread.
      const layerLoads: Promise<void>[] = []
      for (const [id, record] of Object.entries(manifest.sources)) {
        if (!map.getSource(id)) throw new Error('不支援的地圖來源：' + id)
        const source = src(id)
        let sourceError: Error | null = null
        const onError = () => { sourceError = new Error('地圖來源載入失敗：' + id) }
        source.on('error', onError)
        layerLoads.push(source.setData(new URL(runtimeAsset(record.file), location.href).href, true)
          .then(() => { if (sourceError) throw sourceError })
          .finally(() => source.off('error', onError)))
      }
      const sourcesReady = Promise.all(layerLoads)
      void sourcesReady.catch(() => {})
      const buildingsResponse = await fetch(runtimeAsset(manifest.sources.buildings.file), { signal: abort.signal })
      if (!buildingsResponse.ok) throw new Error('無法讀取建築資料')
      const buildings = await buildingsResponse.json() as FeatureCollection<Polygon>
      if (disposed) return
      setActiveNavigationOcclusion(new NavigationOcclusion(map, buildings.features as never))
      bootMeasure('submit-precomputed-layers')
      // 高架橋面 3D 圖層（three.js）——先於車輛圖層加入，車輛畫在橋面之上
      const eLayer = new ElevatedLayer()
      elevatedLayerRef.current = eLayer
      setActiveElevatedLayer(eLayer) // usePlanner/useDrive 畫路線絲帶用（模組單例）
      rebuildElevation(navigation.elevation)
      map.addLayer(eLayer.asLayer())
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__elayer = eLayer
      // 真 3D 車輛模型圖層（three.js）
      const vLayer = new VehicleModelLayer()
      vehicleLayerRef.current = vLayer
      map.addLayer(vLayer.asLayer())
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__vlayer = vLayer
      vehiclesRef.current = []
      refreshVehicles()
      bootMeasure('3d-models')
      await sourcesReady
      if (disposed || abort.signal.aborted) return
      bootMeasure('map-sources-ready')
      clearTimeout(bootTimeout)
      setLoading(false)
      } catch (cause) {
        if (disposed) return
        clearTimeout(bootTimeout)
        console.error('[startup] failed', cause)
        if (!abort.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '路網載入失敗')
        // Keep navigation disabled; never fall back to expensive recomputation.
      }
    })

    map.on('click', (e) => clickRef.current(e, map))

    return () => {
      disposed = true
      clearTimeout(bootTimeout)
      abort.abort()
      setActiveNavigationOcclusion(null)
      setActiveElevatedLayer(null)
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    core: coreRef.current,
    loading, loadError, zoneCount, zoneTick, vehicleCount, selectedVehicle,
  }
}
