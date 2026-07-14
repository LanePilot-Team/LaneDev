// 地圖核心：MapLibre 初始化、預設 shard 底圖載入、journal 載入/套用、
// 跨功能共用的 refs 與重繪函式。LaneDev / LaneNav 兩個 App 共用（sync-lanenav 鏡像），
// App.tsx 只留「模式機 + 點擊分派 + 畫面組裝」。
import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import { buildStyle, makeIcons } from '../core/mapStyle'
import {
  loadRoads, roadsFromGeoJSON, buildDividers, splitAtIntersections, type RoadFeature,
} from '../core/roads'
import { parseImported, mergeMaps } from '../core/importmap'
import { RoadGraph } from '../core/graph'
import { loadZones, saveZones, zonesToGeoJSON, type Zone } from '../core/zones'
import {
  loadJournal, foldJournal, applyToRoads, remapJournalNodes, type EnhancementRecord,
} from '../core/enhancements'
import {
  buildTurnBays, buildChannelization, buildLaneArrows, baysToGeoJSON, type TurnBay,
} from '../core/turnbays'
import { mergeCouplets, applyLantianSections } from '../core/couplet'
import { buildRoadTexts } from '../core/roadtext'
import {
  buildMedians, buildCenterIslands, buildTwinIslands, mediansToGeoJSON, MEDIAN_SCOPE_ROADS,
} from '../core/medians'
import { loadVehicles, saveVehicles, type PlacedVehicle } from '../core/vehicles'
import { VehicleModelLayer } from '../core/models3d'
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
  intersectionsRef: RefObject<{ id: number; pos: [number, number] }[]>
  vehiclesRef: RefObject<PlacedVehicle[]>
  vehicleLayerRef: RefObject<VehicleModelLayer | null>
  selectedVehicleRef: RefObject<string | null>
  lastGestureRef: RefObject<number>
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
  const intersectionsRef = useRef<{ id: number; pos: [number, number] }[]>([])
  const vehiclesRef = useRef<PlacedVehicle[]>([])
  const vehicleLayerRef = useRef<VehicleModelLayer | null>(null)
  const selectedVehicleRef = useRef<string | null>(null)
  const lastGestureRef = useRef(0) // 最近一次滾輪/觸控手勢的時間戳（導航跟隨要讓路給縮放）

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
    // 中央帶標線（雙黃邊界＋槽化斜紋）＋ 路口地面車道箭頭
    const channel = buildChannelization(graphRef.current, baysRef.current)
    const laneArrows = buildLaneArrows(graphRef.current, baysRef.current)
    src('turnbays').setData(baysToGeoJSON(baysRef.current, channel, laneArrows) as never)
    // 分隔島：Case B 自動推導（成對單行間）+ 顯式配對（高雄大學路四線並排）
    // + Case A 編輯設定（中央帶類型 = 島）
    src('medians').setData(mediansToGeoJSON([
      ...buildMedians(roadsRef.current),
      ...buildTwinIslands(roadsRef.current, journalRef.current),
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
    src('dividers').setData(buildDividers(roadsRef.current) as never)
  }, [src])

  const replaceBaseMap = useCallback((roads: RoadFeature[]) => {
    roadsRef.current = roads
    redrawRoads()
    graphRef.current = new RoadGraph(roads)
    intersectionsRef.current = graphRef.current.intersections()
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__graph = graphRef.current
    refreshBays()
  }, [redrawRoads, refreshBays])

  const coreRef = useRef<MapCore>(null as never)
  if (!coreRef.current) {
    coreRef.current = {
      mapRef, roadsRef, graphRef, zonesRef, selectedZoneRef, journalRef, baysRef,
      intersectionsRef, vehiclesRef, vehicleLayerRef, selectedVehicleRef, lastGestureRef,
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
      // couplet 合併：OSM 成對單行 → 單一雙向路體。
      // 藍田路 = 2+2+中央偏心帶（槽化）；大學南路 = 2+2+機車道+實體島，
      // 島寬由 OSM 兩線實際間距反推（「把道路切開放入」，不擠壓車道）。
      // nodeRemap 收集合併造成的 node id 重映射——journal/zones 的既有標註要跟著遷移
      const nodeRemap = new Map<number, number>()
      // 注意：合併 scope ≠ BAY_SCOPE（bay 生成範圍）——couplet 配對一次只能一條路
      let roads = mergeCouplets(roadsRaw, new Set(['藍田路']), undefined, nodeRemap)
      roads = mergeCouplets(roads, MEDIAN_SCOPE_ROADS, {
        lanesF: 2, lanesB: 2, centerM: 2.4, centerKind: 'island',
        motoF: true, motoB: true,
        centerFromGap: { roadW: 8.6, min: 1.6, max: 8 }, // roadW = 2車道+機車道斷面寬
      }, nodeRemap)
      // 援中路：全長成對單行（一條 oneway=-1，載入已反轉）＋中央「偏心槽化帶」
      // （2026-07-14 實地確認是標線偏心不是實體島；已加入 BAY_SCOPE 生成偏心道）
      roads = mergeCouplets(roads, new Set(['援中路']), {
        lanesF: 2, lanesB: 2, centerM: 3.2, centerKind: 'hatch',
        motoF: true, motoB: true,
        centerFromGap: { roadW: 8.6, min: 1.6, max: 8 },
      }, nodeRemap)
      // 高雄大學路「不」做 couplet 合併：它是四線並排的林蔭大道
      // （西側南向主線+慢車道｜大綠帶｜東側北向主線+慢車道），
      // 各 way 維持 OSM 單行原樣，之間的分隔島由 TWIN_ISLAND_PAIRS 顯式配對生成
      applyLantianSections(roads) // 745巷以東 = 東三西二、無中央帶
      // 依路口切塊：車道/中央帶/轉向編輯的最小單位 = 路口到路口（journal 區塊鍵）
      roads = splitAtIntersections(roads)
      roadsRef.current = roads
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
      refreshZones()
      refreshBays()
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
