// 檔案與瀏覽器備援的合併不得用時間戳決定勝負
// （node --test src/core/staticDatabase.test.mjs）
//
// 回歸來源：舊版拿單一個 editor.updated_at 比大小，贏的那邊整包取代輸的那邊。
// 舊分頁隨手一編輯就會把它記憶體裡的舊 journal 蓋上當下時間並整包覆蓋檔案，
// 2026-07-27 一次少掉 258 筆紀錄就是這樣來的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uniteEditors } from './editorMerge.ts'

const rec = (ts, key, fields, op = 'set') => ({
  seq: 0, ts, author: 'anna', op, target: { type: 'road', key }, fields,
})

test('舊分頁的殘缺 journal 不會覆蓋掉檔案裡較完整的版本', () => {
  const file = {
    updated_at: '2026-07-27T07:26:57.000Z',
    journal: [
      rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 }),
      rec('2026-07-27T06:00:00.000Z', 'way/2@b/20', { deleted: 1 }),
      rec('2026-07-27T07:00:00.000Z', 'way/3@b/30', { lanes_forward: 3 }),
    ],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  // 舊分頁只記得第一筆，但它的時間戳更新——舊版會整包覆蓋成 1 筆
  const browser = {
    journal: [rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 })],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  const { editor, recovered } = uniteEditors(file, browser)
  assert.equal(editor.journal.length, 3, '檔案紀錄被縮減了')
  assert.equal(recovered, 0)
  assert.ok(editor.journal.some((r) => Number(r.fields?.deleted) > 0), 'deleted:1 不見了')
})

test('只存在於瀏覽器的編輯會被救回並排回時序', () => {
  const file = {
    updated_at: '2026-07-27T07:00:00.000Z',
    journal: [rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 })],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  const browser = {
    journal: [
      rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 }), // 重複
      rec('2026-07-27T06:00:00.000Z', 'way/9@b/90', { deleted: 1 }), // 存檔失敗的那筆
    ],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  const { editor, recovered } = uniteEditors(file, browser)
  assert.equal(recovered, 1)
  assert.deepEqual(editor.journal.map((r) => r.target.key), ['way/1@b/10', 'way/9@b/90'])
  assert.deepEqual(editor.journal.map((r) => r.seq), [1, 2])
})

test('seq 被重編過的相同紀錄不會被當成新紀錄重複收錄', () => {
  const one = rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 })
  const file = {
    updated_at: '', journal: [{ ...one, seq: 1 }],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  const browser = { journal: [{ ...one, seq: 87 }], waiting_zones: [], deleted_waiting_zone_ids: [] }
  const { editor, recovered } = uniteEditors(file, browser)
  assert.equal(editor.journal.length, 1)
  assert.equal(recovered, 0)
})

test('待轉區只增不減，但墓碑優先', () => {
  const file = {
    updated_at: '', journal: [],
    waiting_zones: [{ id: 'z1', intersectionId: 1 }],
    deleted_waiting_zone_ids: ['z3'],
  }
  const browser = {
    journal: [],
    waiting_zones: [{ id: 'z2', intersectionId: 2 }, { id: 'z3', intersectionId: 3 }],
    deleted_waiting_zone_ids: [],
  }
  const { editor } = uniteEditors(file, browser)
  assert.deepEqual(editor.waiting_zones.map((z) => z.id), ['z1', 'z2'], 'z3 已被刪除，不該復活')
  assert.deepEqual(editor.deleted_waiting_zone_ids, ['z3'])
})

// 現行策略：同 ID 待轉區一律以檔案為準，不看 updated_at。
// 刻意不做「瀏覽器較新就覆蓋」——舊分頁的 updated_at 一定是「現在」，內容卻是舊的，
// 用時間戳判勝負正是 2026-07-27 一次少掉 258 筆的成因。
// 代價已知：既有待轉區的「位置微調」若沒寫進檔案就關掉分頁，該次調整不會被救回
// （新增的待轉區仍會被救回）。要補這個缺口必須用逐筆版本號，不能用單一時間戳。
test('同 ID 待轉區一律以檔案為準，不因瀏覽器時間戳較新而被覆蓋', () => {
  const file = {
    updated_at: '2026-07-27T07:00:00.000Z',
    journal: [],
    waiting_zones: [{ id: 'z1', intersectionId: 1, center: [120, 22] }],
    deleted_waiting_zone_ids: [],
  }
  const browser = {
    updated_at: '2026-07-27T08:00:00.000Z',
    journal: [],
    waiting_zones: [{ id: 'z1', intersectionId: 1, center: [120.1, 22.1] }],
    deleted_waiting_zone_ids: [],
  }
  const { editor, recovered } = uniteEditors(file, browser)
  assert.deepEqual(editor.waiting_zones[0].center, [120, 22])
  assert.equal(recovered, 0)
})

test('瀏覽器快照較舊時，同 ID 待轉區不可覆蓋檔案新值', () => {
  const file = {
    updated_at: '2026-07-27T08:00:00.000Z',
    journal: [],
    waiting_zones: [{ id: 'z1', intersectionId: 1, center: [120.1, 22.1] }],
    deleted_waiting_zone_ids: [],
  }
  const browser = {
    updated_at: '2026-07-27T07:00:00.000Z',
    journal: [],
    waiting_zones: [{ id: 'z1', intersectionId: 1, center: [120, 22] }],
    deleted_waiting_zone_ids: [],
  }
  const { editor, recovered } = uniteEditors(file, browser)
  assert.deepEqual(editor.waiting_zones[0].center, [120.1, 22.1])
  assert.equal(recovered, 0)
})

test('備援壞掉或全空時，檔案原樣保留', () => {
  const file = {
    updated_at: '2026-07-27T07:00:00.000Z',
    journal: [rec('2026-07-27T05:00:00.000Z', 'way/1@b/10', { lanes_forward: 2 })],
    waiting_zones: [], deleted_waiting_zone_ids: [],
  }
  const { editor, recovered } = uniteEditors(file, {})
  assert.equal(editor.journal.length, 1)
  assert.equal(recovered, 0)
})
