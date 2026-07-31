import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoadMergeViews, resolveRoadMerges } from './roadMerge.ts'

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
  assert.ok(view.routingRoads.includes(secondary), '導航必須保留原始次段物件')
  assert.ok(view.routingRoads.includes(side), '側路不得因捏合退出導航圖')
  assert.deepEqual(secondary.properties.nodes, [2, 3], '來源道路不可被繪圖接合改寫')
  assert.deepEqual(primary.properties.oneSideEntryNodes, [2], '主路必須保存接縫轉向限制')
  assert.deepEqual(secondary.properties.oneSideEntryNodes, [2],
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

  assert.deepEqual(primary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: true }])
  assert.deepEqual(secondary.properties.oneSideEntryAccess,
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

  buildRoadMergeViews([primary, secondary, eastSide], [record])

  assert.deepEqual(primary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: false }])
  assert.deepEqual(secondary.properties.oneSideEntryAccess,
    [{ nodeId: 2, allowedBack: true }])
})
