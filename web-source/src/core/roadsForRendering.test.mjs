import test from 'node:test'
import assert from 'node:assert/strict'
import { roadsForRendering } from './roads.ts'

const road = (osmId, nodes, deleted = false) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: nodes.map((node) => [node, node]) },
  properties: { osm_id: osmId, nodes, deleted },
})

test('繪圖道路移除完全重複及同一 OSM 路段的子路徑', () => {
  const full = road(10, [1, 2, 3, 4])
  const duplicate = road(10, [1, 2, 3, 4])
  const contained = road(10, [3, 2])
  const otherWay = road(11, [2, 3])
  const deleted = road(10, [2, 3], true)

  assert.deepEqual(
    roadsForRendering([full, duplicate, contained, otherWay, deleted]),
    [full, otherWay, deleted],
  )
})

test('不同 OSM 路段的繪圖清理不做全路網交叉比較', () => {
  let osmIdReads = 0
  const roads = Array.from({ length: 200 }, (_, index) => {
    const properties = {
      nodes: [index * 2, index * 2 + 1],
      deleted: false,
      get osm_id() {
        osmIdReads += 1
        return index
      },
    }
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[index, 0], [index, 1]] },
      properties,
    }
  })

  assert.equal(roadsForRendering(roads).length, roads.length)
  assert.ok(osmIdReads < roads.length * 10, `osm_id 被讀取 ${osmIdReads} 次，仍像是全路網平方級比較`)
})
