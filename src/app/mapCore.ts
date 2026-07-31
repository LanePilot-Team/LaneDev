// 地圖核心：MapLibre 初始化、預設 shard 底圖載入、journal 載入/套用、
// 跨功能共用的 refs 與重繪函式。LaneDev / LaneNav 兩個 App 共用（sync-lanenav 鏡像），
// App.tsx 只留「模式機 + 點擊分派 + 畫面組裝」。
import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson'
import { buildStyle, makeIcons } from '../core/mapStyle'
import { asset } from '../core/asset'
import {
  buildDividers, buildRoadSurfaces, roadsForRendering, roadsFromGeoJSON, type RoadFeature,
} from '../core/roads'
import { prepareBaseRoads } from '../core/pipeline'
import type { DropRemap } from '../core/couplet'
import { parseImported } from '../core/importmap'
import { RoadGraph } from '../core/graph'
import {
  loadDeletedZoneIds, loadZones, saveZones, zonesToGeoJSON, type Zone,
} from '../core/zones'
import {
  loadJournal, foldJournal, applyToRoads, remapJournalNodes, type EnhancementRecord,
} from '../core/enhancements'
import {
  buildRoadMergeViews, type RoadMergeReplayRow, type RoadMergeViews,
} from '../core/roadMerge'
import { buildRawWays, zonesFromAnnotations, type RawWay } from '../core/zoneimport'
import { newRoadsFromFolded } from '../core/newroads'
import {
  buildTurnBays, buildChannelization, buildLaneArrows, buildRightLanes, buildStopLines,
  buildSpecifiedWhiteMotoHatch,
  buildLeftTurnWaitingAreas,
  buildMotoBoxes, buildMotoLaneEntryIcons, buildUnusedLaneGores, baysToGeoJSON,
  type TurnBay, type RightLane, type MotoBox,
} from '../core/turnbays'
import { buildRoadTexts } from '../core/roadtext'
import {
  buildMedians, buildCenterIslands, buildMotoSepIslands, buildTwinIslands, mediansToGeoJSON,
} from '../core/medians'
import { loadVehicles, saveVehicles, type PlacedVehicle } from '../core/vehicles'
import { VehicleModelLayer } from '../core/models3d'
import { buildElevation, setActiveElevation } from '../core/elevation'
import { ElevatedLayer, setActiveElevatedLayer } from '../core/elevated3d'
import { NANZI_CENTER, haversine } from '../core/geo'
import { cleanIntersectionFeatures, roadsWithCleanupFlags } from '../core/intersectionCleanup'
import { groundMarkingPolygons } from '../core/groundMarkings'
import { NavigationOcclusion, setActiveNavigationOcclusion } from '../core/occlusion'
import {
  loadStaticRoadDatabase, staticAnnotations, staticSegments, updateStaticEditor,
} from '../core/staticDatabase'
import {
  buildLaneGuidanceIndex, remapLaneGuidanceRecords,
  type LaneGuidanceIndex, type LaneGuidanceRecord,
} from '../core/laneGuidance'

export type Mode = 'browse' | 'edit' | 'pick' | 'drive'

export const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

const METERS_PER_LATITUDE_DEGREE = 111_000
const NANZIH_TECHNOLOGY_PARK_STATION_OSM_ID = '112463293'
const JIACHANG_HAIZHUAN_ELEVATED_STATION_OSM_ID = '112463292'

function isElevatedStation(feature: Feature<Polygon>): boolean {
  const osmId = String(feature.properties?.osm_id ?? feature.id ?? '')
  return feature.properties?.building === 'train_station' ||
    osmId === JIACHANG_HAIZHUAN_ELEVATED_STATION_OSM_ID
}

/**
 * Widen both long sides of an elevated station and place a continuous support
 * wall at each new outer edge, away from the road beneath the station.
 */
