import type { RoadFeature } from './roads.ts'
import { haversine } from './geo.ts'

/** Narrow, user-confirmed overrides for directions used by the route reference. */
export function applyNanzihAccessCorrections(roads: RoadFeature[]): void {
  for (const road of roads) {
    const p = road.properties
    if (p.osm_id === 313225089 && [2972429459, 1196965131].includes(p.blockNode)) p.motorcar = 'yes'
    const forward = (p.osm_id === 230216178 && p.blockNode === 4916071634)
      || (p.osm_id === 268219227 && p.blockNode === 2624297538)
    const backward = p.osm_id === 230216178 && p.blockNode === 2387445684
    if (!forward && !backward) continue
    const count = forward ? p.lanesForward : p.lanesBackward
    if (count < 1) throw new Error('楠梓通行修正缺少車道')
    const marks = [...(forward ? p.laneMarksF ?? [] : p.laneMarksB ?? [])]
    if (marks[count - 1]?.text.trim() === '禁行機車') marks[count - 1] = null
    const access = [...(forward ? p.motorcycleAccessByLaneF ?? [] : p.motorcycleAccessByLaneB ?? [])]
    access[count - 1] = 'yes'
    if (forward) {
      p.laneMarksF = marks; p.motorcycleAccessByLaneF = access
      p.rulesF = p.rulesF?.filter(rule => rule !== 'no_moto')
    } else {
      p.laneMarksB = marks; p.motorcycleAccessByLaneB = access
      p.rulesB = p.rulesB?.filter(rule => rule !== 'no_moto')
    }
  }
}

/** User-confirmed connection shown by the Nanzih route reference. */
export function addNanzihConnections(roads: RoadFeature[]): RoadFeature[] {
  if (roads.some(r => r.properties.osm_id === -98765)) return roads
  const incoming = roads.find(r => r.properties.osm_id === 776417983 && r.properties.nodes.at(-1) === 257742657)
  const outgoing = roads.find(r => r.properties.osm_id === 103678948 && r.properties.nodes[0] === 1196964843)
  if (!incoming || !outgoing) throw new Error('楠梓機車連接路段的來源道路不存在')
  const a = incoming.geometry.coordinates.at(-1) as [number, number]
  const b = outgoing.geometry.coordinates[0] as [number, number]
  if (haversine(a, b) > 25) throw new Error('楠梓機車連接路段長度異常')
  const connector: RoadFeature = {
    ...incoming,
    geometry: { type: 'LineString', coordinates: [a, b] },
    properties: {
      ...incoming.properties,
      osm_id: -98765,
      name: '',
      navSegmentKey: 'manual/nanzih-south-station-connector',
      nodes: [257742657, 1196964843],
      blockNode: 257742657,
      sourceSegments: [],
      laneMarksF: undefined,
      turnLanes: undefined,
      startTurnLanes: undefined,
      motoTurnLanesF: undefined,
      stopLineF: false,
      arrowDisplayF: false,
    },
  }
  return [...roads, connector]
}
