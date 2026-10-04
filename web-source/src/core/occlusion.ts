import { BuildingOcclusion } from './buildingOcclusion'
import { activeElevatedLayer } from './elevated3d'
import type { Map as MLMap } from 'maplibre-gl'

export class NavigationOcclusion extends BuildingOcclusion {
  private lastRoadUpdate = -Infinity
  /** Read MapLibre's typed transform in one adapter. It includes pitch, zoom,
   * padding and target elevation, unlike fixed-distance vehicle probes. */
  updateCamera(map: MLMap, force = false) {
    if (map.getZoom() < 14) { super.clear(); return }
    const eye = map.transform.getCameraLngLat()
    const target = map.getCenter()
    this.updateView({ eye: [eye.lng, eye.lat], altitude: map.transform.getCameraAltitude(),
      target: [target.lng, target.lat], targetAltitude: map.getCameraTargetElevation() }, force)
  }
  update(pos: [number, number], _bearing: number, elevM = 0) {
    const now = performance.now()
    if (now - this.lastRoadUpdate < 120) return
    this.lastRoadUpdate = now
    activeElevatedLayer()?.setOcclusionAt(pos, elevM)
  }
  override clear() {
    this.lastRoadUpdate = -Infinity
    super.clear()
    activeElevatedLayer()?.setOcclusionFade(false)
  }
}

let active: NavigationOcclusion | null = null
export const setActiveNavigationOcclusion = (v: NavigationOcclusion | null) => { active = v }
export const activeNavigationOcclusion = () => active
