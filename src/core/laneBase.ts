import type { DropRemap } from './couplet'
import type { MovementRule } from './importmap'
import {
  isLaneDirection,
  type LaneDirection,
  type LaneGuidanceScope,
} from './laneGuidance.ts'

export type EffectiveFieldSource =
  | 'human-block' | 'human-way'
  | 'lanepilot-approach' | 'lanepilot-segment'
  | 'osm' | 'inferred'

export interface LaneBaseRecord {
  sourceKey: string
  wayId: number
  direction: LaneDirection
  scope: LaneGuidanceScope
  intersectionNodeId?: number
  laneCount?: number
  laneMovements?: string[]
  motorcycleAccessByLane?: string[]
  movementRules: MovementRule[]
}

export interface LaneBaseExtraction {
  records: LaneBaseRecord[]
  sourceRecords: number
  accountedSourceKeys: Set<string>
  errors: string[]
}

export interface RemapLaneBaseOptions {
  existingWayIds: Set<number>
  nodeRemap: Map<number, number>
  wayRemap: Map<number, DropRemap>
}

export interface RemappedLaneBase {
  records: LaneBaseRecord[]
  unmappedSourceKeys: string[]
  errors: string[]
}

export interface LaneBaseIndex {
  approachByKey: Map<string, LaneBaseRecord>
  segmentByKey: Map<string, LaneBaseRecord>
  legacyByKey: Map<string, LaneBaseRecord>
}

export interface LaneBaseFieldValues {
  laneCount?: number
  laneMovements?: string[]
  motorcycleAccessByLane?: string[]
  movementRules?: MovementRule[]
}

export interface ResolveLaneBaseInput {
  wayId: number
  intersectionNodeId?: number
  direction: LaneDirection
  humanBlock?: LaneBaseFieldValues
  humanWay?: LaneBaseFieldValues
  osm?: LaneBaseFieldValues
  inferred?: LaneBaseFieldValues
}

export interface ResolvedLaneBase extends LaneBaseFieldValues {
  fieldSources: Partial<Record<keyof LaneBaseFieldValues, EffectiveFieldSource>>
}

type UnknownRecord = Record<string, unknown>

