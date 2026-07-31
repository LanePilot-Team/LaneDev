import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeMergeForRoad, buildRoadMergeViews, previewRoadMerge, resolveRoadMerges,
} from './roadMerge.ts'
import * as roadMergeModule from './roadMerge.ts'

const coordinate = (node) => [120 + node / 1_000_000, 22]

const road = ({
  osmId, blockNode, nodes, sourceSegments, name = '測試路', coordinates,
}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coordinates ?? nodes.map(coordinate) },
  properties: {
    osm_id: osmId,
    blockNode,
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    name,
    nodes: [...nodes],
    sourceSegments: sourceSegments ?? [{
      osmId,
      navSegmentKey: `way/${osmId}`,
      splitIndex: 0,
      nodeRefs: [...nodes],
    }],
  },
})

const mergeRecord = ({
  primary = 'way/100@b/1', secondary = 'way/100@b/2',
  secondaryNodes, seq = 1, op = 'set',
} = {}) => ({
  seq,
  ts: `2026-07-31T00:00:0${seq}.000Z`,
  author: 'anna',
  op,
  target: { type: 'road_merge', key: `merge/${primary}+${secondary}` },
  fields: op === 'delete' ? undefined : {
    primary,
    secondary,
    ...(secondaryNodes ? { secondary_nodes: JSON.stringify(secondaryNodes) } : {}),
  },
})

test('精確 block key 可依日誌追溯', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })

  const result = resolveRoadMerges([primary, secondary], [mergeRecord()])

  assert.equal(result.resolved.length, 1)
  assert.equal(result.rows[0].status, 'replayable')
  assert.equal(result.resolved[0].resolvedBy, 'exact')
  assert.equal(result.resolved[0].sourceAuthor, 'anna')
})

test('次段被 couplet drop 後可由 sourceSegments 找回', () => {
  const keep = road({
    osmId: 900,
    blockNode: 1,
    nodes: [1, 2, 3],
    sourceSegments: [
      { osmId: 100, navSegmentKey: 'way/100', splitIndex: 0, nodeRefs: [1, 2] },
      { osmId: 267715892, navSegmentKey: 'way/267715892', splitIndex: 0,
        nodeRefs: [2, 3] },
    ],
  })
  const record = mergeRecord({
    primary: 'way/100@b/1',
    secondary: 'way/267715892@b/2',
    secondaryNodes: [2, 3],
  })

  const result = resolveRoadMerges([keep], [record])

  assert.equal(result.resolved.length, 1)
  assert.equal(result.rows[0].status, 'recoverable_via_provenance')
  assert.equal(result.resolved[0].resolvedBy, 'already-absorbed')
  assert.equal(result.resolved[0].junctionNodeId, 2)
})

test('連鎖捏合依原始時序重播，不用最終快照誤判較早次段', () => {
  const blocks = [
    road({ osmId: 100, blockNode: 1, nodes: [1, 2] }),
    road({ osmId: 100, blockNode: 2, nodes: [2, 3] }),
    road({ osmId: 100, blockNode: 3, nodes: [3, 4] }),
  ]
  const journal = [
    mergeRecord({ primary: 'way/100@b/1', secondary: 'way/100@b/2', seq: 1 }),
    mergeRecord({ primary: 'way/100@b/1', secondary: 'way/100@b/3', seq: 2 }),
  ]

  const result = resolveRoadMerges(blocks, journal)

  assert.deepEqual(result.rows.map((row) => row.status), ['replayable', 'replayable'])
  assert.equal(result.resolved.length, 2)
})

test('delete tombstone 會停用舊捏合但保留日誌原文', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const set = mergeRecord({ seq: 1 })
  const del = mergeRecord({ seq: 2, op: 'delete' })

  const result = resolveRoadMerges([primary, secondary], [set, del])

  assert.equal(result.rows.length, 0)
  assert.equal(result.resolved.length, 0)
  assert.equal(set.op, 'set')
})

