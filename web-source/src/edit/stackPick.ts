import type { Map as MLMap, MapGeoJSONFeature, Point } from 'maplibre-gl'
import type { RoadFeature } from '../core/roads'
import { haversine } from '../core/geo.ts'

const NEAR_PX = 4
export const CYCLE_PX = 8
// Underground roads only exist in tunnel-surface at lane-edit zoom.
// Elevated roads remain in the Three.js layer and are intentionally unchanged here.
const PICK_LAYERS = ['tunnel-surface', 'road-surface', 'roads-simple']

export interface StackPick {
  key: string
  osmId: number
  blockNode: number
  name: string
  detail: string
}

export const stackKeyOf = (osmId: number, blockNode: number) =>
  `way/${osmId}@b/${blockNode}`

export interface StackCursor {
  x: number
  y: number
  keys: string
  index: number
}

export const EMPTY_CURSOR: StackCursor = { x: -1e9, y: -1e9, keys: '', index: 0 }

export function nextStackIndex(
  prev: StackCursor,
  x: number,
  y: number,
  keys: string,
  count: number,
  ctrl: boolean,
): number {
  if (count <= 0) return 0
  const samePlace = keys === prev.keys
    && Math.abs(x - prev.x) <= CYCLE_PX
    && Math.abs(y - prev.y) <= CYCLE_PX
  if (!samePlace) return 0
  return ctrl ? Math.min(prev.index, count - 1) : (prev.index + 1) % count
}

const HIGHWAY_LABEL: Record<string, string> = {
  motorway: '高速', trunk: '快速', primary: '主要', secondary: '次要', tertiary: '聯絡',
  unclassified: '未分級', residential: '住宅', living_street: '生活', service: '服務／側車道',
  pedestrian: '行人', track: '產業', footway: '人行', cycleway: '自行車', busway: '公車',
}

export function highwayLabel(highway: string): string {
  const base = highway.replace(/_link$/, '')
  const zh = HIGHWAY_LABEL[base] ?? base
  return highway.endsWith('_link') ? `${zh}匝道` : zh
}

export function describeStackRoad(road: RoadFeature): StackPick {
  const p = road.properties
  const coordinates = road.geometry.coordinates as [number, number][]
  const lengthM = coordinates.slice(1).reduce(
    (sum, coordinate, index) => sum + haversine(coordinates[index], coordinate),
    0,
  )
  const lanes = p.oneway === 'yes'
    ? `${p.lanesForward}車道單行`
    : `${p.lanesForward}+${p.lanesBackward}車道`
  return {
    key: stackKeyOf(p.osm_id, p.blockNode),
    osmId: p.osm_id,
    blockNode: p.blockNode,
    name: p.name ?? '（未命名道路）',
    detail: `${highwayLabel(p.highway)}·${lanes}·${Math.round(lengthM)}m`,
  }
}

export function collectStackedRoads(
  map: MLMap,
  point: Point,
  roads: RoadFeature[],
): RoadFeature[] {
  const byKey = new Map<string, RoadFeature>()
  for (const road of roads) {
    byKey.set(stackKeyOf(road.properties.osm_id, road.properties.blockNode), road)
  }
  const layers = PICK_LAYERS.filter((id) => map.getLayer(id))
  if (layers.length === 0) return []

  const result: RoadFeature[] = []
  const seen = new Set<string>()
  const take = (hits: MapGeoJSONFeature[]) => {
    for (const feature of hits) {
      const key = stackKeyOf(
        Number(feature.properties.osm_id),
        Number(feature.properties.blockNode),
      )
      if (seen.has(key)) continue
      const road = byKey.get(key)
      if (!road) continue
      seen.add(key)
      result.push(road)
    }
  }
  take(map.queryRenderedFeatures(point, { layers }))
  take(map.queryRenderedFeatures(
    [[point.x - NEAR_PX, point.y - NEAR_PX], [point.x + NEAR_PX, point.y + NEAR_PX]],
    { layers },
  ))
  return result
}
