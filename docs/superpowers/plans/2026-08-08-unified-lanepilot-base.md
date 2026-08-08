# Unified LanePilot Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a canonical LanePilot annotation base inside `road_database.json` and make road rendering, routing, the route ribbon, and the HUD consume one field-level resolved lane model while preserving every non-LanePilot editor record.

**Architecture:** The static builder copies validated raw LanePilot annotations into `road_database.annotations`, removes only legacy `author=lanepilot` materializations, and writes a candidate plus a preservation report. Runtime code converts canonical annotations into a remapped `LaneBaseIndex`, applies it to prepared road blocks before human journal overlays, and records per-direction provenance on each road; `RoadGraph`, rendering, and HUD then read those same effective road properties instead of fetching `lane-guidance.json` separately.

**Tech Stack:** TypeScript 6, Node.js test runner, React 19, MapLibre GL, Vite 8, GeoJSON, existing offline TypeScript harness (`scripts/run_offline.mjs`).

## Global Constraints

- Human block journal fields override human way fields; human fields override LanePilot approach/segment fields.
- LanePilot `intersection_approach` overrides `segment_direction`; segment data overrides OSM and inference.
- Preserve all non-LanePilot journal records byte-for-byte and in the same order during the base build.
- Keep road merges, new roads, waiting zones, deletion records, turn bays, right lanes, and motorcycle boxes replayable.
- A canonical write requires an explicit `--write-canonical` flag and zero unmapped annotations or other blocking audit findings.
- Do not infer the driver's physical lane from GPS.
- HUD inference copy is `系統推測資料，請依現場標線行駛` and appears only when an effective field is inferred.
- Do not push, create a PR, or merge `main` as part of this plan.

## File Structure

- Create `src/core/laneBase.ts`: parse canonical raw annotations, remap them, resolve field-level LanePilot values, apply them to road blocks, and expose effective road guidance.
- Create `src/core/laneBase.test.mjs`: unit tests for extraction, scope priority, remapping, partial fields, provenance, and mapping failures.
- Modify `src/core/roads.ts`: add per-direction effective lane provenance to `RoadProps` and initialize it from OSM/inference.
- Modify `src/core/enhancements.ts`: mark only explicitly overlaid human lane fields as human-sourced.
- Modify `scripts/build_static_road_database.mjs`: load annotations into the canonical candidate and remove only `author=lanepilot` records with preservation fingerprints.
- Create `scripts/build_lane_base.test.mjs`: candidate-builder regression tests.
- Create `scripts/lane_base_candidate_audit.ts`: remap-aware candidate audit with blocking exit status.
- Modify `src/app/mapCore.ts`: load canonical annotations, apply LanePilot base before human journal, and remove the independent HUD data authority.
- Modify `src/app/importFlow.ts`: route interactive annotation imports through the base model without appending LanePilot journal records.
- Modify `src/core/staticDatabase.ts`: expose canonical annotation replacement only where runtime/session initialization needs it; editor persistence remains editor-only.
- Modify `src/core/graph.ts`: derive edge and maneuver lane guidance from effective road properties.
- Modify `src/core/laneGuidance.ts`: retain shared guidance/result types and remove or deprecate duplicate index resolution once callers migrate.
- Modify `src/nav/lanePreview.ts`, `src/nav/LanePreviewView.tsx`, and related tests: use effective provenance and exact inference copy.
- Modify `src/core/zoneimport.ts` and `src/app/mapCore.ts`: build LanePilot waiting-zone base from canonical annotations, then apply human additions/deletions.
- Modify `scripts/manual_lane_journal_audit.ts`: compare human fields against canonical annotations through the same resolver.
- Modify `package.json`: add candidate build/audit commands and remove the production dependency on `lane-guidance:data`.
- Update `public/data/road_database.json` only after all candidate audits pass; regenerate `docs/audits/manual-lane-journal-review.md` and `.csv` afterward.

---