test('sourceSegments 找到多個候選時不猜測並列入人工確認', () => {
  const source = {
    osmId: 267715892,
    navSegmentKey: 'way/267715892',
    splitIndex: 0,
    nodeRefs: [2, 3],
  }
  const candidates = [
    road({ osmId: 900, blockNode: 1, nodes: [1, 2], sourceSegments: [source] }),
    road({ osmId: 901, blockNode: 4, nodes: [4, 2], sourceSegments: [source] }),
  ]
  const record = mergeRecord({
    primary: 'way/267715892@b/2',
    secondary: 'way/267715892@b/3',
    secondaryNodes: [2, 3],
  })

  const result = resolveRoadMerges(candidates, [record])

  assert.equal(result.resolved.length, 0)
  assert.equal(result.rows[0].status, 'needs_manual_review')
  assert.match(result.rows[0].detail, /候選不唯一/)
})

test('完整來源節點被多段共用時，以來源節點座標定位正確區塊', () => {
  const source = {
    osmId: 267715892,
    navSegmentKey: 'way/267715892',
    splitIndex: 0,
    nodeRefs: [2, 3, 4],
    coordinates: [[120, 22], [120, 22.001], [120, 22.002]],
  }
  const near = road({
    osmId: 900, blockNode: 90, nodes: [90, 91], sourceSegments: [source],
    coordinates: [[120.00001, 22.00099], [120.00001, 22.0015]],
  })
  const far = road({
    osmId: 901, blockNode: 92, nodes: [92, 93], sourceSegments: [source],
    coordinates: [[120.01, 22.01], [120.011, 22.011]],
  })
  const primary = road({
    osmId: 100, blockNode: 1, nodes: [1, 2],
    coordinates: [[120, 22.0005], [120, 22.00099]],
  })
  const record = mergeRecord({
    primary: 'way/100@b/1',
    secondary: 'way/267715892@b/3',
    secondaryNodes: [2, 3],
  })

  const result = resolveRoadMerges([primary, near, far], [record])

  assert.equal(result.rows[0].status, 'recoverable_via_provenance')
  assert.equal(result.resolved[0].secondary.properties.osm_id, near.properties.osm_id)
})

test('來源幾何是不可變追溯資料，建立視圖時不得重複深拷貝', () => {
  const coordinates = [[120, 22], [120, 22.001]]
  const primary = road({
    osmId: 100, blockNode: 1, nodes: [1, 2],
    sourceSegments: [{
      osmId: 100, navSegmentKey: 'way/100', splitIndex: 0,
      nodeRefs: [1, 2], coordinates,
    }],
  })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })

  const view = buildRoadMergeViews([primary, secondary], [mergeRecord()])

  assert.equal(view.routingRoads[0].properties.sourceSegments[0].coordinates, coordinates)
})

test('已有預先解析的捏合視圖時不得再次呼叫完整建圖器', () => {
  const select = roadMergeModule.selectPreparedRoadMergeView
  assert.equal(typeof select, 'function', '需要可沿用預覽結果的視圖選擇器')
  let builds = 0
  const prepared = { routingRoads: [], renderRoads: [], resolved: [], rows: [] }

  const selected = select?.(prepared, () => {
    builds++
    return { routingRoads: [], renderRoads: [], resolved: [], rows: [] }
  })

  assert.equal(selected, prepared)
  assert.equal(builds, 0)
})

test('結構性捏合更新必須等 journal 排隊寫入且落盤後才重新載入', async () => {
  const reloadAfterSave = roadMergeModule.reloadAfterRoadMergeSave
  assert.equal(typeof reloadAfterSave, 'function', '需要安全完成捏合儲存再重新載入的流程')
  const events = []
  queueMicrotask(() => events.push('journal-queued'))

  await reloadAfterSave?.(
    async () => { events.push('database-flushed') },
    () => { events.push('page-reloaded') },
  )

  assert.deepEqual(events, ['journal-queued', 'database-flushed', 'page-reloaded'])
})

