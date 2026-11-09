import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import data from './nanzihRouteData.json' with { type: 'json' }
import { RoadGraph, carAllowed, motoAllowed, laneBand } from './graph.ts'
import { haversine } from './geo.ts'
import { runtimeReviver } from './runtimeCodec.ts'
import { nanzihPreferredRoute } from './nanzihPreferred.ts'
import { applyNanzihAccessCorrections } from './nanzihConnections.ts'

const root = new URL('../../../app/src/main/assets/public/data/runtime/', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)))
const nav = JSON.parse(fs.readFileSync(new URL(manifest.navigation.file, root)), runtimeReviver)
const graph = RoadGraph.fromSnapshot(nav.graph, nav.roads)
const anchors = {
  north: [120.321029, 22.72933], station: [120.32437, 22.727035],
  east: [120.3290217, 22.7236493], south: [120.3253565, 22.7194044],
  west: [120.3166, 22.72246],
}

test('all 35 website cases reconstruct their exact directed path and visible lane band', () => {
  assert.equal(Object.keys(data.routes).length, 35)
  for (const [key, expected] of Object.entries(data.routes)) {
    const [pair, profile] = key.split(':')
    const [from, to] = pair.split('-')
    const result = nanzihPreferredRoute(graph, anchors[from], anchors[to], profile)
    assert.equal(result.matched, true, key)
    assert.ok(result.route, key)
    assert.deepEqual(result.route.coords, expected.coords, key)
    assert.deepEqual(laneBand(result.route), expected.band, key)
    assert.equal(result.route.spans.length, expected.spans.length, key)
    const snappedFrom = graph.snapToLane(anchors[from], profile)?.pos
    const snappedTo = graph.snapToLane(anchors[to], profile)?.pos
    assert.ok(snappedFrom && snappedTo, key)
    assert.ok(nanzihPreferredRoute(graph, snappedFrom, snappedTo, profile).matched, `${key}: snapped stops`)
    for (const maneuver of result.route.maneuvers.filter(m => m.kind !== 'arrive')) {
      assert.ok(maneuver.laneDecision?.allowed, `${key}: turn guidance`)
      if (maneuver.laneDecision.inferred) assert.equal(maneuver.laneGuidance?.source, 'inferred', key)
    }
    for (let i = 1; i < expected.band.coords.length; i++) {
      assert.ok(haversine(expected.band.coords[i - 1], expected.band.coords[i]) < 20, `${key}: missing segment`)
    }
  }
  assert.equal(nanzihPreferredRoute(graph, [120.5, 22.9], anchors.north, 'car').matched, false)
  assert.equal(nanzihPreferredRoute(graph, anchors.station, anchors.east, 'car').matched, false)
  const gap = data.routes['south-station:moto'].band.coords
  const near = [120.3239367, 22.7239161]
  assert.ok(Math.min(...gap.map(point => haversine(point, near))) < 5, 'route reaches the photographed location')
})

test('confirmed marking overrides apply only to the specified direction and blocks', () => {
  const roads = structuredClone(nav.roads)
  applyNanzihAccessCorrections(roads)
  for (const [id, block, back, profile] of [
    [313225089, 2972429459, false, 'car'], [313225089, 1196965131, false, 'car'],
    [230216178, 4916071634, false, 'moto'], [268219227, 2624297538, false, 'moto'],
    [230216178, 2387445684, true, 'moto'],
  ]) {
    const road = roads.find(r => r.properties.osm_id === id && r.properties.blockNode === block)
    assert.ok(road, `${id}@${block}`)
    assert.ok(profile === 'car' ? carAllowed(road, back) : motoAllowed(road, back), `${id}@${block}`)
  }
})
