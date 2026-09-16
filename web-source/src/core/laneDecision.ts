import type { LaneGuidanceSource } from './laneGuidance.ts'

export type LaneAction = 'left' | 'through' | 'right' | 'uturn'
export type LaneDecisionReason =
  | 'compatible'
  | 'inferred'
  | 'explicitly-incompatible'

type NormalMove = 'left' | 'through' | 'right' | 'reverse'

export interface LaneDecisionInput {
  action: LaneAction
  profile: 'car' | 'moto'
  laneCount: number
  laneMovements?: string[]
  guidanceSource: LaneGuidanceSource
  currentLaneIndex?: number
  availableM: number
  speedKmh: number
  twoStage: boolean
}

export interface LaneDecision {
  allowed: boolean
  reason: LaneDecisionReason
  primaryLaneIndex?: number
  secondaryLaneIndices: number[]
  incompatibleLaneIndices: number[]
  inferred: boolean
  preparationM: number
  laneChanges: number
  difficultyS: number
  shortPreparation: boolean
  twoStage: boolean
  /** 轉彎後在下一道路上的建議落點；RoadGraph 可依下一個 maneuver 前瞻調整。 */
  postTurnLaneIndex?: number
}

interface LaneCandidate {
  index: number
  dedicated: boolean
}

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

export function parseLaneMovements(value: string): Set<NormalMove> {
  return new Set(
    value.split(/[;+]/)
      .map(normalizeMove)
      .filter((move): move is NormalMove => move !== null),
  )
}

export function preparationDistanceM(speedKmh: number, laneChanges: number): number {
  const speedMs = Math.max(0, speedKmh) / 3.6
  const dynamicM = speedMs * (4 + Math.max(1, laneChanges) * 3.5)
  return Math.max(250, dynamicM)
}

function candidateOrder(
  action: LaneAction,
  currentLaneIndex: number | undefined,
  preferredSide?: 'outermost' | 'innermost',
): (a: LaneCandidate, b: LaneCandidate) => number {
  return (a, b) => {
    if (preferredSide === 'outermost') return b.index - a.index
    if (preferredSide === 'innermost') return a.index - b.index
    if (a.dedicated !== b.dedicated) return a.dedicated ? -1 : 1
    // When every available turning lane is shared with through traffic, keep
    // the navigation line on the turning side. This avoids selecting an inner
    // through+right lane merely because it needs one fewer lane change.
    if (!a.dedicated && !b.dedicated) {
      if (action === 'right') return b.index - a.index
      if (action === 'left' || action === 'uturn') return a.index - b.index
    }
    if (currentLaneIndex !== undefined) {
      const aMoves = Math.abs(a.index - currentLaneIndex)
      const bMoves = Math.abs(b.index - currentLaneIndex)
      if (aMoves !== bMoves) return aMoves - bMoves
    }
    if (action === 'right') return b.index - a.index
    return a.index - b.index
  }
}

function allowedResult(
  input: LaneDecisionInput,
  candidates: LaneCandidate[],
  incompatibleLaneIndices: number[],
  inferred: boolean,
  preferredSide?: 'outermost' | 'innermost',
): LaneDecision {
  const ordered = [...candidates].sort(candidateOrder(
    input.action,
    input.currentLaneIndex,
    preferredSide,
  ))
  const primaryLaneIndex = ordered[0].index
  const secondaryLaneIndices = ordered.slice(1)
    .map((candidate) => candidate.index)
    .sort((a, b) => a - b)
  const laneChanges = input.currentLaneIndex === undefined
    ? 0
    : Math.abs(primaryLaneIndex - input.currentLaneIndex)
  const preparationM = preparationDistanceM(input.speedKmh, laneChanges)
  const availableM = Number.isFinite(input.availableM)
    ? Math.max(0, input.availableM)
    : Number.POSITIVE_INFINITY
  const shortPreparation = availableM < preparationM
  const speedMs = Math.max(1, input.speedKmh / 3.6)
  const deficitS = shortPreparation ? (preparationM - availableM) / speedMs : 0

  return {
    allowed: true,
    reason: inferred ? 'inferred' : 'compatible',
    primaryLaneIndex,
    secondaryLaneIndices,
    incompatibleLaneIndices: [...incompatibleLaneIndices].sort((a, b) => a - b),
    inferred,
    preparationM,
    laneChanges,
    difficultyS: laneChanges * 2 + deficitS,
    shortPreparation,
    twoStage: input.twoStage,
  }
}