test('導航保留主段次段與側路，只有繪圖視圖接合主路', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const join = coordinate(2)
  const side = road({
    osmId: 200, blockNode: 2, nodes: [2, 9], name: '側路',
    coordinates: [join, [join[0], join[1] - 0.001]],
  })
  const source = [primary, secondary, side]

  const view = buildRoadMergeViews(source, [mergeRecord()])

  assert.equal(view.routingRoads.length, 3)
  assert.equal(view.routingRoads.some((item) => item.properties.blockNode === 2), true,
    '導航必須保留次段')
  assert.equal(view.routingRoads.some((item) => item.properties.osm_id === 200), true,
    '側路不得因捏合退出導航圖')
  assert.deepEqual(secondary.properties.nodes, [2, 3], '來源道路不可被繪圖接合改寫')
  assert.equal(primary.properties.oneSideEntryNodes, undefined, '來源道路不得被衍生限制污染')
  const routingPrimary = view.routingRoads.find((item) => item.properties.blockNode === 1)
  const routingSecondary = view.routingRoads.find((item) => item.properties.blockNode === 2)
  assert.deepEqual(routingPrimary.properties.oneSideEntryNodes, [2], '主路必須保存接縫轉向限制')
  assert.deepEqual(routingSecondary.properties.oneSideEntryNodes, [2],
    '次段也必須標記接縫，避免由次段方向生成主路停止線或箭頭')
  const renderedMain = view.renderRoads.filter((item) => item.properties.osm_id === 100)
  assert.equal(renderedMain.length, 1)
  assert.deepEqual(renderedMain[0].properties.nodes, [1, 2, 3])
  assert.equal(view.renderRoads.some((item) => item.properties.osm_id === 200), true)
})

test('與捏合主路重疊的短碎段只從繪圖隱藏，仍保留在導航來源', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const stub = road({ osmId: 100, blockNode: 50, nodes: [50, 51] })

  const view = buildRoadMergeViews([primary, secondary, stub], [mergeRecord()])

  const routingStub = view.routingRoads.find((item) => item.properties.blockNode === 50)
  assert.ok(routingStub)
  assert.equal(routingStub.properties.deleted, undefined)
  assert.equal(view.renderRoads.some((item) => item.properties.blockNode === 50), false)
})

test('依側路所在方向判定相鄰主路方向，不固定假設 forward', () => {
  const primary = road({
    osmId: 100, blockNode: 1, nodes: [1, 2],
    coordinates: [[120, 22], [120, 22.001]],
  })
  const secondary = road({
    osmId: 100, blockNode: 2, nodes: [2, 3],
    coordinates: [[120, 22.001], [120, 22.002]],
  })
  const westSide = road({
    osmId: 200, blockNode: 2, nodes: [2, 9], name: '西側路',
    coordinates: [[120, 22.001], [119.999, 22.001]],
  })

  const view = buildRoadMergeViews([primary, secondary, westSide], [mergeRecord()])

  const routingPrimary = view.routingRoads.find((item) => item.properties.blockNode === 1)
  const routingSecondary = view.routingRoads.find((item) => item.properties.blockNode === 2)
  assert.deepEqual(routingPrimary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: true }])
  assert.deepEqual(routingSecondary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: true }])
  assert.equal(view.resolved[0].adjacentBack, true)
})

test('端點方向相反時，次段限制會換算成自己的 back 方向', () => {
  const primary = road({
    osmId: 100, blockNode: 1, nodes: [1, 2],
    coordinates: [[120, 22], [120, 22.001]],
  })
  const secondary = road({
    osmId: 100, blockNode: 3, nodes: [3, 2],
    coordinates: [[120, 22.002], [120, 22.001]],
  })
  const eastSide = road({
    osmId: 200, blockNode: 2, nodes: [2, 9], name: '東側路',
    coordinates: [[120, 22.001], [120.001, 22.001]],
  })
  const record = mergeRecord({ secondary: 'way/100@b/3' })

  const view = buildRoadMergeViews([primary, secondary, eastSide], [record])

  const routingPrimary = view.routingRoads.find((item) => item.properties.blockNode === 1)
  const routingSecondary = view.routingRoads.find((item) => item.properties.blockNode === 3)
  assert.deepEqual(routingPrimary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: false }])
  assert.deepEqual(routingSecondary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: true }])
})

