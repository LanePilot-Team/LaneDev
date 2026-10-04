import test from 'node:test'
import assert from 'node:assert/strict'
import { BuildingOcclusion, blocksView } from './buildingOcclusion.ts'

const building = (id, x, y) => ({ type: 'Feature', id, properties: {},
  geometry: { type: 'Polygon', coordinates: [[[x-0.0001,y-0.0001], [x+0.0001,y-0.0001],
    [x+0.0001,y+0.0001], [x-0.0001,y+0.0001], [x-0.0001,y-0.0001]]] } })

test('occlusion publishes only changed IDs and clear restores them without setData', () => {
  const calls = []
  const map = { getSource: id => ({ updateData: diff => calls.push({ id, diff }) }) }
  const occlusion = new BuildingOcclusion(map, [building('near',120.3,22.7), building('far',121,24)])
  occlusion.lastUpdate = -Infinity
  occlusion.updateView({eye: [120.3,22.7], altitude: 30, target: [120.3,22.7], targetAltitude: 0})
  assert.deepEqual(calls[0].diff.remove, ['near'])
  assert.equal(calls[1].diff.add[0].id, 'near')
  occlusion.lastUpdate = -Infinity
  occlusion.updateView({eye: [120.3,22.7], altitude: 30, target: [120.3,22.7], targetAltitude: 0})
  assert.equal(calls.length, 2)
  occlusion.clear()
  assert.equal(calls[2].diff.add[0].id, 'near')
  assert.deepEqual(calls[3].diff.remove, ['near'])
  assert.equal(JSON.stringify(calls).includes('far'), false)
})

test('rejects duplicate building IDs required by MapLibre incremental updates', () => {
  assert.throws(() => new BuildingOcclusion({}, [building(1,0,0), building(1,1,1)]), /唯一/)
})

test('camera line detects thin buildings between former probe points and restores after passing', () => {
  const feature = building('thin', 120.3, 22.7)
  const ray = {eye: [120.299,22.7], altitude: 8, target: [120.301,22.7], targetAltitude: 0}
  assert.equal(blocksView(feature, ray), true)
  assert.equal(blocksView(feature, {...ray, eye: [120.3005,22.7]}), false)
  assert.equal(blocksView(feature, {...ray, altitude: 100}), false)
  const calls = []
  const occlusion = new BuildingOcclusion({getSource: id => ({updateData: diff => calls.push({id,diff})})}, [feature])
  occlusion.updateView(ray, true)
  occlusion.updateView({...ray, eye: [120.3005,22.7]}, true)
  assert.deepEqual(calls[2].diff.add.map(f => f.id), ['thin'])
})

test('respects elevated building bases, multi-polygons and courtyard holes', () => {
  const feature = building('station', 120.3, 22.7)
  feature.properties = {min_height_m: 10, height_m: 30}
  const ray = {eye: [120.299,22.7], altitude: 8, target: [120.301,22.7], targetAltitude: 0}
  assert.equal(blocksView(feature, ray), false)
  assert.equal(blocksView(feature, {...ray, altitude: 30}), true)
  const multi = {...feature, geometry: {type: 'MultiPolygon', coordinates: [feature.geometry.coordinates]}}
  assert.equal(blocksView(multi, {...ray, altitude: 30}), true)
  feature.properties = {height_m: 30}
  feature.geometry.coordinates.push(building('hole',120.3,22.7).geometry.coordinates[0].map(([x,y]) => [120.3+(x-120.3)*0.5,22.7+(y-22.7)*0.5]))
  assert.equal(blocksView(feature, {eye:[120.3,22.7],altitude:50,target:[120.3,22.7],targetAltitude:0}), false)
})
