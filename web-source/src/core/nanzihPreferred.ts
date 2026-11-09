import data from './nanzihRouteData.json' with { type: 'json' }
import { haversine } from './geo.ts'
import type { LaneRoutePolicy, Profile, ReferenceRoadPath, RoadGraph, RouteResult } from './graph.ts'

const anchors: Record<string, [number, number]> = {
  north: [120.321029, 22.72933], station: [120.32437, 22.727035],
  east: [120.3290217, 22.7236493], south: [120.3253565, 22.7194044],
  west: [120.3166, 22.72246],
}
const routes = data.routes as unknown as Record<string, ReferenceRoadPath>

function nearestAnchor(position: [number, number]): string | null {
  const sorted = Object.entries(anchors).map(([id, point]) => ({ id, distance: haversine(position, point) }))
    .sort((a, b) => a.distance - b.distance)
  return sorted[0].distance <= 30 ? sorted[0].id : null
}

/** The website defines 35 directed combinations; other locations retain normal routing. */
export function nanzihPreferredRoute(
  graph: RoadGraph, from: [number, number], to: [number, number], profile: Profile, policy: LaneRoutePolicy = {},
): { matched: boolean; route: RouteResult | null } {
  const start = nearestAnchor(from), end = nearestAnchor(to)
  const path = start && end ? routes[`${start}-${end}:${profile}`] : undefined
  return path ? { matched: true, route: graph.routeFromReference(path, profile, policy) } : { matched: false, route: null }
}
