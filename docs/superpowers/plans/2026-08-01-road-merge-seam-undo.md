# Road Merge Seam Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change road-merge undo from deleting one history record into removing one selected source-block seam while preserving and rebasing every other unambiguous seam in the same merged component.

**Architecture:** Add a pure planner in `roadMerge.ts` that reconstructs the selected merged component from active schema-v2 replay records, removes one seam, tombstones all superseded component records, and emits replacement schema-v2 records for surviving connected components. The editor previews the complete returned transaction, appends it synchronously as one journal update, flushes once, and reloads once.

**Tech Stack:** TypeScript 6, Node test runner, React 19, append-only enhancement journal, existing road-merge replay engine.

## Global Constraints

- `A+B`, then `AB+C`, undoing `A-B` must produce `A | BC`.
- No new OSM way id may be generated.
- Do not mutate canonical static segment geometry.
- Do not infer replacement blocks by nearest-road distance.
- Ambiguous, branched, or provenance-incomplete histories must append no records and return a visible reason.
- `public/data/road_database.json` contains local acceptance-test data and must not be staged or committed.
- Commit messages must be primarily Chinese.

---

### Task 1: Pure seam-undo transaction planner

**Files:**
- Modify: `src/core/roadMerge.ts`
- Test: `src/core/roadMerge.test.mjs`

**Interfaces:**
- Consumes: `RoadFeature[]`, `EnhancementRecord[]`, and a selected active merge key.
- Produces: `planRoadMergeSeamUndo(roads, journal, mergeKey): RoadMergeSeamUndoPlan` where success contains ordered journal records, retired merge keys, and rebased merge keys; failure contains a user-facing reason and no records.

- [ ] **Step 1: Write the failing three-block-chain tests**

Add imports and tests that express both sides of the seam behavior:

```js
import {
  activeMergeForRoad, buildRoadMergeViews, planRoadMergeSeamUndo,
  previewRoadMerge, resolveRoadMerges,
} from './roadMerge.ts'

test('撤銷 A-B 接縫後將後續捏合重定位為 B-C', () => {
  const blocks = [
    road({ osmId: 100, blockNode: 1, nodes: [1, 2] }),
    road({ osmId: 100, blockNode: 2, nodes: [2, 3] }),
    road({ osmId: 100, blockNode: 3, nodes: [3, 4] }),
  ]
  const journal = v2Chain(blocks)

  const plan = planRoadMergeSeamUndo(blocks, journal, journal[0].target.key)

  assert.equal(plan.ok, true)
  assert.deepEqual(plan.retiredMergeKeys, journal.map((record) => record.target.key))
  assert.deepEqual(plan.rebasedMergeKeys, ['merge/way/100@b/2+way/100@b/3'])
  const view = buildRoadMergeViews(blocks, stampPlanned(journal, plan.records))
  assert.deepEqual(view.renderRoads.map((item) => item.properties.nodes), [[1, 2], [2, 3, 4]])
})

test('撤銷 B-C 接縫後保留 A-B', () => {
  const blocks = threeBlocks()
  const journal = v2Chain(blocks)

  const plan = planRoadMergeSeamUndo(blocks, journal, journal[1].target.key)

  assert.equal(plan.ok, true)
  assert.deepEqual(plan.rebasedMergeKeys, ['merge/way/100@b/1+way/100@b/2'])
  const view = buildRoadMergeViews(blocks, stampPlanned(journal, plan.records))
  assert.deepEqual(view.renderRoads.map((item) => item.properties.nodes), [[1, 2, 3], [3, 4]])
})
```

Test helpers must create v2 records through `previewRoadMerge`, so the test exercises real source snapshots instead of handwritten mocks.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="撤銷 A-B|撤銷 B-C" src/core/roadMerge.test.mjs
```

Expected: FAIL because `planRoadMergeSeamUndo` is not exported.

- [ ] **Step 3: Implement the smallest pure planner that passes the linear-chain tests**

Add these public result types:

```ts
export type RoadMergeJournalDraft = Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>

export type RoadMergeSeamUndoPlan =
  | {
      ok: true
      records: RoadMergeJournalDraft[]
      retiredMergeKeys: string[]
      rebasedMergeKeys: string[]
    }
  | {
      ok: false
      reason: string
      records: []
      retiredMergeKeys: []
      rebasedMergeKeys: []
    }
