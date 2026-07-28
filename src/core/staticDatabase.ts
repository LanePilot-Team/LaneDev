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

export interface StaticRoadDatabase {
  format: 'lanedev-static-road-database-v1'
  updated_at: string
  regions: { area_id: string; name: string }[]
  segments: Record<string, unknown>[]
  annotations: Record<string, unknown>[]
  editor: StaticEditorState
}

const DATABASE_URL = asset('/data/road_database.json')
const LOCAL_UPDATED_KEY = 'lanedev-static-editor-updated-at'
let database: StaticRoadDatabase | null = null
let saveTimer: number | null = null

const emptyEditor = (): StaticEditorState => ({
  updated_at: '',
  journal: [],
  waiting_zones: [],
  deleted_waiting_zone_ids: [],
})

function mirrorEditorToBrowser(editor: StaticEditorState) {
  localStorage.setItem('navsim-journal-v1', JSON.stringify(editor.journal))
  localStorage.setItem('navsim-zones-v2', JSON.stringify(editor.waiting_zones))
  localStorage.setItem('navsim-zones-deleted-v1', JSON.stringify(editor.deleted_waiting_zone_ids))
  localStorage.setItem(LOCAL_UPDATED_KEY, editor.updated_at)
}

export async function loadStaticRoadDatabase(): Promise<StaticRoadDatabase> {
  if (database) return database
  const response = await fetch(DATABASE_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`讀取唯一靜態道路資料庫失敗（HTTP ${response.status}）`)
  database = await response.json() as StaticRoadDatabase
  if (!Array.isArray(database.segments) || !database.segments.length) {
    throw new Error('唯一靜態道路資料庫沒有可用路段')
  }
  database.editor ??= emptyEditor()

  // 只在瀏覽器資料明確較新時遷移；網頁人工修改永遠優先於舊靜態快照。
  const localUpdatedAt = localStorage.getItem(LOCAL_UPDATED_KEY)
  const localJournal = localStorage.getItem('navsim-journal-v1')
  const localZones = localStorage.getItem('navsim-zones-v2')
  const localDeleted = localStorage.getItem('navsim-zones-deleted-v1')
  const hasLocal = Boolean(localJournal || localZones || localDeleted)
  const localIsNewer = localUpdatedAt
    ? localUpdatedAt > (database.editor.updated_at || '')
    : hasLocal && !database.editor.updated_at
  if (localIsNewer) {
    try {
      if (localJournal) database.editor.journal = JSON.parse(localJournal)
      if (localZones) database.editor.waiting_zones = JSON.parse(localZones)
      if (localDeleted) database.editor.deleted_waiting_zone_ids = JSON.parse(localDeleted)
      database.editor.updated_at = localUpdatedAt || new Date().toISOString()
      scheduleStaticEditorSave(0)
    } catch {
      mirrorEditorToBrowser(database.editor)
    }
  } else {
    mirrorEditorToBrowser(database.editor)
  }
  return database
}

export const staticSegments = () => database?.segments ?? []
export const staticAnnotations = () => database?.annotations ?? []
export const staticJournal = () => database?.editor.journal ?? []
export const staticZones = () => database?.editor.waiting_zones ?? []
export const staticDeletedZoneIds = () => database?.editor.deleted_waiting_zone_ids ?? []
export const hasStaticRoadDatabase = () => database !== null

export function updateStaticEditor(patch: Partial<StaticEditorState>) {
  if (!database) return
  database.editor = { ...database.editor, ...patch, updated_at: new Date().toISOString() }
  mirrorEditorToBrowser(database.editor)
  scheduleStaticEditorSave()
}

export async function mergeStaticRoadSegments(
  primary: SegmentIdentity,
  secondary: SegmentIdentity,
  joinNode: number,
): Promise<void> {
  // 避免尚在 350ms 防抖中的舊 editor 快照於捏合完成後反向覆蓋遷移結果。
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
    const editorResponse = await fetch('/api/static-road-database/editor', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(database?.editor ?? emptyEditor()),
    })
    if (!editorResponse.ok) throw new Error('捏合前無法寫入最新人工標註')
  }
  const response = await fetch('/api/static-road-database/merge', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, secondary, joinNode }),
  })
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  database = null
}

export function scheduleStaticEditorSave(delayMs = 350) {
  if (!database) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    saveTimer = null
    try {
      const response = await fetch('/api/static-road-database/editor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(database!.editor),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      console.error('靜態道路資料庫寫入失敗；瀏覽器備援仍保留本次修改', error)
    }
  }, delayMs)
}
