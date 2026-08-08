// 「匯入地圖」流程：segments.jsonl（換底圖）與 annotations.jsonl（唯讀套用標註）。
// LaneDev / LaneNav 共用；狀態都在 MapCore 的 refs，這裡是純函式。
import maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import {
  parseImported, mergeMaps,
  type AnnotationRecord as ImportedAnnotation,
} from '../core/importmap.ts'
import { roadsFromGeoJSON } from '../core/roads.ts'
import { prepareBaseRoads } from '../core/pipeline.ts'
import { extractLaneBase } from '../core/laneBase.ts'
import { buildRawWays, zonesFromAnnotations } from '../core/zoneimport.ts'
import type { MapCore, Mode } from './mapCore.ts'

export interface ImportUi {
  switchMode: (m: Mode) => void
  setImportMsg: (msg: string | null) => void
}

/**
 * 匯入（可多選）：自動判別 segments.jsonl（換底圖）或 annotations.jsonl（套標註）。
 * 多個路網檔合併成一張圖（跨行政區 shard 同 way 去重，例：楠梓＋橋頭）；
 * 混選時先換好底圖再套標註。
 */
export async function importFiles(core: MapCore, ui: ImportUi, files: File[]) {
  try {
    const mapParts: { fc: FeatureCollection<LineString> }[] = []
    const annRecords: ImportedAnnotation[] = []
    const mapNames: string[] = []
    const annNames: string[] = []
    for (const file of files) {
      const parsed = parseImported(await file.text())
      if (parsed.kind === 'annotations') {
        annRecords.push(...parsed.records)
        annNames.push(file.name)
      } else {
        mapParts.push(parsed)
        mapNames.push(file.name)
      }
    }
    if (mapParts.length) importBaseMap(core, ui, mergeMaps(mapParts).fc.features, mapNames.join(' + '))
    if (annRecords.length) importAnnotations(core, ui, annRecords, annNames.join(' + '))
  } catch (e) {
    ui.setImportMsg(`匯入失敗：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 換 Base Layer（features 已跨檔合併去重） */
function importBaseMap(core: MapCore, ui: ImportUi, features: Feature<LineString>[], name: string) {
  let withNodes = 0
  for (const f of features) {
    const nodes = (f.properties as Record<string, unknown> | null)?.nodes as number[] | undefined
    if (nodes && nodes.length === f.geometry.coordinates.length) withNodes++
  }
  const total = features.length
  // 與預設底圖同一套前處理（人工修正 → couplet 合併 → 切塊），匯入行為才一致；
  // journal 已存合併後的鍵空間（載入時 remapJournalNodes 回存過），直接疊上
  const roadsRaw = roadsFromGeoJSON({ type: 'FeatureCollection', features })
  core.rawWaysRef.current = buildRawWays(roadsRaw) // 前處理會變動幾何，先留原始快照
  const prep = prepareBaseRoads(roadsRaw)
  core.nodeRemapRef.current = prep.nodeRemap
  core.wayRemapRef.current = prep.wayRemap
  core.preparedRoadsRef.current = structuredClone(prep.roads)
  ui.switchMode('browse') // 內部已處理「行駛中先 endDrive」，涵蓋模擬與 GPS 兩種模式
  // 自訂匯入的底圖不沿用 canonical 道路的 Lane Base；混選 annotations 時
  // importFiles 會在下一步以同一份 prepared roads 建立本次工作階段的 Lane Base。
  core.replaceSessionLaneBase([])
  const roads = core.roadsRef.current
  const first = roads[0].geometry.coordinates[0] as [number, number]
  const b = new maplibregl.LngLatBounds(first, first)
  for (const r of roads) for (const c of r.geometry.coordinates) b.extend(c as [number, number])
  core.mapRef.current?.fitBounds(b, { padding: 60 })
  ui.setImportMsg(withNodes < total
    ? `已匯入 ${name}：${total} 段（⚠ ${total - withNodes} 段缺 node_refs，無法用於路線規劃）`
    : `已匯入 ${name}：${total} 段路網（含拓撲）`)
}

/**
 * 匯入 LanePilot 標註（annotations.jsonl，legacy 與 schema v2 皆可）：
 *   lane_profiles   → 本次工作階段的 Lane Base（不寫 editor journal）
 *   movement_rules  → 兩段式左轉/待轉區 → zones（位置由路口幾何自動計算）
 */
export function importAnnotations(
  core: MapCore,
  ui: ImportUi,
  records: ImportedAnnotation[],
  fileName: string,
) {
  const nodeRemap = core.nodeRemapRef.current
  const wayRemap = core.wayRemapRef.current
  const extraction = extractLaneBase(records.map((record) => ({
    object_identity: {
      object_type: record.contextScope ? 'nav_context_annotation' : 'nav_segment_annotation',
      nav_segment_key: record.segmentKey,
      split_index: Number(record.sourceKey?.match(/#(-?\d+)$/)?.[1] ?? 0),
      source_osm: { osm_id: record.segmentKey },
      ...(record.contextScope ? { context_scope: record.contextScope } : {}),
      ...(record.approachNodeKey
        ? { applies_to_intersection_key: record.approachNodeKey } : {}),
      ...(record.approachDirection
        ? { approach_direction: record.approachDirection } : {}),
    },
    lane_nav_tags: {
      lane_detail_tags: { lane_profiles: record.laneProfiles },
      taiwan_motorcycle_tags: { movement_rules: record.movementRules },
    },
  })))
  if (extraction.errors.length) {
    throw new Error(`Lane Base 萃取失敗：${extraction.errors.join('；')}`)
  }
  const laneReport = core.replaceSessionLaneBase(extraction.records)

  // 2) 待轉區：左轉且（兩段式必須/皆可 或 現場有待轉格）→ 對回路口的左轉配對
  //（核心邏輯在 core/zoneimport.ts，與啟動自動吃入/離線稽核共用）
  const res = core.graphRef.current
    ? zonesFromAnnotations({
        records,
        graph: core.graphRef.current,
        roads: core.roadsRef.current,
        nodeRemap, wayRemap,
        rawWays: core.rawWaysRef.current,
        existing: core.zonesRef.current,
      })
    : { zones: [], skips: [] }
  if (res.zones.length) {
    core.zonesRef.current = [...core.zonesRef.current, ...res.zones]
    core.refreshZones()
  }
  const count = (r: string) => res.skips.filter((s) => s.reason === r).length
  const skipped = res.skips.length
  const detail = [
    count('node') ? `缺路口鍵 ${count('node')}` : '',
    count('noLeft') ? `路口無左轉配對 ${count('noLeft')}` : '',
    count('dir') ? `進入方向對不上 ${count('dir')}` : '',
  ].filter(Boolean).join('、')
  ui.setImportMsg(
    `已匯入標註 ${fileName}：Lane Base 套用 ${laneReport.appliedRoadDirections} 個道路方向、`
    + `待轉區 +${res.zones.length}`
    + (skipped ? `（略過 ${skipped}：${detail}）` : '')
    + '；車道標註僅限本次工作階段，正式保存需重新建置 canonical Lane Base',
  )
}
