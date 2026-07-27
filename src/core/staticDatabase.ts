import { asset } from './asset'

export interface StaticRoadDatabase {
  format: 'lanedev-static-road-database-v1'
  updated_at: string
  regions: { area_id: string; name: string }[]
  segments: Record<string, unknown>[]
  annotations: Record<string, unknown>[]
  /** anna 分支留下的編輯狀態快照（journal/待轉區）。**不讀取**：編輯狀態的
   * 權威來源仍是 localStorage（seed_journal 機制），貿然鏡像會把使用者的
   * 本地編輯蓋掉。/api/static-road-database/editor 寫入端保留，待日後
   * 設計好與 seed_journal / couplet remap 的整合再接。 */
  editor?: unknown
}

// 走 asset()：Pages 是 project site（base=/LaneDev/），寫死 /data/… 線上會 404。
// 註：寫入端（/api/static-road-database/*）只有 vite dev middleware 有，線上無法寫。
const DATABASE_URL = asset('/data/road_database.json')

let database: StaticRoadDatabase | null = null

/** 唯一靜態道路資料庫：底圖 segments 的權威來源（捏合結果的讀取端）。
 * no-store：捏合改寫檔案後 reload 必須拿到新內容，不能吃 HTTP 快取。 */
export async function loadStaticRoadDatabase(): Promise<StaticRoadDatabase> {
  if (database) return database
  const response = await fetch(DATABASE_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`讀取靜態道路資料庫失敗（HTTP ${response.status}）`)
  const parsed = await response.json() as StaticRoadDatabase
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error('靜態道路資料庫沒有 segments')
  }
  database = parsed
  return database
}

/** 直接把兩筆活躍靜態 OSM segment 捏合（vite dev middleware 改寫檔案）；
 * 成功後呼叫端要遷移 live journal 鍵（migrateJournalForStaticMerge）再整頁重載。 */
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
