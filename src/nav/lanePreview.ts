export type LaneArrowKind =
  | 'left'
  | 'through'
  | 'right'
  | 'through-left'
  | 'through-right'

export type LanePreviewAction = 'left' | 'through' | 'right' | 'uturn'

export interface LanePreviewInput {
  laneCount?: number
  turnLanes?: string[]
  guidanceSource?: LaneGuidanceSource
  maneuverKind: 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'arrive'
  distanceM: number
  twoStage: boolean
  laneDecision?: LaneDecision
}

export function selectLanePreviewGuidance<T>({
  distanceM,
  current,
  maneuver,
  preparationM = TURN_GUIDANCE_M,
}: {
  distanceM: number
  current?: T
  maneuver?: T
  preparationM?: number
}): T | undefined {
  return distanceM <= preparationM ? maneuver ?? current : current ?? maneuver
}

export type LanePreviewState = 'primary' | 'secondary' | 'inactive'

export interface LanePreviewLane {
  arrow: LaneArrowKind
  active: boolean
  state: LanePreviewState
}

export interface LanePreviewModel {
  status: 'ready' | 'no-data'
  lanes: LanePreviewLane[]
  immediateAction: LanePreviewAction
  inferred: boolean
  truncated: boolean
  showTwoStageSign: boolean
  inferenceNote?: string
  warningNote?: string
}

const MAX_LANES = 10
const TURN_GUIDANCE_M = 250

type NormalMove = 'left' | 'through' | 'right' | 'reverse'

function normalizeMove(token: string): NormalMove | null {
  const value = token.trim().toLowerCase()
  if (value === 'left' || value === 'slight_left' || value === 'sharp_left' ||
      value === 'merge_to_left') return 'left'
  if (value === 'right' || value === 'slight_right' || value === 'sharp_right' ||
      value === 'merge_to_right') return 'right'
  if (value === 'through' || value === 'none') return 'through'
  if (value === 'reverse' || value === 'uturn') return 'reverse'
  return null
}

function parseMoves(value: string): Set<NormalMove> {
  return new Set(
    value.split(/[;+]/)
      .map(normalizeMove)
      .filter((move): move is NormalMove => move !== null),
  )
}

function arrowFor(moves: Set<NormalMove>): LaneArrowKind {
  if (moves.has('through') && moves.has('left')) return 'through-left'
  if (moves.has('through') && moves.has('right')) return 'through-right'
  if (moves.has('reverse') || moves.has('left')) return 'left'
  if (moves.has('right')) return 'right'
  return 'through'
}

function maneuverAction(kind: LanePreviewInput['maneuverKind']): LanePreviewAction {
  if (kind === 'left' || kind === 'slight-left') return 'left'
  if (kind === 'right' || kind === 'slight-right') return 'right'
  if (kind === 'uturn') return 'uturn'
  return 'through'
}

function inferredLanes(
  count: number,
  action: LanePreviewAction,
  twoStageNear: boolean,
): LanePreviewLane[] {
  return Array.from({ length: count }, (_, index) => {
    if (twoStageNear) {
      const active = index === count - 1
      return { arrow: 'through', active, state: active ? 'primary' : 'inactive' }
    }
    if (action === 'through') return { arrow: 'through', active: true, state: 'secondary' }
    if (action === 'left' || action === 'uturn') {
      const active = index === 0
      return { arrow: active ? 'through-left' : 'through', active,
        state: active ? 'primary' : 'inactive' }
    }
    const active = index === count - 1
    return { arrow: active ? 'through-right' : 'through', active,
      state: active ? 'primary' : 'inactive' }
  })
}