function buildStationSideStructures(
  station: Feature<Polygon>,
  baseHeight: number,
): Feature<Polygon>[] {
  const ring = station.geometry.coordinates[0]
  if (!ring || ring.length < 4 || baseHeight <= 0) return []

  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length
  const metersPerLongitudeDegree = METERS_PER_LATITUDE_DEGREE * Math.cos(lat * Math.PI / 180)
  const vertices = ring.slice(0, -1)
  const center: [number, number] = [
    vertices.reduce((sum, point) => sum + point[0], 0) / vertices.length,
    vertices.reduce((sum, point) => sum + point[1], 0) / vertices.length,
  ]
  const edges = vertices.map((p, index) => {
    const q = ring[index + 1]
    const dx = (q[0] - p[0]) * metersPerLongitudeDegree
    const dy = (q[1] - p[1]) * METERS_PER_LATITUDE_DEGREE
    return { p, q, dx, dy, length: Math.hypot(dx, dy), index }
  }).filter((edge) => edge.length >= 12)
    .sort((a, b) => b.length - a.length)
  if (edges.length < 2) return []

  const osmId = String(station.properties?.osm_id ?? station.id ?? 'station')
  const isNanzihTechnologyParkStation =
    osmId === NANZIH_TECHNOLOGY_PARK_STATION_OSM_ID
  type StationEdge = (typeof edges)[number]
  let first: StationEdge | undefined
  let second: StationEdge | undefined
  if (isNanzihTechnologyParkStation) {
    // This station has four narrow projecting wings. Only the two sides of its
    // broad central body (ring edges 9 and 29) may receive support walls.
    first = edges.find((edge) => edge.index === 9)
    second = edges.find((edge) => edge.index === 29)
    if (!first || !second) return []
  } else {
    const primary = edges[0]
    first = primary
    second = edges.find((edge) => {
      const parallel = Math.abs(
        (primary.dx * edge.dx + primary.dy * edge.dy) / (primary.length * edge.length),
      )
      const firstMid = [(primary.p[0] + primary.q[0]) / 2, (primary.p[1] + primary.q[1]) / 2]
      const edgeMid = [(edge.p[0] + edge.q[0]) / 2, (edge.p[1] + edge.q[1]) / 2]
      const separation = Math.hypot(
        (edgeMid[0] - firstMid[0]) * metersPerLongitudeDegree,
        (edgeMid[1] - firstMid[1]) * METERS_PER_LATITUDE_DEGREE,
      )
      return parallel >= 0.88 && separation >= 5
    }) ?? edges[1]
  }
  if (!first || !second) return []

  return [first, second].flatMap((edge, supportIndex) => {
    const midpoint = [(edge.p[0] + edge.q[0]) / 2, (edge.p[1] + edge.q[1]) / 2]
    let nx = -edge.dy / edge.length
    let ny = edge.dx / edge.length
    const towardCenterX = (center[0] - midpoint[0]) * metersPerLongitudeDegree
    const towardCenterY = (center[1] - midpoint[1]) * METERS_PER_LATITUDE_DEGREE
    // Use the normal pointing away from the footprint centre.
    if (nx * towardCenterX + ny * towardCenterY > 0) {
      nx *= -1
      ny *= -1
    }
    const extensionWidth = isNanzihTechnologyParkStation ? 1.5 : 2.6
    const wallThickness = isNanzihTechnologyParkStation ? 0.55 : 1.0
    const offset = (meters: number): [number, number] => [
      nx * meters / metersPerLongitudeDegree,
      ny * meters / METERS_PER_LATITUDE_DEGREE,
    ]
    const innerWallOffset = offset(extensionWidth - wallThickness)
    const outerOffset = offset(extensionWidth)
    const extensionCoordinates: Position[][] = [[
      edge.p,
      edge.q,
      [edge.q[0] + outerOffset[0], edge.q[1] + outerOffset[1]],
      [edge.p[0] + outerOffset[0], edge.p[1] + outerOffset[1]],
      edge.p,
    ]]
    const supportCoordinates: Position[][] = [[
      [edge.p[0] + innerWallOffset[0], edge.p[1] + innerWallOffset[1]],
      [edge.q[0] + innerWallOffset[0], edge.q[1] + innerWallOffset[1]],
      [edge.q[0] + outerOffset[0], edge.q[1] + outerOffset[1]],
      [edge.p[0] + outerOffset[0], edge.p[1] + outerOffset[1]],
      [edge.p[0] + innerWallOffset[0], edge.p[1] + innerWallOffset[1]],
    ]]
    const sharedProperties = {
      ...(station.properties ?? {}),
      parent_osm_id: osmId,
      station_parent_building: station.properties?.building ?? 'yes',
    }
    return [
      {
        type: 'Feature',
        id: `station-extension/${osmId}/${supportIndex}`,
        properties: {
          ...sharedProperties,
          building: 'station_extension',
          height_m: Number(station.properties?.height_m) || baseHeight + 3,
          min_height_m: baseHeight,
        },
        geometry: { type: 'Polygon', coordinates: extensionCoordinates },
      },
      {
        type: 'Feature',
        id: `station-support/${osmId}/${supportIndex}`,
        properties: {
          ...sharedProperties,
          building: 'station_support',
          height_m: baseHeight,
          min_height_m: 0,
        },
        geometry: { type: 'Polygon', coordinates: supportCoordinates },
      },
    ] as Feature<Polygon>[]
  })
}

