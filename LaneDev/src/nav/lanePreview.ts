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
  maneuverKind: 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'arrive'
  distanceM: number
  twoStage: boolean
}

export interface LanePreviewLane {
  arrow: LaneArrowKind
  active: boolean
}

export interface LanePreviewModel {
  status: 'ready' | 'no-data'
  lanes: LanePreviewLane[]
  immediateAction: LanePreviewAction
  inferred: boolean
  truncated: boolean
  showTwoStageSign: boolean
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
      return { arrow: 'through', active: index === count - 1 }
    }
    if (action === 'through') return { arrow: 'through', active: true }
    if (action === 'left' || action === 'uturn') {
      const active = index === 0
      return { arrow: active ? 'through-left' : 'through', active }
    }
    const active = index === count - 1
    return { arrow: active ? 'through-right' : 'through', active }
  })
}

export function buildLanePreview(input: LanePreviewInput): LanePreviewModel {
  const near = Number.isFinite(input.distanceM) && input.distanceM <= TURN_GUIDANCE_M
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
  const realMovements = Array.isArray(turnLanes) && turnLanes.length >= count

  if (!realMovements) {
    return {
      status: 'ready',
      lanes: inferredLanes(count, immediateAction, twoStageNear),
      immediateAction,
      inferred: true,
      truncated,
      showTwoStageSign: twoStageNear,
    }
  }

  const parsed = turnLanes.slice(0, count).map(parseMoves)
  const hasKnownMovement = parsed.some((moves) => moves.size > 0)
  if (!hasKnownMovement) {
    return {
      status: 'ready',
      lanes: inferredLanes(count, immediateAction, twoStageNear),
      immediateAction,
      inferred: true,
      truncated,
      showTwoStageSign: twoStageNear,
    }
  }

  const hasReverse = parsed.some((moves) => moves.has('reverse'))
  const lanes = parsed.map((moves, index): LanePreviewLane => {
    if (twoStageNear) {
      const active = index === count - 1
      return { arrow: active ? 'through' : arrowFor(moves), active }
    }
    const active = immediateAction === 'uturn'
      ? hasReverse ? moves.has('reverse') : moves.has('left')
      : moves.has(immediateAction)
    return { arrow: arrowFor(moves), active }
  })

  return {
    status: 'ready',
    lanes,
    immediateAction,
    inferred: false,
    truncated,
    showTwoStageSign: twoStageNear,
  }
}