```

Implement `planRoadMergeSeamUndo` with focused private helpers:

```ts
export function planRoadMergeSeamUndo(
  roads: RoadFeature[], journal: EnhancementRecord[], selectedMergeKey: string,
): RoadMergeSeamUndoPlan
```

The planner must:

1. replay active merges in sequence;
2. reconstruct the selected final component as ordered atomic block keys from v2 source snapshots and resolved endpoint orientation;
3. associate each active record in that component with the adjacent atomic seam it introduced;
4. remove the selected seam;
5. emit tombstones for every active record used to construct that component;
6. rebuild every surviving multi-block component with `previewRoadMerge`, using its first atomic block as carrier; and
7. stamp no `seq`, `ts`, or `author` values itself.

Do not add geometry-nearest fallback logic.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command. Expected: both tests PASS.

- [ ] **Step 5: Add failing four-block and no-revival tests**

```js
test('四區塊鏈撤銷中間接縫後保留左右兩個群組', () => {
  const blocks = fourBlocks()
  const journal = v2Chain(blocks)
  const plan = planRoadMergeSeamUndo(blocks, journal, journal[1].target.key)
  const view = buildRoadMergeViews(blocks, stampPlanned(journal, plan.records))

  assert.equal(plan.ok, true)
  assert.deepEqual(view.renderRoads.map((item) => item.properties.nodes), [[1, 2, 3], [3, 4, 5]])
})

test('被替代的相依紀錄都有 tombstone 而不會在日後復活', () => {
  const blocks = threeBlocks()
  const journal = v2Chain(blocks)
  const plan = planRoadMergeSeamUndo(blocks, journal, journal[0].target.key)
  const deleted = new Set(plan.records
    .filter((record) => record.op === 'delete')
    .map((record) => record.target.key))

  assert.deepEqual(deleted, new Set(journal.map((record) => record.target.key)))
})
```

Run the matching tests and verify they fail because the initial implementation handles only one surviving component or fails to retire every dependency.

- [ ] **Step 6: Generalize the planner to connected components and verify GREEN**

Split the ordered atom list at the removed seam, rebuild each component independently, and keep the transaction all-or-nothing. Run:

```powershell
node --test src/core/roadMerge.test.mjs
```

Expected: all road-merge unit tests PASS.

- [ ] **Step 7: Commit the pure planner**

```powershell
git add -- src/core/roadMerge.ts src/core/roadMerge.test.mjs
git commit -m "支援道路捏合接縫重定位撤銷"
```

---

### Task 2: Ambiguity and legacy safety

**Files:**
- Modify: `src/core/roadMerge.ts`
- Test: `src/core/roadMerge.test.mjs`

**Interfaces:**
- Consumes: the planner introduced in Task 1.
- Produces: deterministic failure results with `records: []` for unsupported histories.

- [ ] **Step 1: Write failing safety tests**

Add separate tests for a schema-v1 record without source snapshots, a fork where one carrier has two possible block orders, and a selected key that is not active:

```js
assert.deepEqual(
  planRoadMergeSeamUndo(blocks, legacyJournal, legacyJournal[0].target.key),
  { ok: false, reason: '舊捏合缺少完整來源快照，無法安全解除接縫', records: [],
    retiredMergeKeys: [], rebasedMergeKeys: [] },
)
```

Fork and inactive-key assertions must check their specific Chinese reasons and verify `records.length === 0`.

- [ ] **Step 2: Run the safety tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="缺少完整來源|分岔|不是有效捏合" src/core/roadMerge.test.mjs
```

Expected: FAIL because unsupported histories are not yet rejected atomically.

- [ ] **Step 3: Add strict validation and verify GREEN**

Validate schema version, parsed snapshots, unique atom order, unique adjacency edges, and complete candidate replay before returning success. If any check fails, return the failure union without partial drafts.

Run the focused safety tests, then all of `src/core/roadMerge.test.mjs`. Expected: PASS.

- [ ] **Step 4: Commit safety behavior**

```powershell
git add -- src/core/roadMerge.ts src/core/roadMerge.test.mjs
git commit -m "阻擋來源不明的接縫自動撤銷"
```

