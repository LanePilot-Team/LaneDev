import { angleDelta, bearing, haversine } from './geo.ts'
import {
  applyCenterIslandJoins, CENTER_ISLAND_JOINS, type CenterIslandJoinSpec,
} from './centerIslandJoins.ts'
import type { EnhancementRecord } from './enhancements'
import type { OneSideEntryAccess, RoadFeature, RoadProps } from './roads'

export interface ResolvedRoadMerge {
  mergeKey: string
  primary: RoadFeature
  secondary: RoadFeature
  primaryKey: string
  secondaryKey: string
  junctionNodeId: number
  primaryAt: 'start' | 'end'
  secondaryAt: 'start' | 'end'
  adjacentBack: boolean | null
  sideAccess: { sideRoadKey: string; allowedBack: boolean }[]
  resolvedBy: 'exact' | 'active-node' | 'source-segment' | 'already-absorbed'
  sourceSeq?: number
  sourceTs?: string
  sourceAuthor?: string
}

export interface RoadMergeReplayRow {
  mergeKey: string
  primaryKey: string
  secondaryKey: string
  status: 'replayable' | 'recoverable_via_provenance'
    | 'needs_manual_review' | 'legacy_destructive' | 'invalid'
  detail: string
  resolved?: ResolvedRoadMerge
}

interface ParsedBlockKey {
  wayId: number
  blockNode: number
}

interface BlockResolution {
  road: RoadFeature
  by: 'exact' | 'active-node' | 'source-segment'
}

const roadBlockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

const clonePreviousAccess = (
  value: OneSideEntryAccess[] | OneSideEntryAccess | undefined,
): OneSideEntryAccess[] | undefined => {
  if (!value) return undefined
  return (Array.isArray(value) ? value : [value]).map((entry) => ({ ...entry }))
}

const parseBlockKey = (key: string): ParsedBlockKey | null => {
  const match = key.match(/^way\/(-?\d+)@b\/(-?\d+)$/)
  return match ? { wayId: Number(match[1]), blockNode: Number(match[2]) } : null
}

const cloneRoad = (road: RoadFeature): RoadFeature => ({
  ...road,
  geometry: {
    ...road.geometry,
    coordinates: road.geometry.coordinates.map((coordinate) => [...coordinate]),
  },
  properties: {
    ...road.properties,
    nodes: [...road.properties.nodes],
    sourceSegments: road.properties.sourceSegments.map((source) => ({
      ...source,
      nodeRefs: [...source.nodeRefs],
      // 來源幾何只用於追溯消歧，建立視圖時不會修改；共用可避免每次預覽
      // 都複製整份 OSM 幾何，尤其 UI 在捏合前後連續建圖時會造成記憶體尖峰。
      coordinates: source.coordinates,
    })),
    oneSideEntryNodes: road.properties.oneSideEntryNodes
      ? [...road.properties.oneSideEntryNodes] : undefined,
    oneSideEntryAccess: road.properties.oneSideEntryAccess
      ? road.properties.oneSideEntryAccess.map((entry) => ({ ...entry })) : undefined,
    roadMergeBarrierNodes: road.properties.roadMergeBarrierNodes
      ? [...road.properties.roadMergeBarrierNodes] : undefined,
    centerIslandJoinNodes: road.properties.centerIslandJoinNodes
      ? [...road.properties.centerIslandJoinNodes] : undefined,
    medianContinuityPeers: road.properties.medianContinuityPeers
      ? road.properties.medianContinuityPeers.map((peer) => ({ ...peer })) : undefined,
    roadMergeDerived: road.properties.roadMergeDerived
      ? road.properties.roadMergeDerived.map((entry) => ({
        ...entry,
        previousAccess: clonePreviousAccess(entry.previousAccess),
      })) : undefined,
  },
})

const cloneWithoutDerivedRoadMerge = (road: RoadFeature): RoadFeature => {
  const clean = cloneRoad(road)
  for (const derived of clean.properties.roadMergeDerived ?? []) {
    if (!derived.hadNode) {
      clean.properties.oneSideEntryNodes = clean.properties.oneSideEntryNodes
        ?.filter((node) => node !== derived.nodeId)
    }
    if (!derived.hadBarrier) {
      clean.properties.roadMergeBarrierNodes = clean.properties.roadMergeBarrierNodes
        ?.filter((node) => node !== derived.nodeId)
    }
    clean.properties.oneSideEntryAccess = clean.properties.oneSideEntryAccess
      ?.filter((entry) => entry.nodeId !== derived.nodeId)
    const previousAccess = clonePreviousAccess(derived.previousAccess)
    if (previousAccess) {
      clean.properties.oneSideEntryAccess = [
        ...(clean.properties.oneSideEntryAccess ?? []),
        ...previousAccess,
      ]
    }
  }
  if (clean.properties.oneSideEntryNodes?.length === 0) {
    clean.properties.oneSideEntryNodes = undefined
  }
  if (clean.properties.oneSideEntryAccess?.length === 0) {
    clean.properties.oneSideEntryAccess = undefined
  }
  if (clean.properties.roadMergeBarrierNodes?.length === 0) {
    clean.properties.roadMergeBarrierNodes = undefined
  }
  // 貫通接點與續行對照永遠是視圖推導出來的，重建時一律清掉再重算
  clean.properties.centerIslandJoinNodes = undefined
  clean.properties.medianContinuityPeers = undefined
  clean.properties.roadMergeDerived = undefined
  return clean
}

const activeMergeRecordsInSequence = (journal: EnhancementRecord[]) => {
  const active = new Map<string, EnhancementRecord>()
  const ordered = [...journal].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts))
  for (const record of ordered) {
    if (record.target.type !== 'road_merge') continue
    if (record.op === 'delete') active.delete(record.target.key)
    else active.set(record.target.key, record)
  }
  return [...active.values()].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts))
}

