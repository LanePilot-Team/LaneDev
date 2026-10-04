/** Use the planned route speed, not an instantaneous (possibly zero) GPS speed.
 * This is an offline estimate, without traffic or traffic-light predictions. */
export function remainingRouteSeconds(lengthM: number, timeS: number, remainM: number, arrived = false): number {
  if (arrived || remainM <= 0 || !Number.isFinite(remainM)) return 0
  const plannedSpeed = lengthM > 0 && timeS > 0 && Number.isFinite(lengthM) && Number.isFinite(timeS)
    ? lengthM / timeS : 30 / 3.6
  return remainM / plannedSpeed
}

export function arrivalTimestamp(now: number, remainingSeconds: number): number {
  return now + Math.max(0, Number.isFinite(remainingSeconds) ? remainingSeconds : 0) * 1000
}
