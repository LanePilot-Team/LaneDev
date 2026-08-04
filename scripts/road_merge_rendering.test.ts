import assert from 'node:assert/strict'
import { medianJunctionGuard } from '../src/core/medians'
import { RoadGraph } from '../src/core/graph'
import type { RoadFeature } from '../src/core/roads'

const point = (node: number): [number, number] => [120 + node / 1_000, 22]
const road = (osmId: number, nodes: number[], oneSideEntryNodes?: number[]): RoadFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: nodes.map(point) },
  properties: {
    osm_id: osmId,
    blockNode: nodes[0],
    navSegmentKey: `way/${osmId}`,
    splitIndex: 0,
    nodes,
    sourceSegments: [{ osmId, navSegmentKey: `way/${osmId}`, splitIndex: 0, nodeRefs: nodes }],
    width_m: 8,
    oneSideEntryNodes,
  },
})

const mergedMain = road(100, [1, 2, 3], [2])
const ordinaryMain = road(101, [4, 5, 6])
const mergedSide = road(200, [2, 20])
const ordinarySide = road(201, [5, 50])
const nearJunction = medianJunctionGuard(
  [mergedMain, ordinaryMain, mergedSide, ordinarySide],
  new Set([mergedMain, ordinaryMain]),
)

assert.equal(nearJunction(point(2)), false,
  '捏合接縫的側路不得切斷中央島')
assert.equal(nearJunction(point(5)), true,
  '一般路口仍須為中央島保留開口')

const incomingOnlySide = road(300, [30, 2])
incomingOnlySide.properties.oneway = 'yes'
const graph = new RoadGraph([mergedMain, incomingOnlySide])
assert.equal(graph.hasDistinctRoadAt(2, mergedMain), true,
  '只進不出的單行側路仍須被辨識為接縫側路')
console.log('✅ 捏合接縫中央島連續；一般路口仍保留開口')
