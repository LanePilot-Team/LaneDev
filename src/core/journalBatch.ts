import type { EnhancementRecord } from './enhancements.ts'

export type EnhancementRecordDraft = Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>

/** 為同一使用者動作建立連號且共用時間戳的 journal 批次。 */
export function materializeJournalRecords(
  journal: EnhancementRecord[],
  records: EnhancementRecordDraft[],
  author: string,
  now: () => Date,
): EnhancementRecord[] {
  if (records.length === 0) return journal
  const timestamp = now().toISOString()
  const firstSeq = (journal[journal.length - 1]?.seq ?? 0) + 1
  const next = [
    ...journal,
    ...records.map((record, index): EnhancementRecord => ({
      ...record,
      seq: firstSeq + index,
      ts: timestamp,
      author,
    })),
  ]
  return next
}

/** 為同一使用者動作建立不可分割的 journal 批次，且只送出一次完整結果。 */
export function appendJournalRecords(
  journal: EnhancementRecord[],
  records: EnhancementRecordDraft[],
  author: string,
  now: () => Date,
  persist: (next: EnhancementRecord[]) => void,
): EnhancementRecord[] {
  const next = materializeJournalRecords(journal, records, author, now)
  if (next !== journal) persist(next)
  return next
}
