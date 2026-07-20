// 地圖核心：MapLibre 初始化、預設 shard 底圖載入、journal 載入/套用、
// 跨功能共用的 refs 與重繪函式。LaneDev / LaneNav 兩個 App 共用（sync-lanenav 鏡像），
// App.tsx 只留「模式機 + 點擊分派 + 畫面組裝」。
import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import { buildStyle, makeIcons } from '../core/mapStyle'
import {
  buildDividers, buildRoadSurfaces, loadRoads, roadsFromGeoJSON, type RoadFeature,
} from '../core/roads'
import { prepareBaseRoads } from '../core/pipeline'
import type { DropRemap } from '../core/couplet'
import { parseImported, mergeMaps } from '../core/importmap'
import { RoadGraph } from '../core/graph'
import { loadZones, saveZones, zonesToGeoJSON, type Zone } from '../core/zones'
import {
  loadJournal, foldJournal, applyToRoads, remapJournalNodes, type EnhancementRecord,
} from '../core/enhancements'
import { buildRawWays, zonesFromAnnotations, type RawWay } from '../core/zoneimport'
import {
  buildTurnBays, buildChannelization, buildLaneArrows, buildRightLanes, buildStopLines,
  baysToGeoJSON, type TurnBay, type RightLane,
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

export type Mode = 'browse' | 'edit' | 'pick' | 'drive'

export const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

/** 預設底圖：LanePilot shard（含 node_refs）。
 * 橋頭暫時不載（2026-07-10 指示，先專注楠梓/藍田路實驗）——注意楠梓車站周邊
 * 路網在 OSM 行政區劃屬橋頭，Demo 路線東端會缺路，要跑車站 Demo 再加回來 */
const DEFAULT_SHARD_URLS = [
  '/data/lanepilot/area_4212599.segments.jsonl', // 楠梓區
]

async function loadDefaultRoads() {
  // 底圖預設 = LanePilot shard（同學版 OSM，幾何較新較貼實地——槽化/偏心規則
  // 依賴路段幾何，舊 Overpass 快照與實地有出入會讓規則不穩）。
  // 標註仍不套用（journal 過濾 author=lanepilot）。?base=osm 退回快照對照。
  if (location.search.includes('base=osm')) return loadRoads('/data/nanzi_roads.geojson')
  try {
    const texts = await Promise.all(DEFAULT_SHARD_URLS.map(async (u) => {
      const r = await fetch(u)
      if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`)
      return r.text()
    }))
    const parts = texts.map(parseImported)
      .filter((p): p is Extract<ReturnType<typeof parseImported>, { kind: 'map' }> => p.kind === 'map')
    return roadsFromGeoJSON(mergeMaps(parts).fc)
  } catch (e) {
    console.warn('LanePilot shard 底圖載入失敗，退回 Overpass 快照', e)
    return loadRoads('/data/nanzi_roads.geojson')
  }
}

/** 跨功能共用的地圖狀態（refs 讓地圖 handler 安全讀寫）與重繪函式 */
export interface MapCore {
  mapRef: RefObject<MLMap | null>
  roadsRef: RefObject<RoadFeature[]>
  graphRef: RefObject<RoadGraph | null>
  zonesRef: RefObject<Zone[]>
  selectedZoneRef: RefObject<string | null>
  journalRef: RefObject<EnhancementRecord[]>
  baysRef: RefObject<TurnBay[]>
  /** 右轉附加車道（journal right_lane 折疊生成，refreshBays 重算） */
  rightLanesRef: RefObject<RightLane[]>
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
  refreshBays: () => void
  refreshVehicles: () => void
  /** 路面與車道分隔線重繪（journal 覆寫/標註匯入後） */
  redrawRoads: () => void
  /** 換 Base Layer：換路網、重建圖、重算 bay（匯入地圖用） */
  replaceBaseMap: (roads: RoadFeature[]) => void
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
  const graphRef = useRef<RoadGraph | null>(null)
  const zonesRef = useRef<Zone[]>([])
  const selectedZoneRef = useRef<string | null>(null)
  const journalRef = useRef<EnhancementRecord[]>([])
  const baysRef = useRef<TurnBay[]>([])
  const rightLanesRef = useRef<RightLane[]>([])
  const intersectionsRef = useRef<{ id: number; pos: [number, number] }[]>([])
  const vehiclesRef = useRef<PlacedVehicle[]>([])
  const vehicleLayerRef = useRef<VehicleModelLayer | null>(null)
  const elevatedLayerRef = useRef<ElevatedLayer | null>(null)
  const selectedVehicleRef = useRef<string | null>(null)
  const lastGestureRef = useRef(0) // 最近一次滾輪/觸控手勢的時間戳（導航跟隨要讓路給縮放）
  const nodeRemapRef = useRef<Map<number, number>>(new Map())
  const wayRemapRef = useRef<Map<number, DropRemap>>(new Map())
  const rawWaysRef = useRef<Map<number, RawWay>>(new Map())

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
    src('zones').setData(zonesToGeoJSON(zonesRef.current, selectedZoneRef.current) as never)
    saveZones(zonesRef.current)
    setZoneCount(zonesRef.current.length)
    setZoneTick((t) => t + 1)
  }, [src])

  /** 重算偏心左轉道（路網/車道數/journal 變動後都要跑：bay 的橫向位置依斷面寬推導） */
  const refreshBays = useCallback(() => {
    if (!mapRef.current || !graphRef.current) return
    baysRef.current = buildTurnBays(graphRef.current, journalRef.current)
    rightLanesRef.current = buildRightLanes(graphRef.current, journalRef.current)
    // 中央帶標線（雙黃邊界＋槽化斜紋）＋ 路口停止線 ＋ 路口地面車道箭頭
    const channel = buildChannelization(graphRef.current, baysRef.current)
    const stopLines = buildStopLines(graphRef.current, baysRef.current, rightLanesRef.current)
    const laneArrows = buildLaneArrows(graphRef.current, baysRef.current, rightLanesRef.current)
    src('turnbays').setData(baysToGeoJSON(
      baysRef.current, [...channel, ...stopLines], laneArrows, rightLanesRef.current) as never)
    // 分隔島：Case B 自動推導（成對單行間）+ 顯式配對（高雄大學路四線並排）
    // + Case A 編輯設定（中央帶類型 = 島）
    src('medians').setData(mediansToGeoJSON([
      ...buildMedians(roadsRef.current),
      ...buildTwinIslands(roadsRef.current, journalRef.current),
      ...buildMotoSepIslands(graphRef.current),
      ...buildCenterIslands(graphRef.current, baysRef.current),
    ]) as never)
    // 路面印字（禁行機車）：motorcycle 可被 journal 覆寫，跟著這條重算路徑走
    src('roadtext').setData(buildRoadTexts(graphRef.current) as never)
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
    src('roads').setData({ type: 'FeatureCollection', features: roadsRef.current } as never)
    src('roadSurfaces').setData(buildRoadSurfaces(roadsRef.current) as never)
    src('dividers').setData(buildDividers(roadsRef.current) as never)
  }, [src])

  /** 高架高度模型重建（底圖就緒/更換時）：渲染（橋面）與車輛 z 共用同一份 */
  const rebuildElevation = useCallback((roads: RoadFeature[]) => {
    const model = buildElevation(roads)
    setActiveElevation(model)
    elevatedLayerRef.current?.setModel(model)
  }, [])

  const replaceBaseMap = useCallback((roads: RoadFeature[]) => {
    roadsRef.current = roads
    redrawRoads()
    graphRef.current = new RoadGraph(roads)
    intersectionsRef.current = graphRef.current.intersections()
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__graph = graphRef.current
    rebuildElevation(roads)
    refreshBays()
  }, [redrawRoads, refreshBays, rebuildElevation])

  const coreRef = useRef<MapCore>(null as never)
  if (!coreRef.current) {
    coreRef.current = {
      mapRef, roadsRef, graphRef, zonesRef, selectedZoneRef, journalRef, baysRef,
      rightLanesRef,
      intersectionsRef, vehiclesRef, vehicleLayerRef, selectedVehicleRef, lastGestureRef,
      nodeRemapRef, wayRemapRef, rawWaysRef,
      src, refreshZones, refreshBays, refreshVehicles, redrawRoads, replaceBaseMap,
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
      attributionControl: { compact: true },
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

      const [roadsRaw, buildings] = await Promise.all([
        loadDefaultRoads(),
        fetch('/data/nanzi_buildings.geojson').then((r) => r.json()),
      ])
      // 底圖前處理（人工修正 → couplet 合併 → 切塊）收斂在 core/pipeline.ts，
      // 與「匯入地圖」及離線 harness 共用。nodeRemap/wayRemap = 合併造成的
      // node/way id 重映射——journal/zones 與 LanePilot 標註匯入都要跟著遷移
      rawWaysRef.current = buildRawWays(roadsRaw) // 前處理會變動幾何，先留原始快照
      const { roads, nodeRemap, wayRemap } = prepareBaseRoads(roadsRaw)
      roadsRef.current = roads
      nodeRemapRef.current = nodeRemap
      wayRemapRef.current = wayRemap
      // 除錯開關：?journal=off 完全不套標註（連 seed 都不載），看純 OSM 原始狀態。
      // 同學的 LanePilot annotation（author=lanepilot）實驗期間一律不套。
      const journalOff = location.search.includes('journal=off')
      // 遷移在過濾之前：remapJournalNodes 會回存整份 journal（含 lanepilot 紀錄）
      journalRef.current = journalOff
        ? []
        : remapJournalNodes(loadJournal(), nodeRemap).filter((r) => r.author !== 'lanepilot')
      if (!journalOff && journalRef.current.length === 0) {
        // 首次啟動：載入示範標註（大學南路 2+2+機車道／大學西路 1+1+機車道）
        try {
          const seed: EnhancementRecord[] = await fetch('/data/seed_journal.json').then((r) => r.json())
          journalRef.current = seed
          localStorage.setItem('navsim-journal-v1', JSON.stringify(seed))
        } catch { /* 沒有 seed 檔就算了 */ }
      }
      applyToRoads(roads, foldJournal(journalRef.current))
      redrawRoads()
      src('buildings').setData(buildings)
      graphRef.current = new RoadGraph(roads)
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
      // 啟動自動吃入 LanePilot 標註待轉區（?lpzones=off 關閉）：
      // zone-lp-* 每次啟動由最新標註檔重建（stale 的舊匯入自我修復），
      // 手動放置的 zone 保留且去重時優先。車道覆寫維持不套用（journal 過濾政策）。
      if (!location.search.includes('lpzones=off')) {
        try {
          const r = await fetch('/data/lanepilot/annotations.jsonl')
          if (r.ok) {
            const parsed = parseImported(await r.text())
            if (parsed.kind === 'annotations') {
              const manual = zonesRef.current.filter((z) => !z.id.startsWith('zone-lp-'))
              const res = zonesFromAnnotations({
                records: parsed.records,
                graph: graphRef.current,
                roads,
                nodeRemap, wayRemap,
                rawWays: rawWaysRef.current,
                existing: manual,
              })
              zonesRef.current = [...manual, ...res.zones]
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
      rebuildElevation(roads)
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

    return () => { map.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    core: coreRef.current,
    loading, zoneCount, zoneTick, vehicleCount, selectedVehicle,
  }
}
