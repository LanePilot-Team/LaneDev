import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { buildCanonicalEditor, stableJsonHash } from './build_static_road_database.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

async function createBuildFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lanedev-lane-base-fixture-'))
  const scriptsDirectory = join(directory, 'scripts')
  const lanePilotDirectory = join(directory, 'public/data/lanepilot')
  const canonicalPath = join(directory, 'public/data/road_database.json')
  const canonical = {
    sentinel: 'original-canonical',
    editor: {
      updated_at: '',
      journal: [{ seq: 7, author: 'anna', op: 'set', fields: { lanes_forward: 2 } }],
      waiting_zones: [{ id: 'manual-zone' }],
      deleted_waiting_zone_ids: ['deleted-zone'],
    },
  }
  const segment = (wayId) => JSON.stringify({
    object_identity: { nav_segment_key: `way/${wayId}`, split_index: 0 },
    geometry: { type: 'LineString', coordinates: [[120.3, 22.7], [120.31, 22.71]] },
    node_refs: [wayId, wayId + 1],
  })

  await mkdir(scriptsDirectory, { recursive: true })
  await mkdir(lanePilotDirectory, { recursive: true })
  await Promise.all([
    copyFile(resolve(root, 'scripts/build_static_road_database.mjs'), join(scriptsDirectory, 'build_static_road_database.mjs')),
    copyFile(resolve(root, 'scripts/segment_dedupe.mjs'), join(scriptsDirectory, 'segment_dedupe.mjs')),
    writeFile(join(lanePilotDirectory, 'area_4212599.segments.jsonl'), `${segment(1)}\n`, 'utf8'),
    writeFile(join(lanePilotDirectory, 'area_4212533.segments.jsonl'), `${segment(2)}\n`, 'utf8'),
    writeFile(join(lanePilotDirectory, 'annotations.jsonl'), '{}\n', 'utf8'),
    writeFile(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8'),
  ])
  return {
    directory,
    canonicalPath,
    scriptPath: join(scriptsDirectory, 'build_static_road_database.mjs'),
  }
}

async function runScript(scriptPath, args, cwd) {
  try {
    await execFileAsync(process.execPath, [scriptPath, ...args], { cwd })
    return null
  } catch (error) {
    return error
  }
}

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

