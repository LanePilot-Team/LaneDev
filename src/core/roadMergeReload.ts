export const ROAD_MERGE_RELOAD_STATE_KEY = 'lanedev:road-merge-reload-state:v1'

export interface RoadMergeReloadState {
  camera: {
    center: [number, number]
    zoom: number
    bearing: number
    pitch: number
  }
  mode: 'edit'
  editTool: 'lane' | 'zone' | 'bay' | 'vehicle' | 'road'
  editRoad: unknown
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const validState = (value: unknown): value is RoadMergeReloadState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<RoadMergeReloadState>
  const camera = state.camera
  return state.mode === 'edit'
    && ['lane', 'zone', 'bay', 'vehicle', 'road'].includes(String(state.editTool))
    && !!camera
    && Array.isArray(camera.center)
    && camera.center.length === 2
    && finite(camera.center[0])
    && finite(camera.center[1])
    && finite(camera.zoom)
    && finite(camera.bearing)
    && finite(camera.pitch)
}

export function saveRoadMergeReloadState(
  storage: StorageLike,
  state: RoadMergeReloadState,
): boolean {
  try {
    storage.setItem(ROAD_MERGE_RELOAD_STATE_KEY, JSON.stringify(state))
    return true
  } catch (error) {
    console.warn('無法保存道路捏合重載狀態', error)
    return false
  }
}

export function consumeRoadMergeReloadState(
  storage: StorageLike,
): RoadMergeReloadState | null {
  let raw: string | null = null
  try {
    raw = storage.getItem(ROAD_MERGE_RELOAD_STATE_KEY)
    storage.removeItem(ROAD_MERGE_RELOAD_STATE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return validState(parsed) ? parsed : null
  } catch (error) {
    try { storage.removeItem(ROAD_MERGE_RELOAD_STATE_KEY) } catch { /* no-op */ }
    console.warn('忽略損壞的道路捏合重載狀態', error)
    return null
  }
}

