// 捏合的 journal 遷移不得刪紀錄（node --test scripts/merge_migration.test.mjs）
//
// 回歸來源：舊版 migrateEditorForMerge 會丟掉任何鍵提到接點的紀錄，並把兩條 way
// 的所有區塊級 road 紀錄壓平成一筆 way 級紀錄——掛在那裡的 deleted:1 一起蒸發，
// 使用者刪掉的路段就自己復活了。journal 是 append-only 歷程，遷移只准改鍵。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateEditorForMerge } from '../vite.config.ts'

const PRIMARY = 111
const SECONDARY = 222
const PRIMARY_BLOCK = 1001
const SECONDARY_BLOCK = 2002
const JOIN = 1001 // 接點恰好就是保留區塊的起點，正是舊版會誤刪的形狀

const baseJournal = () => [
  // 被選取的兩個區塊
  { seq: 1, op: 'set', target: { type: 'road', key: `way/${PRIMARY}@b/${PRIMARY_BLOCK}` }, fields: { lanes_forward: 2 } },
  { seq: 2, op: 'set', target: { type: 'road', key: `way/${SECONDARY}@b/${SECONDARY_BLOCK}` }, fields: { lanes_forward: 3, moto_forward: 1 } },
  // 同一條 way 的別的區塊：使用者刪掉的路段
  { seq: 3, op: 'set', target: { type: 'road', key: `way/${PRIMARY}@b/9009` }, fields: { deleted: 1 } },
  // 次 way 上另一個刪除
  { seq: 4, op: 'set', target: { type: 'road', key: `way/${SECONDARY}@b/8008` }, fields: { deleted: 1 } },
  // 鍵提到接點的路口元件
  { seq: 5, op: 'set', target: { type: 'moto_box', key: `way/${PRIMARY}@node/${JOIN}~m` }, fields: { lanes: 2 } },
  { seq: 6, op: 'set', target: { type: 'turn_bay', key: `way/${SECONDARY}@node/${JOIN}` }, fields: { present: 1 } },
  // 完全無關的第三條路
  { seq: 7, op: 'set', target: { type: 'road', key: 'way/333@b/7007' }, fields: { deleted: 1 } },
]

const run = (journal, zones = []) => migrateEditorForMerge(
  { journal, waiting_zones: zones, deleted_waiting_zone_ids: [] },
  PRIMARY, SECONDARY, PRIMARY_BLOCK, SECONDARY_BLOCK,
)

test('遷移不會弄丟任何一筆 deleted:1', () => {
  const { journal } = run(baseJournal())
  const deletes = journal.filter((r) => Number(r.fields?.deleted) > 0).map((r) => r.target.key)
  assert.deepEqual(deletes.sort(), [
    `way/${PRIMARY}@b/8008`, // 次 way 被吸收，鍵改掛保留 way，區塊不變
    `way/${PRIMARY}@b/9009`,
    'way/333@b/7007',
  ])
})

test('鍵提到接點的紀錄不再被丟棄', () => {
  const { journal } = run(baseJournal())
  const keys = journal.map((r) => r.target.key)
  assert.ok(keys.includes(`way/${PRIMARY}@node/${JOIN}~m`), '保留 way 的停等格被刪了')
  assert.ok(keys.includes(`way/${PRIMARY}@node/${JOIN}`), '次 way 的偏心道被刪了')
})

test('只有被選取的兩個區塊收斂，不壓平成 way 級', () => {
  const { journal } = run(baseJournal())
  assert.equal(journal.filter((r) => /^way\/\d+$/.test(r.target.key)).length, 0,
    '不應該產生 way 級紀錄——那會讓整條路吃同一組設定')
  const merged = journal.filter((r) => r.target.key === `way/${PRIMARY}@b/${PRIMARY_BLOCK}`).at(-1)
  // 次段先、保留段後：衝突欄位以首先選取的保留段為準
  assert.deepEqual(merged.fields, { lanes_forward: 2, moto_forward: 1 })
})

test('紀錄只增不減，seq 重新連號', () => {
  const before = baseJournal()
  const { journal } = run(before)
  assert.ok(journal.length >= before.length, `紀錄從 ${before.length} 掉到 ${journal.length}`)
  assert.deepEqual(journal.map((r) => r.seq), journal.map((_, i) => i + 1))
})

test('同分段捏合不做 way id 改寫', () => {
  const journal = [
    { seq: 1, op: 'set', target: { type: 'road', key: `way/${PRIMARY}@b/${PRIMARY_BLOCK}` }, fields: { lanes_forward: 2 } },
    { seq: 2, op: 'set', target: { type: 'road', key: `way/${PRIMARY}@b/${SECONDARY_BLOCK}` }, fields: { deleted: 1 } },
  ]
  const result = migrateEditorForMerge(
    { journal, waiting_zones: [], deleted_waiting_zone_ids: [] },
    PRIMARY, PRIMARY, PRIMARY_BLOCK, SECONDARY_BLOCK,
  )
  assert.ok(result.journal.some((r) => Number(r.fields?.deleted) > 0), 'deleted:1 不見了')
})

test('接點上的待轉區不再被刪除', () => {
  const zones = [{ id: 'z1', intersectionId: JOIN }, { id: 'z2', intersectionId: 5005 }]
  const result = run(baseJournal(), zones)
  assert.deepEqual(result.waiting_zones.map((z) => z.id), ['z1', 'z2'])
  assert.deepEqual(result.deleted_waiting_zone_ids, [])
})