function applyLaneStates(
  lanes: LanePreviewLane[],
  action: LanePreviewAction,
  laneDecision: LaneDecision | undefined,
  near: boolean,
): LanePreviewLane[] {
  if (laneDecision && near) {
    const secondary = new Set(laneDecision.secondaryLaneIndices)
    return lanes.map((lane, index) => {
      const state: LanePreviewState = index === laneDecision.primaryLaneIndex
        ? 'primary'
        : secondary.has(index) ? 'secondary' : 'inactive'
      return { ...lane, state, active: state !== 'inactive' }
    })
  }
  const activeIndices = lanes.flatMap((lane, index) => lane.active ? [index] : [])
  const primary = action === 'right'
    ? activeIndices.at(-1)
    : activeIndices[0]
  return lanes.map((lane, index) => ({
    ...lane,
    state: !lane.active ? 'inactive' : index === primary ? 'primary' : 'secondary',
  }))
}

export function buildLanePreview(input: LanePreviewInput): LanePreviewModel {
  const preparationM = input.laneDecision?.preparationM ?? TURN_GUIDANCE_M
  const near = Number.isFinite(input.distanceM) && input.distanceM <= preparationM
  const twoStageNear = input.twoStage && near
  const immediateAction: LanePreviewAction = near ? maneuverAction(input.maneuverKind) : 'through'
  const countValue = Number(input.laneCount)

  if (!Number.isFinite(countValue) || countValue < 1) {
    return {
      status: 'no-data',
      lanes: [],
      immediateAction,
      inferred: false,
      truncated: false,
      showTwoStageSign: twoStageNear,
    }
  }

  const sourceCount = Math.floor(countValue)
  const count = Math.min(sourceCount, MAX_LANES)
  const truncated = sourceCount > MAX_LANES
  const turnLanes = input.turnLanes
  const realMovements = Array.isArray(turnLanes) && turnLanes.length > 0

  if (!realMovements) {
    const inferred = input.laneDecision?.inferred ?? true
    return {
      status: 'ready',
      lanes: applyLaneStates(
        inferredLanes(count, immediateAction, twoStageNear),
        immediateAction,
        input.laneDecision,
        near,
      ),
      immediateAction,
      inferred,
      truncated,
      showTwoStageSign: twoStageNear,
      inferenceNote: inferred ? '車道建議（系統推測）' : undefined,
      warningNote: near && input.laneDecision?.shortPreparation
        ? '前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。'
        : undefined,
    }
  }

  const parsed = Array.from(
    { length: count },
    (_, index) => parseMoves(turnLanes[index] ?? ''),
  )
  const hasKnownMovement = parsed.some((moves) => moves.size > 0)
  if (!hasKnownMovement) {
    const inferred = input.laneDecision?.inferred ?? true
    return {
      status: 'ready',
      lanes: applyLaneStates(
        inferredLanes(count, immediateAction, twoStageNear),
        immediateAction,
        input.laneDecision,
        near,
      ),
      immediateAction,
      inferred,
      truncated,
      showTwoStageSign: twoStageNear,
      inferenceNote: inferred ? '車道建議（系統推測）' : undefined,
      warningNote: near && input.laneDecision?.shortPreparation
        ? '前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。'
        : undefined,
    }
  }

  const hasReverse = parsed.some((moves) => moves.has('reverse'))
  const lanes = parsed.map((moves, index): LanePreviewLane => {
    if (twoStageNear) {
      const active = index === count - 1
      return { arrow: active ? 'through' : arrowFor(moves), active,
        state: active ? 'primary' : 'inactive' }
    }
    const active = immediateAction === 'uturn'
      ? hasReverse ? moves.has('reverse') : moves.has('left')
      : moves.has(immediateAction)
    return { arrow: arrowFor(moves), active, state: active ? 'secondary' : 'inactive' }
  })

  const inferred = near && input.laneDecision
    ? input.laneDecision.inferred
    : input.guidanceSource === 'inferred'

  return {
    status: 'ready',
    lanes: applyLaneStates(lanes, immediateAction, input.laneDecision, near),
    immediateAction,
    inferred,
    truncated,
    showTwoStageSign: twoStageNear,
    inferenceNote: inferred ? '車道建議（系統推測）' : undefined,
    warningNote: near && input.laneDecision?.shortPreparation
      ? '前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。'
      : undefined,
  }
}
import type { LaneGuidanceSource } from '../core/laneGuidance'
import type { LaneDecision } from '../core/laneDecision'
