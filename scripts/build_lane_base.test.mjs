import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { buildCanonicalEditor, stableJsonHash } from './build_static_road_database.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

test('移除 LanePilot journal 而完整保留人工 journal、順序與編號', () => {
  const editor = {
    journal: [
      { seq: 1, author: 'lanepilot', op: 'set', target: { type: 'road', key: 'way/1' }, fields: { lanes_forward: 2 } },
      { seq: 2, author: 'anna', op: 'set', target: { type: 'road', key: 'way/1' }, fields: { turn_lanes: 'through|right' } },
      { seq: 3, author: 'road-merge-recovery-v2', op: 'set', target: { type: 'road_merge', key: 'merge/1' }, fields: { primary: 'way/1' } },
      { seq: 4, author: 'lanepilot', op: 'delete', target: { type: 'waiting_zone', key: 'zone-lp-old' }, fields: {} },
      { seq: 5, author: 'anna', op: 'delete', target: { type: 'road', key: 'way/9' }, fields: { deleted: true } },
    ],
    waiting_zones: [{ id: 'manual-zone', kind: 'motorcycle_box' }],
    deleted_waiting_zone_ids: ['zone-lp-old'],
  }
  const before = JSON.stringify(editor)

  const result = buildCanonicalEditor(editor)

  assert.equal(result.removedLanePilotJournalCount, 2)
  assert.deepEqual(result.editor.journal.map((record) => record.author), [
    'anna',
    'road-merge-recovery-v2',
    'anna',
  ])
  assert.deepEqual(result.editor.journal.map((record) => record.seq), [2, 3, 5])
  assert.equal(JSON.stringify(result.editor.journal), JSON.stringify(editor.journal.filter((record) => record.author !== 'lanepilot')))
  assert.deepEqual(result.editor.waiting_zones, [{ id: 'manual-zone', kind: 'motorcycle_box' }])
  assert.deepEqual(result.editor.deleted_waiting_zone_ids, ['zone-lp-old'])
  assert.equal(JSON.stringify(editor), before, '原始 editor 不可被建置流程改寫')
})

test('stableJsonHash 對物件鍵的插入順序不敏感', () => {
  assert.equal(
    stableJsonHash({ annotation: { b: 2, a: 1 }, segments: ['way/1'] }),
    stableJsonHash({ segments: ['way/1'], annotation: { a: 1, b: 2 } }),
  )
})

test('stableJsonHash 採用 JSON 的 undefined 處理規則', () => {
  assert.equal(stableJsonHash({ retained: true, omitted: undefined }), stableJsonHash({ retained: true }))
})

test('promotion 必須同時提供候選檔與 base audit', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      resolve(root, 'scripts/build_static_road_database.mjs'),
      '--promote-candidate=only-a-candidate.json',
    ], { cwd: root }),
    /同時提供 --promote-candidate=<path> 與 --base-audit=<path>/,
  )
})

test('候選檔包含 annotations.jsonl 的每一筆非空白紀錄', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'lanedev-lane-base-'))
  const candidatePath = join(tempDirectory, 'candidate.json')
  const annotationPath = resolve(root, 'public/data/lanepilot/annotations.jsonl')

  try {
    await execFileAsync(process.execPath, [
      resolve(root, 'scripts/build_static_road_database.mjs'),
      `--out=${candidatePath}`,
    ], { cwd: root })

    const [candidate, report, annotationText, canonical] = await Promise.all([
      readFile(candidatePath, 'utf8').then(JSON.parse),
      readFile(`${candidatePath}.dedup-report.json`, 'utf8').then(JSON.parse),
      readFile(annotationPath, 'utf8'),
      readFile(resolve(root, 'public/data/road_database.json'), 'utf8').then(JSON.parse),
    ])
    const annotations = annotationText
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))

    assert.equal(candidate.annotations.length, annotations.length)
    assert.deepEqual(candidate.annotations, annotations)
    const expectedEditor = buildCanonicalEditor(canonical.editor)
    assert.equal(report.annotation_count, annotations.length)
    assert.equal(report.removed_lanepilot_journal_count, expectedEditor.removedLanePilotJournalCount)
    assert.equal(report.preserved_editor_sha256, stableJsonHash(expectedEditor.editor))
    assert.equal(report.candidate_sha256, stableJsonHash(candidate))
    assert.ok(Array.isArray(report.blocking_errors))
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})
