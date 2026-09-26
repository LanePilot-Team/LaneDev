import { BuildingOcclusion } from './buildingOcclusion'
import { activeElevatedLayer } from './elevated3d'

export class NavigationOcclusion extends BuildingOcclusion {
  override update(pos: [number, number], bearing: number, elevM = 0) {
    const changed = super.update(pos, bearing, elevM)
    if (changed) activeElevatedLayer()?.setOcclusionAt(pos, elevM)
    return changed
  }
  override clear() {
    super.clear()
    activeElevatedLayer()?.setOcclusionFade(false)
  }
}

let active: NavigationOcclusion | null = null
export const setActiveNavigationOcclusion = (v: NavigationOcclusion | null) => { active = v }
export const activeNavigationOcclusion = () => active