async function loadDefaultRoads() {
  await loadStaticRoadDatabase()
  const canonicalSegments = staticSegments()
  if (!canonicalSegments.length) throw new Error('唯一靜態道路資料庫沒有路段')
  const parsed = parseImported(
    canonicalSegments.map((record) => JSON.stringify(record)).join('\n'),
  )
  if (parsed.kind !== 'map') throw new Error('唯一靜態道路資料庫格式錯誤')
  return roadsFromGeoJSON(parsed.fc)
}

/** 跨功能共用的地圖狀態（refs 讓地圖 handler 安全讀寫）與重繪函式 */
async function loadLaneGuidanceRecords(): Promise<LaneGuidanceRecord[]> {
  try {
    const response = await fetch(asset('/data/lanepilot/lane-guidance.json'))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const records: unknown = await response.json()
    if (!Array.isArray(records)) throw new Error('根節點不是陣列')
    return records as LaneGuidanceRecord[]
  } catch (error) {
    console.warn('車道標註索引載入失敗，改用 OSM／系統推測', error)
    return []
  }
}

function guidanceIndexForRoads(
  records: LaneGuidanceRecord[],
  roads: RoadFeature[],
  nodeRemap: Map<number, number>,
  wayRemap: Map<number, DropRemap>,
): LaneGuidanceIndex {
  return buildLaneGuidanceIndex(remapLaneGuidanceRecords(records, {
    existingWayIds: new Set(roads.map((road) => road.properties.osm_id)),
    nodeRemap,
    wayRemap,
  }))
}

export interface MapCore {
  mapRef: RefObject<MLMap | null>
  roadsRef: RefObject<RoadFeature[]>
  renderRoadsRef: RefObject<RoadFeature[]>
  mergeReplayRef: RefObject<RoadMergeReplayRow[]>
  graphRef: RefObject<RoadGraph | null>
  zonesRef: RefObject<Zone[]>
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
  /** couplet 合併造成的 node id 重映射（原始 OSM node → 合併後 node） */
  nodeRemapRef: RefObject<Map<number, number>>
  /** 被合併（drop 側）way → keep way 對照（LanePilot 標註匯入重映射用） */
  wayRemapRef: RefObject<Map<number, DropRemap>>
  /** 前處理「之前」的原始 way 幾何快照（標註匯入的進入方位角後援：
   * couplet/退化清理清掉的 way 在底圖與 wayRemap 都查不到） */
  rawWaysRef: RefObject<Map<number, RawWay>>
  src: (id: string) => GeoJSONSource
  refreshZones: () => void
  setZoneHighlight: (id: string | null) => void
  refreshBays: () => void
  refreshVehicles: () => void
  /** 路面與車道分隔線重繪（journal 覆寫/標註匯入後） */
  redrawRoads: () => void
  /** 換 Base Layer：換路網、重建圖、重算 bay（匯入地圖用） */
  replaceBaseMap: (roads: RoadFeature[]) => boolean
  /** 純預覽 journal 對捏合視圖的影響，不改動任何 ref。 */
  previewJournal: (journal: EnhancementRecord[]) => RoadMergeViews | null
  /** 以目前來源道路和 journal 原子重建導航／繪圖雙視圖。 */
  refreshRoadMergeViews: (journal?: EnhancementRecord[]) => boolean
}

export interface MapCoreState {
  core: MapCore
  loading: boolean
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
  const roadsRef = useRef<RoadFeature[]>([])
  const renderRoadsRef = useRef<RoadFeature[]>([])
  const mergeReplayRef = useRef<RoadMergeReplayRow[]>([])
  const graphRef = useRef<RoadGraph | null>(null)
  const zonesRef = useRef<Zone[]>([])
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
  const nodeRemapRef = useRef<Map<number, number>>(new Map())
  const wayRemapRef = useRef<Map<number, DropRemap>>(new Map())
  const rawWaysRef = useRef<Map<number, RawWay>>(new Map())
  const laneGuidanceRecordsRef = useRef<LaneGuidanceRecord[]>([])
  const laneGuidanceIndexRef = useRef<LaneGuidanceIndex>(buildLaneGuidanceIndex([]))

