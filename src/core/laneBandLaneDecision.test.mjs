import test from 'node:test'
import assert from 'node:assert/strict'
import { laneBand } from './graph.ts'
import { cumulative, pointAlong } from './geo.ts'

const decision = (overrides = {}) => ({
  allowed: true,
  reason: 'compatible',
  primaryLaneIndex: 2,
  secondaryLaneIndices: [],
  incompatibleLaneIndices: [],
  inferred: false,
  preparationM: 320,
  laneChanges: 1,
  difficultyS: 2,
  shortPreparation: false,
  postTurnLaneIndex: 2,
  ...overrides,
})

const straightRoute = (laneDecision) => {
  const coords = [[120, 22], [120.005, 22]]
  const cum = cumulative(coords)
  return {
    coords,
    cum,
    lengthM: cum.at(-1),
    timeS: 45,
    maneuvers: [
      {
        distM: 400,
        kind: 'right',
        lanesForward: 4,
        laneGuidance: {
          laneCount: 4,
          laneMovements: ['through', 'right', 'right', 'through'],
          source: 'annotation',
        },
        laneDecision,
      },
      { distM: cum.at(-1), kind: 'arrive', lanesForward: 1 },
    ],
    spans: [{
      toIdx: 1,
      offM: 0,
      leftM: -4.8,
      rightM: 4.8,
      laneGuidance: { laneCount: 4, source: 'annotation' },
    }],
    diverges: [],
    weaves: [],
  }
}

function offsetAt(route, distanceM) {
  const band = laneBand(route)
  let best = 0
  for (let i = 1; i < band.routeD.length; i++) {
    if (Math.abs(band.routeD[i] - distanceM) < Math.abs(band.routeD[best] - distanceM)) best = i
  }
  const d = band.routeD[best]
  const base = pointAlong(route.coords, route.cum, d)
  const c = band.coords[best]
  const kx = 111320 * Math.cos((base.pos[1] * Math.PI) / 180)
  const ex = (c[0] - base.pos[0]) * kx
  const ny = (c[1] - base.pos[1]) * 110540
  const rad = ((base.brg + 90) * Math.PI) / 180
  return ex * Math.sin(rad) + ny * Math.cos(rad)
}

test('導航線使用保存的主要車道索引而不是固定最外側', () => {
  const route = straightRoute(decision({ primaryLaneIndex: 2 }))

  assert.ok(Math.abs(offsetAt(route, 390) - 1.6) < 0.35)
})

test('導航線在保存的 preparationM 邊界開始切換車道', () => {
  const route = straightRoute(decision({ primaryLaneIndex: 3, preparationM: 320 }))

  assert.ok(Math.abs(offsetAt(route, 55)) < 0.1)
  assert.ok(offsetAt(route, 95) > 0.15)
})

test('轉彎後導航線落在前瞻保存的車道而不是先回外側', () => {
  const coords = [[120, 22], [120.001, 22], [120.001, 21.999]]
  const cum = cumulative(coords)
  const turnM = cum[1]
  const route = {
    coords,
    cum,
    lengthM: cum.at(-1),
    timeS: 20,
    maneuvers: [
      {
        distM: turnM,
        kind: 'right',
        lanesForward: 3,
        laneDecision: decision({ primaryLaneIndex: 2, postTurnLaneIndex: 0 }),
      },
      { distM: cum.at(-1), kind: 'arrive', lanesForward: 3 },
    ],
    spans: [
      { toIdx: 1, offM: 0, leftM: -3.2, rightM: 3.2, laneGuidance: { laneCount: 3, source: 'annotation' } },
      { toIdx: 2, offM: 0, leftM: -3.2, rightM: 3.2, laneGuidance: { laneCount: 3, source: 'annotation' } },
    ],
    diverges: [],
    weaves: [],
  }

  const actual = offsetAt(route, turnM + 10)
  assert.ok(actual < -0.1, `actual offset ${actual.toFixed(2)}m`)
})
