import { angleDelta, bearing, haversine } from './geo.ts'
import type { EnhancementRecord } from './enhancements'
import type { RoadFeature } from './roads'

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
    })),
    oneSideEntryNodes: road.properties.oneSideEntryNodes
      ? [...road.properties.oneSideEntryNodes] : undefined,
    oneSideEntryAccess: road.properties.oneSideEntryAccess
      ? road.properties.oneSideEntryAccess.map((entry) => ({ ...entry })) : undefined,
  },
})

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
  return roads
    .filter((road) => road.properties.sourceSegments.some((source) =>
      source.osmId === parsed.wayId && source.nodeRefs.includes(parsed.blockNode)))
    .map((road) => ({ road, by: 'source-segment' }))
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

const resolveAdjacentDirection = (
  primary: RoadFeature,
  secondary: RoadFeature,
  primaryAt: 'start' | 'end',
  secondaryAt: 'start' | 'end',
  junctionNodeId: number,
  sideRoads: RoadFeature[],
): boolean | null => {
  if (!sideRoads.length) return null
  const main = mergedMainAroundJunction(
    primary, secondary, primaryAt, secondaryAt, junctionNodeId)
  if (!main) return null
  const candidates = new Set<boolean>()
  for (const side of sideRoads) {
    const index = side.properties.nodes.indexOf(junctionNodeId)
    const coordinates = side.geometry.coordinates as [number, number][]
    if (index !== 0 && index !== coordinates.length - 1) return null
    const other = index === 0 ? coordinates[1] : coordinates[coordinates.length - 2]
    const sideOut = bearing(main.join, other)
    const sideIn = bearing(other, main.join)
    const forward = isRightTurn(bearing(main.before, main.join), sideOut)
      && isRightTurn(sideIn, bearing(main.join, main.after))
    const backward = isRightTurn(bearing(main.after, main.join), sideOut)
      && isRightTurn(sideIn, bearing(main.join, main.before))
    if (forward === backward) return null
    candidates.add(backward)
  }
  return candidates.size === 1 ? [...candidates][0] : null
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
  const access = new Map(
    (merge.primary.properties.oneSideEntryAccess ?? [])
      .map((entry) => [entry.nodeId, entry] as const))
  for (const entry of merge.secondary.properties.oneSideEntryAccess ?? []) {
    if (!access.has(entry.nodeId)) access.set(entry.nodeId, entry)
  }
  merge.primary.properties.oneSideEntryAccess = access.size ? [...access.values()] : undefined
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

const registerOneSideAccess = (road: RoadFeature, nodeId: number, allowedBack: boolean) => {
    const restricted = new Set(road.properties.oneSideEntryNodes ?? [])
    restricted.add(nodeId)
    road.properties.oneSideEntryNodes = [...restricted]
    const access = new Map(
      (road.properties.oneSideEntryAccess ?? [])
        .map((entry) => [entry.nodeId, entry] as const))
    access.set(nodeId, { nodeId, allowedBack })
    road.properties.oneSideEntryAccess = [...access.values()]
}

const applyRoutingConstraints = (
  routingRoads: RoadFeature[],
  merges: ResolvedRoadMerge[],
) => {
  for (const merge of merges) {
    if (merge.adjacentBack === null) continue
    const primary = candidatesFor(routingRoads, merge.primaryKey)
    if (primary.length !== 1) continue
    registerOneSideAccess(primary[0].road, merge.junctionNodeId, merge.adjacentBack)

    const secondary = candidatesFor(routingRoads, merge.secondaryKey)
    if (secondary.length !== 1 || secondary[0].road === primary[0].road) continue
    // 合併主線的 forward 始終跟 primary 的 digitize 方向一致；secondary
    // 若以同類端點接合（start-start / end-end），其 digitize 方向相反。
    const secondaryForwardBack = merge.primaryAt === merge.secondaryAt
    registerOneSideAccess(
      secondary[0].road,
      merge.junctionNodeId,
      secondaryForwardBack !== merge.adjacentBack,
    )
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
    const adjacentBack = resolveAdjacentDirection(
      primaryResolution.road,
      secondaryResolution.road,
      primaryAt,
      secondaryAt,
      junctionNodeId,
      sideRoads,
    )
    if (sideRoads.length && adjacentBack === null) {
      rows.push({ ...rowBase, status: 'needs_manual_review',
        detail: '無法唯一判定側路相鄰的主路方向' })
      continue
    }
    const merge: ResolvedRoadMerge = {
      ...rowBase,
      primary: primaryResolution.road,
      secondary: secondaryResolution.road,
      junctionNodeId,
      primaryAt,
      secondaryAt,
      adjacentBack,
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
    if (merge.adjacentBack !== null) {
      // working 就是繪圖視圖；直接標在當前 carrier，避免連鎖捏合後舊 block key
      // 已被吸收而無法再次查回。若 carrier 後續成為 secondary，視覺合併會轉移標記。
      registerOneSideAccess(merge.primary, merge.junctionNodeId, merge.adjacentBack)
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

export function buildRoadMergeViews(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): RoadMergeViews {
  const { working, resolved, rows } = replayRoadMerges(roads, journal)
  applyRoutingConstraints(roads, resolved)
  suppressOverlappedRenderStubs(working, resolved)
  return {
    routingRoads: roads,
    renderRoads: working.filter((road) => !road.properties.renderHidden),
    resolved,
    rows,
  }
}
