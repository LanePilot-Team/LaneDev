import type { Stop } from '../plan/placeRoute.ts'

/** viaDistM belongs to the installed route and is indexed by that route's targets. */
export function pendingRouteTargets(targets: Stop[], viaDistM: readonly number[], traveledM: number): Stop[] {
  return targets.filter((stop, i) => stop.pos !== null && (
    i === targets.length - 1 || viaDistM[i] === undefined || viaDistM[i] > traveledM + 1
  ))
}

export function passedAllViaStops(viaDistM: readonly number[] | undefined, traveledM: number): boolean {
  return viaDistM?.every(distance => distance <= traveledM + 1) ?? true
}
