import test from 'node:test'
import assert from 'node:assert/strict'
import { BuildingOcclusion } from './buildingOcclusion.ts'

const building = (id, x, y) => ({ type: 'Feature', id, properties: {},
  geometry: { type: 'Polygon', coordinates: [[[x-0.0001,y-0.0001], [x+0.0001,y-0.0001],
    [x+0.0001,y+0.0001], [x-0.0001,y+0.0001], [x-0.0001,y-0.0001]]] } })

test('occlusion publishes only changed IDs and clear restores them without setData', () => {
  const calls = []
  const map = { getSource: id => ({ updateData: diff => calls.push({ id, diff }) }) }
  const occlusion = new BuildingOcclusion(map, [building('near',120.3,22.7), building('far',121,24)])
  occlusion.lastUpdate = -Infinity
  occlusion.update([120.3,22.7],0)
  assert.deepEqual(calls[0].diff.remove, ['near'])
  assert.equal(calls[1].diff.add[0].id, 'near')
  occlusion.lastUpdate = -Infinity
  occlusion.update([120.3,22.7],0)
  assert.equal(calls.length, 2)
  occlusion.clear()
  assert.equal(calls[2].diff.add[0].id, 'near')
  assert.deepEqual(calls[3].diff.remove, ['near'])
  assert.equal(JSON.stringify(calls).includes('far'), false)
})

test('rejects duplicate building IDs required by MapLibre incremental updates', () => {
  assert.throws(() => new BuildingOcclusion({}, [building(1,0,0), building(1,1,1)]), /唯一/)
})
