import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { RoadGraph } from './graph.ts'
import { runtimeReviver } from './runtimeCodec.ts'
import { addNanzihConnections } from './nanzihConnections.ts'

const root = new URL('../../../app/src/main/assets/public/data/runtime/', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)))
const nav = JSON.parse(fs.readFileSync(new URL(manifest.navigation.file, root)), runtimeReviver)
const originalRoads = nav.roads.filter(r => r.properties.osm_id !== -98765)

test('confirmed scooter connector closes the gap without altering source roads', () => {
  const roads = addNanzihConnections(originalRoads)
  assert.equal(roads.length, originalRoads.length + 1)
  const graph = new RoadGraph(roads)
  const start = [120.3253565, 22.7194044], end = [120.32437, 22.727035]
  const route = graph.routeDetailed(start, end, 'moto', {}, undefined, 'area', 'area').route
  assert.ok(route)
  assert.ok(route.spans.some(s => s.road?.properties.osm_id === -98765))
  assert.ok(route.lengthM > 1100 && route.lengthM < 1200)
  const car = graph.routeDetailed(start, end, 'car', {}, undefined, 'area', 'area').route
  assert.ok(car)
  assert.ok(!car.spans.some(s => s.road?.properties.osm_id === -98765))
  assert.ok(!originalRoads.some(r => r.properties.osm_id === -98765))
})
