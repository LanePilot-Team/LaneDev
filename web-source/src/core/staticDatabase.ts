import { asset } from './asset'
import type { EnhancementRecord } from './enhancements'
import type { Zone } from './zones'
export interface StaticEditorState {
  updated_at: string
  journal: EnhancementRecord[]
  waiting_zones: Zone[]
  deleted_waiting_zone_ids: string[]
}

export interface SegmentIdentity {
  osmId: number
  navSegmentKey: string
  splitIndex: number
  blockNode: number
}

export interface InternalMergeCarrier extends SegmentIdentity {
  /** 明確表示兩個畫面區塊屬於同一條攤平道路，只移除這筆來源內的分段節點。 */
  internalOnly: true
}

export interface StaticRoadDatabase {
  format: 'lanedev-static-road-database-v1'
  updated_at: string
  regions: { area_id: string; name: string }[]
  segments: Record<string, unknown>[]
  annotations: Record<string, unknown>[]
  editor: StaticEditorState
}


let database: StaticRoadDatabase | null = null;
export async function loadStaticRoadDatabase(): Promise<StaticRoadDatabase> {
  if (database) return database
  const response = await fetch(asset('/data/road_database.json'))
  if (!response.ok) throw new Error('無法載入道路資料')
  database = await response.json() as StaticRoadDatabase
  if (!Array.isArray(database.segments) || !database.segments.length) throw new Error('沒有可用道路')
  database.editor ??= { updated_at: '', journal: [], waiting_zones: [], deleted_waiting_zone_ids: [] }
  return database
}
export const staticSegments = () => database?.segments ?? []
export const staticAnnotations = (): readonly Record<string, unknown>[] => database?.annotations ?? []
export const staticJournal = () => structuredClone(database?.editor.journal ?? [])
export const staticZones = () => structuredClone(database?.editor.waiting_zones ?? [])
export const staticDeletedZoneIds = () => [...(database?.editor.deleted_waiting_zone_ids ?? [])]
export const hasStaticRoadDatabase = () => database !== null

// Compatibility signatures for shared source; no write implementation is shipped.
const readOnly = (): never => { throw new Error('App 道路資料僅供讀取') }
export function updateStaticEditor(_patch: Partial<StaticEditorState>) { return readOnly() }
export async function mergeStaticRoadSegments(_a: SegmentIdentity, _b: SegmentIdentity,
  _node: number, _carrier?: InternalMergeCarrier): Promise<void> { readOnly() }
export function scheduleStaticEditorSave(_delay = 350) { return readOnly() }
export async function flushStaticEditorSave(): Promise<void> { readOnly() }
export const getStaticSaveSnapshot = () => 'saved|'
export const subscribeStaticSaveState = (_listener: () => void) => () => {}