const candidatesFor = (roads: RoadFeature[], key: string): BlockResolution[] => {
  const exact = roads.find((road) => roadBlockKey(road) === key)
  if (exact) return [{ road: exact, by: 'exact' }]
  const parsed = parseBlockKey(key)
  if (!parsed) return []
  const activeNode = roads.filter((road) =>
    road.properties.osm_id === parsed.wayId
    && road.properties.nodes.includes(parsed.blockNode))
  if (activeNode.length) return activeNode.map((road) => ({ road, by: 'active-node' }))
  const provenance = roads
    .filter((road) => road.properties.sourceSegments.some((source) =>
      source.osmId === parsed.wayId && source.nodeRefs.includes(parsed.blockNode)))
    .map((road): BlockResolution => ({ road, by: 'source-segment' }))
  // couplet 的 sourceSegments 可能保存整條被 drop way 的完整 nodeRefs，因而讓
  // 每個切塊都看似候選；目前活躍幾何仍實際承載 blockNode 時，以它精確消歧。
  const carryingNode = provenance.filter(({ road }) =>
    road.properties.nodes.includes(parsed.blockNode))
  if (carryingNode.length) return carryingNode

  const pointToRoadM = (point: [number, number], road: RoadFeature) => {
    const coordinates = road.geometry.coordinates as [number, number][]
    const kx = 111320 * Math.cos(point[1] * Math.PI / 180)
    const ky = 110540
    let best = Infinity
    for (let index = 0; index < coordinates.length - 1; index++) {
      const a = coordinates[index], b = coordinates[index + 1]
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky
      const px = (point[0] - a[0]) * kx, py = (point[1] - a[1]) * ky
      const length2 = dx * dx + dy * dy
      const t = length2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy))
    }
    return best
  }
  const positioned = provenance.filter(({ road }) => {
    for (const source of road.properties.sourceSegments) {
      if (source.osmId !== parsed.wayId || !source.coordinates) continue
      const index = source.nodeRefs.indexOf(parsed.blockNode)
      const point = source.coordinates[index]
      if (point && pointToRoadM(point, road) <= 25) return true
    }
    return false
  })
  return positioned.length ? positioned : provenance
}

const endpointJoin = (primary: RoadFeature, secondary: RoadFeature) => {
  const a = primary.geometry.coordinates as [number, number][]
  const b = secondary.geometry.coordinates as [number, number][]
  if (a.length < 2 || b.length < 2) return null
  const pairs = [
    { primaryAt: 'start' as const, secondaryAt: 'start' as const,
      primaryIndex: 0, secondaryIndex: 0 },
    { primaryAt: 'start' as const, secondaryAt: 'end' as const,
      primaryIndex: 0, secondaryIndex: b.length - 1 },
    { primaryAt: 'end' as const, secondaryAt: 'start' as const,
      primaryIndex: a.length - 1, secondaryIndex: 0 },
    { primaryAt: 'end' as const, secondaryAt: 'end' as const,
      primaryIndex: a.length - 1, secondaryIndex: b.length - 1 },
  ].map((pair) => ({ ...pair, distanceM: haversine(a[pair.primaryIndex], b[pair.secondaryIndex]) }))
    .sort((left, right) => left.distanceM - right.distanceM)
  return pairs[0]
}

const mergedMainAroundJunction = (
  primary: RoadFeature,
  secondary: RoadFeature,
  primaryAt: 'start' | 'end',
  secondaryAt: 'start' | 'end',
  junctionNodeId: number,
) => {
  if (primary === secondary) {
    const index = primary.properties.nodes.indexOf(junctionNodeId)
    const coordinates = primary.geometry.coordinates as [number, number][]
    return index > 0 && index < coordinates.length - 1
      ? { before: coordinates[index - 1], join: coordinates[index], after: coordinates[index + 1] }
      : null
  }
  const primaryCoordinates = primary.geometry.coordinates as [number, number][]
  const secondaryCoordinates0 = secondary.geometry.coordinates as [number, number][]
  const secondaryCoordinates = secondaryAt === 'start'
    ? secondaryCoordinates0 : [...secondaryCoordinates0].reverse()
  if (primaryAt === 'end') {
    return {
      before: primaryCoordinates[primaryCoordinates.length - 2],
      join: primaryCoordinates[primaryCoordinates.length - 1],
      after: secondaryCoordinates[1],
    }
  }
  return {
    before: secondaryCoordinates[1],
    join: primaryCoordinates[0],
    after: primaryCoordinates[1],
  }
}

const isRightTurn = (from: number, to: number) => {
  const delta = angleDelta(from, to)
  return delta >= 20 && delta <= 160
}

type SideAccessResolution =
  | { ok: true; access: { sideRoadKey: string; allowedBack: boolean }[] }
  | { ok: false; reason: string }

