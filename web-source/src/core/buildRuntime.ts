import type { Feature, FeatureCollection, Polygon, Position } from 'geojson'
import { asset } from './asset'
import {
  buildDividers, buildRoadSurfaces, roadsForRendering, roadsFromGeoJSON, type RoadFeature,
} from './roads'
import { prepareBaseRoads } from './pipeline'
import type { DropRemap } from './couplet'
import { parseImported } from './importmap'
import { RoadGraph } from './graph'
import {
  loadDeletedZoneIds, loadZones, zonesToGeoJSON, type Zone,
} from './zones'
import {
  loadJournal, foldJournal, applyToRoads, remapJournalNodes, type EnhancementRecord,
} from './enhancements'
import {
  buildRoadMergeViews,
} from './roadMerge'
import {
  buildRawWays, overlayWaitingZones, zonesFromLaneBase,
  type RawWay,
} from './zoneimport'
import { newRoadsFromFolded } from './newroads'
import {
  buildTurnBays, buildChannelization, buildLaneArrows, buildRightLanes, buildStopLines,
  buildSpecifiedWhiteMotoHatch,
  buildLeftTurnWaitingAreas,
  buildMotoBoxes, buildMotoLaneEntryIcons, buildUnusedLaneGores, baysToGeoJSON,
  type TurnBay, type RightLane, type MotoBox,
} from './turnbays'
import { buildRoadLabelLines, buildRoadTexts, roadTextObstacles } from './roadtext'
import {
  buildMedians, buildCenterIslands, buildMotoSepIslands, buildTwinIslands, mediansToGeoJSON,
} from './medians'
import { buildElevation } from './elevation'
import { haversine } from './geo'
import { cleanIntersectionFeatures, roadsWithCleanupFlags } from './intersectionCleanup'
import { groundMarkingPolygons } from './groundMarkings'
import {
  loadStaticRoadDatabase, staticAnnotations, staticSegments,
} from './staticDatabase'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
  type LaneBaseApplyReport, type LaneBaseIndex, type LaneBaseRecord,
} from './laneBase'


const cell = <T>(current: T) => ({ current })
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

