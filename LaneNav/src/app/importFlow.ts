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
import { saveZones, planZone } from '../core/zones'
import { angleDelta, bearing as geoBearing, haversine } from '../core/geo'
import type { TurnOption } from '../core/graph'
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
  const prep = prepareBaseRoads(roadsFromGeoJSON({ type: 'FeatureCollection', features }))
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

type Dir = 'forward' | 'backward'
const flipDir = (d: Dir): Dir => (d === 'forward' ? 'backward' : 'forward')

/** way 上某節點的「進入行向」（forward = 沿座標順向抵達該點）。
 * way 已依路口切塊，node 可能只在其中一塊：逐塊找到有相鄰點的那塊。
 * normalized = dir 已是載入後的幾何方向（couplet wayRemap 換算過），
 * 不再套 road.reversed（預設 false：dir 是 OSM 原始方向，要翻回來） */
function approachBearingAt(
  blocks: RoadFeature[], nodeId: number, dir: Dir, normalized = false,
): number | null {
  for (const road of blocks) {
    const nodes = road.properties.nodes
    const i = nodes.indexOf(nodeId)
    if (i < 0) continue
    // oneway=-1 的 way 載入時反轉過幾何；標註的方向是 OSM 原始方向，要翻回來
    const eff = !normalized && road.properties.reversed ? flipDir(dir) : dir
    const cs = road.geometry.coordinates as [number, number][]
    if (eff === 'forward') {
      if (i > 0) return geoBearing(cs[i - 1], cs[i])
    } else if (i < cs.length - 1) {
      return geoBearing(cs[i + 1], cs[i])
    }
  }
  return null
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
  const skip = { seg: 0, node: 0, noLeft: 0, dir: 0 }
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
    if (f?.motorcycle_access_by_lane?.includes('designated')) fields.moto_forward = 1
    if (bwd?.motorcycle_access_by_lane?.includes('designated')) fields.moto_backward = 1
    const access = [...(f?.motorcycle_access_by_lane ?? []), ...(bwd?.motorcycle_access_by_lane ?? [])]
    if (access.length && access.every((x) => x === 'no')) fields.motorcycle = 'no' // 全車道禁行 = 整段禁行機車
    if (!Object.keys(fields).length) continue
    let keys = [wayKey]
    if (dropped) {
      // drop 側標註（OSM 原始方向）換到 keep way：drop 行進方向 = 合併後 backward。
      // dropReversed（oneway=-1，載入已反轉）時兩次翻轉抵銷，欄位方向不對調
      if (!dropped.dropReversed) {
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
  let zonesAdded = 0
  const interPos = new Map(core.intersectionsRef.current.map((i) => [i.id, i.pos]))
  for (const rec of records) {
    for (const rule of rec.movementRules) {
      if (rule.movement !== 'left') continue
      const want = rule.motorcycle_turn_rule === 'two_stage_required'
        || rule.motorcycle_turn_rule === 'two_stage_optional'
        || rule.waiting_zone_exists === 'yes'
      if (!want) continue
      const rawNode = Number((rule.applies_to_intersection_key ?? '').split('/')[1])
      if (!rawNode) { skip.node++; continue }
      // couplet 合併可能把路口 node 併到 keep 側既有 node——先過重映射表
      let nodeId = nodeRemap.get(rawNode) ?? rawNode
      const appId = Number((rule.approach_segment_key ?? rec.segmentKey).split('/')[1])
      let blocks = byId.get(appId)
      let dir: Dir = rule.approach_direction === 'backward' ? 'backward' : 'forward'
      let normalized = false
      if (!blocks) {
        const dropped = wayRemap.get(appId)
        if (dropped) {
          blocks = dropped.keepIds.flatMap((id) => byId.get(id) ?? [])
          // OSM 原始方向 → drop 載入後行向（dropReversed 翻轉）→ 對向 keep 再翻一次
          dir = dropped.dropReversed ? dir : flipDir(dir)
          normalized = true
        }
      }
      /** 在節點 nid 試配：最佳左轉選項＋進入方向誤差（null = 無左轉配對/方向不明） */
      const evaluate = (nid: number): { opt: TurnOption; err: number } | null => {
        const options = core.graphRef.current?.leftTurnOptions(nid) ?? []
        if (!options.length) return null
        const appBrg = blocks?.length ? approachBearingAt(blocks, nid, dir, normalized) : null
        if (appBrg === null) return options.length === 1 ? { opt: options[0], err: 0 } : null
        let best = Infinity
        let opt = options[0]
        for (const o of options) {
          const d = Math.abs(angleDelta(o.fromBearing, appBrg))
          if (d < best) { best = d; opt = o }
        }
        return { opt, err: best }
      }
      let m = evaluate(nodeId)
      if ((!m || m.err > 60) && blocks?.length) {
        // couplet 合併把成對路口的 2×2 節點收攏：標註釘的 node 可能已不是
        // 「這個進入向的左轉」所在的節點——沿 approach 區塊 40m 內其他路口重試
        const p0 = interPos.get(nodeId)
        if (p0) {
          const seen = new Set<number>([nodeId])
          for (const b of blocks) {
            for (const n of b.properties.nodes) {
              if (seen.has(n)) continue
              seen.add(n)
              const p = interPos.get(n)
              if (!p || haversine(p0, p) > 40) continue
              const mm = evaluate(n)
              if (mm && mm.err <= 60) { m = mm; nodeId = n; break }
            }
            if (m && m.err <= 60) break
          }
        }
      }
      if (!m) { skip.noLeft++; continue }
      if (m.err > 60) { skip.dir++; continue } // 對不上進入方向，寧缺勿錯
      const opt = m.opt
      if (core.zonesRef.current.some((z) =>
        z.intersectionId === nodeId && Math.abs(angleDelta(z.from.bearing, opt.fromBearing)) < 30)) continue
      const zone = { ...planZone(opt), id: `zone-lp-${nodeId}-${Math.round(opt.fromBearing)}` }
      core.zonesRef.current = [...core.zonesRef.current, zone]
      zonesAdded++
    }
  }
  if (zonesAdded) {
    saveZones(core.zonesRef.current)
    core.refreshZones()
  }
  const skipped = skip.seg + skip.node + skip.noLeft + skip.dir
  const detail = [
    skip.seg ? `路段不在底圖 ${skip.seg}` : '',
    skip.node ? `缺路口鍵 ${skip.node}` : '',
    skip.noLeft ? `路口無左轉配對 ${skip.noLeft}` : '',
    skip.dir ? `進入方向對不上 ${skip.dir}` : '',
  ].filter(Boolean).join('、')
  ui.setImportMsg(`已匯入標註 ${fileName}：車道覆寫 ${laneApplied} 路段、待轉區 +${zonesAdded}`
    + (skipped ? `（略過 ${skipped}：${detail}）` : ''))
}