const resolveSideAccess = (
  primary: RoadFeature,
  secondary: RoadFeature,
  primaryAt: 'start' | 'end',
  secondaryAt: 'start' | 'end',
  junctionNodeId: number,
  sideRoads: RoadFeature[],
): SideAccessResolution => {
  if (!sideRoads.length) return { ok: true, access: [] }
  const main = mergedMainAroundJunction(
    primary, secondary, primaryAt, secondaryAt, junctionNodeId)
  if (!main) return { ok: false, reason: '無法建立主路接縫幾何' }
  const access: { sideRoadKey: string; allowedBack: boolean }[] = []
  for (const side of sideRoads) {
    const sideRoadKey = roadBlockKey(side)
    const sideLabel = `${side.properties.name || '未命名側路'}（${sideRoadKey}）`
    const index = side.properties.nodes.indexOf(junctionNodeId)
    const coordinates = side.geometry.coordinates as [number, number][]
    if (coordinates.length < 2) {
      return { ok: false, reason: `${sideLabel}：幾何點不足` }
    }
    if (index !== 0 && index !== side.properties.nodes.length - 1) {
      return { ok: false, reason: `${sideLabel}：接縫不是側路端點` }
    }
    const other = index === 0 ? coordinates[1] : coordinates[coordinates.length - 2]
    const sideOut = bearing(main.join, other)
    const sideIn = bearing(other, main.join)
    const forward = isRightTurn(bearing(main.before, main.join), sideOut)
      && isRightTurn(sideIn, bearing(main.join, main.after))
    const backward = isRightTurn(bearing(main.after, main.join), sideOut)
      && isRightTurn(sideIn, bearing(main.join, main.before))
    if (forward === backward) {
      return { ok: false, reason: `${sideLabel}：無法唯一判定相鄰的主路方向` }
    }
    access.push({ sideRoadKey, allowedBack: backward })
  }
  return { ok: true, access }
}

const applyVisualMergeInPlace = (roads: RoadFeature[], merge: ResolvedRoadMerge) => {
  if (merge.primary === merge.secondary) return
  const primaryCoordinates = merge.primary.geometry.coordinates as [number, number][]
  const secondaryCoordinates0 = merge.secondary.geometry.coordinates as [number, number][]
  const secondaryCoordinates = merge.secondaryAt === 'start'
    ? secondaryCoordinates0 : [...secondaryCoordinates0].reverse()
  const secondaryNodes = merge.secondaryAt === 'start'
    ? [...merge.secondary.properties.nodes] : [...merge.secondary.properties.nodes].reverse()
  if (merge.primaryAt === 'end') {
    merge.primary.geometry.coordinates = [...primaryCoordinates, ...secondaryCoordinates.slice(1)]
    merge.primary.properties.nodes = [...merge.primary.properties.nodes, ...secondaryNodes.slice(1)]
  } else {
    merge.primary.geometry.coordinates = [
      ...secondaryCoordinates.slice(1).reverse(), ...primaryCoordinates,
    ]
    merge.primary.properties.nodes = [
      ...secondaryNodes.slice(1).reverse(), ...merge.primary.properties.nodes,
    ]
  }
  const restricted = new Set(merge.primary.properties.oneSideEntryNodes ?? [])
  for (const node of merge.secondary.properties.oneSideEntryNodes ?? []) restricted.add(node)
  merge.primary.properties.oneSideEntryNodes = restricted.size ? [...restricted] : undefined
  const access = new Map<string, OneSideEntryAccess>(
    (merge.primary.properties.oneSideEntryAccess ?? [])
      .map((entry) => [`${entry.nodeId}:${entry.sideRoadKey ?? '*'}`, entry] as const))
  for (const entry of merge.secondary.properties.oneSideEntryAccess ?? []) {
    const key = `${entry.nodeId}:${entry.sideRoadKey ?? '*'}`
    if (!access.has(key)) access.set(key, entry)
  }
  merge.primary.properties.oneSideEntryAccess = access.size ? [...access.values()] : undefined
  const barriers = new Set(merge.primary.properties.roadMergeBarrierNodes ?? [])
  for (const node of merge.secondary.properties.roadMergeBarrierNodes ?? []) barriers.add(node)
  merge.primary.properties.roadMergeBarrierNodes = barriers.size ? [...barriers] : undefined
  const joins = new Set(merge.primary.properties.centerIslandJoinNodes ?? [])
  for (const node of merge.secondary.properties.centerIslandJoinNodes ?? []) joins.add(node)
  merge.primary.properties.centerIslandJoinNodes = joins.size ? [...joins] : undefined
  const index = roads.indexOf(merge.secondary)
  if (index >= 0) roads.splice(index, 1)
}

const polylineLengthM = (coordinates: [number, number][]) =>
  coordinates.slice(1).reduce(
    (total, coordinate, index) => total + haversine(coordinates[index], coordinate), 0)

const suppressOverlappedRenderStubs = (
  renderRoads: RoadFeature[],
  merges: ResolvedRoadMerge[],
) => {
  for (const merge of merges) {
    const carrier = merge.primary
    const carrierCoordinates = carrier.geometry.coordinates as [number, number][]
    for (const road of renderRoads) {
      if (road === carrier || road.properties.deleted || road.properties.renderHidden) continue
      if (road.properties.osm_id !== carrier.properties.osm_id) continue
      const coordinates = road.geometry.coordinates as [number, number][]
      if (coordinates.length < 2 || polylineLengthM(coordinates) > 25) continue
      const covered = coordinates.filter((point) =>
        carrierCoordinates.some((carrierPoint) => haversine(point, carrierPoint) < 12)).length
      if (covered / coordinates.length < 0.9) continue
      road.properties.renderHidden = true
    }
  }
}

const ensureRoadMergeDerived = (road: RoadFeature, nodeId: number) => {
  const prior = road.properties.roadMergeDerived
    ?.find((entry) => entry.nodeId === nodeId)
  if (prior) return prior
  const previousAccess = road.properties.oneSideEntryAccess
    ?.filter((entry) => entry.nodeId === nodeId)
  const derived = {
    nodeId,
    hadNode: road.properties.oneSideEntryNodes?.includes(nodeId) ?? false,
    hadBarrier: road.properties.roadMergeBarrierNodes?.includes(nodeId) ?? false,
    previousAccess: clonePreviousAccess(previousAccess),
  }
  road.properties.roadMergeDerived = [
    ...(road.properties.roadMergeDerived ?? []), derived,
  ]
  return derived
}

