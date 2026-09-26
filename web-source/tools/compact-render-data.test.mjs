import test from 'node:test'
import assert from 'node:assert/strict'
import { compactRenderData, renderPropertyKeys } from './compact-render-data.mjs'
import { runtimeReplacer, runtimeReviver } from '../src/core/runtimeCodec.ts'

test('render compaction preserves corners, holes, feature count and required properties', () => {
  const keys = renderPropertyKeys({ layers: [{ paint: { color: ['get', 'color'] } }] })
  const ring = [[0,0], [1,0], [2,0], [2,2], [0,2], [0,0]]
  const hole = [[0.5,0.5], [0.5,1], [1,1], [1,0.5], [0.5,0.5]]
  const data = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1,
    properties: { color: 'red', name: 'road', sourceSegments: [1,2,3] },
    geometry: { type: 'Polygon', coordinates: [ring, hole] } }] }
  const compact = compactRenderData(data, keys)
  assert.equal(compact.features.length, 1)
  assert.equal(compact.features[0].id, 1)
  assert.deepEqual(compact.features[0].geometry.coordinates[0], [[0,0], [2,0], [2,2], [0,2], [0,0]])
  assert.deepEqual(compact.features[0].geometry.coordinates[1], hole)
  assert.deepEqual(compact.features[0].properties, { color:'red', name:'road' })
  assert.equal(data.features[0].geometry.coordinates[0].length, 6)
})

test('runtime codec restores nested movement-policy maps and sets', () => {
  const value = { rules: new Map([['a', new Map([[7, new Set(['left'])]])]]) }
  assert.deepEqual(JSON.parse(JSON.stringify(value, runtimeReplacer), runtimeReviver), value)
})