---

### Task 3: Atomic editor integration

**Files:**
- Modify: `src/core/enhancements.ts`
- Modify: `src/edit/useEditor.ts`
- Test: `src/core/roadMergeReload.test.mjs`

**Interfaces:**
- Consumes: `RoadMergeSeamUndoPlan.records` from Tasks 1-2.
- Produces: `appendRecords(journal, records, author): EnhancementRecord[]`, assigning consecutive sequence numbers and one transaction timestamp before queueing a single persistence update.

- [ ] **Step 1: Write failing batch-append and reload-gating tests**

Add a pure batch append test proving ordered seq values and one author/timestamp group. Extend reload tests so reload occurs only after a successful flush; a planner failure or flush rejection must not call reload.

```js
const next = appendRecords(existing, [deleteAB, deleteAC, setBC], 'anna', () => fixedTime)
assert.deepEqual(next.slice(-3).map((record) => record.seq), [8, 9, 10])
assert.equal(new Set(next.slice(-3).map((record) => record.ts)).size, 1)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test src/core/roadMergeReload.test.mjs
```

Expected: FAIL because `appendRecords` and transaction assertions do not exist.

- [ ] **Step 3: Implement `appendRecords` and wire `undoRoadMerge`**

In `enhancements.ts`, add:

```ts
export function appendRecords(
  journal: EnhancementRecord[],
  records: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>[],
  author: string = getAuthor(),
  now: () => Date = () => new Date(),
): EnhancementRecord[]
```

It must return the original journal unchanged for an empty batch and call `queueJournalPersistence` only once for a non-empty batch.

In `undoRoadMerge`:

1. call `planRoadMergeSeamUndo(core.roadsRef.current, core.journalRef.current, row.mergeKey)`;
2. show `plan.reason` and return when `ok` is false;
3. build a stamped preview journal without persisting;
4. require `core.previewJournal(previewJournal)` to succeed;
5. remember reload state;
6. call `appendRecords` once;
7. show `已解除接縫；停用 N 筆、重定位 M 筆，正在儲存…`; and
8. preserve the existing flush-then-reload error handling.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the reload test and `src/core/roadMerge.test.mjs`. Expected: PASS.

- [ ] **Step 5: Run the full relevant verification**

```powershell
npm.cmd run test:road-merge
npm.cmd run build
```

Expected: all tests and TypeScript/Vite build PASS. Generated build output must not be staged.

- [ ] **Step 6: Confirm protected data and commit integration**

```powershell
git status --short
git diff --cached --name-only
git add -- src/core/enhancements.ts src/edit/useEditor.ts src/core/roadMergeReload.test.mjs
git commit -m "讓接縫撤銷以單一交易安全儲存"
```

Before committing, verify `public/data/road_database.json` is absent from the staged file list.

---

### Task 4: Target-data regression and acceptance handoff

**Files:**
- Modify: `scripts/road_merge_recovery.test.mjs` only if the target case needs a reusable fixture; otherwise no production files.
- Read-only input: `public/data/road_database.json`

**Interfaces:**
- Consumes: final planner and the local target merge history.
- Produces: evidence that the target chain rebases from carrier `1080697514` to carrier `1080697102` without committing local data.

- [ ] **Step 1: Run a read-only target probe**

Use the local database only as input and assert:

```text
retired:
  merge/way/312871463@b/1080697514+way/312871463@b/1080697102
  merge/way/312871463@b/1080697514+way/312871463@b/1080697358
rebased:
  merge/way/312871463@b/1080697102+way/312871463@b/1080697358
```

The resulting render roads must contain separate A nodes and a merged B-C node sequence.

- [ ] **Step 2: Re-run status and protected-data checks**

```powershell
git status --short --branch
git diff --name-only HEAD
git diff --cached --name-only
```

Expected: the local `public/data/road_database.json` may remain modified but is not staged; no temporary probe file remains.

- [ ] **Step 3: Report exact before/after behavior for user acceptance**

Report `A+B+C -> A | B+C`, list the target retired/rebased keys, test commands and results, commits, and the local acceptance URL. Do not push unless the user separately asks to push this new work.
