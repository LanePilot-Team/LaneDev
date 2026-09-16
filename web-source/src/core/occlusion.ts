import { booleanPointInPolygon, destination, point } from '@turf/turf'
import type { Feature, Polygon } from 'geojson'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'
import { activeElevatedLayer } from './elevated3d'

type Building = Feature<Polygon, {
  osm_id?: number
  building?: string
  min_height_m?: number
}>

type IndexedBuilding = {
  feature: Building
  id: string | number
  bbox: [number, number, number, number]
}

const bboxOf = (f: Building): [number, number, number, number] => {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const ring of f.geometry.coordinates) for (const [lng, lat] of ring) {
    west = Math.min(west, lng); south = Math.min(south, lat)
    east = Math.max(east, lng); north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

const insideBox = (p: [number, number], b: IndexedBuilding['bbox']) =>
  p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]

/** 導航遮擋管理：建築以 feature-state 淡出；Three.js 高架由 ElevatedLayer 處理。 */
export class NavigationOcclusion {
  private indexed: IndexedBuilding[]
  private faded = new Set<string | number>()
  private lastUpdate = 0

  constructor(private map: MLMap, buildings: Building[]) {
    this.indexed = buildings
      .filter((f) => f.geometry?.type === 'Polygon' && f.id !== undefined)
      .map((feature) => ({ feature, id: feature.id!, bbox: bboxOf(feature) }))
  }

  private publish(next: Set<string | number>) {
    const visible: Building[] = []
    const occluded: Building[] = []
    for (const b of this.indexed) (next.has(b.id) ? occluded : visible).push(b.feature)
    const fc = (features: Building[]) => ({ type: 'FeatureCollection' as const, features })
    ;(this.map.getSource('buildings') as GeoJSONSource).setData(fc(visible) as never)
    ;(this.map.getSource('occludedBuildings') as GeoJSONSource).setData(fc(occluded) as never)
  }

  update(pos: [number, number], bearing: number, elevM = 0) {
    const now = performance.now()
    if (now - this.lastUpdate < 120) return
    this.lastUpdate = now
    // 後方涵蓋傾斜鏡頭到車輛的視線，前方涵蓋下一段導航路況。
    const probes = [-45, -25, -10, 0, 12, 28, 48, 70].map((m) => {
      if (m === 0) return pos
      const p = destination(point(pos), Math.abs(m) / 1000, m < 0 ? bearing + 180 : bearing)
      return p.geometry.coordinates as [number, number]
    })
    const next = new Set<string | number>()
    for (const b of this.indexed) {
      // 一般建築只在視線走廊實際穿過 footprint 時淡出；架空站體也適用。
      if (probes.some((p) => insideBox(p, b.bbox) && booleanPointInPolygon(point(p), b.feature))) {
        next.add(b.id)
      }
    }
    const changed = next.size !== this.faded.size ||
      [...next].some((id) => !this.faded.has(id))
    if (changed) this.publish(next)
    this.faded = next
    activeElevatedLayer()?.setOcclusionAt(pos, elevM)
  }

  clear() {
    if (this.faded.size) this.publish(new Set())
    this.faded.clear()
    activeElevatedLayer()?.setOcclusionFade(false)
  }
}

let active: NavigationOcclusion | null = null
export const setActiveNavigationOcclusion = (v: NavigationOcclusion | null) => { active = v }
export const activeNavigationOcclusion = () => active
