// 「整段禁行機車」與「本段有機車道」的矛盾調解（enhancements.applyToRoads）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyToRoads, foldJournal } from './enhancements.ts'
import { motoAllowed } from './graph.ts'
import * as laneBase from './laneBase.ts'

const road = (osmId, blockNode, overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[120, 22], [120, 22.001]] },
  properties: {
    osm_id: osmId,
    name: '外環西路',
    highway: 'tertiary',
    lanes: 4,
    lanesForward: 2,
    lanesBackward: 2,
    motoF: false,
    motoB: false,
    motoCountF: 0,
    motoCountB: 0,
    motoSepF: 0,
    motoSepB: 0,
    motoEntryIconF: false,
    motoEntryIconB: false,
    motoTextDiamondF: false,
    motoTextDiamondB: false,
    stopLineF: false,
    stopLineB: false,
    arrowDisplayF: false,
    arrowDisplayB: false,
    startArrowDisplayF: false,
    startArrowDisplayB: false,
    leftWaitAreaF: false,
    leftWaitAreaB: false,
    roadMarkingMode: 'all',
    centerM: 0,
    centerKind: 'hatch',
    islandBayMode: false,
    centerExtendStart: false,
    centerExtendEnd: false,
    extraM: 0,
    divOffM: 0,
    width_m: 14,
    oneway: 'no',
    layer: 0,
    blockNode,
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: [blockNode, 2] }],
    nodes: [blockNode, 2],
    ...overrides,
  },
})

test('Lane Base motorcycle access is applied before human journal authority', () => {
  const r = road(99, 1, {
    laneFieldSourcesF: {
      laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred',
    },
    laneFieldSourcesB: {
      laneCount: 'inferred', laneMovements: 'inferred', motorcycleAccess: 'inferred',
    },
  })
  laneBase.applyLaneBaseToRoads([r], laneBase.buildLaneBaseIndex([{
    sourceKey: 'way/99/forward', wayId: 99, direction: 'forward',
    scope: 'segment_direction', motorcycleAccessByLane: ['no', 'no'], movementRules: [],
  }]))

  assert.equal(motoAllowed(r, false), false)
  assert.deepEqual(r.properties.motorcycleAccessByLaneF, ['no', 'no'])

  applyToRoads([r], foldJournal([record(1, 'way/99@b/1', {
    motorcycle_access_by_lane_forward: 'yes|designated',
  })]))
  assert.equal(motoAllowed(r, false), true)
  assert.deepEqual(r.properties.motorcycleAccessByLaneF, ['yes', 'designated'])
  assert.equal(r.properties.laneFieldSourcesF.motorcycleAccess, 'human-block')
})

const record = (seq, key, fields) => ({
  seq, ts: `2026-01-0${seq}T00:00:00.000Z`, author: 'test',
  op: 'set', target: { type: 'road', key }, fields,
})

test('way 級禁行機車遇到區塊級機車道時降級成汽車車道禁行', () => {
  const r = road(1454602407, 7244167956)
  // LanePilot 匯入的 way 級「整段禁行機車」，之後在面板加了兩條機車道（區塊級）
  const journal = [
    record(1, 'way/1454602407', { motorcycle: 'no', lanes_forward: 2 }),
    record(2, 'way/1454602407@b/7244167956', { moto_forward: 2, moto_backward: 1 }),
  ]
  applyToRoads([r], foldJournal(journal))

  assert.equal(r.properties.motorcycle, undefined, '整段禁行必須解除，否則機車無路可走')
  assert.equal(r.properties.motoCountF, 2)
  assert.equal(motoAllowed(r, false), true, '順向有兩條機車道，機車走得了')
  assert.equal(motoAllowed(r, true), true, '逆向有一條機車道，機車也走得了')
  // 降級不是取消：汽車車道仍然禁行機車（地面照樣印字）
  assert.deepEqual(r.properties.rulesF, ['no_moto'])
  assert.deepEqual(r.properties.rulesB, ['no_moto'])
})

test('沒有機車道的路段仍然整段禁行機車', () => {
  const r = road(75852429, 1)
  applyToRoads([r], foldJournal([
    record(1, 'way/75852429', { motorcycle: 'no', lanes_forward: 3 }),
  ]))

  assert.equal(r.properties.motorcycle, 'no')
  assert.equal(motoAllowed(r, false), false)
  assert.equal(motoAllowed(r, true), false)
})

test('人工設定的 rules 不會被降級覆蓋', () => {
  const r = road(1454602407, 7244167956)
  applyToRoads([r], foldJournal([
    record(1, 'way/1454602407', { motorcycle: 'no' }),
    record(2, 'way/1454602407@b/7244167956', {
      moto_forward: 1, rules_forward: '', rules_backward: '',
    }),
  ]))

  assert.equal(r.properties.motorcycle, undefined)
  assert.deepEqual(r.properties.rulesF, [], '明確設定「無禁行」不可被 fallback 蓋回去')
  assert.deepEqual(r.properties.rulesB, [])
})

test('單行道降級不會生出逆向 rules', () => {
  const r = road(1454602408, 3, { oneway: 'yes', lanesBackward: 0 })
  applyToRoads([r], foldJournal([
    record(1, 'way/1454602408', { motorcycle: 'no' }),
    record(2, 'way/1454602408@b/3', { moto_forward: 1 }),
  ]))

  assert.equal(r.properties.motorcycle, undefined)
  assert.deepEqual(r.properties.rulesF, ['no_moto'])
  assert.equal(r.properties.rulesB, undefined)
})