const registerRoadMergeBarrier = (road: RoadFeature, nodeId: number) => {
  ensureRoadMergeDerived(road, nodeId)
  const barriers = new Set(road.properties.roadMergeBarrierNodes ?? [])
  barriers.add(nodeId)
  road.properties.roadMergeBarrierNodes = [...barriers]
}

/**
 * 接縫兩側是同一條主路的續行。way id 相同時 oneSideEntry 本來就認得出來，
 * 但跨 way 的捏合（外環西路 way/268219234 ↔ way/1454602407）沒有這個線索，
 * 側街產生的 T 字限制會連主路反向一起擋掉——登記續行對照才不會誤傷。
 */
const registerMergeSeamPeers = (
  primary: RoadFeature, secondary: RoadFeature, nodeId: number,
) => {
  if (primary === secondary) return
  const link = (road: RoadFeature, peer: RoadFeature) => {
    const peerKey = roadBlockKey(peer)
    const peers = road.properties.medianContinuityPeers ?? []
    if (peers.some((entry) => entry.nodeId === nodeId && entry.peerKey === peerKey)) return
    road.properties.medianContinuityPeers = [...peers, { nodeId, peerKey }]
  }
  link(primary, secondary)
  link(secondary, primary)
}

const registerOneSideAccess = (
  road: RoadFeature,
  nodeId: number,
  allowedBack: boolean,
  sideRoadKey?: string,
) => {
  ensureRoadMergeDerived(road, nodeId)
  const restricted = new Set(road.properties.oneSideEntryNodes ?? [])
  restricted.add(nodeId)
  road.properties.oneSideEntryNodes = [...restricted]
  const access = new Map<string, OneSideEntryAccess>(
    (road.properties.oneSideEntryAccess ?? [])
      .map((entry) => [`${entry.nodeId}:${entry.sideRoadKey ?? '*'}`, entry] as const))
  access.set(`${nodeId}:${sideRoadKey ?? '*'}`, {
    nodeId,
    allowedBack,
    ...(sideRoadKey ? { sideRoadKey } : {}),
  })
  road.properties.oneSideEntryAccess = [...access.values()]
}

const accessRulesForMerge = (merge: ResolvedRoadMerge): {
  allowedBack: boolean
  sideRoadKey?: string
}[] => {
  if (!merge.sideAccess.length) return []
  const directions = new Set(merge.sideAccess.map((entry) => entry.allowedBack))
  if (directions.size === 1) {
    return [{ allowedBack: merge.sideAccess[0].allowedBack }]
  }
  return merge.sideAccess
}

const applyRoutingConstraints = (
  routingRoads: RoadFeature[],
  merges: ResolvedRoadMerge[],
) => {
  for (const merge of merges) {
    const primary = candidatesFor(routingRoads, merge.primaryKey)
    if (primary.length !== 1) continue
    registerRoadMergeBarrier(primary[0].road, merge.junctionNodeId)

    const secondary = candidatesFor(routingRoads, merge.secondaryKey)
    if (secondary.length === 1 && secondary[0].road !== primary[0].road) {
      registerRoadMergeBarrier(secondary[0].road, merge.junctionNodeId)
      registerMergeSeamPeers(primary[0].road, secondary[0].road, merge.junctionNodeId)
    }
    const accessRules = accessRulesForMerge(merge)
    for (const access of accessRules) {
      registerOneSideAccess(
        primary[0].road,
        merge.junctionNodeId,
        access.allowedBack,
        access.sideRoadKey,
      )
    }
    if (!accessRules.length
      || secondary.length !== 1 || secondary[0].road === primary[0].road) continue
    // 合併主線的 forward 始終跟 primary 的 digitize 方向一致；secondary
    // 若以同類端點接合（start-start / end-end），其 digitize 方向相反。
    const secondaryForwardBack = merge.primaryAt === merge.secondaryAt
    for (const access of accessRules) {
      registerOneSideAccess(
        secondary[0].road,
        merge.junctionNodeId,
        secondaryForwardBack !== access.allowedBack,
        access.sideRoadKey,
      )
    }
  }
}

