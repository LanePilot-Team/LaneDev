import type { Stop } from '../plan/placeRoute.ts'
import type { RouteResult } from '../core/graph.ts'
import { haversine, pointAlong } from '../core/geo.ts'

const VIA_VISIT_RADIUS_M = 35

/** A matching fix still has to agree with the physical position of the next stop. */
export function advanceViaStops(
  route: Pick<RouteResult, 'viaDistM' | 'coords' | 'cum'>,
  visited: number,
  traveledM: number,
  position: [number, number],
): number {
  const via = route.viaDistM ?? []
  for (; visited < via.length; visited++) {
    if (Math.abs(via[visited] - traveledM) > VIA_VISIT_RADIUS_M) break
    const stop = pointAlong(route.coords, route.cum, via[visited]).pos
    if (haversine(position, stop) > VIA_VISIT_RADIUS_M) break
  }
  return visited
}

/** Count and targets belong to the same installed route. */
export function pendingRouteTargets(targets: Stop[], visited: number): Stop[] {
  return targets.slice(Math.min(visited, Math.max(0, targets.length - 1))).filter(stop => stop.pos !== null)
}
