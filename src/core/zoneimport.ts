// LanePilot 標註 → 待轉區的核心匹配邏輯：movement_rules（兩段式左轉/有待轉格）
// 對回路網圖的左轉配對，位置交給 planZone（停止線對齊）。
// 三個使用方共用同一套：importFlow（手動匯入）、mapCore（啟動自動吃入）、
// scripts/import_audit.ts（離線稽核）——稽核工具必須與 app 走同一條 code path。
import type { AnnotationRecord } from './importmap'
import type { RoadFeature } from './roads'
import type { RoadGraph, TurnOption } from './graph'
import type { DropRemap } from './couplet'
import { makeZoneCtx, planZone, type Zone } from './zones'
import { angleDelta, bearing as geoBearing, haversine } from './geo'
import { laneBaseZoneCandidates, type LaneBaseIndex } from './laneBase.ts'

/** 底圖前處理「之前」的原始 way 幾何（載入時反轉 oneway=-1 之後）。
 * couplet 合併/退化清理會讓部分 way 從底圖消失（連 wayRemap 都沒有——
 * 例：成對單行間的短穿越段被整條清除），標註的進入方位角只能從這裡回推。 */
export interface RawWay {
  coords: [number, number][]
  nodes: number[]
  reversed: boolean
}

export function buildRawWays(roads: RoadFeature[]): Map<number, RawWay> {
  const out = new Map<number, RawWay>()
  for (const r of roads) {
    out.set(r.properties.osm_id, {
      coords: (r.geometry.coordinates as [number, number][]).map((c) => [c[0], c[1]]),
      nodes: [...r.properties.nodes],
      reversed: !!r.properties.reversed,
    })
  }
  return out
}

type Dir = 'forward' | 'backward'
const flipDir = (d: Dir): Dir => (d === 'forward' ? 'backward' : 'forward')

export interface ZoneSkip {
  reason: 'node' | 'noLeft' | 'dir'
  /** 標註識別：segmentKey@路口鍵/方向（稽核清單給組員對回標註用） */
  key: string
  segmentKey: string
  nodeId?: number
  detail?: string
}

export interface ZoneImportResult {
  zones: Zone[]
  skips: ZoneSkip[]
}

export interface LaneBaseZoneBuildResult extends ZoneImportResult {
  accountedSourceKeys: string[]
  unresolvedSourceKeys: string[]
}

/** Visible editor state: immutable LanePilot base, then human overrides, then tombstones. */
export function overlayWaitingZones(
  baseZones: Zone[], humanZones: Zone[], deletedIds: Set<string>,
): Zone[] {
  const visible = new Map<string, Zone>()
  for (const zone of baseZones) visible.set(zone.id, zone)
  for (const zone of humanZones) {
    const base = visible.get(zone.id)
    // Before Task 5, derived zone-lp-* rows were persisted in editor.waiting_zones.
    // Only a current stable base id may now be treated as an intentional replacement.
    if (zone.id.startsWith('zone-lp-') && !base) continue
    visible.set(zone.id, { ...(base ?? {}), ...zone } as Zone)
  }
  for (const id of deletedIds) visible.delete(id)
  return [...visible.values()]
}

/** Extract only editor-owned additions/replacements from a visible overlaid zone list. */
export function humanWaitingZones(baseZones: Zone[], visibleZones: Zone[]): Zone[] {
  const baseById = new Map(baseZones.map((zone) => [zone.id, zone]))
  return visibleZones.filter((zone) => {
    const base = baseById.get(zone.id)
    return !base || JSON.stringify(base) !== JSON.stringify(zone)
  })
}

/** Build geometric zones from the already-normalized Lane Base; no annotation parsing occurs here. */
export function zonesFromLaneBase(args: {
  index: LaneBaseIndex
  graph: RoadGraph
  roads: RoadFeature[]
  rawWays?: Map<number, RawWay>
  existing?: Zone[]
}): LaneBaseZoneBuildResult {
  const zones: Zone[] = []
  const skips: ZoneSkip[] = []
  const resolvedGeometry = new Set<string>()
  const candidates = laneBaseZoneCandidates(args.index)
  for (const candidate of candidates) {
    const result = zonesFromAnnotations({
      records: [{
        segmentKey: `way/${candidate.approachWayId}`,
        sourceKey: candidate.sourceKey,
        contextScope: 'intersection_approach',
        approachNodeKey: `node/${candidate.intersectionNodeId}`,
        approachDirection: candidate.direction,
        laneProfiles: [],
        movementRules: [{
          applies_to_intersection_key: `node/${candidate.intersectionNodeId}`,
          approach_segment_key: `way/${candidate.approachWayId}`,
          approach_direction: candidate.direction,
          movement: candidate.movement,
          motorcycle_turn_rule: candidate.twoStage ? 'two_stage_required' : 'normal',
          waiting_zone_exists: 'yes',
        }],
      }],
      graph: args.graph,
      roads: args.roads,
      nodeRemap: new Map(),
      wayRemap: new Map(),
      rawWays: args.rawWays,
      existing: [...(args.existing ?? []), ...zones],
    })
    skips.push(...result.skips)
    if (result.zones.length) {
      const derived = { ...result.zones[0], id: candidate.id }
      zones.push(derived)
      resolvedGeometry.add(candidate.sourceKey)
    }
  }
  const candidateSources = new Set(candidates.map((candidate) => candidate.sourceKey))
  return {
    zones,
    skips,
    accountedSourceKeys: [...candidateSources].sort(),
    unresolvedSourceKeys: [...candidateSources]
      .filter((key) => !resolvedGeometry.has(key)).sort(),
  }
}

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