function replayRoadMerges(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): { working: RoadFeature[]; resolved: ResolvedRoadMerge[]; rows: RoadMergeReplayRow[] } {
  const working = roads.map(cloneRoad)
  const resolved: ResolvedRoadMerge[] = []
  const rows: RoadMergeReplayRow[] = []
  for (const record of activeMergeRecordsInSequence(journal)) {
    const primaryKey = String(record.fields?.primary ?? '')
    const secondaryKey = String(record.fields?.secondary ?? '')
    const rowBase = { mergeKey: record.target.key, primaryKey, secondaryKey }
    const primaryCandidates = candidatesFor(working, primaryKey)
    const secondaryCandidates = candidatesFor(working, secondaryKey)
    if (primaryCandidates.length > 1 || secondaryCandidates.length > 1) {
      rows.push({ ...rowBase, status: 'needs_manual_review',
        detail: `來源候選不唯一（主 ${primaryCandidates.length}／次 ${secondaryCandidates.length}）` })
      continue
    }
    if (!primaryCandidates.length || !secondaryCandidates.length) {
      rows.push({ ...rowBase, status: 'legacy_destructive',
        detail: `找不到來源（主 ${primaryCandidates.length ? 'ok' : '缺'}／次 ${secondaryCandidates.length ? 'ok' : '缺'}）` })
      continue
    }
    const primaryResolution = primaryCandidates[0]
    const secondaryResolution = secondaryCandidates[0]
    let primaryAt: 'start' | 'end' = 'end'
    let secondaryAt: 'start' | 'end' = 'start'
    let junctionNodeId = parseBlockKey(secondaryKey)?.blockNode ?? 0
    const alreadyAbsorbed = primaryResolution.road === secondaryResolution.road
    if (!alreadyAbsorbed) {
      const join = endpointJoin(primaryResolution.road, secondaryResolution.road)
      if (!join || join.distanceM > 5) {
        rows.push({ ...rowBase, status: 'invalid',
          detail: join ? `兩段端點相距 ${join.distanceM.toFixed(1)} 公尺` : '道路幾何點不足' })
        continue
      }
      primaryAt = join.primaryAt
      secondaryAt = join.secondaryAt
      const nodes = primaryResolution.road.properties.nodes
      junctionNodeId = primaryAt === 'start' ? nodes[0] : nodes[nodes.length - 1]
    }
    const usedProvenance = alreadyAbsorbed
      || primaryResolution.by === 'source-segment'
      || secondaryResolution.by === 'source-segment'
    const sideRoads = working.filter((road) =>
      road !== primaryResolution.road
      && road !== secondaryResolution.road
      && road.properties.nodes.includes(junctionNodeId))
    const sideAccessResolution = resolveSideAccess(
      primaryResolution.road,
      secondaryResolution.road,
      primaryAt,
      secondaryAt,
      junctionNodeId,
      sideRoads,
    )
    if (!sideAccessResolution.ok) {
      rows.push({ ...rowBase, status: 'needs_manual_review',
        detail: sideAccessResolution.reason })
      continue
    }
    const sideAccess = sideAccessResolution.access
    const adjacentDirections = new Set(sideAccess.map((entry) => entry.allowedBack))
    const adjacentBack = adjacentDirections.size === 1
      ? sideAccess[0].allowedBack : null
    const merge: ResolvedRoadMerge = {
      ...rowBase,
      primary: primaryResolution.road,
      secondary: secondaryResolution.road,
      junctionNodeId,
      primaryAt,
      secondaryAt,
      adjacentBack,
      sideAccess,
      resolvedBy: alreadyAbsorbed ? 'already-absorbed'
        : usedProvenance ? 'source-segment'
          : primaryResolution.by === 'active-node' || secondaryResolution.by === 'active-node'
            ? 'active-node' : 'exact',
      sourceSeq: record.seq,
      sourceTs: record.ts,
      sourceAuthor: record.author,
    }
    const status = usedProvenance ? 'recoverable_via_provenance' : 'replayable'
    const row: RoadMergeReplayRow = {
      ...rowBase,
      status,
      detail: alreadyAbsorbed ? '主次來源已吸收到同一存活道路' : '可依序重播',
      resolved: merge,
    }
    resolved.push(merge)
    rows.push(row)
    registerRoadMergeBarrier(merge.primary, merge.junctionNodeId)
    for (const access of accessRulesForMerge(merge)) {
      // working 就是繪圖視圖；直接標在當前 carrier，避免連鎖捏合後舊 block key
      // 已被吸收而無法再次查回。若 carrier 後續成為 secondary，視覺合併會轉移標記。
      registerOneSideAccess(
        merge.primary,
        merge.junctionNodeId,
        access.allowedBack,
        access.sideRoadKey,
      )
    }
    applyVisualMergeInPlace(working, merge)
  }
  return { working, resolved, rows }
}

export function resolveRoadMerges(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): { resolved: ResolvedRoadMerge[]; rows: RoadMergeReplayRow[] } {
  const { resolved, rows } = replayRoadMerges(roads, journal)
  return { resolved, rows }
}

export interface RoadMergeViews {
  routingRoads: RoadFeature[]
  renderRoads: RoadFeature[]
  resolved: ResolvedRoadMerge[]
  rows: RoadMergeReplayRow[]
}

export function selectPreparedRoadMergeView<T>(prepared: T | undefined, build: () => T): T {
  return prepared === undefined ? build() : prepared
}

/** 讓 journal 先排入儲存並確實落盤，再原地套用預先建好的繪圖與導航雙視圖。 */
export async function applyRoadMergeAfterSave(
  flush: () => Promise<void>,
  apply: () => void,
): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await flush()
  apply()
}

export function buildRoadMergeViews(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
  /** 中央島貫通接點清單；稽核可傳 [] 建立「未貫通」對照組。 */
  centerIslandJoins: CenterIslandJoinSpec[] = CENTER_ISLAND_JOINS,
): RoadMergeViews {
  const routingRoads = roads.map(cloneWithoutDerivedRoadMerge)
  const { working, resolved, rows } = replayRoadMerges(routingRoads, journal)
  applyRoutingConstraints(routingRoads, resolved)
  suppressOverlappedRenderStubs(working, resolved)
  const renderRoads = working.filter((road) => !road.properties.renderHidden)
  // 現地指定的中央島貫通接點：導航與島面各套一次（兩份視圖的區塊切法不同）
  applyCenterIslandJoins(routingRoads, centerIslandJoins)
  applyCenterIslandJoins(renderRoads, centerIslandJoins)
  return { routingRoads, renderRoads, resolved, rows }
}

const MERGE_CRITICAL_FIELDS = [
  'highway', 'oneway',
  'lanesForward', 'lanesBackward',
  'motoF', 'motoB', 'motoSepF', 'motoSepB',
  'centerM', 'centerKind', 'roadMarkingMode',
] as const satisfies readonly (keyof RoadProps)[]

export interface RoadMergePreview {
  ok: boolean
  reason?: string
  record?: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>
  resolved?: ResolvedRoadMerge
}

export type RoadMergeJournalDraft = Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>

