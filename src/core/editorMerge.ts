// 檔案 editor 與瀏覽器備援的合併規則（純函式，無副作用，可單獨測試）。
import type { EnhancementRecord } from './enhancements'
import type { StaticEditorState } from './staticDatabase'
import type { Zone } from './zones'

/**
 * 紀錄的內容指紋。seq 會在遷移時整批重編，ts+作者+目標+欄位值才是穩定身分；
 * 用它比對「這筆檔案裡有沒有」，重編過的號碼不會被誤判成不同紀錄。
 */
const recordFingerprint = (record: EnhancementRecord) => JSON.stringify([
  record.ts, record.author, record.op,
  record.target?.type, record.target?.key, record.fields ?? null,
])

/**
 * 合併檔案與瀏覽器備援——只增不減，不用時間戳決定誰勝出。
 *
 * 舊版拿單一個 `editor.updated_at` 比大小，贏的那邊「整包」取代輸的那邊。只要有個
 * 舊分頁隨手編輯一下（updateStaticEditor 會先蓋上當下時間再鏡像到 localStorage），
 * 它記憶體裡的舊 journal 就整包覆蓋掉檔案裡較完整的版本並自動存檔；2026-07-27
 * 一次少掉 258 筆就是這樣來的。
 *
 * 現在檔案是唯一來源且永遠完整，瀏覽器只是「還沒寫進檔案的暫存」，因此只補檔案裡
 * 沒有的紀錄——任何一邊都不會被縮減。
 */
export function uniteEditors(
  fileEditor: StaticEditorState, browser: Partial<StaticEditorState>,
): { editor: StaticEditorState; recovered: number } {
  const fileJournal = Array.isArray(fileEditor.journal) ? fileEditor.journal : []
  const known = new Set(fileJournal.map(recordFingerprint))
  const missing = (browser.journal ?? []).filter((record) => {
    const fingerprint = recordFingerprint(record)
    if (known.has(fingerprint)) return false
    known.add(fingerprint) // 備援自己重複的也只收一次
    return true
  })
  // 依時間排回歷程順序，seq 重新連號。foldJournal 取最後值，順序即語意。
  const journal = [...fileJournal, ...missing]
    .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))
    .map((record, index) => ({ ...record, seq: index + 1 }))

  const fileZones: Zone[] = Array.isArray(fileEditor.waiting_zones)
    ? fileEditor.waiting_zones : []
  const browserZones = Array.isArray(browser.waiting_zones) ? browser.waiting_zones : []
  const browserIsNewer = Boolean(browser.updated_at)
    && String(browser.updated_at) > String(fileEditor.updated_at || '')
  const browserZoneById = new Map(browserZones.map((zone) => [String(zone.id), zone]))
  const fileZoneIds = new Set(fileZones.map((zone) => String(zone.id)))
  const missingZones = browserZones.filter((zone) => !fileZoneIds.has(String(zone.id)))
  const deletedIds = [...new Set([
    ...(Array.isArray(fileEditor.deleted_waiting_zone_ids)
      ? fileEditor.deleted_waiting_zone_ids.map(String) : []),
    ...(browser.deleted_waiting_zone_ids ?? []).map(String),
  ])]
  // 墓碑優先：被刪掉的待轉區不因為備援還留著就復活。
  const tombstoned = new Set(deletedIds)
  const waitingZones = [
    ...fileZones.map((zone) =>
      browserIsNewer ? (browserZoneById.get(String(zone.id)) ?? zone) : zone),
    ...missingZones,
  ]
    .filter((zone) => !tombstoned.has(String(zone.id)))
  const replacedZones = browserIsNewer
    ? fileZones.filter((zone) => browserZoneById.has(String(zone.id))
      && JSON.stringify(browserZoneById.get(String(zone.id))) !== JSON.stringify(zone)).length
    : 0

  return {
    editor: {
      updated_at: fileEditor.updated_at,
      journal,
      waiting_zones: waitingZones,
      deleted_waiting_zone_ids: deletedIds,
    },
    recovered: missing.length + missingZones.length + replacedZones,
  }
}
