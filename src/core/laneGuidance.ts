import type { DropRemap } from './couplet'

export type LaneDirection = 'forward' | 'backward'
export type LaneGuidanceScope =
  | 'intersection_approach'
  | 'segment_direction'
  | 'legacy'
export type LaneGuidanceSource =
  | 'annotation'
  | 'annotation+osm'
  | 'osm'
  | 'inferred'

export interface LaneGuidanceRecord {
  wayId: number
  direction: LaneDirection
  scope: LaneGuidanceScope
  intersectionNodeId?: number
  laneCount?: number
  laneMovements: string[]
}

export interface LaneGuidanceIndex {
  approachByKey: Map<string, LaneGuidanceRecord>
  segmentByKey: Map<string, LaneGuidanceRecord>
}

export interface ResolvedLaneGuidance {
  laneCount: number
  laneMovements?: string[]
  source: LaneGuidanceSource
}

export interface ResolveLaneGuidanceInput {
  wayId: number
  intersectionNodeId?: number
  direction: LaneDirection
  roadLaneCount?: number
  osmMovements?: string[]
}

interface RemapLaneGuidanceOptions {
  existingWayIds: Set<number>
  nodeRemap: Map<number, number>
  wayRemap: Map<number, DropRemap>
}

const segmentKey = (wayId: number, direction: LaneDirection) =>
  `${wayId}/${direction}`

const approachKey = (
  wayId: number,
  nodeId: number,
  direction: LaneDirection,
) => `${wayId}@${nodeId}/${direction}`

const validCount = (value: unknown): number | undefined => {
  const count = Number(value)
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined
}

const knownMovement = (value: unknown): string | undefined => {
  const movement = String(value ?? '').trim()
  return movement && movement.toLowerCase() !== 'unknown' ? movement : undefined
}

export function buildLaneGuidanceIndex(
  records: LaneGuidanceRecord[],
): LaneGuidanceIndex {
  const approachByKey = new Map<string, LaneGuidanceRecord>()
  const segmentByKey = new Map<string, LaneGuidanceRecord>()

  for (const record of records) {
    if (record.scope === 'intersection_approach') {
      if (record.intersectionNodeId !== undefined) {
        const key = approachKey(
          record.wayId,
          record.intersectionNodeId,
          record.direction,
        )
        if (!approachByKey.has(key)) approachByKey.set(key, record)
      }
      continue
    }

    const key = segmentKey(record.wayId, record.direction)
    const current = segmentByKey.get(key)
    if (!current ||
        (current.scope === 'legacy' && record.scope === 'segment_direction')) {
      segmentByKey.set(key, record)
    }
  }

  return { approachByKey, segmentByKey }
}

export function remapLaneGuidanceRecords(
  records: LaneGuidanceRecord[],
  options: RemapLaneGuidanceOptions,
): LaneGuidanceRecord[] {
  const output: LaneGuidanceRecord[] = []

  for (const record of records) {
    const nodeId = record.intersectionNodeId === undefined
      ? undefined
      : options.nodeRemap.get(record.intersectionNodeId) ??
        record.intersectionNodeId

    if (options.existingWayIds.has(record.wayId)) {
      output.push({
        ...record,
        ...(nodeId === undefined ? {} : { intersectionNodeId: nodeId }),
      })
      continue
    }

    const remap = options.wayRemap.get(record.wayId)
    if (!remap) continue
    const aligned = remap.dropReversed
      ? !(remap.sameDir ?? false)
      : (remap.sameDir ?? false)
    const direction = aligned
      ? record.direction
      : record.direction === 'forward' ? 'backward' : 'forward'

    for (const wayId of remap.keepIds) {
      if (!options.existingWayIds.has(wayId)) continue
      output.push({
        ...record,
        wayId,
        direction,
        ...(nodeId === undefined ? {} : { intersectionNodeId: nodeId }),
      })
    }
  }

  return output.sort((a, b) =>
    a.wayId - b.wayId ||
    (a.intersectionNodeId ?? -1) - (b.intersectionNodeId ?? -1) ||
    a.direction.localeCompare(b.direction) ||
    a.scope.localeCompare(b.scope))
}

export function resolveLaneGuidance(
  index: LaneGuidanceIndex,
  input: ResolveLaneGuidanceInput,
): ResolvedLaneGuidance {
  const approach = input.intersectionNodeId === undefined
    ? undefined
    : index.approachByKey.get(approachKey(
      input.wayId,
      input.intersectionNodeId,
      input.direction,
    ))
  const annotation = approach ??
    index.segmentByKey.get(segmentKey(input.wayId, input.direction))
  const laneCount = validCount(annotation?.laneCount) ??
    validCount(input.roadLaneCount) ??
    Math.max(annotation?.laneMovements.length ?? 0, input.osmMovements?.length ?? 0)

  if (laneCount < 1) {
    return { laneCount: 0, laneMovements: undefined, source: 'inferred' }
  }

  let usedAnnotation = false
  let usedOsm = false
  const laneMovements = Array.from({ length: laneCount }, (_, indexValue) => {
    const manual = knownMovement(annotation?.laneMovements[indexValue])
    if (manual !== undefined) {
      usedAnnotation = true
      return manual
    }
    const osm = knownMovement(input.osmMovements?.[indexValue])
    if (osm !== undefined) {
      usedOsm = true
      return osm
    }
    return ''
  })

  if (!usedAnnotation && !usedOsm) {
    return { laneCount, laneMovements: undefined, source: 'inferred' }
  }

  const source: LaneGuidanceSource = usedAnnotation
    ? usedOsm ? 'annotation+osm' : 'annotation'
    : 'osm'
  return { laneCount, laneMovements, source }
}
