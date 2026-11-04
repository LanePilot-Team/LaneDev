// 常用地點（住家／學校／公司）：使用者自己的偏好，只存本機 localStorage，不進道路資料或 journal。
// 設定面板負責編輯；搜尋欄點開時以可左右滑動的捷徑列顯示。
import { useSyncExternalStore } from 'react'
import type { PlaceRecord } from './places.ts'

export type SavedPlaceKind = 'home' | 'school' | 'work'

export interface SavedPlace {
  kind: SavedPlaceKind
  /** 對應的地標名稱（可空）；捷徑與目的地卡優先顯示類別名稱 */
  name?: string
  address: string
  position: [number, number]
}

export const SAVED_PLACE_KINDS: SavedPlaceKind[] = ['home', 'school', 'work']
export const SAVED_PLACE_META: Record<SavedPlaceKind, { label: string; icon: string }> = {
  home: { label: '住家', icon: '🏠' },
  school: { label: '學校', icon: '🎓' },
  work: { label: '公司', icon: '💼' },
}

// 預設值：大學二十一路566號（使用者提供座標）、
// 資訊工程學系（OSM node/7921962225）、建楠路236號（依同側 184/206 號門牌座標內插估計）。
const DEFAULTS: Record<SavedPlaceKind, SavedPlace> = {
  home: { kind: 'home', address: '811高雄市楠梓區大學二十一路566號', position: [120.28208, 22.7275] },
  school: { kind: 'school', name: '資訊工程學系', address: '811高雄市楠梓區高雄大學路700號（國立高雄大學）', position: [120.2762767, 22.7326883] },
  work: { kind: 'work', address: '高雄市楠梓區惠楠里建楠路236號5樓', position: [120.32496, 22.72717] },
}

const STORAGE_KEY = 'client.savedPlaces'

function validPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n))
}

function load(): Record<SavedPlaceKind, SavedPlace> {
  const result = { ...DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Partial<SavedPlace>>
    for (const kind of SAVED_PLACE_KINDS) {
      const item = raw[kind]
      if (item && validPosition(item.position)) {
        result[kind] = { kind, name: item.name || undefined, address: String(item.address ?? ''), position: item.position }
      }
    }
  } catch { /* 偏好設定壞掉就用預設 */ }
  return result
}

let state = {
  places: load(),
  /** 正在「於地圖上標記」的類別；App 的地圖點擊會優先交給它 */
  picking: null as SavedPlaceKind | null,
}
const listeners = new Set<() => void>()
function publish(patch: Partial<typeof state>) {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
}
function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function savedPlacesState() { return state }
export function useSavedPlaces() {
  return useSyncExternalStore(subscribe, savedPlacesState)
}

export function setSavedPlace(place: SavedPlace) {
  publish({ places: { ...state.places, [place.kind]: place } })
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.places)) } catch { /* preference only */ }
}
export function resetSavedPlace(kind: SavedPlaceKind) {
  setSavedPlace(DEFAULTS[kind])
}
export function startSavedPlacePick(kind: SavedPlaceKind) { publish({ picking: kind }) }
export function cancelSavedPlacePick() { publish({ picking: null }) }

/** 轉成搜尋／規劃流程可直接使用的地標紀錄（id 以 saved: 開頭，不會和 OSM/TDX 撞） */
export function savedPlaceRecord(place: SavedPlace): PlaceRecord {
  const meta = SAVED_PLACE_META[place.kind]
  return {
    id: `saved:${place.kind}`,
    source: 'osm',
    sourceId: `saved/${place.kind}`,
    name: place.name ? `${meta.label}・${place.name}` : meta.label,
    aliases: [],
    category: 'other',
    position: place.position,
    address: place.address || undefined,
    fetchedAt: '',
  }
}
