// 「匯入地圖」流程：segments.jsonl（換底圖）與 annotations.jsonl（唯讀套用標註）。
// LaneDev / LaneNav 共用；狀態都在 MapCore 的 refs，這裡是純函式。
import maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import {
  parseImported, mergeMaps,
  type AnnotationRecord as ImportedAnnotation, type LaneProfile,
} from '../core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../core/roads'
import { prepareBaseRoads } from '../core/pipeline'
import { appendRecord, applyToRoads, foldJournal } from '../core/enhancements'
import { saveZones } from '../core/zones'
import { buildRawWays, zonesFromAnnotations } from '../core/zoneimport'
import type { MapCore, Mode } from './mapCore'

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
  const roads = prep.roads
  core.nodeRemapRef.current = prep.nodeRemap
  core.wayRemapRef.current = prep.wayRemap
  applyToRoads(roads, foldJournal(core.journalRef.current))
  ui.switchMode('browse') // 內部已處理「行駛中先 endDrive」，涵蓋模擬與 GPS 兩種模式
  core.replaceBaseMap(roads)
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
 *   lane_profiles   → journal 車道覆寫（記 author=lanepilot，可追溯/可重匯）
 *   movement_rules  → 兩段式左轉/待轉區 → zones（位置由路口幾何自動計算）
 */
function importAnnotations(core: MapCore, ui: ImportUi, records: ImportedAnnotation[], fileName: string) {
  // way 依路口切塊後同 osm_id 有多個區塊，全部收（進入行向要逐塊找 node）
  const byId = new Map<number, RoadFeature[]>()
  for (const r of core.roadsRef.current) {
    const id = r.properties.osm_id
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(r)
  }

  // 1) 車道覆寫：同路段同方向以「整段 scope」優先（approach scope 是路口前的區域資訊）
  const profByWay = new Map<string, Map<string, { p: LaneProfile; whole: boolean }>>()
  for (const rec of records) {
    const whole = rec.contextScope !== 'intersection_approach'
    for (const p of rec.laneProfiles) {
      if (!p?.direction) continue
      let dirs = profByWay.get(rec.segmentKey)
      if (!dirs) profByWay.set(rec.segmentKey, dirs = new Map())
      const cur = dirs.get(p.direction)
      if (!cur || (whole && !cur.whole)) dirs.set(p.direction, { p, whole })
    }
  }
  const nodeRemap = core.nodeRemapRef.current
  const wayRemap = core.wayRemapRef.current
  let laneApplied = 0
  // 略過原因分類計數（訊息要能回答「為什麼掉了」——標註格式檢討的依據）
  const skip = { seg: 0 }
  for (const [wayKey, dirs] of profByWay) {
    const segId = Number(wayKey.split('/')[1])
    // 被 couplet 合併掉的 way：標註轉掛到對向 keep way（方向要翻，見下）
    const dropped = byId.has(segId) ? undefined : wayRemap.get(segId)
    if (!byId.has(segId) && !dropped) { skip.seg++; continue }
    const f = dirs.get('forward')?.p
    const bwd = dirs.get('backward')?.p
    const fields: Record<string, string | number> = {}
    if (f?.lane_count) fields.lanes_forward = f.lane_count
    if (bwd?.lane_count) fields.lanes_backward = bwd.lane_count
    if (f?.lane_movements?.some((x) => x && x !== 'unknown')) {
      fields.turn_lanes = f.lane_movements.map((x) => (x === 'unknown' ? '' : x)).join('|')
    }
    if (bwd?.lane_movements?.some((x) => x && x !== 'unknown')) {
      fields.turn_lanes_backward = bwd.lane_movements.map((x) => (x === 'unknown' ? '' : x)).join('|')
    }
    const motoForwardLanes = f?.motorcycle_access_by_lane
      ?.filter((access) => access === 'designated').length ?? 0
    const motoBackwardLanes = bwd?.motorcycle_access_by_lane
      ?.filter((access) => access === 'designated').length ?? 0
    if (motoForwardLanes > 0) fields.moto_forward = motoForwardLanes
    if (motoBackwardLanes > 0) fields.moto_backward = motoBackwardLanes
    const access = [...(f?.motorcycle_access_by_lane ?? []), ...(bwd?.motorcycle_access_by_lane ?? [])]
    if (access.length && access.every((x) => x === 'no')) fields.motorcycle = 'no' // 全車道禁行 = 整段禁行機車
    if (!Object.keys(fields).length) continue
    let keys = [wayKey]
    if (dropped) {
      // drop 側標註（OSM 原始方向）換到 keep way：對向 drop（couplet）行進方向
      // = 合併後 backward、同向吸收（sameDir，慢車道）= forward；
      // dropReversed（oneway=-1，載入已反轉）再翻轉一次，兩者 XOR 決定是否對調
      const aligned = dropped.dropReversed ? !(dropped.sameDir ?? false) : (dropped.sameDir ?? false)
      if (!aligned) {
        const swap = (a: string, b: string) => {
          const va = fields[a], vb = fields[b]
          delete fields[a]; delete fields[b]
          if (vb !== undefined) fields[a] = vb
          if (va !== undefined) fields[b] = va
        }
        swap('lanes_forward', 'lanes_backward')
        swap('turn_lanes', 'turn_lanes_backward')
        swap('moto_forward', 'moto_backward')
      }
      keys = dropped.keepIds.filter((id) => byId.has(id)).map((id) => `way/${id}`)
      if (!keys.length) { skip.seg++; continue }
    }
    for (const key of keys) {
      core.journalRef.current = appendRecord(core.journalRef.current,
        { op: 'set', target: { type: 'road', key }, fields }, 'lanepilot')
    }
    laneApplied++
  }
  if (laneApplied) {
    applyToRoads(core.roadsRef.current, foldJournal(core.journalRef.current))
    core.redrawRoads()
    core.refreshBays()
  }

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
    saveZones(core.zonesRef.current)
    core.refreshZones()
  }
  const count = (r: string) => res.skips.filter((s) => s.reason === r).length
  const skipped = skip.seg + res.skips.length
  const detail = [
    skip.seg ? `路段不在底圖 ${skip.seg}` : '',
    count('node') ? `缺路口鍵 ${count('node')}` : '',
    count('noLeft') ? `路口無左轉配對 ${count('noLeft')}` : '',
    count('dir') ? `進入方向對不上 ${count('dir')}` : '',
  ].filter(Boolean).join('、')
  ui.setImportMsg(`已匯入標註 ${fileName}：車道覆寫 ${laneApplied} 路段、待轉區 +${res.zones.length}`
    + (skipped ? `（略過 ${skipped}：${detail}）` : ''))
}
