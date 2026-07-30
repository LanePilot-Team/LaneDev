import type { EnhancementRecord } from './enhancements'
import type { TurnBay } from './turnbays'

export type ChannelizationState = 'none' | 'auto' | 'override' | 'disabled'

export const TAIWAN_YELLOW_HATCH_V1 = {
  style: 'taiwan-yellow-hatch-v1' as const,
  stripeWidthM: 0.18,
  stripePitchM: 1.25,
  insetM: 0.30,
  minLengthM: 3,
  referenceBandWidthM: 3.2,
}

export function buildCappedTriangleRange(input: {
  taperStartM: number
  stopBoundaryM: number
  movingAt: (distanceM: number) => number
  fixedOffsetM: number
}) {
  if (input.stopBoundaryM - input.taperStartM < TAIWAN_YELLOW_HATCH_V1.minLengthM) return null
  return {
    startM: input.taperStartM,
    endM: input.stopBoundaryM,
    movingAt: input.movingAt,
    fixedOffsetM: input.fixedOffsetM,
  }
}

export interface OffsetTurnBayMarkingRecord {
  key: string
  offset_bay: {
    state: 'active'
    turns: string
    source: 'default' | 'manual'
    bay_len_m: number
    taper_len_m: number
    width_m: number
  }
  channelization: {
    state: ChannelizationState
    closure?: 'none' | 'unused-side'
    s_start_m?: number
    s_end_m?: number
    width_start_m?: number
    width_end_m?: number
    style?: 'taiwan-yellow-hatch-v1'
  }
  review: {
    status: 'unreviewed' | 'reviewed' | 'verified' | 'needs_review'
    evidence_url?: string
    evidence_captured_at?: string
    reviewed_by?: string
    reviewed_at?: string
    confidence?: number
    note?: string
  }
}

export const channelizationKey = (parentKey: string) => `${parentKey}#channelization`
export const reviewKey = (parentKey: string) => `${parentKey}#review`
export const parentBayKey = (key: string) => key.replace(/#(?:channelization|review)$/, '')

/**
 * A single bay's closure is always on the opposite side of its moving
 * double-yellow line. The moving side itself is the usable turn-bay area.
 */
export function singleBayUnusedSideOffsets(
  direction: 'forward' | 'backward', c: number, dv = 0,
) {
  return direction === 'forward'
    ? { movingStart: dv - c, unusedBoundary: dv + c }
    : { movingStart: dv + c, unusedBoundary: dv - c }
}

export function buildHatchDistances(startM: number, endM: number, pitchM = TAIWAN_YELLOW_HATCH_V1.stripePitchM): number[] {
  if (!(endM > startM) || !(pitchM > 0)) return []
  const out: number[] = []
  for (let distance = Math.ceil(startM / pitchM) * pitchM;
    distance <= endM - TAIWAN_YELLOW_HATCH_V1.insetM + 1e-6;
    distance += pitchM) out.push(Number(distance.toFixed(6)))
  return out
}

function latestFields(journal: EnhancementRecord[], key: string): Record<string, string | number> | undefined {
  let fields: Record<string, string | number> | undefined
  for (const record of journal) {
    if (record.target.key !== key) continue
    if (record.op === 'delete') fields = undefined
    else fields = { ...fields, ...record.fields }
  }
  return fields
}

function reviewFrom(fields: Record<string, string | number> | undefined): OffsetTurnBayMarkingRecord['review'] {
  const status = fields?.status
  return {
    status: status === 'reviewed' || status === 'verified' || status === 'needs_review'
      ? status
      : 'unreviewed',
    ...(typeof fields?.evidence_url === 'string' ? { evidence_url: fields.evidence_url } : {}),
    ...(typeof fields?.evidence_captured_at === 'string' ? { evidence_captured_at: fields.evidence_captured_at } : {}),
    ...(typeof fields?.reviewed_by === 'string' ? { reviewed_by: fields.reviewed_by } : {}),
    ...(typeof fields?.reviewed_at === 'string' ? { reviewed_at: fields.reviewed_at } : {}),
    ...(typeof fields?.confidence === 'number' ? { confidence: fields.confidence } : {}),
    ...(typeof fields?.note === 'string' ? { note: fields.note } : {}),
  }
}

function channelizationFrom(fields: Record<string, string | number> | undefined): OffsetTurnBayMarkingRecord['channelization'] {
  const values = fields ?? {}
  const mode = values.mode
  if (mode === 'disabled') return { state: 'disabled' }
  if (mode !== 'auto' && mode !== 'override') return { state: 'none' }
  return {
    state: mode,
    ...(values.closure === 'none' || values.closure === 'unused-side' ? { closure: values.closure } : {}),
    ...(typeof values.s_start_m === 'number' ? { s_start_m: values.s_start_m } : {}),
    ...(typeof values.s_end_m === 'number' ? { s_end_m: values.s_end_m } : {}),
    ...(typeof values.width_start_m === 'number' ? { width_start_m: values.width_start_m } : {}),
    ...(typeof values.width_end_m === 'number' ? { width_end_m: values.width_end_m } : {}),
    ...(values.style === 'taiwan-yellow-hatch-v1' ? { style: values.style } : {}),
  }
}

export interface EffectiveChannelization {
  state: 'auto' | 'override'
  closure: 'none' | 'unused-side'
  sStartM?: number
  sEndM?: number
  widthStartM?: number
  widthEndM?: number
  style: 'taiwan-yellow-hatch-v1'
}

export function resolveChannelization(
  parentKey: string,
  bay: Pick<TurnBay, 'singleMode' | 'paired'>,
  journal: EnhancementRecord[],
): EffectiveChannelization | null {
  if (bay.paired || bay.singleMode === 'ignore') return null
  const fields = latestFields(journal, channelizationKey(parentKey))
  const channelization = channelizationFrom(fields)
  if (channelization.state === 'disabled') return null
  if (bay.singleMode === 'capped') {
    return {
      state: 'auto',
      closure: 'unused-side',
      style: TAIWAN_YELLOW_HATCH_V1.style,
    }
  }
  return null
}

export function buildOffsetTurnBayMarkings(
  journal: EnhancementRecord[], bays: TurnBay[],
): OffsetTurnBayMarkingRecord[] {
  return bays.map((bay) => ({
    key: bay.key,
    offset_bay: {
      state: 'active',
      turns: bay.turns,
      source: bay.source,
      bay_len_m: bay.bayLenM,
      taper_len_m: bay.taperLenM,
      width_m: bay.widthM,
    },
    channelization: channelizationFrom(latestFields(journal, channelizationKey(bay.key))),
    review: reviewFrom(latestFields(journal, reviewKey(bay.key))),
  }))
}