export type RoadMergeSeamUndoPlan =
  | {
      ok: true
      records: RoadMergeJournalDraft[]
      retiredMergeKeys: string[]
      rebasedMergeKeys: string[]
    }
  | {
      ok: false
      reason: string
      records: []
      retiredMergeKeys: []
      rebasedMergeKeys: []
    }

const sourceSnapshot = (road: RoadFeature) => JSON.stringify({
  osmId: road.properties.osm_id,
  navSegmentKey: road.properties.navSegmentKey,
  splitIndex: road.properties.splitIndex,
  blockNode: road.properties.blockNode,
  nodeRefs: road.properties.nodes,
  sourceSegments: road.properties.sourceSegments,
})

export function previewRoadMerge(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
  primary: RoadFeature,
  secondary: RoadFeature,
): RoadMergePreview {
  const primaryKey = roadBlockKey(primary)
  const secondaryKey = roadBlockKey(secondary)
  if (primary === secondary || primaryKey === secondaryKey) {
    return { ok: false, reason: '不可選取同一路段兩次' }
  }
  const normalizeName = (name?: string) => (name ?? '').replace(/\s+/g, '').trim()
  if (!normalizeName(primary.properties.name)
    || normalizeName(primary.properties.name) !== normalizeName(secondary.properties.name)) {
    return { ok: false, reason: '兩段道路名稱不同，為避免誤併已拒絕' }
  }
  const conflicts = MERGE_CRITICAL_FIELDS.filter((field) =>
    JSON.stringify(primary.properties[field]) !== JSON.stringify(secondary.properties[field]))
  if (conflicts.length) {
    const detail = conflicts.map((field) =>
      `${field}=${JSON.stringify(primary.properties[field])}/${JSON.stringify(secondary.properties[field])}`)
      .join('、')
    return { ok: false, reason: `關鍵欄位不同：${detail}` }
  }
  const join = endpointJoin(primary, secondary)
  if (!join || join.distanceM > 1) {
    return { ok: false, reason: join
      ? `兩段端點未相接（相距 ${join.distanceM.toFixed(1)} 公尺）`
      : '道路幾何點不足' }
  }
  const primaryCoordinates = primary.geometry.coordinates as [number, number][]
  const secondaryCoordinates = secondary.geometry.coordinates as [number, number][]
  const primaryAway = join.primaryAt === 'start'
    ? bearing(primaryCoordinates[0], primaryCoordinates[1])
    : bearing(primaryCoordinates[primaryCoordinates.length - 1],
      primaryCoordinates[primaryCoordinates.length - 2])
  const secondaryAway = join.secondaryAt === 'start'
    ? bearing(secondaryCoordinates[0], secondaryCoordinates[1])
    : bearing(secondaryCoordinates[secondaryCoordinates.length - 1],
      secondaryCoordinates[secondaryCoordinates.length - 2])
  const straightError = Math.abs(180 - Math.abs(angleDelta(primaryAway, secondaryAway)))
  if (straightError > 15) {
    return { ok: false,
      reason: `兩段接合角度不是平順直線（偏差 ${straightError.toFixed(1)}°）` }
  }
  const junctionNode = join.primaryAt === 'start'
    ? primary.properties.nodes[0]
    : primary.properties.nodes[primary.properties.nodes.length - 1]
  const record: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'> = {
    op: 'set',
    target: {
      type: 'road_merge',
      key: `merge/${primaryKey}+${secondaryKey}`,
    },
    fields: {
      schema_version: 2,
      primary: primaryKey,
      secondary: secondaryKey,
      junction_node: junctionNode,
      primary_source: sourceSnapshot(primary),
      secondary_source: sourceSnapshot(secondary),
      secondary_nodes: JSON.stringify(secondary.properties.nodes),
    },
  }
  const candidate: EnhancementRecord = {
    ...record,
    seq: (journal[journal.length - 1]?.seq ?? 0) + 1,
    ts: 'preview',
    author: 'preview',
  }
  const result = resolveRoadMerges(roads, [...journal, candidate])
  const row = result.rows.find((item) => item.mergeKey === record.target.key)
  if (!row?.resolved) {
    return { ok: false, reason: row?.detail ?? '無法解析新增捏合' }
  }
  return { ok: true, record, resolved: row.resolved }
}

const failedSeamUndoPlan = (reason: string): RoadMergeSeamUndoPlan => ({
  ok: false,
  reason,
  records: [],
  retiredMergeKeys: [],
  rebasedMergeKeys: [],
})

const stampRoadMergeDrafts = (
  journal: EnhancementRecord[], drafts: RoadMergeJournalDraft[],
): EnhancementRecord[] => {
  const firstSeq = (journal[journal.length - 1]?.seq ?? 0) + 1
  return [
    ...journal,
    ...drafts.map((draft, index): EnhancementRecord => ({
      ...draft,
      seq: firstSeq + index,
      ts: `preview-seam-undo-${String(index).padStart(4, '0')}`,
      author: 'preview',
    })),
  ]
}

interface RoadMergeSourceSnapshot {
  osmId: number
  blockNode: number
  nodeRefs: number[]
}

const parseRoadMergeSourceSnapshot = (value: unknown): RoadMergeSourceSnapshot | null => {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as Partial<RoadMergeSourceSnapshot>
    if (!Number.isFinite(parsed.osmId) || !Number.isFinite(parsed.blockNode)
      || !Array.isArray(parsed.nodeRefs) || parsed.nodeRefs.length < 2
      || parsed.nodeRefs.some((node) => !Number.isFinite(node))) return null
    return {
      osmId: Number(parsed.osmId),
      blockNode: Number(parsed.blockNode),
      nodeRefs: parsed.nodeRefs.map(Number),
    }
  } catch {
    return null
  }
}

