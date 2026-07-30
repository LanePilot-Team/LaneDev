// 跨 shard 去重（node --test scripts/segment_dedupe.test.mjs）
//
// 回歸來源：build_static_road_database.mjs 過去是純串接，整條鏈上沒有唯一性檢查，
// 而且去重排在 node_refs 補齊之前——等於讓 regions 順序決定資料品質。實測跨區界的
// 57 個分段在左營側完全沒有 node_refs，若把左營放前面，460 個節點位置中有 395 個
// 會退化成合成負節點。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareSegments, canonicalJson } from './segment_dedupe.mjs'

const seg = (key, coords, nodeRefs, extra = {}) => ({
  object_identity: { nav_segment_key: key, split_index: 0 },
  geometry: { type: 'LineString', coordinates: coords },
  ...(nodeRefs ? { node_refs: nodeRefs } : {}),
  ...extra,
})
const at = (record, source, line) => ({ record, source, line })
const C1 = [120.3, 22.7]
const C2 = [120.31, 22.71]
const C3 = [120.32, 22.72]

test('楠梓有 node_refs、左營沒有 → 兩種 regions 順序結果相同', () => {
  const withRefs = () => at(seg('way/1', [C1, C2], [11, 22]), 'nanzi.jsonl', 1)
  const without = () => at(seg('way/1', [C1, C2], null), 'zuoying.jsonl', 5)
  const a = prepareSegments([withRefs(), without()])
  const b = prepareSegments([without(), withRefs()])
  assert.deepEqual(a.segments[0].node_refs, [11, 22])
  assert.deepEqual(b.segments[0].node_refs, [11, 22], '反轉順序後仍須保留真實 OSM 節點')
  assert.equal(a.exactDuplicates.length, 1)
  assert.equal(b.exactDuplicates.length, 1)
  assert.equal(a.conflicts.length, 0)
  assert.equal(b.conflicts.length, 0)
})

test('左營有 node_refs、楠梓沒有 → 兩種順序結果仍相同', () => {
  const without = () => at(seg('way/2', [C1, C2], null), 'nanzi.jsonl', 1)
  const withRefs = () => at(seg('way/2', [C1, C2], [33, 44]), 'zuoying.jsonl', 2)
  const a = prepareSegments([without(), withRefs()])
  const b = prepareSegments([withRefs(), without()])
  assert.deepEqual(a.segments[0].node_refs, [33, 44], '缺節點的那份在前也不得丟掉真實節點')
  assert.deepEqual(b.segments[0].node_refs, [33, 44])
  assert.equal(a.conflicts.length, 0)
  assert.equal(b.conflicts.length, 0)
})

test('相同 identity、相同 geometry，補齊後成為 exact duplicate', () => {
  const r = prepareSegments([
    at(seg('way/3', [C1, C2], [1, 2]), 'a.jsonl', 1),
    at(seg('way/3', [C1, C2], null), 'b.jsonl', 9),
  ])
  assert.equal(r.segments.length, 1)
  assert.equal(r.exactDuplicates.length, 1)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.exactDuplicates[0].kept, { source: 'a.jsonl', line: 1 })
  assert.deepEqual(r.exactDuplicates[0].rejected, { source: 'b.jsonl', line: 9 })
})

test('相同 identity、不同 geometry → conflict，不靜默丟棄', () => {
  const r = prepareSegments([
    at(seg('way/4', [C1, C2], [1, 2]), 'a.jsonl', 1),
    at(seg('way/4', [C1, C3], [1, 3]), 'b.jsonl', 2),
  ])
  assert.equal(r.segments.length, 1, '候選仍要能建置')
  assert.equal(r.exactDuplicates.length, 0)
  assert.equal(r.conflicts.length, 1)
  assert.ok(r.conflicts[0].differing_fields.includes('geometry'))
  assert.ok(r.conflicts[0].differing_fields.includes('node_refs'))
  // first-wins：保留先出現的那份
  assert.deepEqual(r.segments[0].geometry.coordinates, [C1, C2])
})

test('相同 nav_segment_key、不同 split_index 不可互相去重', () => {
  const a = at(seg('way/5', [C1, C2], [1, 2]), 'a.jsonl', 1)
  const b = at({
    ...seg('way/5', [C2, C3], [2, 3]),
    object_identity: { nav_segment_key: 'way/5', split_index: 1 },
  }, 'a.jsonl', 2)
  const r = prepareSegments([a, b])
  assert.equal(r.segments.length, 2)
  assert.equal(r.exactDuplicates.length, 0)
  assert.equal(r.conflicts.length, 0)
})

test('不修改輸入物件', () => {
  const input = at(seg('way/6', [C1, C2], null), 'a.jsonl', 1)
  const before = canonicalJson(input.record)
  prepareSegments([input, at(seg('way/6', [C1, C2], [7, 8]), 'b.jsonl', 2)])
  assert.equal(canonicalJson(input.record), before, '補齊必須回傳新物件，不得就地改寫')
})

test('合成節點依座標排序配號，與載入順序無關', () => {
  const x = () => at(seg('way/7', [C1, C2], null), 'a.jsonl', 1)
  const y = () => at(seg('way/8', [C2, C3], null), 'b.jsonl', 1)
  const a = prepareSegments([x(), y()])
  const b = prepareSegments([y(), x()])
  const nodesOf = (r) => Object.fromEntries(
    r.segments.map((s) => [s.object_identity.nav_segment_key, s.node_refs]))
  assert.deepEqual(nodesOf(a), nodesOf(b))
  // 共用座標 C2 在兩條路上必須拿到同一個 id
  const m = nodesOf(a)
  assert.equal(m['way/7'][1], m['way/8'][0])
})

test('沒有任何真實節點時仍會補滿，且都是負數', () => {
  const r = prepareSegments([at(seg('way/9', [C1, C2, C3], null), 'a.jsonl', 1)])
  assert.equal(r.segments[0].node_refs.length, 3)
  assert.ok(r.segments[0].node_refs.every((n) => n < 0))
  assert.equal(new Set(r.segments[0].node_refs).size, 3, '不同座標不可共用同一個合成 id')
})