  const [loading, setLoading] = useState(true)
  const [zoneCount, setZoneCount] = useState(0)
  const [zoneTick, setZoneTick] = useState(0)
  const [vehicleCount, setVehicleCount] = useState(0)
  const [selectedVehicle, setSelectedVehicle] = useState<PlacedVehicle | null>(null)

  // 點擊分派由 App 組裝（LaneNav 沒有 edit 分支）；用 ref 存最新 closure，地圖 handler 只綁一次
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick

  const src = useCallback((id: string) => mapRef.current!.getSource(id) as GeoJSONSource, [])

  const refreshZones = useCallback(() => {
    if (!mapRef.current) return
    if (
      highlightedZoneRef.current
      && zonesRef.current.some((z) => z.id === highlightedZoneRef.current && z.visible === false)
    ) {
      highlightedZoneRef.current = null
    }
    src('zones').setData(groundMarkingPolygons(
      zonesToGeoJSON(
        zonesRef.current,
        selectedZoneRef.current,
        highlightedZoneRef.current,
      ),
      (properties) => properties?.kind === 'outline-casing' ? 0.34
        : properties?.kind === 'outline' ? 0.18
          : null,
    ) as never)
    saveZones(zonesRef.current)
    setZoneCount(zonesRef.current.length)
    setZoneTick((t) => t + 1)
  }, [src])

  const setZoneHighlight = useCallback((id: string | null) => {
    if (highlightedZoneRef.current === id) return
    highlightedZoneRef.current = id
    if (!mapRef.current) return
    src('zones').setData(groundMarkingPolygons(
      zonesToGeoJSON(zonesRef.current, selectedZoneRef.current, id),
      (properties) => properties?.kind === 'outline-casing' ? 0.34
        : properties?.kind === 'outline' ? 0.18
          : null,
    ) as never)
  }, [src])

  /** 重算偏心左轉道（路網/車道數/journal 變動後都要跑：bay 的橫向位置依斷面寬推導） */
  const refreshBays = useCallback(() => {
    if (!mapRef.current || !graphRef.current) return
    // 所有地面樣式使用捏合後的繪圖圖；導航與編輯仍使用 graphRef 的來源拓撲。
    // 因此主路跨接縫連續，但側路端點仍存在並可生成自己的停止線。
    const renderGraph = new RoadGraph(renderRoadsRef.current)
    const journal = journalRef.current
    baysRef.current = buildTurnBays(renderGraph, journal)
    rightLanesRef.current = buildRightLanes(renderGraph, journal)
    // 中央帶標線（雙黃邊界＋槽化斜紋）＋ 路口停止線 ＋ 路口地面車道箭頭
    const channel = [
      ...buildChannelization(renderGraph, baysRef.current),
      ...buildSpecifiedWhiteMotoHatch(renderGraph),
    ]
    const stopLines = buildStopLines(
      renderGraph, baysRef.current, rightLanesRef.current, journal)
    const leftWaitAreas = buildLeftTurnWaitingAreas(renderGraph, baysRef.current)
    // 機車停等格（白框，停止線與車道箭頭之間）；有格的行向箭頭往後退讓
    const motoBoxes = buildMotoBoxes(
      renderGraph, baysRef.current, rightLanesRef.current, journal)
    motoBoxesRef.current = motoBoxes.boxes
    const laneArrows = buildLaneArrows(
      renderGraph, baysRef.current, rightLanesRef.current, motoBoxes.dirs,
      journal)
    const turnBayFeaturesRaw = baysToGeoJSON(
      baysRef.current, [...channel, ...stopLines, ...leftWaitAreas],
      laneArrows, rightLanesRef.current, motoBoxes.boxes)
    turnBayFeaturesRaw.features.push(
      ...buildMotoLaneEntryIcons(renderGraph, journal).features,
      ...buildUnusedLaneGores(renderGraph, baysRef.current).features)
    const turnBayFeatures = cleanIntersectionFeatures(turnBayFeaturesRaw)
    src('turnbays').setData(groundMarkingPolygons(
      turnBayFeatures,
      (p) => p?.kind === 'line'
        ? (p.color === 'stop' ? 0.45 : 0.15)
        : null,
    ) as never)
    // 分隔島：Case B 自動推導（成對單行間）+ 顯式配對（高雄大學路四線並排）
    // + Case A 編輯設定（中央帶類型 = 島）
    const renderRoads = roadsForRendering(renderRoadsRef.current)
    src('medians').setData(mediansToGeoJSON([
      ...buildMedians(renderRoads),
      ...buildTwinIslands(renderRoads, journalRef.current),
      ...buildMotoSepIslands(renderGraph),
      ...buildCenterIslands(renderGraph, baysRef.current),
    ]) as never)
    // 路面印字（禁行機車）：motorcycle 可被 journal 覆寫，跟著這條重算路徑走
    src('roadtext').setData(cleanIntersectionFeatures(
      buildRoadTexts(renderGraph, baysRef.current)) as never)
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bays = baysRef.current
  }, [src])