const snapshotMatchesKey = (snapshot: RoadMergeSourceSnapshot, key: string) =>
  `way/${snapshot.osmId}@b/${snapshot.blockNode}` === key

/**
 * 解除一條捏合接縫，而不是回滾整個 carrier 的後續歷史。線性鏈 A+B、AB+C
 * 撤銷 A-B 時，舊紀錄全部以 tombstone 退役，再重建仍連通的 B+C。
 */
export function planRoadMergeSeamUndo(
  roads: RoadFeature[], journal: EnhancementRecord[], selectedMergeKey: string,
): RoadMergeSeamUndoPlan {
  const active = activeMergeRecordsInSequence(journal)
  const selected = active.find((record) => record.target.key === selectedMergeKey)
  if (!selected) return failedSeamUndoPlan('選取的接縫已不是有效捏合')
  const carrierKey = String(selected.fields?.primary ?? '')
  const componentRecords = active.filter((record) =>
    String(record.fields?.primary ?? '') === carrierKey)
  const selectedIndex = componentRecords.findIndex((record) =>
    record.target.key === selectedMergeKey)
  if (!carrierKey || selectedIndex < 0) {
    return failedSeamUndoPlan('無法辨識捏合接縫的承載路段')
  }
  const atomSnapshots: RoadMergeSourceSnapshot[] = []
  for (const [index, record] of componentRecords.entries()) {
    const primaryKey = String(record.fields?.primary ?? '')
    const secondaryKey = String(record.fields?.secondary ?? '')
    const primarySnapshot = parseRoadMergeSourceSnapshot(record.fields?.primary_source)
    const secondarySnapshot = parseRoadMergeSourceSnapshot(record.fields?.secondary_source)
    if (Number(record.fields?.schema_version) !== 2
      || !primarySnapshot || !secondarySnapshot
      || !snapshotMatchesKey(primarySnapshot, primaryKey)
      || !snapshotMatchesKey(secondarySnapshot, secondaryKey)) {
      return failedSeamUndoPlan('舊捏合缺少完整來源快照，無法安全解除接縫')
    }
    if (index === 0) atomSnapshots.push(primarySnapshot)
    const primaryNodes = new Set(primarySnapshot.nodeRefs)
    if (atomSnapshots.some((snapshot) =>
      snapshot.nodeRefs.some((node) => !primaryNodes.has(node)))) {
      return failedSeamUndoPlan('捏合來源鏈形成分岔，無法唯一重定位')
    }
    const junctionNode = Number(record.fields?.junction_node)
    if (!Number.isFinite(junctionNode)
      || !primarySnapshot.nodeRefs.includes(junctionNode)
      || !secondarySnapshot.nodeRefs.includes(junctionNode)) {
      return failedSeamUndoPlan('捏合來源鏈形成分岔，無法唯一重定位')
    }
    atomSnapshots.push(secondarySnapshot)
  }
  const atomKeys = [
    carrierKey,
    ...componentRecords.map((record) => String(record.fields?.secondary ?? '')),
  ]
  if (atomKeys.some((key) => !parseBlockKey(key)) || new Set(atomKeys).size !== atomKeys.length) {
    return failedSeamUndoPlan('捏合來源不是唯一線性道路鏈')
  }

  const records: RoadMergeJournalDraft[] = componentRecords.map((record) => ({
    op: 'delete',
    target: { type: 'road_merge', key: record.target.key },
    fields: { supersedes_seq: record.seq },
  }))
  const groups = [
    atomKeys.slice(0, selectedIndex + 1),
    atomKeys.slice(selectedIndex + 1),
  ]
  const atomRoads = atomKeys.map((key) => roads.filter((road) => roadBlockKey(road) === key))
  if (atomRoads.some((matches) => matches.length !== 1)) {
    return failedSeamUndoPlan('無法唯一找到接縫兩側的來源路段')
  }
  const componentNodes = new Set(atomRoads.flat().flatMap((road) => road.properties.nodes))
  // 重定位只需要本鏈與接點側路；避免在 UI 預演階段重建數千筆無關道路捏合，
  // 最後仍由呼叫端以完整路網做一次 all-or-nothing 驗證。
  const localRoads = roads.filter((road) =>
    atomKeys.includes(roadBlockKey(road))
    || road.properties.nodes.some((node) => componentNodes.has(node)))
  const rebasedMergeKeys: string[] = []
  const replacementRecords: RoadMergeJournalDraft[] = []
  let previewJournal: EnhancementRecord[] = []

  for (const group of groups) {
    if (group.length < 2) continue
    for (let index = 1; index < group.length; index++) {
      const view = buildRoadMergeViews(localRoads, previewJournal)
      const primary = view.renderRoads.find((road) => roadBlockKey(road) === group[0])
      const secondary = view.renderRoads.find((road) => roadBlockKey(road) === group[index])
      if (!primary || !secondary) {
        return failedSeamUndoPlan('無法唯一找到接縫兩側的來源路段')
      }
      const preview = previewRoadMerge(view.renderRoads, previewJournal, primary, secondary)
      if (!preview.ok || !preview.record) {
        return failedSeamUndoPlan(preview.reason ?? '保留接縫無法重新定位')
      }
      replacementRecords.push(preview.record)
      rebasedMergeKeys.push(preview.record.target.key)
      previewJournal = stampRoadMergeDrafts([], replacementRecords)
    }
  }

  const finalView = buildRoadMergeViews(localRoads, previewJournal)
  const resolvedKeys = new Set(finalView.resolved.map((merge) => merge.mergeKey))
  if (rebasedMergeKeys.some((key) => !resolvedKeys.has(key))) {
    return failedSeamUndoPlan('接縫重定位預演未完整解析')
  }
  return {
    ok: true,
    records: [...records, ...replacementRecords],
    retiredMergeKeys: componentRecords.map((record) => record.target.key),
    rebasedMergeKeys,
  }
}