function rejectedResult(laneCount: number, twoStage = false): LaneDecision {
  return {
    allowed: false,
    reason: 'explicitly-incompatible',
    secondaryLaneIndices: [],
    incompatibleLaneIndices: Array.from({ length: laneCount }, (_, index) => index),
    inferred: false,
    preparationM: 250,
    laneChanges: 0,
    difficultyS: 0,
    shortPreparation: false,
    twoStage,
  }
}

export function resolveLaneDecision(input: LaneDecisionInput): LaneDecision {
  const laneCountValue = Number(input.laneCount)
  const laneCount = Number.isFinite(laneCountValue) && laneCountValue >= 1
    ? Math.floor(laneCountValue)
    : 0
  if (laneCount === 0) return rejectedResult(0, input.twoStage)

  const parsed = Array.from(
    { length: laneCount },
    (_, index) => parseLaneMovements(input.laneMovements?.[index] ?? ''),
  )
  const unknownIndices = parsed
    .map((moves, index) => moves.size === 0 ? index : -1)
    .filter((index) => index >= 0)

  const effectiveAction: LaneAction = input.profile === 'moto' && input.twoStage
    ? 'through'
    : input.action
  const effectiveMove: NormalMove = effectiveAction === 'uturn'
    ? 'reverse'
    : effectiveAction

  if (input.action === 'uturn' && !input.twoStage) {
    const reverse = parsed.flatMap((moves, index) => moves.has('reverse')
      ? [{ index, dedicated: moves.size === 1 }]
      : [])
    if (reverse.length > 0) {
      const incompatible = parsed.flatMap((moves, index) =>
        moves.has('reverse') ? [] : [index])
      return allowedResult(input, reverse, incompatible, false)
    }

    const left = parsed.flatMap((moves, index) => moves.has('left')
      ? [{ index, dedicated: moves.size === 1 }]
      : [])
    if (left.length > 0) {
      const incompatible = parsed.flatMap((moves, index) =>
        moves.has('left') || moves.size === 0 ? [] : [index])
      return allowedResult(input, left, incompatible, true, 'innermost')
    }

    if (unknownIndices.length > 0) {
      const candidates = unknownIndices.map((index) => ({ index, dedicated: false }))
      const incompatible = parsed.flatMap((moves, index) => moves.size > 0 ? [index] : [])
      return allowedResult(input, candidates, incompatible, true, 'innermost')
    }
    return rejectedResult(laneCount, input.twoStage)
  }

  const compatible = parsed.flatMap((moves, index) => moves.has(effectiveMove)
    ? [{ index, dedicated: moves.size === 1 }]
    : [])
  if (compatible.length > 0) {
    const incompatible = parsed.flatMap((moves, index) =>
      moves.size > 0 && !moves.has(effectiveMove) ? [index] : [])
    return allowedResult(
      input,
      compatible,
      incompatible,
      input.guidanceSource === 'inferred',
      input.profile === 'moto' && input.twoStage ? 'outermost' : undefined,
    )
  }

  if (unknownIndices.length > 0) {
    const candidates = unknownIndices.map((index) => ({ index, dedicated: false }))
    const incompatible = parsed.flatMap((moves, index) => moves.size > 0 ? [index] : [])
    return allowedResult(
      input,
      candidates,
      incompatible,
      true,
      input.profile === 'moto' && input.twoStage
        ? 'outermost'
        : effectiveAction === 'right'
          ? 'outermost'
          : effectiveAction === 'left' || effectiveAction === 'uturn'
            ? 'innermost'
            : undefined,
    )
  }

  return rejectedResult(laneCount, input.twoStage)
}