const isObject = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const numericId = (value: unknown, prefix: string): number | undefined => {
  const normalized = String(value ?? '').replace(new RegExp(`^${prefix}/`), '')
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const validLaneCount = (value: unknown): number | undefined => {
  const count = Number(value)
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined
}

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length
    ? value.map((item) => String(item))
    : undefined

const movementRules = (source: UnknownRecord): MovementRule[] => {
  const laneNav = isObject(source.lane_nav_tags) ? source.lane_nav_tags : {}
  const taiwan = isObject(laneNav.taiwan_motorcycle_tags)
    ? laneNav.taiwan_motorcycle_tags
    : {}
  return Array.isArray(taiwan.movement_rules)
    ? taiwan.movement_rules.filter(isObject).map((rule) => ({ ...rule }))
    : []
}

const laneProfiles = (source: UnknownRecord): UnknownRecord[] => {
  const laneNav = isObject(source.lane_nav_tags) ? source.lane_nav_tags : {}
  const detail = isObject(laneNav.lane_detail_tags) ? laneNav.lane_detail_tags : {}
  return Array.isArray(detail.lane_profiles)
    ? detail.lane_profiles.filter(isObject)
    : []
}

const segmentKey = (wayId: number, direction: LaneDirection) =>
  `${wayId}/${direction}`

const approachKey = (wayId: number, nodeId: number, direction: LaneDirection) =>
  `${wayId}@${nodeId}/${direction}`

const recordKey = (record: LaneBaseRecord) =>
  record.scope === 'intersection_approach'
    ? `${record.scope}:${approachKey(record.wayId, record.intersectionNodeId!, record.direction)}`
    : `${record.scope}:${segmentKey(record.wayId, record.direction)}`

const scopeOf = (value: unknown): LaneGuidanceScope | undefined => {
  if (value === undefined || value === null || value === '') return 'legacy'
  return value === 'intersection_approach' || value === 'segment_direction'
    ? value
    : undefined
}

const SUPPORTED_ANNOTATION_TYPES = new Set([
  'nav_segment_annotation',
  'nav_context_annotation',
])

const sourceBaseKey = (source: UnknownRecord | undefined, index: number): string => {
  const identity = source && isObject(source.object_identity) ? source.object_identity : {}
  const navSegmentKey = String(identity.nav_segment_key ?? '')
  const wayId = numericId(
    isObject(identity.source_osm) ? identity.source_osm.osm_id : undefined,
    'way',
  ) ?? numericId(navSegmentKey, 'way')
  const segment = navSegmentKey || (wayId === undefined ? `annotation/${index + 1}` : `way/${wayId}`)
  const splitIndex = Number(identity.split_index ?? 0)
  return `${segment}#${Number.isSafeInteger(splitIndex) ? splitIndex : 0}`
}

/** Converts raw LanePilot annotation records without touching runtime/canonical state. */
export function extractLaneBase(raw: unknown[]): LaneBaseExtraction {
  const records: LaneBaseRecord[] = []
  const accountedSourceKeys = new Set<string>()
  const errors: string[] = []
  const canonicalKeys = new Set<string>()
  const sourceCounts = new Map<string, number>()

  for (const [index, item] of raw.entries()) {
    const source = isObject(item) ? item : undefined
    const baseKey = sourceBaseKey(source, index)
    const seen = sourceCounts.get(baseKey) ?? 0
    sourceCounts.set(baseKey, seen + 1)
    const sourceKey = seen ? `${baseKey}~${seen + 1}` : baseKey
    accountedSourceKeys.add(sourceKey)

    if (!source || !isObject(source.object_identity)) {
      errors.push(`${sourceKey}: invalid annotation record`)
      continue
    }
    const identity = source.object_identity
    const objectType = String(identity.object_type ?? '')
    if (!SUPPORTED_ANNOTATION_TYPES.has(objectType)) {
      errors.push(`${sourceKey}: unsupported object type ${objectType || '(missing)'}`)
      continue
    }
    const wayId = numericId(
      isObject(identity.source_osm) ? identity.source_osm.osm_id : identity.nav_segment_key,
      'way',
    ) ?? numericId(identity.nav_segment_key, 'way')
    if (wayId === undefined) {
      errors.push(`${sourceKey}: invalid way identity`)
      continue
    }
    const scope = scopeOf(identity.context_scope)
    if (!scope) {
      errors.push(`${sourceKey}: invalid lane guidance scope`)
      continue
    }
    const intersectionNodeId = scope === 'intersection_approach'
      ? numericId(identity.applies_to_intersection_key, 'node')
      : undefined
    if (scope === 'intersection_approach' && intersectionNodeId === undefined) {
      errors.push(`${sourceKey}: intersection node missing for way/${wayId}`)
      continue
    }

    const rules = movementRules(source)
    const profiles = laneProfiles(source)
    let extracted = false
    let invalidProfileDirection = false
    for (const [profileIndex, profile] of profiles.entries()) {
      const direction = profile.direction ?? identity.approach_direction
      if (!isLaneDirection(direction)) {
        invalidProfileDirection = true
        errors.push(`${sourceKey}: profile ${profileIndex + 1}: invalid direction`)
        continue
      }
      const laneCount = validLaneCount(profile.lane_count)
      const laneMovements = stringArray(profile.lane_movements)
      const motorcycleAccessByLane = stringArray(profile.motorcycle_access_by_lane)
      if (laneCount === undefined && !laneMovements && !motorcycleAccessByLane) continue
      const record: LaneBaseRecord = {
        sourceKey,
        wayId,
        direction,
        scope,
        ...(intersectionNodeId === undefined ? {} : { intersectionNodeId }),
        ...(laneCount === undefined ? {} : { laneCount }),
        ...(laneMovements === undefined ? {} : { laneMovements }),
        ...(motorcycleAccessByLane === undefined ? {} : { motorcycleAccessByLane }),
        movementRules: rules,
      }
      const key = recordKey(record)
      if (canonicalKeys.has(key)) {
        errors.push(`${sourceKey}: duplicate lane-base record ${key}`)
        continue
      }
      canonicalKeys.add(key)
      records.push(record)
      extracted = true
    }

    if (!extracted && !profiles.length && rules.length) {
      let direction = identity.approach_direction
      if (direction === undefined) {
        const ruleDirections = [...new Set(rules
          .map((rule) => rule.approach_direction)
          .filter(isLaneDirection))]
        if (ruleDirections.length > 1) {
          errors.push(`${sourceKey}: conflicting movement-rule directions`)
          continue
        }
        direction = ruleDirections[0]
      }
      if (!isLaneDirection(direction)) {
        errors.push(`${sourceKey}: invalid direction`)
        continue
      }
      const record: LaneBaseRecord = {
        sourceKey,
        wayId,
        direction,
        scope,
        ...(intersectionNodeId === undefined ? {} : { intersectionNodeId }),
        movementRules: rules,
      }
      const key = recordKey(record)
      if (canonicalKeys.has(key)) {
        errors.push(`${sourceKey}: duplicate lane-base record ${key}`)
        continue
      }
      canonicalKeys.add(key)
      records.push(record)
      extracted = true
    }

    if (!extracted && !invalidProfileDirection) {
      errors.push(`${sourceKey}: no consumable lane profile or movement rules`)
    }
  }

  return {
    records: records.sort(compareRecords),
    sourceRecords: raw.length,
    accountedSourceKeys,
    errors,
  }
}

export function remapLaneBase(
  records: LaneBaseRecord[],
  options: RemapLaneBaseOptions,
): RemappedLaneBase {
  const output: LaneBaseRecord[] = []
  const unmappedSourceKeys = new Set<string>()
  const errors: string[] = []

  for (const record of records) {
    const intersectionNodeId = record.intersectionNodeId === undefined
      ? undefined
      : options.nodeRemap.get(record.intersectionNodeId) ?? record.intersectionNodeId
    const withNode = (next: Omit<LaneBaseRecord, 'intersectionNodeId'>): LaneBaseRecord => ({
      ...next,
      ...(intersectionNodeId === undefined ? {} : { intersectionNodeId }),
    })
    if (options.existingWayIds.has(record.wayId)) {
      output.push(withNode(record))
      continue
    }
    const remap = options.wayRemap.get(record.wayId)
    const keepIds = remap?.keepIds.filter((wayId) => options.existingWayIds.has(wayId)) ?? []
    if (!remap || !keepIds.length) {
      unmappedSourceKeys.add(record.sourceKey)
      errors.push(`${record.sourceKey}: no surviving way for way/${record.wayId}`)
      continue
    }
    const aligned = remap.dropReversed
      ? !(remap.sameDir ?? false)
      : (remap.sameDir ?? false)
    const direction = aligned
      ? record.direction
      : record.direction === 'forward' ? 'backward' : 'forward'
    for (const wayId of keepIds) output.push(withNode({ ...record, wayId, direction }))
  }

  return {
    records: output.sort(compareRecords),
    unmappedSourceKeys: [...unmappedSourceKeys].sort(),
    errors,
  }
}

export function buildLaneBaseIndex(records: LaneBaseRecord[]): LaneBaseIndex {
  const approachByKey = new Map<string, LaneBaseRecord>()
  const segmentByKey = new Map<string, LaneBaseRecord>()
  const legacyByKey = new Map<string, LaneBaseRecord>()
  for (const record of records) {
    assertRecord(record)
    const target = record.scope === 'intersection_approach'
      ? approachByKey
      : record.scope === 'segment_direction' ? segmentByKey : legacyByKey
    const key = record.scope === 'intersection_approach'
      ? approachKey(record.wayId, record.intersectionNodeId!, record.direction)
      : segmentKey(record.wayId, record.direction)
    if (target.has(key)) throw new Error(`duplicate lane-base record ${recordKey(record)}`)
    target.set(key, record)
  }
  return { approachByKey, segmentByKey, legacyByKey }
}

export function resolveLaneBase(
  index: LaneBaseIndex,
  input: ResolveLaneBaseInput,
): ResolvedLaneBase {
  const approach = input.intersectionNodeId === undefined ? undefined
    : index.approachByKey.get(approachKey(input.wayId, input.intersectionNodeId, input.direction))
  const segment = index.segmentByKey.get(segmentKey(input.wayId, input.direction))
    ?? index.legacyByKey.get(segmentKey(input.wayId, input.direction))
  const sources: Array<[LaneBaseFieldValues | undefined, EffectiveFieldSource]> = [
    [input.humanBlock, 'human-block'],
    [input.humanWay, 'human-way'],
    [recordFields(approach), 'lanepilot-approach'],
    [recordFields(segment), 'lanepilot-segment'],
    [input.osm, 'osm'],
    [input.inferred, 'inferred'],
  ]
  const resolveField = <Key extends keyof LaneBaseFieldValues>(field: Key): {
    value: LaneBaseFieldValues[Key]
    source?: EffectiveFieldSource
  } => {
    for (const [values, source] of sources) {
      if (values?.[field] === undefined) continue
      const value = values[field]
      return {
        value: (Array.isArray(value) ? [...value] : value) as LaneBaseFieldValues[Key],
        source,
      }
    }
    return { value: undefined }
  }
  const laneCount = resolveField('laneCount')
  const laneMovements = resolveField('laneMovements')
  const motorcycleAccessByLane = resolveField('motorcycleAccessByLane')
  const rules = resolveField('movementRules')
  const selected = [
    ['laneCount', laneCount],
    ['laneMovements', laneMovements],
    ['motorcycleAccessByLane', motorcycleAccessByLane],
    ['movementRules', rules],
  ] as const
  const fieldSources = Object.fromEntries(selected
    .filter(([, result]) => result.source)
    .map(([field, result]) => [field, result.source]))
  return {
    ...(laneCount.value === undefined ? {} : { laneCount: laneCount.value }),
    ...(laneMovements.value === undefined ? {} : { laneMovements: laneMovements.value }),
    ...(motorcycleAccessByLane.value === undefined
      ? {} : { motorcycleAccessByLane: motorcycleAccessByLane.value }),
    ...(rules.value === undefined ? {} : { movementRules: rules.value }),
    fieldSources,
  }
}

function recordFields(record: LaneBaseRecord | undefined): LaneBaseFieldValues | undefined {
  if (!record) return undefined
  return {
    ...(record.laneCount === undefined ? {} : { laneCount: record.laneCount }),
    ...(record.laneMovements === undefined ? {} : { laneMovements: record.laneMovements }),
    ...(record.motorcycleAccessByLane === undefined
      ? {} : { motorcycleAccessByLane: record.motorcycleAccessByLane }),
    ...(record.movementRules.length ? { movementRules: record.movementRules } : {}),
  }
}

function assertRecord(record: LaneBaseRecord): void {
  if (!Number.isSafeInteger(record.wayId) || record.wayId < 1) {
    throw new Error(`invalid way identity for ${record.sourceKey}`)
  }
  if (!isLaneDirection(record.direction)) throw new Error(`invalid direction for ${record.sourceKey}`)
  if (record.scope === 'intersection_approach' &&
      (!Number.isSafeInteger(record.intersectionNodeId) || record.intersectionNodeId! < 1)) {
    throw new Error(`intersection node missing for ${record.sourceKey}`)
  }
}

function compareRecords(a: LaneBaseRecord, b: LaneBaseRecord): number {
  return a.wayId - b.wayId ||
    (a.intersectionNodeId ?? -1) - (b.intersectionNodeId ?? -1) ||
    a.direction.localeCompare(b.direction) ||
    a.scope.localeCompare(b.scope) ||
    a.sourceKey.localeCompare(b.sourceKey)
}