test('新捏合預覽產生 V2 來源快照，且可追蹤目前道路', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })

  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)

  assert.equal(preview.ok, true)
  assert.equal(preview.record.fields.schema_version, 2)
  assert.equal(preview.record.fields.junction_node, 2)
  assert.match(preview.record.fields.primary_source, /navSegmentKey/)
  assert.match(preview.record.fields.secondary_source, /nodeRefs/)
  const fullRecord = { ...preview.record, seq: 1, ts: '2026-07-31T00:00:00Z', author: 'anna' }
  const view = buildRoadMergeViews([primary, secondary], [fullRecord])
  assert.equal(activeMergeForRoad(view.rows, view.routingRoads[0])?.mergeKey,
    preview.record.target.key)
})

test('新捏合的關鍵內容欄位不同時拒絕且不產生紀錄', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  primary.properties.centerM = 2.4
  primary.properties.centerKind = 'island'
  secondary.properties.centerM = 0.6
  secondary.properties.centerKind = 'hatch'

  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)

  assert.equal(preview.ok, false)
  assert.equal(preview.record, undefined)
  assert.match(preview.reason, /centerM|centerKind/)
})

test('撤銷後重建會清除先前衍生的接縫限制', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const side = road({
    osmId: 200, blockNode: 2, nodes: [2, 9], name: '側路',
    coordinates: [coordinate(2), [coordinate(2)[0], coordinate(2)[1] - 0.001]],
  })
  const set = mergeRecord()
  const merged = buildRoadMergeViews([primary, secondary, side], [set])
  const del = mergeRecord({ seq: 2, op: 'delete' })

  const restored = buildRoadMergeViews(merged.routingRoads, [set, del])

  assert.equal(restored.rows.length, 0)
  assert.equal(restored.routingRoads.some((item) => item.properties.oneSideEntryNodes?.includes(2)),
    false)
})

test('新版捏合撤銷後繪圖恢復原始兩段道路', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)
  assert.equal(preview.ok, true)
  const set = {
    ...preview.record, seq: 1, ts: '2026-08-01T00:00:00Z', author: 'anna',
  }
  const del = {
    seq: 2, ts: '2026-08-01T00:00:01Z', author: 'anna', op: 'delete',
    target: { type: 'road_merge', key: set.target.key },
    fields: { supersedes_seq: 1 },
  }

  const merged = buildRoadMergeViews([primary, secondary], [set])
  const restored = buildRoadMergeViews([primary, secondary], [set, del])

  assert.equal(merged.renderRoads.filter((item) => item.properties.osm_id === 100).length, 1)
  assert.deepEqual(
    restored.renderRoads
      .filter((item) => item.properties.osm_id === 100)
      .map((item) => item.properties.nodes),
    [[1, 2], [2, 3]],
  )
})

test('舊版捏合升級後仍可撤銷並恢復原始兩段繪圖', () => {
  const primary = road({ osmId: 100, blockNode: 1, nodes: [1, 2] })
  const secondary = road({ osmId: 100, blockNode: 2, nodes: [2, 3] })
  const legacy = mergeRecord({ seq: 1 })
  const legacyDelete = mergeRecord({ seq: 2, op: 'delete' })
  const preview = previewRoadMerge([primary, secondary], [], primary, secondary)
  assert.equal(preview.ok, true)
  const upgraded = {
    ...preview.record, seq: 3, ts: '2026-08-01T00:00:02Z', author: 'migration',
  }
  const undo = {
    seq: 4, ts: '2026-08-01T00:00:03Z', author: 'anna', op: 'delete',
    target: { type: 'road_merge', key: upgraded.target.key },
    fields: { supersedes_seq: 3 },
  }

  const upgradedView = buildRoadMergeViews(
    [primary, secondary], [legacy, legacyDelete, upgraded],
  )
  const restored = buildRoadMergeViews(
    [primary, secondary], [legacy, legacyDelete, upgraded, undo],
  )

  assert.equal(upgradedView.renderRoads.filter((item) => item.properties.osm_id === 100).length, 1)
  assert.deepEqual(
    restored.renderRoads
      .filter((item) => item.properties.osm_id === 100)
      .map((item) => item.properties.nodes),
    [[1, 2], [2, 3]],
  )
})
