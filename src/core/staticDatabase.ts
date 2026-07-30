import { asset } from './asset'
import { uniteEditors } from './editorMerge'
import type { EnhancementRecord } from './enhancements'
import type { OffsetTurnBayMarkingRecord } from './channelization'
import type { Zone } from './zones'

export interface StaticEditorState {
  updated_at: string
  journal: EnhancementRecord[]
  offset_turn_bay_markings: OffsetTurnBayMarkingRecord[]
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

const DATABASE_URL = asset('/data/road_database.json')
const LOCAL_UPDATED_KEY = 'lanedev-static-editor-updated-at'
let database: StaticRoadDatabase | null = null
let saveTimer: number | null = null
let saveInFlight: Promise<void> | null = null
let persistedEditorUpdatedAt = ''
export type StaticSaveState = 'saved' | 'dirty' | 'saving' | 'error'
let saveState: StaticSaveState = 'saved'
let saveError = ''
const saveListeners = new Set<() => void>()

const setSaveState = (next: StaticSaveState, error = '') => {
  saveState = next
  saveError = error
  for (const listener of saveListeners) listener()
}

export const getStaticSaveSnapshot = () => `${saveState}|${saveError}`
export const subscribeStaticSaveState = (listener: () => void) => {
  saveListeners.add(listener)
  return () => saveListeners.delete(listener)
}

const emptyEditor = (): StaticEditorState => ({
  updated_at: '',
  journal: [],
  offset_turn_bay_markings: [],
  waiting_zones: [],
  deleted_waiting_zone_ids: [],
})

function mirrorEditorToBrowser(editor: StaticEditorState) {
  localStorage.setItem('navsim-journal-v1', JSON.stringify(editor.journal))
  localStorage.setItem('navsim-zones-v2', JSON.stringify(editor.waiting_zones))
  localStorage.setItem('navsim-zones-deleted-v1', JSON.stringify(editor.deleted_waiting_zone_ids))
  localStorage.setItem(LOCAL_UPDATED_KEY, editor.updated_at)
}

function readBrowserEditor(): Partial<StaticEditorState> {
  const parse = <T>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) as T : fallback
    } catch { return fallback }
  }
  return {
    journal: parse<EnhancementRecord[]>('navsim-journal-v1', []),
    waiting_zones: parse<Zone[]>('navsim-zones-v2', []),
    deleted_waiting_zone_ids: parse<string[]>('navsim-zones-deleted-v1', []),
  }
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
  database.editor.offset_turn_bay_markings ??= []
  persistedEditorUpdatedAt = database.editor.updated_at || ''

  const { editor, recovered } = uniteEditors(database.editor, readBrowserEditor())
  database.editor = editor
  if (recovered > 0) {
    // 只有「檔案裡沒有、瀏覽器裡有」的紀錄才需要回寫；檔案本身永遠不會被縮減。
    console.info(`從瀏覽器備援救回 ${recovered} 筆未寫入檔案的編輯`)
    database.editor.updated_at = new Date().toISOString()
    scheduleStaticEditorSave(0)
  }
  mirrorEditorToBrowser(database.editor)
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
  setSaveState('dirty')
  scheduleStaticEditorSave()
}

export async function mergeStaticRoadSegments(
  primary: SegmentIdentity,
  secondary: SegmentIdentity,
  joinNode: number,
  internalCarrier?: InternalMergeCarrier,
): Promise<void> {
  // 避免尚在 350ms 防抖中的舊 editor 快照於捏合完成後反向覆蓋遷移結果。
  await flushStaticEditorSave()
  const response = await fetch('/api/static-road-database/merge', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, secondary, joinNode, internalCarrier }),
  })
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  database = null
  persistedEditorUpdatedAt = ''
  setSaveState('saved')
}

export function scheduleStaticEditorSave(delayMs = 350) {
  if (!database) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void flushStaticEditorSave()
  }, delayMs)
}

async function persistCurrentEditor() {
  if (!database) return
  const snapshot = structuredClone(database.editor)
  const response = await fetch('/api/static-road-database/editor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_updated_at: persistedEditorUpdatedAt,
      editor: snapshot,
    }),
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail || `HTTP ${response.status}`)
  }
  persistedEditorUpdatedAt = snapshot.updated_at
  if (database.editor.updated_at === snapshot.updated_at) setSaveState('saved')
  else setSaveState('dirty')
}

/** 立即把目前所有人工編輯寫入唯一靜態資料庫。
 * Promise 完成代表 atomic rename 已成功，不只是排進自動儲存佇列。 */
export async function flushStaticEditorSave(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!database) return
  try {
    if (saveInFlight) await saveInFlight
    while (database && database.editor.updated_at !== persistedEditorUpdatedAt) {
      setSaveState('saving')
      saveInFlight = persistCurrentEditor()
      await saveInFlight
      saveInFlight = null
    }
    setSaveState('saved')
  } catch (error) {
    saveInFlight = null
    const message = error instanceof Error ? error.message : String(error)
    setSaveState('error', message)
    console.error('靜態道路資料庫寫入失敗；瀏覽器備援仍保留本次修改', error)
    throw error
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (saveState === 'saved') return
    event.preventDefault()
    event.returnValue = ''
  })
}