function applyLaneBaseRecords(
  records: LaneBaseRecord[],
  roads: RoadFeature[],
  nodeRemap: Map<number, number>,
  wayRemap: Map<number, DropRemap>,
): { report: LaneBaseApplyReport; index: LaneBaseIndex } {
  const remapped = remapLaneBase(records, {
    existingWayIds: new Set(roads.map((road) => road.properties.osm_id)),
    nodeRemap,
    wayRemap,
    wayApproachNodes: roads.reduce((index, road) => {
      const nodes = index.get(road.properties.osm_id) ?? {
        forward: new Set<number>(), backward: new Set<number>(),
      }
      nodes.forward.add(road.properties.nodes.at(-1)!)
      if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
      index.set(road.properties.osm_id, nodes)
      return index
    }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
  })
  if (remapped.errors.length || remapped.unmappedSourceKeys.length) {
    const detail = [...new Set([
      ...remapped.errors,
      ...remapped.unmappedSourceKeys.map((key) => `${key}: unmapped`),
    ])].join('；')
    throw new Error(`Lane Base 重映射失敗：${detail}`)
  }
  const index = buildLaneBaseIndex(remapped.records)
  if (index.movementRuleErrors.length) {
    throw new Error(`Lane Base movement rule 無法解析：${index.movementRuleErrors.join('；')}`)
  }
  return {
    report: applyLaneBaseToRoads(roads, index),
    index,
  }
}


/** Build-only: the original readonly initialization pipeline, never imported by the app. */
export async function buildClientRuntime() {
  const sources: Record<string, FeatureCollection> = {}
  const src = (id: string) => ({ setData: (data: FeatureCollection) => { sources[id] = data } })
  const roadsRef = cell<RoadFeature[]>([])
  const renderRoadsRef = cell<RoadFeature[]>([])
  const graphRef = cell<RoadGraph | null>(null)
  const laneBaseIndexRef = cell<LaneBaseIndex>(buildLaneBaseIndex([]))
  const zonesRef = cell<Zone[]>([])
  const baseZonesRef = cell<Zone[]>([])
  const selectedZoneRef = cell<string | null>(null)
  const highlightedZoneRef = cell<string | null>(null)
  const journalRef = cell<EnhancementRecord[]>([])
  const baysRef = cell<TurnBay[]>([])
  const rightLanesRef = cell<RightLane[]>([])
  const motoBoxesRef = cell<MotoBox[]>([])
  const intersectionsRef = cell<{ id: number; pos: [number, number] }[]>([])
  const rawWaysRef = cell<Map<number, RawWay>>(new Map())


  const refreshBays = () => {
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
      journal, stopLines)
    const motoEntryIcons = buildMotoLaneEntryIcons(renderGraph, journal)
    const turnBayFeaturesRaw = baysToGeoJSON(
      baysRef.current, [...channel, ...stopLines, ...leftWaitAreas],
      laneArrows, rightLanesRef.current, motoBoxes.boxes)
    turnBayFeaturesRaw.features.push(
      ...motoEntryIcons.features,
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
    // 路面印字（禁行機車）：motorcycle 可被 journal 覆寫，跟著這條重算路徑走。
    // 印字位置要避開同一段路已經畫好的箭頭、機車道入口圖示與停止線——
    // 這些都在上面算完了，直接餵給 buildRoadTexts，不重算一份會漂移的位置。
    const markingObstacles = roadTextObstacles({
      arrows: laneArrows,
      motoEntryIcons: motoEntryIcons.features,
      stopLines,
      motoBoxes: motoBoxes.boxes,
    })
    const roadTexts = cleanIntersectionFeatures(
      buildRoadTexts(renderGraph, baysRef.current, rightLanesRef.current, markingObstacles))
    src('roadtext').setData(roadTexts as never)
    // 路名：只沿「避開所有地面標線與路面印字」的中心線區段排字
    src('roadlabels').setData(buildRoadLabelLines(renderRoads, [
      ...markingObstacles,
      ...roadTexts.features.map((f) => ({
        points: [(f.geometry as unknown as { coordinates: [number, number] }).coordinates],
        alongHalfM: 5,
        crossHalfM: 1,
      })),
    ]) as never)
  }


  const redrawRoads = () => {
    const renderRoads = roadsForRendering(renderRoadsRef.current)
    src('roads').setData({ type: 'FeatureCollection', features: roadsWithCleanupFlags(renderRoads) } as never)
    src('roadSurfaces').setData(buildRoadSurfaces(renderRoads) as never)
    const dividerFeatures = cleanIntersectionFeatures(buildDividers(renderRoads))
    src('dividers').setData(groundMarkingPolygons(
      dividerFeatures,
      (p) => p?.kind === 'center' ? 0.3
        : p?.kind === 'tunnel-edge' ? 0.12 // 地下道側緣：比車道線細一點
        : ['lane', 'center-double', 'moto'].includes(String(p?.kind)) ? 0.15 : null,
      // 車道線與地下道側緣都是虛線（後者用虛線表示「在地面之下」）
      (p) => p?.kind === 'lane' || p?.kind === 'tunnel-edge',
    ) as never)
  }


  const refreshZones = () => {
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
    // Client renders bundled zones without persisting derived or user changes.
  }


      const [roadsRaw, buildingsRaw] = await Promise.all([
        loadDefaultRoads(),
        fetch(asset('/data/nanzih_buildings_height.geojson')).then((r) => r.json()) as
          Promise<FeatureCollection<Polygon>>,
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

      const extraction = extractLaneBase([...staticAnnotations()])
      if (extraction.errors.length) {
        const error = new Error(
          `Canonical Lane Base 萃取失敗：${extraction.errors.join('；')}`,
        )

        throw error
      }
      let canonicalLaneBase: ReturnType<typeof applyLaneBaseRecords>
      try {
        canonicalLaneBase = applyLaneBaseRecords(extraction.records, roads, nodeRemap, wayRemap)
      } catch (cause) {
        const error = new Error(
          `Canonical Lane Base 載入失敗：${cause instanceof Error ? cause.message : String(cause)}`,
        )

        throw error
      }

      laneBaseIndexRef.current = canonicalLaneBase.index
      roadsRef.current = roads
      // 除錯開關：?journal=off 不套人工 journal；canonical Lane Base 仍是底圖的一部分。
      const journalOff = false
      journalRef.current = journalOff
        ? []
        : remapJournalNodes(
            loadJournal().filter((record) => record.author !== 'lanepilot'),
            nodeRemap,
          )
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
      if (mergeView.resolved.length > 0) {
        console.info(`journal 捏合：解析 ${mergeView.resolved.length} 組路段`)
      }
      for (const row of mergeView.rows) {
        if (!row.resolved) console.warn(`未套用道路捏合 ${row.mergeKey}：${row.detail}`)
      }

      redrawRoads()
      src('buildings').setData(buildings)


      graphRef.current = new RoadGraph(roadsRef.current)
      intersectionsRef.current = graphRef.current.intersections()


      // 待轉區的路口 node 也跟著 couplet 合併遷移（refreshZones 會回存）；
      // remap 表沒涵蓋的（drop 側互接節點合併後直接消失）用位置吸附最近路口補救
      const knownInter = new Set(intersectionsRef.current.map((i) => i.id))
      const humanZones = loadZones().map((z) => {
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
      const zoneResult = false
        ? { zones: [], skips: [], accountedSourceKeys: [], unresolvedSourceKeys: [] }
        : zonesFromLaneBase({
            index: canonicalLaneBase.index,
            graph: graphRef.current,
            roads: roadsRef.current,
            rawWays: rawWaysRef.current,
          })
      baseZonesRef.current = zoneResult.zones
      zonesRef.current = overlayWaitingZones(
        baseZonesRef.current, humanZones, loadDeletedZoneIds(),
      )
      if (zoneResult.skips.length || zoneResult.unresolvedSourceKeys.length) {
        console.warn('Lane Base 待轉區仍有未解析規則', {
          skips: zoneResult.skips,
          sourceKeys: zoneResult.unresolvedSourceKeys,
        })
      }
      // 初始繪製不得把 derived Lane Base zones 寫進 editor waiting_zones。
      refreshZones()

      refreshBays()


  const zoneFeatureIds = new Map<string, string[]>()
  sources.zones.features.forEach((feature, index) => {
    const zoneId = String(feature.properties?.id)
    feature.id = `${zoneId}:${index}`
    if (!zoneFeatureIds.has(zoneId)) zoneFeatureIds.set(zoneId, [])
    zoneFeatureIds.get(zoneId)!.push(feature.id)
  })
  return {
    sources,
    navigation: {
      roads: roadsRef.current,
      graph: graphRef.current!.snapshot(roadsRef.current),
      laneBaseIndex: laneBaseIndexRef.current,
      zones: zonesRef.current,
      zoneFeatureIds,
      bays: baysRef.current,
      rightLanes: rightLanesRef.current,
      motoBoxes: motoBoxesRef.current,
      // Ground connections are computed here, then only the solved model is shipped.
      elevation: buildElevation(roadsAll).snapshot(),
    },
  }
}
