import { booleanIntersects, booleanPointInPolygon, lineString, point } from '@turf/turf'
import type { Feature, Polygon, MultiPolygon } from 'geojson'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'

type Building = Feature<Polygon | MultiPolygon, {
  osm_id?: number
  building?: string
  min_height_m?: number
  height_m?: number
}>

type IndexedBuilding = {
  feature: Building
  id: string | number
  bbox: [number, number, number, number]
}

const bboxOf = (f: Building): [number, number, number, number] => {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  for (const polygon of polygons) for (const ring of polygon) for (const [lng, lat] of ring) {
    west = Math.min(west, lng); south = Math.min(south, lat)
    east = Math.max(east, lng); north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

export type ViewRay = { eye: [number, number]; altitude: number; target: [number, number]; targetAltitude: number }

/** Clip the sight line to the extrusion's height interval before testing its
 * footprint. Continuous intersection also catches thin buildings and holes. */
export function blocksView(feature: Building, ray: ViewRay): boolean {
  const base = Number(feature.properties?.min_height_m ?? 0)
  const roof = Number(feature.properties?.height_m ?? 9)
  if (!Number.isFinite(base) || !Number.isFinite(roof) || roof <= base) return false
  const dz = ray.targetAltitude - ray.altitude
  let from = 0, to = 1
  if (Math.abs(dz) < 0.001) {
    if (ray.altitude < base || ray.altitude > roof) return false
  } else {
    const a = (base - ray.altitude) / dz, b = (roof - ray.altitude) / dz
    from = Math.max(0, Math.min(a, b)); to = Math.min(1, Math.max(a, b))
    if (from > to) return false
  }
  const at = (t: number): [number, number] => [
    ray.eye[0] + (ray.target[0] - ray.eye[0]) * t,
    ray.eye[1] + (ray.target[1] - ray.eye[1]) * t,
  ]
  const a = at(from), b = at(to)
  return a[0] === b[0] && a[1] === b[1]
    ? booleanPointInPolygon(point(a), feature)
    : booleanIntersects(lineString([a, b]), feature)
}

/** Local grid query + source diffs; opacity stays on the two supported layers. */
export class BuildingOcclusion {
  private byId = new Map<string | number, IndexedBuilding>()
  private cells = new Map<string, IndexedBuilding[]>()
  private faded = new Set<string | number>()
  private lastUpdate = 0

  private map: Pick<MLMap, 'getSource'>
  constructor(map: Pick<MLMap, 'getSource'>, buildings: Building[]) {
    this.map = map
    const indexed = buildings
      .filter((f) => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type) && f.id !== undefined)
      .map((feature) => ({ feature, id: feature.id!, bbox: bboxOf(feature) }))
    for (const b of indexed) {
      if (this.byId.has(b.id)) throw new Error('建築來源必須有唯一 ID')
      this.byId.set(b.id, b)
      for (let x = Math.floor(b.bbox[0] / 0.002); x <= Math.floor(b.bbox[2] / 0.002); x++) {
        for (let y = Math.floor(b.bbox[1] / 0.002); y <= Math.floor(b.bbox[3] / 0.002); y++) {
          const key = `${x}:${y}`
          if (!this.cells.has(key)) this.cells.set(key, [])
          this.cells.get(key)!.push(b)
        }
      }
    }
  }

  private publish(next: Set<string | number>) {
    const hide = [...next].filter(id => !this.faded.has(id))
    const show = [...this.faded].filter(id => !next.has(id))
    ;(this.map.getSource('buildings') as GeoJSONSource).updateData({
      remove: hide, add: show.map(id => this.byId.get(id)!.feature),
    })
    ;(this.map.getSource('occludedBuildings') as GeoJSONSource).updateData({
      remove: show, add: hide.map(id => this.byId.get(id)!.feature),
    })
  }

  updateView(ray: ViewRay, force = false) {
    const now = performance.now()
    if (!force && now - this.lastUpdate < 120) return false
    this.lastUpdate = now
    if (![...ray.eye, ...ray.target, ray.altitude, ray.targetAltitude].every(Number.isFinite)) return false
    const next = new Set<string | number>()
    const nearby = new Set<IndexedBuilding>()
    const west = Math.min(ray.eye[0], ray.target[0]), east = Math.max(ray.eye[0], ray.target[0])
    const south = Math.min(ray.eye[1], ray.target[1]), north = Math.max(ray.eye[1], ray.target[1])
    for (let x = Math.floor(west / 0.002); x <= Math.floor(east / 0.002); x++) {
      for (let y = Math.floor(south / 0.002); y <= Math.floor(north / 0.002); y++) {
        for (const b of this.cells.get(`${x}:${y}`) ?? []) nearby.add(b)
      }
    }
    for (const b of nearby) {
      if (b.bbox[2] >= west && b.bbox[0] <= east && b.bbox[3] >= south && b.bbox[1] <= north && blocksView(b.feature, ray)) {
        next.add(b.id)
      }
    }
    const changed = next.size !== this.faded.size ||
      [...next].some((id) => !this.faded.has(id))
    if (changed) this.publish(next)
    this.faded = next
    return true
  }

  clear() {
    if (this.faded.size) this.publish(new Set())
    this.faded.clear()
  }
}