  const refreshVehicles = useCallback(() => {
    vehicleLayerRef.current?.setVehicles(vehiclesRef.current, selectedVehicleRef.current)
    saveVehicles(vehiclesRef.current)
    setVehicleCount(vehiclesRef.current.length)
    setSelectedVehicle(
      vehiclesRef.current.find((v) => v.id === selectedVehicleRef.current) ?? null)
  }, [])

  const redrawRoads = useCallback(() => {
    const renderRoads = roadsForRendering(renderRoadsRef.current)
    src('roads').setData({ type: 'FeatureCollection', features: roadsWithCleanupFlags(renderRoads) } as never)
    src('roadSurfaces').setData(buildRoadSurfaces(renderRoads) as never)
    const dividerFeatures = cleanIntersectionFeatures(buildDividers(renderRoads))
    src('dividers').setData(groundMarkingPolygons(
      dividerFeatures,
      (p) => p?.kind === 'center' ? 0.3
        : ['lane', 'center-double', 'moto'].includes(String(p?.kind)) ? 0.15 : null,
      (p) => p?.kind === 'lane',
    ) as never)
  }, [src])

  /** 高架高度模型重建（底圖就緒/更換時）：渲染（橋面）與車輛 z 共用同一份 */
  const rebuildElevation = useCallback((roads: RoadFeature[]) => {
    const model = buildElevation(roads)
    setActiveElevation(model)
    elevatedLayerRef.current?.setModel(model)
  }, [])

  const previewJournal = useCallback((journal: EnhancementRecord[]) => {
    try {
      return buildRoadMergeViews(roadsRef.current, journal)
    } catch (error) {
      console.error('道路捏合預覽失敗', error)
      return null
    }
  }, [])

  const refreshRoadMergeViews = useCallback((journal = journalRef.current) => {
    const mergeView = previewJournal(journal)
    if (!mergeView) return false
    roadsRef.current = mergeView.routingRoads
    renderRoadsRef.current = mergeView.renderRoads
    mergeReplayRef.current = mergeView.rows
    graphRef.current = new RoadGraph(roadsRef.current, laneGuidanceIndexRef.current)
    intersectionsRef.current = graphRef.current.intersections()
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__graph = graphRef.current
    for (const row of mergeView.rows) {
      if (!row.resolved) console.warn(`未套用道路捏合 ${row.mergeKey}：${row.detail}`)
    }
    redrawRoads()
    rebuildElevation(renderRoadsRef.current)
    refreshBays()
    return true
  }, [previewJournal, redrawRoads, refreshBays, rebuildElevation])

  const replaceBaseMap = useCallback((roads: RoadFeature[]) => {
    roadsRef.current = roads.filter((road) => !road.properties.deleted)
    laneGuidanceIndexRef.current = guidanceIndexForRoads(
      laneGuidanceRecordsRef.current, roadsRef.current,
      nodeRemapRef.current, wayRemapRef.current,
    )
    return refreshRoadMergeViews()
  }, [refreshRoadMergeViews])

  const coreRef = useRef<MapCore>(null as never)
  if (!coreRef.current) {
    coreRef.current = {
      mapRef, roadsRef, renderRoadsRef, mergeReplayRef,
      graphRef, zonesRef, selectedZoneRef, highlightedZoneRef,
      journalRef, baysRef,
      rightLanesRef, motoBoxesRef,
      intersectionsRef, vehiclesRef, vehicleLayerRef, selectedVehicleRef, lastGestureRef,
      nodeRemapRef, wayRemapRef, rawWaysRef,
      src, refreshZones, setZoneHighlight, refreshBays, refreshVehicles,
      redrawRoads, replaceBaseMap, previewJournal, refreshRoadMergeViews,
    }
  }

