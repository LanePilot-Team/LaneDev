import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import maplibregl, { AttributionControl, Map as MLMap, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Polygon } from 'geojson'
import { buildStyle, makeIcons } from '../core/mapStyle.ts'
import { asset } from '../core/asset.ts'
import { RoadGraph } from '../core/graph.ts'
import { type Zone } from '../core/zones.ts'
import { speedCamerasToGeoJson, type SpeedCamera, type SpeedCameraDataset } from '../core/speedCameras.ts'
import type { TurnBay, RightLane } from '../core/turnbays.ts'
import { VehicleModelLayer } from '../core/models3d.ts'
import { ElevationModel, setActiveElevation } from '../core/elevation.ts'
import { ElevatedLayer, setActiveElevatedLayer } from '../core/elevated3d.ts'
import { NANZI_CENTER } from '../core/geo.ts'
import { NavigationOcclusion, setActiveNavigationOcclusion } from '../core/occlusion.ts'
import { buildLaneBaseIndex, type LaneBaseIndex } from '../core/laneBase.ts'
import { loadRuntimeData, runtimeAsset } from '../core/runtimeData.ts'

export type Mode = 'browse' | 'pick' | 'drive'
export const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

function formatAttributionLines(map: MLMap) {
  const inner = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-attrib-inner')
  if (!inner || typeof MutationObserver === 'undefined') return

  const format = () => {
    const children = Array.from(inner.children)
    if (children.length > 0 && children.every(child => child.classList.contains('lanedev-attribution-line'))) return

    const html = inner.innerHTML.trim()
    if (!html) return
    const parts = html.split(' | ').map(part => part.trim()).filter(Boolean)
    inner.replaceChildren(...parts.map(part => {
      const line = document.createElement('span')
      line.className = 'lanedev-attribution-line'
      line.innerHTML = part.replace('內政部警政署', '內政部警政署<br />')
      return line
    }))
  }

  format()
  const observer = new MutationObserver(format)
  observer.observe(inner, { childList: true, characterData: true, subtree: true })
  map.once('remove', () => observer.disconnect())
}

