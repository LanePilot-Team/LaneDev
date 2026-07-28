import { buffer, lineString } from '@turf/turf'
import type {
  Feature, FeatureCollection, GeoJsonProperties, Geometry, LineString, MultiPolygon, Polygon,
} from 'geojson'
import { cumulative, pointAlong } from './geo'

type GroundGeometry = Geometry | Polygon | MultiPolygon

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
      const polygon = buffer(lineString(run), width / 2, { units: 'meters', steps: 2 })
      if (!polygon) continue
      features.push({
        type: 'Feature',
        properties: { ...feature.properties, groundMarking: true },
        geometry: polygon.geometry,
      })
    }
  }
  return { type: 'FeatureCollection', features }
}