const resolvedRoadBlockKeys = (row: RoadMergeReplayRow): string[] => row.resolved
  ? [roadBlockKey(row.resolved.primary), roadBlockKey(row.resolved.secondary)]
  : []

const rowMatchesCurrentRoad = (row: RoadMergeReplayRow, roadKey: string) =>
  row.primaryKey === roadKey
  || row.secondaryKey === roadKey
  || resolvedRoadBlockKeys(row).includes(roadKey)

export function activeMergeForRoad(
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
): RoadMergeReplayRow | undefined {
  const key = roadBlockKey(road)
  return rows.find((row) => row.resolved && rowMatchesCurrentRoad(row, key))
}

export function roadMergeComponentBlockKeys(
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
): string[] {
  const selectedKey = roadBlockKey(road)
  const component = new Set([selectedKey])
  for (const row of rows) {
    if (!row.resolved || !rowMatchesCurrentRoad(row, selectedKey)) continue
    component.add(row.primaryKey)
    component.add(row.secondaryKey)
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const row of rows) {
      if (!row.resolved) continue
      if (!component.has(row.primaryKey) && !component.has(row.secondaryKey)) continue
      if (!component.has(row.primaryKey)) {
        component.add(row.primaryKey)
        expanded = true
      }
      if (!component.has(row.secondaryKey)) {
        component.add(row.secondaryKey)
        expanded = true
      }
    }
  }
  if (component.size === 1) return [selectedKey]
  const ordered = rows.flatMap((row) => row.resolved
    ? [row.primaryKey, row.secondaryKey]
    : [])
  return [...new Set(ordered)].filter((key) => component.has(key))
}

/**
 * 編輯器連續捏合時使用的目前主線幾何。
 *
 * 導航視圖刻意保留 A、B 各自的道路；第一次捏合後若使用者再從 B 選 C，直接拿
 * 導航 B 的舊端點量距離會看不到已由 A＋B 延伸到 C 旁的另一端。這裡只替預覽
 * 找出該捏合元件唯一的繪圖承載線，不改導航來源或捏合重播語意。
 */
export function roadMergeRenderCarrier(
  rows: RoadMergeReplayRow[], road: RoadFeature, renderRoads: RoadFeature[],
): RoadFeature {
  const component = new Set(roadMergeComponentBlockKeys(rows, road))
  const candidates = renderRoads.filter((candidate) =>
    component.has(roadBlockKey(candidate)))
  return candidates.length === 1 ? candidates[0] : road
}

export interface RoadMergeMotoBoxTarget {
  wayId: number
  nodeId: number
  back: boolean
}

/** Map the selected block's two travel directions onto the visible merged road ends. */
export function roadMergeMotoBoxTargets(
  rows: RoadMergeReplayRow[], road: RoadFeature, renderRoads: RoadFeature[],
): { forward: RoadMergeMotoBoxTarget; backward: RoadMergeMotoBoxTarget } {
  const carrier = roadMergeRenderCarrier(rows, road, renderRoads)
  const carrierNodes = carrier.properties.nodes
  const selectedNodes = road.properties.nodes
  const carrierFirst = carrierNodes[0] ?? selectedNodes[0] ?? 0
  const carrierLast = carrierNodes[carrierNodes.length - 1]
    ?? selectedNodes[selectedNodes.length - 1] ?? 0
  const selectedFirstIndex = carrierNodes.indexOf(selectedNodes[0])
  const selectedLastIndex = carrierNodes.lastIndexOf(selectedNodes[selectedNodes.length - 1])
  const sameDirection = selectedFirstIndex < 0 || selectedLastIndex < 0
    ? true
    : selectedFirstIndex <= selectedLastIndex
  const wayId = carrier.properties.osm_id
  return sameDirection
    ? {
      forward: { wayId, nodeId: carrierLast, back: false },
      backward: { wayId, nodeId: carrierFirst, back: true },
    }
    : {
      forward: { wayId, nodeId: carrierFirst, back: true },
      backward: { wayId, nodeId: carrierLast, back: false },
    }
}

export function roadMergeEditDrafts(
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
  fields: Record<string, string | number>,
  routingRoads?: RoadFeature[],
): RoadMergeJournalDraft[] {
  const keys = routingRoads
    ? currentRoadsForMergeComponent(rows, road, routingRoads).map(roadBlockKey)
    : roadMergeComponentBlockKeys(rows, road)
  return [...new Set(keys)].map((key) => ({
    op: 'set',
    target: { type: 'road', key },
    fields,
  }))
}

const currentRoadsForMergeComponent = (
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
  roads: RoadFeature[],
) => {
  const keys = new Set(roadMergeComponentBlockKeys(rows, road))
  const componentRows = rows.filter((row) => row.resolved
    && (keys.has(row.primaryKey) || keys.has(row.secondaryKey)))
  const currentKeys = new Set(componentRows.flatMap(resolvedRoadBlockKeys))
  return roads.filter((candidate) =>
    keys.has(roadBlockKey(candidate))
    || currentKeys.has(roadBlockKey(candidate)))
}

export function roadMergeEditableRoads(
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
  routingRoads: RoadFeature[],
  renderRoads: RoadFeature[],
): RoadFeature[] {
  const candidates = [
    ...currentRoadsForMergeComponent(rows, road, routingRoads),
    ...currentRoadsForMergeComponent(rows, road, renderRoads),
  ]
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index)
}
