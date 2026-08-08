import test from 'node:test'
import assert from 'node:assert/strict'
import * as turnbays from './turnbays.ts'
import { buildRoadMergeViews, previewRoadMerge, roadMergeMotoBoxTargets } from './roadMerge.ts'
import { motoBoxPanelLimits } from '../edit/useEditor.ts'

const road = (osmId, blockNode, nodes, coords, extra = {}) => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
  properties: {
    osm_id: osmId, blockNode, nodes, name: 'merge road', highway: 'tertiary',
    oneway: 'no', lanes: 4, lanesForward: 2, lanesBackward: 2,
    motoF: false, motoB: false, motoCountF: 0, motoCountB: 0,
    motoSepF: 0, motoSepB: 0, roadMarkingMode: 'all',
    centerM: 0, centerKind: 'hatch', islandBayMode: false,
    centerExtendStart: false, centerExtendEnd: false, extraM: 0, divOffM: 0,
    width_m: 14, layer: 0, navSegmentKey: `way/${osmId}`, splitIndex: 0,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: nodes }],
    ...extra,
  },
})

test('secondary endpoint policy constrains moto-box initialization, panel, and saved fields', () => {
  assert.equal(typeof turnbays.motoBoxApproachPolicy, 'function')
  assert.equal(typeof turnbays.motoBoxEditorLimits, 'function')
  assert.equal(typeof turnbays.motoBoxInitialRange, 'function')
  assert.equal(typeof turnbays.motoBoxSaveFields, 'function')
  const primary = road(100, 10, [10, 20], [[120, 22], [120, 22.001]], {
    motorcycleAccessByLaneF: ['yes', 'yes'],
  })
  const secondary = road(200, 20, [20, 30], [[120, 22.001], [120, 22.002]], {
    motorcycle: 'no', motorcycleAccessByLaneF: ['unknown', 'yes'],
  })
  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)
  assert.equal(preview.ok, true)
  const record = { ...preview.record, seq: 1, ts: '2026-01-01T00:00:00.000Z', author: 'test' }
  const view = buildRoadMergeViews([primary, secondary], [record], [])
  const carrier = view.renderRoads[0]
  const targets = roadMergeMotoBoxTargets(view.rows, primary, view.renderRoads)
  const policy = turnbays.motoBoxApproachPolicy(
    carrier, targets.forward.nodeId, targets.forward.back,
  )
  const panel = turnbays.motoBoxEditorLimits(policy, true, false)
  const editorPanel = motoBoxPanelLimits({
    oneway: 'no', f: 2, b: 2, motoF: false, motoB: false,
    motoCountF: 0, motoCountB: 0, rightLaneF: false, rightLaneB: false,
    motoBoxTopoF: true, motoBoxTopoB: true,
    motoBoxPolicyF: policy, motoBoxPolicyB: policy,
  }, false)

  assert.deepEqual(turnbays.motoBoxInitialRange(panel), { start: 1, end: 2 })
  assert.deepEqual(panel, { max: 1, min: 1, slots: 2 })
  assert.deepEqual(editorPanel, panel)
  assert.deepEqual(turnbays.motoBoxSaveFields(true, 0, 2, panel), {
    lanes: 1, start_lane: 1, end_lane: 2,
  })
})

test('reverse-connected mapped backward endpoint does not inherit selected forward lane count', () => {
  const primary = road(300, 10, [10, 20], [[120, 22], [120, 22.001]])
  const secondary = road(400, 20, [30, 20], [[120, 22.002], [120, 22.001]], {
    roadMergeApproachPolicies: [{
      nodeId: 30, sourceWayId: 401, direction: 'backward', laneCount: 1,
      moto: false, motoCount: 0, motoSep: 0,
      motorcycleAccessByLane: ['yes'], motorcycle: 'yes',
    }],
  })
  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)
  assert.equal(preview.ok, true)
  const record = { ...preview.record, seq: 1, ts: '2026-01-01T00:00:00.000Z', author: 'test' }
  const view = buildRoadMergeViews([primary, secondary], [record], [])
  const carrier = view.renderRoads[0]
  const targets = roadMergeMotoBoxTargets(view.rows, primary, view.renderRoads)
  const policy = turnbays.motoBoxApproachPolicy(
    carrier, targets.forward.nodeId, targets.forward.back,
  )
  assert.equal(policy.lanes, 1)
  const panel = motoBoxPanelLimits({
    oneway: 'no', f: 2, b: 2, motoF: false, motoB: false,
    motoCountF: 0, motoCountB: 0, rightLaneF: false, rightLaneB: false,
    motoBoxTopoF: true, motoBoxTopoB: true,
    motoBoxPolicyF: policy, motoBoxPolicyB: policy,
  }, false)

  assert.deepEqual(panel, { max: 1, min: 0, slots: 1 })
  assert.deepEqual(turnbays.motoBoxInitialRange(panel), { start: 0, end: 1 })
  assert.deepEqual(turnbays.motoBoxSaveFields(true, 0, 2, panel), {
    lanes: 1, start_lane: 0, end_lane: 1,
  })
})
