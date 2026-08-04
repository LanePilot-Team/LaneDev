import test from 'node:test'
import assert from 'node:assert/strict'
import { groundMarkingPolygons } from './groundMarkings.ts'
import { haversine } from './geo.ts'

const line = (coordinates, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates },
})

test('直線地面標線以最小窄帶多邊形維持公尺寬度', () => {
  const input = {
    type: 'FeatureCollection',
    features: [line([[120, 22.73], [120.001, 22.73]], { kind: 'lane' })],
  }

  const output = groundMarkingPolygons(input, () => 0.3)
  const polygon = output.features[0]

  assert.equal(polygon.geometry.type, 'Polygon')
  assert.equal(polygon.geometry.coordinates[0].length, 5, '直線只需四個角與閉合點，不產生圓帽額外頂點')
  assert.equal(polygon.properties.kind, 'lane')
  assert.equal(polygon.properties.groundMarking, true)
  const ring = polygon.geometry.coordinates[0]
  assert.ok(Math.abs(haversine(ring[0], ring[3]) - 0.3) < 0.01)
})

test('虛線仍以每十公尺四公尺實線切段', () => {
  const input = {
    type: 'FeatureCollection',
    features: [line([[120, 22.73], [120, 22.73023]])],
  }

  const output = groundMarkingPolygons(input, () => 0.15, () => true)

  assert.equal(output.features.length, 3)
  assert.ok(output.features.every((feature) => feature.geometry.type === 'Polygon'))
})

test('非線段圖徵原樣保留', () => {
  const polygon = {
    type: 'Feature',
    properties: { kind: 'area' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[120, 22.73], [120.001, 22.73], [120, 22.731], [120, 22.73]]],
    },
  }

  const output = groundMarkingPolygons({ type: 'FeatureCollection', features: [polygon] }, () => 0.3)

  assert.equal(output.features[0], polygon)
})
