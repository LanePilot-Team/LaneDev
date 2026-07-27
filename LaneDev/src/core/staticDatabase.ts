import type { EnhancementRecord } from './enhancements'
import type { Zone } from './zones'

export interface StaticEditorState {
  updated_at: string
  journal: EnhancementRecord[]
  waiting_zones: Zone[]
  deleted_waiting_zone_ids: string[]
}

export interface StaticRoadDatabase {
  format: 'lanedev-static-road-database-v1'
  updated_at: string
  regions: { area_id: string; name: string }[]
  segments: Record<string, unknown>[]
  annotations: Record<string, unknown>[]
  editor: StaticEditorState
}

const DATABASE_URL = '/data/road_database.json'
const LOCAL_UPDATED_KEY = 'lanedev-static-editor-updated-at'

let database: StaticRoadDatabase | null = null
let saveTimer: number | null = null

function emptyEditor(): StaticEditorState {
  return {
    updated_at: '',
    journal: [],
    waiting_zones: [],
    deleted_waiting_zone_ids: [],
  }
}

export async function loadStaticRoadDatabase(): Promise<StaticRoadDatabase> {
  if (database) return database
  const response = await fetch(DATABASE_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`讀取唯一靜態道路資料庫失敗（HTTP ${response.status}）`)
  database = await response.json() as StaticRoadDatabase
  database.editor ??= emptyEditor()

  // One-time migration: data already edited in this browser predates the static
  // database. Browser edits are authoritative, so migrate them into the file.
  const localUpdatedAt = localStorage.getItem(LOCAL_UPDATED_KEY)
  const localJournal = localStorage.getItem('navsim-journal-v1')
  const localZones = localStorage.getItem('navsim-zones-v2')
  const localDeleted = localStorage.getItem('navsim-zones-deleted-v1')
  const hasLegacyLocalData = Boolean(localJournal || localZones || localDeleted)
  const localIsNewer = localUpdatedAt
    ? localUpdatedAt > (database.editor.updated_at || '')
    : hasLegacyLocalData && !database.editor.updated_at
  if (localIsNewer) {
    try {
      if (localJournal) database.editor.journal = JSON.parse(localJournal)
      if (localZones) database.editor.waiting_zones = JSON.parse(localZones)
      if (localDeleted) database.editor.deleted_waiting_zone_ids = JSON.parse(localDeleted)
      database.editor.updated_at = localUpdatedAt || new Date().toISOString()
      scheduleStaticEditorSave(0)
    } catch {
      // Invalid legacy browser data must never replace the canonical file.
    }
  } else {
    mirrorEditorToBrowser(database.editor)
  }
  return database
}

export function staticSegments(): Record<string, unknown>[] {
  return database?.segments ?? []
}

export function hasStaticRoadDatabase(): boolean {
  return database !== null
}

export function staticAnnotations(): Record<string, unknown>[] {
  return database?.annotations ?? []
}

export function staticJournal(): EnhancementRecord[] {
  return database?.editor.journal ?? []
}

export function staticZones(): Zone[] {
  return database?.editor.waiting_zones ?? []
}

export function staticDeletedZoneIds(): string[] {
  return database?.editor.deleted_waiting_zone_ids ?? []
}

function mirrorEditorToBrowser(editor: StaticEditorState) {
  localStorage.setItem('navsim-journal-v1', JSON.stringify(editor.journal))
  localStorage.setItem('navsim-zones-v2', JSON.stringify(editor.waiting_zones))
  localStorage.setItem(
    'navsim-zones-deleted-v1',
    JSON.stringify(editor.deleted_waiting_zone_ids),
  )
  localStorage.setItem(LOCAL_UPDATED_KEY, editor.updated_at)
}

export function updateStaticEditor(patch: Partial<StaticEditorState>) {
  if (!database) return
  database.editor = {
    ...database.editor,
    ...patch,
    updated_at: new Date().toISOString(),
  }
  mirrorEditorToBrowser(database.editor)
  scheduleStaticEditorSave()
}

/** 直接把兩筆活躍靜態 OSM segment 捏合；成功後須重新載入資料庫。 */
export async function mergeStaticRoadSegments(
  primary: string,
  secondary: string,
  joinNode: number,
): Promise<void> {
  const response = await fetch('/api/static-road-database/merge', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, secondary, joinNode }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `HTTP ${response.status}`)
  }
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