test('direct --out 不得覆寫 canonical', async () => {
  const fixture = await createBuildFixture()
  try {
    const before = await readFile(fixture.canonicalPath, 'utf8')
    const error = await runScript(
      fixture.scriptPath,
      [`--out=${fixture.canonicalPath}`],
      fixture.directory,
    )
    const after = await readFile(fixture.canonicalPath, 'utf8')

    assert.equal(after, before, 'direct --out 不可改變 canonical 位元組')
    assert.ok(error, 'direct --out canonical 必須以非零狀態結束')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('direct --report 不得覆寫 canonical', async () => {
  const fixture = await createBuildFixture()
  try {
    const before = await readFile(fixture.canonicalPath, 'utf8')
    const error = await runScript(fixture.scriptPath, [
      `--out=${join(fixture.directory, 'candidate.json')}`,
      `--report=${fixture.canonicalPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before, 'direct --report 不可改變 canonical 位元組')
    assert.ok(error, 'direct --report canonical 必須以非零狀態結束')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('direct --out 不得透過 hard link 覆寫 canonical', async () => {
  const fixture = await createBuildFixture()
  const aliasPath = join(fixture.directory, 'canonical-hardlink.json')
  try {
    await link(fixture.canonicalPath, aliasPath)
    const before = await readFile(fixture.canonicalPath, 'utf8')
    const error = await runScript(fixture.scriptPath, [
      `--out=${aliasPath}`,
      `--report=${join(fixture.directory, 'report.json')}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, 'canonical hard link 必須視為相同目的地並拒絕')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('direct --report 不得透過 hard link 覆寫 canonical', async () => {
  const fixture = await createBuildFixture()
  const aliasPath = join(fixture.directory, 'canonical-report-hardlink.json')
  try {
    await link(fixture.canonicalPath, aliasPath)
    const before = await readFile(fixture.canonicalPath, 'utf8')
    const error = await runScript(fixture.scriptPath, [
      `--out=${join(fixture.directory, 'candidate.json')}`,
      `--report=${aliasPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, 'canonical report hard link 必須視為相同目的地並拒絕')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('outPath 與 reportPath 相同時在任一寫入前拒絕', async () => {
  const fixture = await createBuildFixture()
  const sharedPath = join(fixture.directory, 'shared-output.json')
  try {
    const error = await runScript(fixture.scriptPath, [
      `--out=${sharedPath}`,
      `--report=${sharedPath}`,
    ], fixture.directory)

    assert.ok(error, '候選與報告目的地相同時必須拒絕')
    await assert.rejects(readFile(sharedPath, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('outPath 與 reportPath 為 hard link aliases 時在任一寫入前拒絕', async () => {
  const fixture = await createBuildFixture()
  const outPath = join(fixture.directory, 'candidate-existing.json')
  const reportPath = join(fixture.directory, 'report-hardlink.json')
  const before = '{"untouched":true}\n'
  try {
    await writeFile(outPath, before, 'utf8')
    await link(outPath, reportPath)
    const error = await runScript(fixture.scriptPath, [
      `--out=${outPath}`,
      `--report=${reportPath}`,
    ], fixture.directory)

    assert.equal(await readFile(outPath, 'utf8'), before)
    assert.equal(await readFile(reportPath, 'utf8'), before)
    assert.ok(error, '候選與報告 hard link aliases 必須拒絕')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('canonical JSON 損壞時建置失敗而不退回空 editor', async () => {
  const fixture = await createBuildFixture()
  try {
    await writeFile(fixture.canonicalPath, '{ malformed canonical', 'utf8')
    const error = await runScript(
      fixture.scriptPath,
      [`--out=${join(fixture.directory, 'candidate.json')}`],
      fixture.directory,
    )

    assert.ok(error, '損壞的 canonical 必須讓建置失敗')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('canonical editor 結構不完整時建置失敗', async () => {
  const fixture = await createBuildFixture()
  try {
    await writeFile(fixture.canonicalPath, JSON.stringify({
      editor: { journal: [], waiting_zones: [] },
    }), 'utf8')
    const error = await runScript(
      fixture.scriptPath,
      [`--out=${join(fixture.directory, 'candidate.json')}`],
      fixture.directory,
    )

    assert.ok(error, '缺少 tombstone 陣列的 editor 必須讓建置失敗')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('canonical 為 JSON null 時仍視為結構損壞', async () => {
  const fixture = await createBuildFixture()
  try {
    await writeFile(fixture.canonicalPath, 'null\n', 'utf8')
    const error = await runScript(
      fixture.scriptPath,
      [`--out=${join(fixture.directory, 'candidate.json')}`],
      fixture.directory,
    )

    assert.ok(error, '存在但為 null 的 canonical 不可視為初始缺檔')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 拒絕仍有 blocking errors 的 audit', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'blocked' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [{ type: 'unresolved' }],
      unmapped_count: 0,
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, 'blocking errors 非空時必須拒絕 promotion')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 拒絕 unmapped_count 非零的 audit', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'unmapped' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped_count: 1,
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, '任一 unmapped count 非零時必須拒絕 promotion')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 拒絕字串 unmapped_count', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'string-unmapped-count' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped_count: '1',
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, '字串 unmapped_count 必須拒絕 promotion')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 不把 unrelated unmapped.metadata_count 當成 audit gate', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'unrelated-nested-field' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped: { metadata_count: 0 },
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, 'unrelated nested count 不可取代支援的 unmapped schema')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 拒絕未提供 unmapped count 的 audit', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'missing-unmapped-count' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, '缺少 unmapped count 時必須保守拒絕 promotion')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 拒絕與 unmapped_count 不一致的 unmapped array', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'inconsistent-unmapped' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped_count: 0,
      unmapped: [{ key: 'way/1' }],
    }), 'utf8')

    const error = await runScript(fixture.scriptPath, [
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], fixture.directory)

    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), before)
    assert.ok(error, 'count 與 array 不一致時必須拒絕 promotion')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 接受 unmapped_count 零並原樣發布已雜湊候選 bytes', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidateText = '{\n  "candidate": "exact bytes",\n  "spacing": true\n}\n'
    const candidate = JSON.parse(candidateText)
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    const before = await readFile(fixture.canonicalPath, 'utf8')
    await writeFile(candidatePath, candidateText, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped_count: 0,
      unmapped: [],
    }), 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [fixture.scriptPath,
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], { cwd: fixture.directory })
    const result = JSON.parse(stdout)

    assert.equal(await readFile(result.backup, 'utf8'), before)
    assert.equal(await readFile(fixture.canonicalPath, 'utf8'), candidateText)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('promotion 接受空 unmapped array', async () => {
  const fixture = await createBuildFixture()
  try {
    const candidate = { candidate: 'empty-unmapped-array' }
    const candidatePath = join(fixture.directory, 'candidate.json')
    const auditPath = join(fixture.directory, 'audit.json')
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, 'utf8')
    await writeFile(auditPath, JSON.stringify({
      candidate_sha256: stableJsonHash(candidate),
      blocking_errors: [],
      unmapped: [],
    }), 'utf8')

    await execFileAsync(process.execPath, [fixture.scriptPath,
      `--promote-candidate=${candidatePath}`,
      `--base-audit=${auditPath}`,
    ], { cwd: fixture.directory })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('validated candidate publisher 只接收已讀取的 candidateText', async () => {
  const module = await import('./build_static_road_database.mjs')
  assert.equal(typeof module.promoteValidatedCandidateText, 'function')

  const directory = await mkdtemp(join(tmpdir(), 'lanedev-publish-text-'))
  const canonicalPath = join(directory, 'road_database.json')
  const backupPath = join(directory, 'road_database.backup.json')
  const oldCanonical = '{"old":true}\n'
  const candidateText = '{\n  "validated": true\n}\n'
  try {
    await writeFile(canonicalPath, oldCanonical, 'utf8')
    await module.promoteValidatedCandidateText({ canonicalPath, backupPath, candidateText })

    assert.equal(await readFile(backupPath, 'utf8'), oldCanonical)
    assert.equal(await readFile(canonicalPath, 'utf8'), candidateText)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
