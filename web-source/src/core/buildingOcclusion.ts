import { booleanPointInPolygon, destination, point } from '@turf/turf'
import type { Feature, Polygon } from 'geojson'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'

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
      .filter((f) => f.geometry?.type === 'Polygon' && f.id !== undefined)
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

  update(pos: [number, number], bearing: number, elevM = 0) {
    const now = performance.now()
    if (now - this.lastUpdate < 120) return false
    this.lastUpdate = now
    // 後方涵蓋傾斜鏡頭到車輛的視線，前方涵蓋下一段導航路況。
    const probes = [-45, -25, -10, 0, 12, 28, 48, 70].map((m) => {
      if (m === 0) return pos
      const p = destination(point(pos), Math.abs(m) / 1000, m < 0 ? bearing + 180 : bearing)
      return p.geometry.coordinates as [number, number]
    })
    const next = new Set<string | number>()
    const nearby = new Set<IndexedBuilding>()
    for (const p of probes) {
      const key = `${Math.floor(p[0] / 0.002)}:${Math.floor(p[1] / 0.002)}`
      for (const b of this.cells.get(key) ?? []) nearby.add(b)
    }
    for (const b of nearby) {
      // 一般建築只在視線走廊實際穿過 footprint 時淡出；架空站體也適用。
      if (probes.some((p) => insideBox(p, b.bbox) && booleanPointInPolygon(point(p), b.feature))) {
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