  // ── 地圖初始化 ──
  useEffect(() => {
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
      canvasContextAttributes: location.search.includes('screenshot')
        ? { antialias: true, preserveDrawingBuffer: true }
        : undefined,
      // 中文字在本地渲染，不依賴 glyph 伺服器（伺服器只剩英數字會用到）
      localIdeographFontFamily: '"Microsoft JhengHei", "PingFang TC", sans-serif',
    })
    mapRef.current = map
    map.touchZoomRotate.enableRotation()
    // 記錄縮放手勢時間：jumpTo 內部會 stop() 掉進行中的手勢動畫（handlers.stop），
    // 導航 30Hz 跟隨會把滾輪的平滑縮放掐死——跟隨迴圈靠這個時間戳暫時讓路
    map.on('wheel', () => { lastGestureRef.current = performance.now() })
    map.on('touchmove', () => { lastGestureRef.current = performance.now() })
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__map = map

    map.on('load', async () => {
      const icons = makeIcons()
      for (const [name, img] of Object.entries(icons)) map.addImage(name, img)
      const loadSvg = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`無法載入路面標誌：${url}`))
        img.src = url
      })
      const [motorcycleIcon, bicycleIcon] = await Promise.all([
        loadSvg('/assets/road-markings/motorcycle.svg'),
        loadSvg('/assets/road-markings/bicycle.svg'),
      ])
      map.addImage('moto-box-motorcycle', motorcycleIcon)
      map.addImage('moto-box-bicycle', bicycleIcon)

      const [roadsRaw, buildingsRaw, laneGuidanceRecords] = await Promise.all([
        loadDefaultRoads(),
        fetch(asset('/data/nanzih_buildings_height.geojson')).then((r) => r.json()) as
          Promise<FeatureCollection<Polygon>>,
        loadLaneGuidanceRecords(),
      ])
      // 建築－道路中心線幾何稽核：排除 footprint 覆蓋單一路段至少 75%、
      // 且沒有架空高度的建築。train_station／架高站由簍空與支架邏輯處理，
      // 不列入此清單。
      const removedBuildingOsmIds = new Set([
        '823172097', '823172098', '823172099',
        '631751541', // 寶溪北街115巷
        '682189070', // 大學南路273巷
        '631753341', // 寶溪北街19巷
        '631740710', // 無名 service 路段
        '434973244', // 無名 service 路段
        '773733480', // 大學三十八街207巷
        '773733478', // 藍昌路532巷
        '752957679', // 無名 service 路段
        '237779871', // 大學三十二街388巷
        '231986022', // 無名 service 路段
        '464258028', // 無名 service 路段
      ])
      const preparedBuildings = buildingsRaw.features
        .filter((feature) => !removedBuildingOsmIds.has(String(feature.properties?.osm_id ?? '')))
        .map((feature) => {
          const properties = { ...(feature.properties ?? {}) }
          const osmId = String(properties.osm_id ?? '')
          // 捷運／車站站體橫跨道路：底部抬高形成可通車的鏤空層，而非落地實心量體。
          if (isElevatedStation({ ...feature, properties } as Feature<Polygon>)) {
            // 楠梓科技園區站橫跨加昌路；它的 footprint 是高空站體，
            // 需保留比一般車站更清楚的道路及導航標線淨空。
            const minimumClearance = (
              osmId === NANZIH_TECHNOLOGY_PARK_STATION_OSM_ID ||
              osmId === JIACHANG_HAIZHUAN_ELEVATED_STATION_OSM_ID
            ) ? 8 : 6
            properties.min_height_m = Math.max(
              Number(properties.min_height_m) || 0,
              minimumClearance,
            )
            properties.height_m = Math.max(
              Number(properties.height_m) || 9,
              properties.min_height_m +
                (minimumClearance === 8 ? 4 : 3),
            )
          }
          return {
            ...feature,
            id: feature.id ?? `way/${properties.osm_id}`,
            properties,
          } as Feature<Polygon>
        })
      const stationSideStructures = preparedBuildings.flatMap((feature) =>
        isElevatedStation(feature)
          ? buildStationSideStructures(feature, Number(feature.properties?.min_height_m) || 0)
          : [],
      )
      const buildings: FeatureCollection<Polygon> = {
        ...buildingsRaw,
        features: [...preparedBuildings, ...stationSideStructures],
      }
      // 底圖前處理（人工修正 → couplet 合併 → 切塊）收斂在 core/pipeline.ts，
      // 與「匯入地圖」及離線 harness 共用。nodeRemap/wayRemap = 合併造成的
      // node/way id 重映射——journal/zones 與 LanePilot 標註匯入都要跟著遷移
      rawWaysRef.current = buildRawWays(roadsRaw) // 前處理會變動幾何，先留原始快照
      const { roads, nodeRemap, wayRemap } = prepareBaseRoads(roadsRaw)
      if (import.meta.env.DEV) {
        const bounds = {
          minLng: Infinity, minLat: Infinity,
          maxLng: -Infinity, maxLat: -Infinity,
        }
        for (const road of roads) for (const point of road.geometry.coordinates) {
          bounds.minLng = Math.min(bounds.minLng, point[0])
          bounds.minLat = Math.min(bounds.minLat, point[1])
          bounds.maxLng = Math.max(bounds.maxLng, point[0])
          bounds.maxLat = Math.max(bounds.maxLat, point[1])
        }
        console.info('Canonical road database prepared', JSON.stringify({
          roads: roads.length,
          bounds: Number.isFinite(bounds.minLng) ? bounds : null,
        }))
      }
      roadsRef.current = roads
      nodeRemapRef.current = nodeRemap
      wayRemapRef.current = wayRemap
      laneGuidanceRecordsRef.current = laneGuidanceRecords
      laneGuidanceIndexRef.current = guidanceIndexForRoads(
        laneGuidanceRecords, roads, nodeRemap, wayRemap,
      )
      // 除錯開關：?journal=off 完全不套標註（連 seed 都不載），看純 OSM 原始狀態。
      // 同學的 LanePilot annotation（author=lanepilot）實驗期間一律不套。
      const journalOff = location.search.includes('journal=off')
      // 遷移在過濾之前：remapJournalNodes 會回存整份 journal（含 lanepilot 紀錄）
      journalRef.current = journalOff
        ? []
        : remapJournalNodes(loadJournal(), nodeRemap)
      const folded = foldJournal(journalRef.current)
      const roadsAll = [...roads, ...newRoadsFromFolded(folded, nodeRemap)]
      applyToRoads(roadsAll, folded)
      // 捏合＝journal 紀錄，每次載入才在記憶體內接合；靜態 OSM 一個位元組都不動，
      // 所以重建 segments 也炸不到它。必須排在 applyToRoads 之後：checkRoadMerge
      // 要比對兩段的車道配置，那是人工覆寫套用後才成立的。
      // 導航保留來源路段；只有繪圖視圖接合幾何。被 drop 的次段仍可由 provenance 解析。
      const activeRoads = roadsAll.filter((road) => !road.properties.deleted)
      const mergeView = buildRoadMergeViews(activeRoads, journalRef.current)
      roadsRef.current = mergeView.routingRoads
      renderRoadsRef.current = mergeView.renderRoads
      mergeReplayRef.current = mergeView.rows
      if (mergeView.resolved.length > 0) {
        console.info(`journal 捏合：解析 ${mergeView.resolved.length} 組路段`)
      }
      for (const row of mergeView.rows) {
        if (!row.resolved) console.warn(`未套用道路捏合 ${row.mergeKey}：${row.detail}`)
      }
      redrawRoads()
      src('buildings').setData(buildings)
      setActiveNavigationOcclusion(new NavigationOcclusion(map, buildings.features as never))
      graphRef.current = new RoadGraph(roadsRef.current, laneGuidanceIndexRef.current)
      intersectionsRef.current = graphRef.current.intersections()
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__graph = graphRef.current
      // 待轉區的路口 node 也跟著 couplet 合併遷移（refreshZones 會回存）；
      // remap 表沒涵蓋的（drop 側互接節點合併後直接消失）用位置吸附最近路口補救
      const knownInter = new Set(intersectionsRef.current.map((i) => i.id))
      zonesRef.current = loadZones().map((z) => {
        // remap 後仍要驗證存在——目標節點可能又被退化清理消滅（鏈斷）
        let id = nodeRemap.get(z.intersectionId) ?? z.intersectionId
        if (!knownInter.has(id)) {
          let best: { id: number; d: number } | null = null
          for (const it of intersectionsRef.current) {
            const d = haversine(z.center, it.pos)
            if (d < 30 && (!best || d < best.d)) best = { id: it.id, d }
          }
          if (best) id = best.id
        }
        return id === z.intersectionId ? z : { ...z, intersectionId: id }
      })
      // Rebuild LanePilot lane profiles from the canonical annotations, then
      // append browser-made records last so the effective value is exactly what
      // the editor shows. Persist the combined result into the same database.
      // 正常情況直接使用靜態資料庫內已轉換完成的 LanePilot journal。
      // 僅相容舊資料庫：沒有任何匯入紀錄時才做一次性轉換。
      if (!journalOff && !journalRef.current.some((r) => r.author === 'lanepilot')) {
        try {
          const canonicalAnnotations = staticAnnotations()
          if (canonicalAnnotations.length) {
            const parsed = parseImported(
              canonicalAnnotations.map((record) => JSON.stringify(record)).join('\n'),
            )
            if (parsed.kind === 'annotations') {
              const manualJournal = [...journalRef.current]
              journalRef.current = []
              const { importAnnotations } = await import('./importFlow')
              importAnnotations(coreRef.current, {
                switchMode: () => undefined,
                setImportMsg: (message) => {
                  if (message) console.info(message)
                },
              }, parsed.records, 'road_database.json')
              const importedJournal = journalRef.current.filter((r) => r.author === 'lanepilot')
              journalRef.current = [...importedJournal, ...manualJournal].map((record, index) => ({
                ...record,
                seq: index + 1,
              }))
              updateStaticEditor({ journal: journalRef.current })
              applyToRoads(roadsRef.current, foldJournal(journalRef.current))
              replaceBaseMap(roadsRef.current)
            }
          }
        } catch (error) {
          console.warn('Canonical LanePilot 車道標註套用失敗；沿用人工資料', error)
        }
      }
      // 啟動自動吃入 LanePilot 標註待轉區（?lpzones=off 關閉）：
      // zone-lp-* 每次啟動由最新標註檔重建（stale 的舊匯入自我修復），
      // 手動放置的 zone 保留且去重時優先。車道覆寫維持不套用（journal 過濾政策）。
      // 已寫進唯一靜態資料來源的待轉區不必每次由 annotations 重新配對。
      if (!location.search.includes('lpzones=off')
        && !zonesRef.current.some((z) => z.id.startsWith('zone-lp-'))) {
        try {
          const canonicalAnnotations = staticAnnotations()
          const annotationText =
            canonicalAnnotations.map((record) => JSON.stringify(record)).join('\n')
          if (annotationText) {
            const parsed = parseImported(annotationText)
            if (parsed.kind === 'annotations') {
              const manual = zonesRef.current.filter((z) => !z.id.startsWith('zone-lp-'))
              const savedImported = new Map(
                zonesRef.current
                  .filter((z) => z.id.startsWith('zone-lp-'))
                  .map((z) => [z.id, z]),
              )
              const deleted = loadDeletedZoneIds()
              const res = zonesFromAnnotations({
                records: parsed.records,
                graph: graphRef.current,
                roads: roadsAll,
                nodeRemap, wayRemap,
                rawWays: rawWaysRef.current,
                existing: manual,
              })
              // 靜態標註只提供初始值；同 ID 的人工位置、尺寸、形狀、旋轉與啟停狀態優先。
              // 明確刪除的 ID 由 tombstone 排除，避免重新整理後被自動匯入復活。
              const imported = res.zones
                .filter((z) => !deleted.has(z.id))
                .map((z) => savedImported.get(z.id) ?? z)
              zonesRef.current = [...manual, ...imported]
              if (res.skips.length) {
                console.warn(`LanePilot 待轉區標註略過 ${res.skips.length} 筆`, res.skips)
              }
            }
          }
        } catch (e) {
          console.warn('LanePilot 標註自動載入失敗（沿用 localStorage 既有待轉區）', e)
        }
      }
      refreshZones()
      refreshBays()
      // 高架橋面 3D 圖層（three.js）——先於車輛圖層加入，車輛畫在橋面之上
      const eLayer = new ElevatedLayer()
      elevatedLayerRef.current = eLayer
      setActiveElevatedLayer(eLayer) // usePlanner/useDrive 畫路線絲帶用（模組單例）
      rebuildElevation(roadsAll)
      map.addLayer(eLayer.asLayer())
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__elayer = eLayer
      // 真 3D 車輛模型圖層（three.js）
      const vLayer = new VehicleModelLayer()
      vehicleLayerRef.current = vLayer
      map.addLayer(vLayer.asLayer())
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__vlayer = vLayer
      vehiclesRef.current = loadVehicles()
      refreshVehicles()
      setLoading(false)
    })

    map.on('click', (e) => clickRef.current(e, map))

    return () => {
      setActiveNavigationOcclusion(null)
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    core: coreRef.current,
    loading, zoneCount, zoneTick, vehicleCount, selectedVehicle,
  }
}
