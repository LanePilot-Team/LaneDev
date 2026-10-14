export type NavigationPosition = [number, number]

const COORDINATE_QUERY = /^\s*(?:地圖選取位置\s*[·•:：]\s*)?([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*[,，]\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/

/** Parse a coordinate pair and normalize it to the app's [longitude, latitude] order. */
export function parseCoordinateQuery(input: string): NavigationPosition | null {
  const match = COORDINATE_QUERY.exec(input)
  if (!match) return null
  const first = Number(match[1])
  const second = Number(match[2])
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null

  if (Math.abs(first) <= 90 && Math.abs(second) > 90 && Math.abs(second) <= 180) {
    return [second, first]
  }
  if (Math.abs(first) > 90 && Math.abs(first) <= 180 && Math.abs(second) <= 90) {
    return [first, second]
  }
  if (Math.abs(first) <= 90 && Math.abs(second) <= 90) {
    return [second, first]
  }
  return null
}