### Task 1: Canonical annotation candidate and human-data preservation

**Files:**
- Modify: `scripts/build_static_road_database.mjs`
- Create: `scripts/build_lane_base.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `public/data/lanepilot/*.segments.jsonl`, `public/data/lanepilot/annotations.jsonl`, and the current `road_database.json.editor`.
- Produces: candidate `{ segments, annotations, editor }` and report fields `annotation_count`, `removed_lanepilot_journal_count`, `preserved_editor_sha256`, and `blocking_errors`.

- [ ] **Step 1: Write failing builder tests**

Add fixtures that call exported pure helpers from `build_static_road_database.mjs`:

```js
test('candidate stores annotations and removes only LanePilot materializations', () => {
  const editor = { journal: [
    { seq: 1, author: 'lanepilot', op: 'set', target: { type: 'road', key: 'way/1' }, fields: { lanes_forward: 2 } },
    { seq: 2, author: 'anna', op: 'set', target: { type: 'road', key: 'way/1' }, fields: { turn_lanes: 'through|right' } },
    { seq: 3, author: 'road-merge-recovery-v2', op: 'set', target: { type: 'road_merge', key: 'merge/1' }, fields: { primary: 'way/1' } },
  ], waiting_zones: [{ id: 'manual-zone' }], deleted_waiting_zone_ids: ['zone-lp-old'] }
  const result = buildCanonicalEditor(editor)
  assert.deepEqual(result.editor.journal.map((record) => record.author), ['anna', 'road-merge-recovery-v2'])
  assert.deepEqual(result.editor.waiting_zones, editor.waiting_zones)
  assert.deepEqual(result.editor.deleted_waiting_zone_ids, editor.deleted_waiting_zone_ids)
  assert.equal(result.removedLanePilotJournalCount, 1)
})

test('candidate includes every parsed annotation line', () => {
  const annotations = parseJsonl('{"object_identity":{"object_type":"nav_context_annotation"}}\n')
  assert.equal(annotations.length, 1)
})
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run: `node --test scripts/build_lane_base.test.mjs`

Expected: FAIL because `buildCanonicalEditor` is not exported and annotations are still hard-coded to `[]`.

- [ ] **Step 3: Extract pure builder helpers and load annotations**

Implement and export:

```js
export function buildCanonicalEditor(editor) {
  const journal = Array.isArray(editor?.journal) ? editor.journal : []
  const preserved = journal.filter((record) => record.author !== 'lanepilot')
  return {
    editor: { ...editor, journal: preserved },
    removedLanePilotJournalCount: journal.length - preserved.length,
  }
}

export function stableJsonHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
```

Read `annotations.jsonl` with the existing `parseJsonl`, assign all parsed objects to `output.annotations`, and report the SHA-256 of the preserved editor object before and after candidate assembly. Do not renumber journal `seq` values.

- [ ] **Step 4: Make candidate output the default and keep canonical writes explicit**

Keep `.lanedev-backups/road_database.candidate.json` as the default. When `--write-canonical` is requested, require an audit report supplied through `--base-audit=<path>` whose `blocking_errors` is empty and `unmapped_count` is zero; otherwise exit 2 before writing.

- [ ] **Step 5: Add commands and run the focused tests**

Add:

```json
"test:lane-base-build": "node --test scripts/build_lane_base.test.mjs",
"build:lane-base-candidate": "node scripts/build_static_road_database.mjs"
```

Run: `npm.cmd run test:lane-base-build`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add scripts/build_static_road_database.mjs scripts/build_lane_base.test.mjs package.json
git commit -m "建立 LanePilot base 候選資料庫"
```

### Task 2: Lane base extraction, remapping, and field-level resolution

**Files:**
- Create: `src/core/laneBase.ts`
- Create: `src/core/laneBase.test.mjs`
- Modify: `src/core/importmap.ts`
- Modify: `src/core/laneGuidance.ts`

**Interfaces:**
- Produces: `extractLaneBase(raw: unknown[]): LaneBaseExtraction`, `remapLaneBase(records, options): RemappedLaneBase`, `buildLaneBaseIndex(records): LaneBaseIndex`, and `resolveLaneBase(index, input): ResolvedLaneBase`.
- `ResolvedLaneBase` contains optional `laneCount`, `laneMovements`, `motorcycleAccessByLane`, movement rules, and per-field sources.

- [ ] **Step 1: Write extraction and priority tests**

Cover one segment record and two approaches on the same way:

```js
test('approach fields override segment fields without clearing missing fields', () => {
  const index = buildLaneBaseIndex([
    record({ scope: 'segment_direction', wayId: 10, direction: 'forward', laneCount: 3,
      laneMovements: ['through', 'through', 'right'] }),
    record({ scope: 'intersection_approach', wayId: 10, intersectionNodeId: 99,
      direction: 'forward', laneMovements: ['left', 'through', 'right'] }),
  ])
  assert.deepEqual(resolveLaneBase(index, { wayId: 10, intersectionNodeId: 99, direction: 'forward' }), {
    laneCount: 3,
    laneMovements: ['left', 'through', 'right'],
    fieldSources: { laneCount: 'lanepilot-segment', laneMovements: 'lanepilot-approach' },
  })
})
```

Also test extraction of `motorcycle_access_by_lane`, approach node, direction, movement rules, duplicate conflicting keys, and records with movement rules but no lane profile.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/core/laneBase.test.mjs`

Expected: FAIL because `laneBase.ts` does not exist.

- [ ] **Step 3: Define exact types and extraction accounting**

Implement:

```ts
export type EffectiveFieldSource =
  | 'human-block' | 'human-way'
  | 'lanepilot-approach' | 'lanepilot-segment'
  | 'osm' | 'inferred'

export interface LaneBaseRecord {
  sourceKey: string
  wayId: number
  direction: LaneDirection
  scope: LaneGuidanceScope
  intersectionNodeId?: number
  laneCount?: number
  laneMovements?: string[]
  motorcycleAccessByLane?: string[]
  movementRules: MovementRule[]
}

export interface LaneBaseExtraction {
  records: LaneBaseRecord[]
  sourceRecords: number
  accountedSourceKeys: Set<string>
  errors: string[]
}
```

Treat a raw annotation without a lane profile as accounted when its movement rules are extracted. Conflicting duplicate canonical keys add an error instead of using first-wins.

- [ ] **Step 4: Implement remapping and resolver**

Reuse the existing `DropRemap` direction-alignment rule from `remapLaneGuidanceRecords`. Return explicit unmapped source keys instead of silently dropping them. Resolve each field independently: approach field, then segment field; do not let an absent approach field erase a segment field.

- [ ] **Step 5: Run focused tests**

Run: `node --test src/core/laneBase.test.mjs src/core/laneGuidance.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/core/laneBase.ts src/core/laneBase.test.mjs src/core/importmap.ts src/core/laneGuidance.ts
git commit -m "新增 LanePilot base 解析與欄位級覆蓋"
```

### Task 3: Apply base and human provenance to prepared road blocks

**Files:**
- Modify: `src/core/roads.ts`
- Modify: `src/core/laneBase.ts`
- Modify: `src/core/enhancements.ts`
- Create: `src/core/effectiveLaneModel.test.mjs`

**Interfaces:**
- Produces: `applyLaneBaseToRoads(roads, index): LaneBaseApplyReport` and `guidanceForRoadDirection(road, back): ResolvedLaneGuidance`.
- Extends `RoadProps` with `laneFieldSourcesF` and `laneFieldSourcesB` for `laneCount`, `laneMovements`, and `motorcycleAccess`.

- [ ] **Step 1: Write failing road-application tests**

Create one road split into two blocks ending at different approach nodes. Assert that each block receives its own approach arrows, that segment lane count fills a missing approach lane count, and that the backward direction uses the opposite endpoint.

Add a human overlay test:

```js
applyLaneBaseToRoads([road], index)
applyToRoads([road], foldJournal([humanSet('way/10@b/1', { turn_lanes: 'left|through|right' })]))
assert.equal(road.properties.lanesForward, 3)
assert.deepEqual(road.properties.turnLanes, ['left', 'through', 'right'])
assert.equal(road.properties.laneFieldSourcesF.laneCount, 'lanepilot-segment')
assert.equal(road.properties.laneFieldSourcesF.laneMovements, 'human-block')
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/core/effectiveLaneModel.test.mjs`

Expected: FAIL because road provenance and `applyLaneBaseToRoads` are missing.

- [ ] **Step 3: Initialize OSM/inferred provenance in `roadsFromGeoJSON`**

Set lane-count source to `osm` only when a valid lane tag supplied the value; otherwise `inferred`. Set movement source to `osm` only when a non-empty turn-lane tag exists; otherwise `inferred`.

- [ ] **Step 4: Apply LanePilot base per block and direction**

For forward travel, resolve the block's final node; for backward travel, resolve its first node. Apply base fields to road properties and call `computeDerived` after changes. Return counts for applied blocks and any unresolved annotation keys.

- [ ] **Step 5: Mark human fields without broad record attribution**

In `applyToRoads`, change only provenance for fields explicitly present in the effective way/block maps. A block field marks `human-block`; a way field marks `human-way`. Saving unrelated editor fields must not mark lane fields as human.

- [ ] **Step 6: Expose effective road guidance and pass tests**

`guidanceForRoadDirection` returns the road's actual lane count, movements, and source. It returns `source: 'inferred'` if either lane count or movements needed for guidance is inferred; otherwise map LanePilot and human provenance to `annotation` and OSM provenance to `osm`.

Run: `node --test src/core/effectiveLaneModel.test.mjs src/core/motoAccess.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/core/roads.ts src/core/laneBase.ts src/core/enhancements.ts src/core/effectiveLaneModel.test.mjs
git commit -m "統一道路區塊的有效車道模型"
```

### Task 4: Replace the independent runtime HUD authority

**Files:**
- Modify: `src/app/mapCore.ts`
- Modify: `src/app/importFlow.ts`
- Modify: `src/core/staticDatabase.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/core/graphLaneDecision.test.mjs`
- Modify: `src/core/graphRouteState.test.mjs`

**Interfaces:**
- Consumes: `extractLaneBase`, `remapLaneBase`, `buildLaneBaseIndex`, `applyLaneBaseToRoads`, and `guidanceForRoadDirection`.
- Produces: `RoadGraph` routes whose spans and maneuvers carry guidance from effective road properties only.

- [ ] **Step 1: Add failing graph consistency tests**

Construct a road whose effective properties are three lanes `['through', 'through;right', 'right']`, while passing a contradictory legacy guidance index. Assert `RoadGraph` ignores the contradictory index, the right maneuver chooses lane 2, and the span guidance equals the road properties.

- [ ] **Step 2: Run graph tests and verify failure**

Run: `npm.cmd run test:graph-lane-decision`

Expected: the new contradiction test FAILS because `RoadGraph` still resolves its separate index.

- [ ] **Step 3: Change canonical load order in `mapCore`**

Replace the `Promise.all` fetch of `lane-guidance.json` with `staticAnnotations()` after `loadStaticRoadDatabase()`. Use this order:

```ts
const prepared = prepareBaseRoads(roadsRaw)
const extraction = extractLaneBase(staticAnnotations())
const remapped = remapLaneBase(extraction.records, remapOptions)
const laneBaseIndex = buildLaneBaseIndex(remapped.records)
applyLaneBaseToRoads(prepared.roads, laneBaseIndex)
const journal = remapJournalNodes(loadJournal(), prepared.nodeRemap)
applyToRoads(roadsWithNewRoads, foldJournal(journal))
```

If extraction/remapping has errors, throw a visible canonical data-load error. Delete `loadLaneGuidanceRecords`, `laneGuidanceRecordsRef`, `laneGuidanceIndexRef`, and the fallback warning.

- [ ] **Step 4: Make `RoadGraph` consume road guidance**

Remove `LaneGuidanceIndex` from the constructor and from `buildManeuvers`. Replace all `resolveLaneGuidance(index, ...)` calls with `guidanceForRoadDirection(edge.road, edge.back)`. The renderer already reads the same `RoadProps`, so this establishes one authority.

- [ ] **Step 5: Stop interactive annotation import from writing LanePilot journal**

Refactor `importAnnotations` to parse an in-memory base index and call `applyLaneBaseToRoads`; it must not call `appendRecord(..., 'lanepilot')`. Label this browser import as session-only in the UI message unless a later explicit canonical build is run.

- [ ] **Step 6: Run graph and import regressions**

Run: `npm.cmd run test:graph-lane-decision`

Run: `node --test src/core/graphRouteState.test.mjs scripts/build_lane_guidance.test.mjs`

Expected: all tests PASS; the legacy lane-guidance builder test remains as a derived-artifact compatibility test.

- [ ] **Step 7: Commit**

```powershell
git add src/app/mapCore.ts src/app/importFlow.ts src/core/staticDatabase.ts src/core/graph.ts src/core/graphLaneDecision.test.mjs src/core/graphRouteState.test.mjs
git commit -m "讓導航與繪圖共用有效車道資料"
```

### Task 5: Canonical motorcycle and waiting-zone base overlay

**Files:**
- Modify: `src/core/laneBase.ts`
- Modify: `src/core/zoneimport.ts`
- Modify: `src/app/mapCore.ts`
- Modify: `src/core/motoAccess.test.mjs`
- Modify: `src/core/motoBoxLimits.test.mjs`
- Create: `src/core/laneBaseZones.test.mjs`

**Interfaces:**
- Produces: base waiting zones derived from canonical movement rules, followed by human zone additions and `deleted_waiting_zone_ids` tombstones.
- Supplies motorcycle access and two-stage-turn policy from the same canonical annotation extraction used by lanes.

- [ ] **Step 1: Write failing motorcycle and zone overlay tests**

Test a movement-only annotation with `two_stage_required`, `waiting_zone_exists=yes`, and no lane profile. Assert it is accounted for, creates a base zone, and affects motorcycle policy. Add a tombstone test proving a deleted LanePilot zone stays deleted, while a human zone at the same intersection remains.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test src/core/laneBaseZones.test.mjs src/core/motoAccess.test.mjs src/core/motoBoxLimits.test.mjs`

Expected: at least the new base-zone tests FAIL.

- [ ] **Step 3: Build zones from canonical annotations once**

Change `zonesFromAnnotations` to accept the normalized movement-rule view or add `zonesFromLaneBase`. Deduplicate by stable LanePilot zone id, then overlay `editor.waiting_zones` and finally apply `deleted_waiting_zone_ids`.

- [ ] **Step 4: Resolve motorcycle access and two-stage policy from lane base**

Apply `motorcycle_access_by_lane` to the corresponding effective road direction before human journal. Use the normalized movement rule keyed by approach way/node/direction for `isTwoStage`; do not infer two-stage merely from the maneuver kind.

- [ ] **Step 5: Run focused and merged-junction tests**

Run: `node --test src/core/laneBaseZones.test.mjs src/core/motoAccess.test.mjs src/core/motoBoxLimits.test.mjs`

Run: `npm.cmd run test:merged-junctions`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/core/laneBase.ts src/core/zoneimport.ts src/app/mapCore.ts src/core/motoAccess.test.mjs src/core/motoBoxLimits.test.mjs src/core/laneBaseZones.test.mjs
git commit -m "統一機車與待轉 base 規則"
```

### Task 6: HUD provenance and exact inference warning

**Files:**
- Modify: `src/nav/lanePreview.ts`
- Modify: `src/nav/LanePreviewView.tsx`
- Modify: `src/nav/lanePreview.test.mjs`
- Modify: `src/nav/DriveHUD.tsx`

**Interfaces:**
- Consumes: span/maneuver `ResolvedLaneGuidance` created from effective road properties.
- Produces: HUD lanes and warning state that match rendered lanes exactly.

- [ ] **Step 1: Write failing HUD tests**

Add assertions that explicit human and LanePilot fields do not show an inference note, inferred movements do show `系統推測資料，請依現場標線行駛`, and a right maneuver highlights the same primary index returned by `LaneDecision`.

- [ ] **Step 2: Run HUD tests and verify failure**

Run: `npm.cmd run test:lane-preview`

Expected: the exact-copy assertion FAILS against the old `車道建議（系統推測）` text.

- [ ] **Step 3: Pass effective source through without re-inferring known lanes**

Keep `LaneDecision` responsible for recommended indices, but use `guidance.source` for data provenance. Do not mark guidance inferred merely because the selected maneuver is farther than the preparation threshold.

- [ ] **Step 4: Update the HUD copy and render it as small text**

Set:

```ts
inferenceNote: inferred ? '系統推測資料，請依現場標線行駛' : undefined
```

Keep the existing visual hierarchy in `LanePreviewView`; do not add a second warning component.

- [ ] **Step 5: Run HUD and navigation tests**

Run: `npm.cmd run test:lane-preview`

Run: `npm.cmd run test:graph-lane-decision`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/nav/lanePreview.ts src/nav/LanePreviewView.tsx src/nav/lanePreview.test.mjs src/nav/DriveHUD.tsx
git commit -m "同步 HUD 車道來源與推測提示"
```

### Task 7: Remap-aware candidate audit and canonical promotion gate

**Files:**
- Create: `scripts/lane_base_candidate_audit.ts`
- Create: `scripts/lane_base_candidate_audit.test.mjs`
- Modify: `scripts/build_static_road_database.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces report `{ source_annotations, accounted_annotations, lane_profiles, movement_rule_records, unmapped, conflicts, human_editor_hash_match, replay_errors, blocking_errors }`.
- Canonical builder consumes this report through `--base-audit=<path>`.

- [ ] **Step 1: Write failing audit-status tests**

Test that one unmapped approach produces `blocking_errors.length === 1` and process exit 2, while a mapped movement-only record counts as accounted and exits 0. Test that changing one human journal field makes `human_editor_hash_match=false` and blocks promotion.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test scripts/lane_base_candidate_audit.test.mjs`

Expected: FAIL because the audit module does not exist.

- [ ] **Step 3: Implement the offline candidate audit**

Load the candidate through `parseImported`, `prepareBaseRoads`, and the Task 2 remapper. Check every raw source key against `accountedSourceKeys`, require zero remap errors, and replay non-LanePilot journal through `applyToRoads`, new-road materialization, and road-merge views.

- [ ] **Step 4: Add package commands**

```json
"test:lane-base-audit": "node --test scripts/lane_base_candidate_audit.test.mjs",
"audit:lane-base-candidate": "node scripts/run_offline.mjs scripts/lane_base_candidate_audit.ts",
"verify:lane-base-candidate": "npm run test:lane-base-build && npm run test:lane-base-audit && npm run audit:lane-base-candidate"
```

- [ ] **Step 5: Run the candidate build and audit without touching canonical data**

Run: `npm.cmd run build:lane-base-candidate`

Run: `npm.cmd run verify:lane-base-candidate`

Expected: exit 0, `source_annotations=1485`, `accounted_annotations=1485`, `unmapped=0`, `blocking_errors=[]`, and `human_editor_hash_match=true`. If not, fix the converter or explicit mapping; do not add an allow-conflicts bypass.

- [ ] **Step 6: Commit**

```powershell
git add scripts/lane_base_candidate_audit.ts scripts/lane_base_candidate_audit.test.mjs scripts/build_static_road_database.mjs package.json
git commit -m "新增新 base 正式寫入閘門"
```

### Task 8: Promote the verified base and regenerate the human review

**Files:**
- Modify: `public/data/road_database.json`
- Modify: `scripts/manual_lane_journal_audit.ts`
- Modify: `docs/audits/manual-lane-journal-review.md`
- Modify: `docs/audits/manual-lane-journal-review.csv`
- Modify: `package.json`

**Interfaces:**
- Consumes: the verified candidate and audit report from Task 7.
- Produces: canonical database with non-empty annotations, zero `author=lanepilot` journal entries, and a regenerated human comparison using `resolveLaneBase`.

- [ ] **Step 1: Change the comparison audit to use canonical annotations**

Replace its `lane-guidance.json` load with `extractLaneBase(db.annotations)`, remapping, and the shared resolver. Add an `annotation_present_but_unmapped` category and make any nonzero count exit 2.

- [ ] **Step 2: Run the comparison against the candidate**

Run the audit with an explicit candidate path before promotion. Expected: a complete Markdown/CSV preview and zero unmapped records. Record the new category counts; do not reuse the old value of 488.

- [ ] **Step 3: Promote with an explicit verified report**

Run:

```powershell
node scripts/build_static_road_database.mjs --write-canonical --base-audit=.lanedev-backups/road_database.candidate.audit.json
```

Expected: a timestamped backup path is printed before the canonical file changes. Immediately verify `annotations.length === 1485`, `journal.filter(author=lanepilot).length === 0`, and the preserved-editor SHA-256 matches the candidate report.

- [ ] **Step 4: Regenerate the final report**

Run: `npm.cmd run audit:manual-lane-journal`

Expected: Markdown and CSV are updated from the canonical base, contain the same number of effective road-direction rows, and report zero `annotation_present_but_unmapped` rows.

- [ ] **Step 5: Remove production generation of the independent authority**

Remove `predev`/`prebuild` dependency on `lane-guidance:data`. Keep `lane-guidance:data` only if another offline compatibility test still needs it, and label the file derived/non-authoritative in the script header.

- [ ] **Step 6: Run the full verification set**

Run:

```powershell
npm.cmd run test:all
npm.cmd run verify:lane-base-candidate
npm.cmd run audit:manual-lane-journal
npm.cmd run build
git diff --check
```

Expected: every command exits 0. Existing informational couplet warnings are allowed only when the related audit still exits 0; new unmapped, hash, replay, navigation, or rendering findings are not allowed.

- [ ] **Step 7: Inspect the protected-data diff**

Confirm that `road_database.json` changes consist of populated annotations, removal of only LanePilot-authored journal records, preserved non-LanePilot editor data, expected `updated_at`, and no unexplained segment loss. Confirm the regenerated report uses the new base.

- [ ] **Step 8: Commit without pushing**

```powershell
git add public/data/road_database.json scripts/manual_lane_journal_audit.ts docs/audits/manual-lane-journal-review.md docs/audits/manual-lane-journal-review.csv package.json
git commit -m "建立統一 LanePilot base 並更新人工回查"
```

## Final Review Checklist

- [ ] `road_database.annotations.length === 1485` or a source-count change is explained by an updated input file and report.
- [ ] `author=lanepilot` journal count is zero.
- [ ] Non-LanePilot editor hash matches the pre-build value.
- [ ] Road renderer, `RoadGraph`, route ribbon, and HUD consume effective road properties.
- [ ] LanePilot approach, segment, motorcycle, and waiting-zone data all have accounted outcomes.
- [ ] HUD shows the exact inference note only for inferred data.
- [ ] The final human comparison is regenerated and has zero unmapped annotations.
- [ ] Full tests, audits, production build, and `git diff --check` pass.
- [ ] The branch remains local until the user explicitly requests a push.