async function loadSpeedCameraDataset(): Promise<SpeedCameraDataset> {
  const res = await fetch(asset('/data/speed_cameras.json'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as SpeedCameraDataset
  if (!Array.isArray(data.cameras)) throw new Error('cameras 欄位缺失')
  return data
}


/** 用戶端唯讀：路網、待轉區、偏心道等全部來自建置期預計算資料，執行期不改寫。 */
export interface MapCore {
  mapRef: RefObject<MLMap | null>
  graphRef: RefObject<RoadGraph | null>
  laneBaseIndexRef: RefObject<LaneBaseIndex>
  zonesRef: RefObject<Zone[]>
  baysRef: RefObject<TurnBay[]>
  /** 右轉附加車道（路線標註右轉車道用） */
  rightLanesRef: RefObject<RightLane[]>
  vehicleLayerRef: RefObject<VehicleModelLayer | null>
  lastGestureRef: RefObject<number>
  /**
   * 使用者自己動了鏡頭（拖曳／旋轉／傾斜）時呼叫。導航跟隨用它來交還鏡頭控制權——
   * 事件註冊在這裡（地圖實例的擁有者），實際「要不要停止跟隨」由 nav/useDrive 決定。
   */
  onUserCameraTakeoverRef: RefObject<(() => void) | null>
  /** 測速執法設置點（警政署開放資料）——導航提示與地圖圖層共用 */
  speedCamerasRef: RefObject<SpeedCamera[]>
  src: (id: string) => GeoJSONSource
  /** 清除待轉區高亮並通知畫面重繪（切換模式時用） */
  refreshZones: () => void
  setZoneHighlight: (id: string | null) => void
}

export interface MapCoreState {
  core: MapCore
  loading: boolean
  loadError: string | null
  zoneTick: number
}

export function useMapCore(
  containerRef: RefObject<HTMLDivElement | null>,
  onMapClick: (e: MapMouseEvent, map: MLMap) => void,
): MapCoreState {
  const mapRef = useRef<MLMap | null>(null)
  const graphRef = useRef<RoadGraph | null>(null)
  const laneBaseIndexRef = useRef<LaneBaseIndex>(buildLaneBaseIndex([]))
  const zonesRef = useRef<Zone[]>([])
  const highlightedZoneRef = useRef<string | null>(null)
  const baysRef = useRef<TurnBay[]>([])
  const rightLanesRef = useRef<RightLane[]>([])
  const vehicleLayerRef = useRef<VehicleModelLayer | null>(null)
  const elevatedLayerRef = useRef<ElevatedLayer | null>(null)
  const lastGestureRef = useRef(0) // 最近一次滾輪/觸控手勢的時間戳（導航跟隨要讓路給縮放）
  const onUserCameraTakeoverRef = useRef<(() => void) | null>(null)
  const speedCamerasRef = useRef<SpeedCamera[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [zoneTick, setZoneTick] = useState(0)

  // 點擊分派由 App 組裝；用 ref 存最新 closure，地圖 handler 只綁一次
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

  const refreshZones = useCallback(() => {
    setZoneHighlight(null)
    setZoneTick(t => t + 1)
  }, [setZoneHighlight])

  /** 高架高度模型重建（底圖就緒/更換時）：渲染（橋面）與車輛 z 共用同一份 */
  const rebuildElevation = useCallback((data: ReturnType<ElevationModel['snapshot']>) => {
    const model = ElevationModel.fromSnapshot(data)
    setActiveElevation(model)
    elevatedLayerRef.current?.setModel(model)
  }, [])

  const coreRef = useRef<MapCore>(null as never)
  if (!coreRef.current) {
    coreRef.current = {
      mapRef, graphRef, laneBaseIndexRef, zonesRef, baysRef, rightLanesRef,
      vehicleLayerRef, lastGestureRef, onUserCameraTakeoverRef, speedCamerasRef,
      src, refreshZones, setZoneHighlight,
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
      attributionControl: false,
      // 效能：不開 MSAA 與 preserveDrawingBuffer（內顯上很貴）
      // 所有字形本機繪製，不等待外部字型服務。
      localIdeographFontFamily: '"Microsoft JhengHei", "PingFang TC", sans-serif',
    })
    map.addControl(new AttributionControl({
      compact: true,
      customAttribution: '© OpenStreetMap contributors',
    }), 'bottom-left')
    formatAttributionLines(map)
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
        src('speedCameras').setData(speedCamerasToGeoJson(dataset.cameras) as never)
        console.info(`測速執法設置點 ${dataset.cameras.length} 筆（${dataset.districts.join('、')}）`
          + `，來源同步時間 ${dataset.source.fetchedAt}`)
      }).catch((cause) => {
        console.warn('測速執法設置點載入失敗，本次導航沒有測速提示：', cause)
      })

      const { manifest, navigation } = await runtimePromise
      if (disposed) return
      bootMeasure('read-precomputed-navigation')
      laneBaseIndexRef.current = navigation.laneBaseIndex
      zoneFeatureIdsRef.current = navigation.zoneFeatureIds
      zonesRef.current = navigation.zones
      baysRef.current = navigation.bays
      rightLanesRef.current = navigation.rightLanes
      graphRef.current = RoadGraph.fromSnapshot(navigation.graph, navigation.roads)
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
      const occlusion = new NavigationOcclusion(map, buildings.features as never)
      setActiveNavigationOcclusion(occlusion)
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
      bootMeasure('3d-models')
      await sourcesReady
      if (disposed || abort.signal.aborted) return
      // Camera gestures and zoom still update occlusion while GPS is stationary.
      let occlusionTimer: ReturnType<typeof setTimeout> | undefined
      map.on('move', () => occlusion.updateCamera(map))
      map.on('moveend', () => {
        // jumpTo emits moveend on every animation frame. Flush only after the
        // camera settles, instead of bypassing the throttle at display rate.
        clearTimeout(occlusionTimer)
        occlusionTimer = setTimeout(() => occlusion.updateCamera(map, true), 125)
      })
      map.on('remove', () => clearTimeout(occlusionTimer))
      occlusion.updateCamera(map, true)
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
    loading, loadError, zoneTick,
  }
}
