import type { RoadFeature } from './roads.ts'
import { haversine } from './geo.ts'

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
