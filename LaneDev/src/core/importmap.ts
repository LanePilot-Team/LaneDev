// 匯入 LanePilot 資料（自動判別種類）：
//   segments.jsonl（行政區 shard）→ Base Layer 換底圖
//   annotations.jsonl（人工標註） → Enhancement Layer（journal 車道覆寫 + 待轉區）
//   一般 GeoJSON FeatureCollection  → 同 fetch_nanzi.py 輸出，直接當底圖
//
// segments 每行一筆 nav_segment，帶 osm_raw_tags、geometry 與 node_refs
//（node ID 陣列，與座標一一對應——graph.ts 切拓撲必需，沒有它只能看不能導航）。
// annotations 同時支援 legacy（nav_segment_annotation）與 schema v2
//（nav_context_annotation，一路段多筆 context）。
import type { Feature, FeatureCollection, LineString } from 'geojson'

export interface LaneProfile {
  direction: string
  lane_count?: number
  lane_movements?: string[]
  motorcycle_access_by_lane?: string[]
}

export interface MovementRule {
  applies_to_intersection_key?: string | null
  approach_segment_key?: string
  approach_direction?: string
  movement?: string
  motorcycle_turn_rule?: string
  waiting_zone_exists?: string
}

export interface AnnotationRecord {
  segmentKey: string // "way/123"
  /** v2 的 context_scope；legacy 記錄為 undefined（視同整段） */
  contextScope?: string
  laneProfiles: LaneProfile[]
  movementRules: MovementRule[]
}

export type ImportResult =
  | { kind: 'map'; fc: FeatureCollection<LineString>; total: number; withNodes: number }
  | { kind: 'annotations'; records: AnnotationRecord[] }

/** 單筆標註物件 → AnnotationRecord（jsonl 逐行與「一筆一檔」單檔共用） */
function annotationRecord(rec: Record<string, unknown>): AnnotationRecord | null {
  const identity = rec.object_identity as Record<string, unknown> | undefined
  if (!String(identity?.object_type ?? '').includes('annotation')) return null
  const segmentKey = String(identity?.nav_segment_key ?? '')
  if (!segmentKey) return null
  const laneNav = (rec.lane_nav_tags ?? {}) as Record<string, unknown>
  const taiwan = (laneNav.taiwan_motorcycle_tags ?? {}) as Record<string, unknown>
  const detail = (laneNav.lane_detail_tags ?? {}) as Record<string, unknown>
  return {
    segmentKey,
    contextScope: identity?.context_scope ? String(identity.context_scope) : undefined,
    laneProfiles: (detail.lane_profiles as LaneProfile[] | undefined) ?? [],
    movementRules: (taiwan.movement_rules as MovementRule[] | undefined) ?? [],
  }
}

export function parseImported(text: string): ImportResult {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('檔案是空的')

  // 整份 JSON：GeoJSON FeatureCollection，或 LanePilot 佇列「一筆一檔」的單筆標註
  if (trimmed.startsWith('{') && !trimmed.includes('\n{"')) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj?.type === 'FeatureCollection') {
        return { kind: 'map', fc: obj, total: obj.features.length, withNodes: countNodes(obj) }
      }
      const single = annotationRecord(obj as Record<string, unknown>)
      if (single) return { kind: 'annotations', records: [single] }
    } catch { /* 落到 jsonl 解析 */ }
  }

  // JSONL：逐行解析，路段與標註分開收
  const features: Feature<LineString>[] = []
  const annotations: AnnotationRecord[] = []
  let withNodes = 0
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line)
    } catch {
      throw new Error('不是有效的 JSONL（某一行無法解析）')
    }
    const identity = rec.object_identity as Record<string, unknown> | undefined
    const objType = String(identity?.object_type ?? '')
    const laneNav = (rec.lane_nav_tags ?? {}) as Record<string, unknown>

    if (objType.includes('annotation')) {
      const ann = annotationRecord(rec)
      if (ann) annotations.push(ann)
      continue
    }

    const geometry = rec.geometry as LineString | undefined
    if (objType !== 'nav_segment' || !geometry || geometry.type !== 'LineString') continue
    const tags = (rec.osm_raw_tags ?? {}) as Record<string, string>
    const nodeRefs = rec.node_refs as number[] | undefined
    if (nodeRefs && nodeRefs.length === geometry.coordinates.length) withNodes++
    features.push({
      type: 'Feature',
      geometry,
      properties: {
        osm_id: (identity!.source_osm as Record<string, unknown>).osm_id,
        name: tags.name ?? (laneNav.road_name as string | undefined),
        highway: tags.highway ?? (laneNav.road_class as string | undefined),
        oneway: tags.oneway,
        maxspeed: tags.maxspeed,
        motorcycle: tags.motorcycle,
        motorcar: tags.motorcar,
        junction: tags.junction,
        lanes: tags.lanes,
        lanes_forward: tags['lanes:forward'],
        lanes_backward: tags['lanes:backward'],
        turn_lanes: tags['turn:lanes'],
        turn_lanes_forward: tags['turn:lanes:forward'],
        nodes: nodeRefs ?? [],
      },
    })
  }

  if (features.length) {
    return { kind: 'map', fc: { type: 'FeatureCollection', features }, total: features.length, withNodes }
  }
  if (annotations.length) return { kind: 'annotations', records: annotations }
  throw new Error('檔案裡沒有可用的內容（需要 segments.jsonl、annotations.jsonl 或路網 GeoJSON）')
}

/** 多份路網（跨行政區 shard）合併：同 osm_id 只留第一筆（跨界 way 兩區都收錄） */
export function mergeMaps(
  maps: { fc: FeatureCollection<LineString> }[],
): { fc: FeatureCollection<LineString>; total: number; withNodes: number } {
  const byId = new Map<unknown, Feature<LineString>>()
  for (const m of maps) {
    for (const f of m.fc.features) {
      const id = (f.properties as Record<string, unknown> | null)?.osm_id
      if (!byId.has(id)) byId.set(id, f)
    }
  }
  const fc: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [...byId.values()] }
  return { fc, total: fc.features.length, withNodes: countNodes(fc) }
}

function countNodes(fc: FeatureCollection<LineString>): number {
  let n = 0
  for (const f of fc.features) {
    const nodes = (f.properties as Record<string, unknown> | null)?.nodes as number[] | undefined
    if (nodes && nodes.length === f.geometry.coordinates.length) n++
  }
  return n
}