/** 原始 way 幾何版的進入行向（底圖裡找不到 approach way 時的後援） */
function rawBearingAt(raw: RawWay, i: number, dir: Dir): number | null {
  const eff = raw.reversed ? flipDir(dir) : dir
  if (eff === 'forward') {
    if (i > 0) return geoBearing(raw.coords[i - 1], raw.coords[i])
  } else if (i < raw.coords.length - 1) {
    return geoBearing(raw.coords[i + 1], raw.coords[i])
  }
  return null
}

/**
 * 標註 → 待轉區。回傳新生成的 zones（id = zone-lp-{node}-{fromBearing}，確定性、
 * 可重跑）與略過清單。existing 只做去重（同路口同進入向 30° 內不重複生成），
 * 不會被修改——手動放置的 zone 永遠優先。
 */
export function zonesFromAnnotations(args: {
  records: AnnotationRecord[]
  graph: RoadGraph
  roads: RoadFeature[]
  nodeRemap: Map<number, number>
  wayRemap: Map<number, DropRemap>
  rawWays?: Map<number, RawWay>
  existing?: Zone[]
}): ZoneImportResult {
  const { records, graph, roads, nodeRemap, wayRemap, rawWays } = args
  const existing = args.existing ?? []
  const byId = new Map<number, RoadFeature[]>()
  for (const r of roads) {
    const id = r.properties.osm_id
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(r)
  }
  const inters = graph.intersections()
  const interPos = new Map(inters.map((i) => [i.id, i.pos]))
  const ctx = makeZoneCtx(graph)
  const zones: Zone[] = []
  const skips: ZoneSkip[] = []
  const taken = (nodeId: number, fromBearing: number) =>
    existing.concat(zones).some((z) =>
      z.intersectionId === nodeId && Math.abs(angleDelta(z.from.bearing, fromBearing)) < 30)

  for (const rec of records) {
    for (const rule of rec.movementRules) {
      if (rule.movement !== 'left') continue
      const want = rule.motorcycle_turn_rule === 'two_stage_required'
        || rule.motorcycle_turn_rule === 'two_stage_optional'
        || rule.waiting_zone_exists === 'yes'
      if (!want) continue
      const key = `${rec.segmentKey}@${rule.applies_to_intersection_key ?? '?'}`
        + `/${rule.approach_direction ?? 'forward'}`
      const rawNode = Number((rule.applies_to_intersection_key ?? '').split('/')[1])
      if (!rawNode) {
        skips.push({ reason: 'node', key, segmentKey: rec.segmentKey })
        continue
      }
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
          // OSM 原始方向 → drop 載入後行向（dropReversed 翻轉）→ 對 keep 順向：
          // 對向 drop（couplet）再翻一次；同向吸收（sameDir，慢車道）不翻
          const eff = dropped.dropReversed ? flipDir(dir) : dir
          dir = dropped.sameDir ? eff : flipDir(eff)
          normalized = true
        }
      }
      // 進入方位角：底圖區塊優先；way 被前處理清掉時退到原始 shard 幾何
      let refBrg = blocks?.length ? approachBearingAt(blocks, nodeId, dir, normalized) : null
      let rawPos: [number, number] | null = null
      const raw = rawWays?.get(appId)
      if (raw) {
        const i = raw.nodes.indexOf(rawNode)
        if (i >= 0) {
          rawPos = raw.coords[i]
          if (refBrg === null) refBrg = rawBearingAt(raw, i, dir)
        }
      }
      /** 在節點 nid 試配：最佳左轉選項＋進入方向誤差（null = 無左轉配對/方向不明） */
      const evaluate = (nid: number): { opt: TurnOption; err: number } | null => {
        const options = graph.leftTurnOptions(nid)
        if (!options.length) return null
        if (refBrg === null) return options.length === 1 ? { opt: options[0], err: 0 } : null
        let best = Infinity
        let opt = options[0]
        for (const o of options) {
          const d = Math.abs(angleDelta(o.fromBearing, refBrg))
          if (d < best) { best = d; opt = o }
        }
        return { opt, err: best }
      }
      let m = evaluate(nodeId)
      if ((!m || m.err > 60) && refBrg !== null) {
        // couplet 合併把成對路口的 2×2 節點收攏：標註釘的 node 可能已不是
        // 「這個進入向的左轉」所在節點——40m 內其他路口依距離近到遠重試。
        // 方向不明（refBrg null）不重試：單選項小巷會亂配
        const p0 = interPos.get(nodeId) ?? rawPos
        if (p0) {
          const cands = inters
            .map((i) => ({ id: i.id, d: haversine(p0, i.pos) }))
            .filter((c) => c.id !== nodeId && c.d <= 40)
            .sort((a, b) => a.d - b.d)
          for (const c of cands) {
            const mm = evaluate(c.id)
            if (mm && mm.err <= 60) { m = mm; nodeId = c.id; break }
          }
        }
      }
      if (!m) {
        skips.push({ reason: 'noLeft', key, segmentKey: rec.segmentKey, nodeId })
        continue
      }
      if (m.err > 60) { // 對不上進入方向，寧缺勿錯
        skips.push({
          reason: 'dir', key, segmentKey: rec.segmentKey, nodeId,
          detail: `標註方向=${rule.approach_direction ?? 'forward'} 方位角 `
            + `${refBrg?.toFixed(0) ?? '?'}°，最佳選項差 ${m.err.toFixed(0)}°`,
        })
        continue
      }
      if (taken(nodeId, m.opt.fromBearing)) continue
      zones.push({
        ...planZone(m.opt, ctx),
        id: `zone-lp-${nodeId}-${Math.round(m.opt.fromBearing)}`,
      })
    }
  }
  return { zones, skips }
}
