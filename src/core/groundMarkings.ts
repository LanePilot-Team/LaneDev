import type {
  Feature, FeatureCollection, GeoJsonProperties, Geometry, LineString, MultiPolygon, Polygon,
} from 'geojson'
import { cumulative, haversine, pointAlong } from './geo'

type GroundGeometry = Geometry | Polygon | MultiPolygon

function markingStrip(coords: [number, number][], widthM: number): Polygon | null {
  const points = coords.filter((coord, index) =>
    index === 0 || haversine(coords[index - 1], coord) > 0.001)
  if (points.length < 2) return null

  const normals: [number, number][] = []
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    const meanLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180
    const dx = (b[0] - a[0]) * 111320 * Math.cos(meanLatRad)
    const dy = (b[1] - a[1]) * 110540
    const length = Math.hypot(dx, dy)
    normals.push([-dy / length, dx / length])
  }

  const halfWidth = widthM / 2
  const offsets = points.map((_, index): [number, number] => {
    if (index === 0) return [normals[0][0] * halfWidth, normals[0][1] * halfWidth]
    if (index === points.length - 1) {
      const normal = normals[normals.length - 1]
      return [normal[0] * halfWidth, normal[1] * halfWidth]
    }
    const before = normals[index - 1]
    const after = normals[index]
    const sumLength = Math.hypot(before[0] + after[0], before[1] + after[1])
    if (sumLength < 0.001) return [after[0] * halfWidth, after[1] * halfWidth]
    const miter: [number, number] = [
      (before[0] + after[0]) / sumLength,
      (before[1] + after[1]) / sumLength,
    ]
    const projection = Math.abs(miter[0] * after[0] + miter[1] * after[1])
    const distance = Math.min(halfWidth / Math.max(projection, 0.25), halfWidth * 4)
    return [miter[0] * distance, miter[1] * distance]
  })

  const offsetPoint = (point: [number, number], offset: [number, number]): [number, number] => {
    const lonMeters = 111320 * Math.cos(point[1] * Math.PI / 180)
    return [point[0] + offset[0] / lonMeters, point[1] + offset[1] / 110540]
  }
  const left = points.map((point, index) => offsetPoint(point, offsets[index]))
  const right = points.map((point, index) =>
    offsetPoint(point, [-offsets[index][0], -offsets[index][1]] as [number, number]))
  const ring = [...left, ...right.reverse(), left[0]]
  return { type: 'Polygon', coordinates: [ring] }
}

function sliceLine(
  coords: [number, number][], cum: number[], fromM: number, toM: number,
): [number, number][] | null {
  if (toM <= fromM) return null
  const out: [number, number][] = [pointAlong(coords, cum, fromM).pos]
  for (let i = 1; i < coords.length - 1; i++) {
    if (cum[i] > fromM && cum[i] < toM) out.push(coords[i])
  }
  out.push(pointAlong(coords, cum, toM).pos)
  return out.length >= 2 ? out : null
}

/**
 * 將 MapLibre 螢幕像素寬的 LineString 轉為貼地、具有實際公尺寬的 Polygon。
 * fill 幾何會隨地面透視自然縮放，低俯角時靠近鏡頭不再膨脹。
 * lane 虛線使用 4m 實線／6m 間隔切成實際地面片段。
 */
export function groundMarkingPolygons(
  fc: FeatureCollection,
  widthM: (properties: GeoJsonProperties) => number | null,
  dashed: (properties: GeoJsonProperties) => boolean = () => false,
): FeatureCollection<GroundGeometry> {
  const features: Feature<GroundGeometry>[] = []
  for (const feature of fc.features) {
    if (!feature.geometry || feature.geometry.type !== 'LineString') {
      features.push(feature as Feature<GroundGeometry>)
      continue
    }
    const width = widthM(feature.properties)
    if (width === null || width <= 0) {
      features.push(feature as Feature<GroundGeometry>)
      continue
    }
    const coords = feature.geometry.coordinates as [number, number][]
    if (coords.length < 2) continue
    const cum = cumulative(coords)
    const lengthM = cum[cum.length - 1]
    const runs: [number, number][][] = []
    if (dashed(feature.properties)) {
      for (let fromM = 0; fromM < lengthM; fromM += 10) {
        const run = sliceLine(coords, cum, fromM, Math.min(lengthM, fromM + 4))
        if (run) runs.push(run)
      }
    } else {
      runs.push(coords)
    }
    for (const run of runs) {
      const polygon = markingStrip(run, width)
      if (!polygon) continue
      features.push({
        type: 'Feature',
        properties: { ...feature.properties, groundMarking: true },
        geometry: polygon,
      })
    }
  }
  return { type: 'FeatureCollection', features }
}
