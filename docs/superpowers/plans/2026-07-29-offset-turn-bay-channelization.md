# Offset Turn-Bay Channelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a consistent, road-relative channelization closure only for offset turn bays, allow a reviewer to override it, and persist a reviewable offset-turn-bay record in the existing editor data.

**Architecture:** Keep `editor.journal` as the append-only source of truth. A pure channelization model folds `turn_bay`, `channelization`, and `approach_marking_review` journal records into one `OffsetTurnBayMarkingRecord` per parent bay key; `editor.offset_turn_bay_markings` is regenerated from that model when the editor is saved or exported. Rendering consumes the same model and emits one metric hatch profile, replacing the current duplicated/unreachable one-sided hatch branches in `buildChannelization()`.

**Tech Stack:** React 19, TypeScript, MapLibre GL, Turf, Node built-in test runner, Vite.

## Global Constraints

- Keep the feature branch `codex/channelization-editor` isolated; do not merge or push to `main`.
- A channelization area may exist only as a child of an effective offset turn bay; generic standalone hatching remains out of scope.
- Follow Street View/field evidence as closely as the available road geometry permits; record any geometry-limited approximation in the review note.
- Use the one metric profile `taiwan-yellow-hatch-v1` for every channelization area: constant yellow stroke family, 0.18 m stripe width, 1.25 m stripe pitch, 45-degree road-relative hatch angle, and 0.30 m boundary inset.
- Preserve every existing `road` and `turn_bay` journal record and existing navigation semantics.
- UI copy uses Traditional Chinese: 「偏心道」、「槽化帶」、「未使用側封閉」、「人工回查」. Do not expose `turn_bay` as user-facing copy.
- New committed documentation must keep matching English and Traditional Chinese versions.

---

## File structure

- Create `src/core/channelization.ts`: pure types, key helpers, journal folding, review-index derivation, metric hatch sampling, and all unit-testable decisions.
- Create `src/core/channelization.test.mjs`: Node tests for parent/child eligibility, key isolation, history folding, review records, and constant hatch pitch across tapered widths.
- Modify `src/core/enhancements.ts`: extend `EnhancementRecord.target.type`, re-export the derived index during enhancement export, and preserve child-key remapping.
- Modify `src/core/staticDatabase.ts`: persist `editor.offset_turn_bay_markings` beside the existing journal through the current editor save API.
- Modify `src/core/turnbays.ts`: obtain effective channelization specs from the journal and replace the duplicate one-sided branches with the pure renderer.
- Modify `src/app/mapCore.ts`: pass the journal to channelization rendering and refresh/save the derived index after editor changes.
- Modify `src/edit/useEditor.ts`: append channelization/review records through narrowly scoped editor methods and immediately redraw.
- Modify `src/edit/EditPanels.tsx`: place a 「槽化帶與人工回查」 section inside the existing 偏心道 panel.
- Modify `src/App.css`: add only local styles needed for the new compact review field group.

## Task 1: Add the offset-turn-bay record model and persistence contract

**Files:**
- Create: `src/core/channelization.ts`
- Create: `src/core/channelization.test.mjs`
- Modify: `src/core/enhancements.ts:15-39, 417-470`
- Modify: `src/core/staticDatabase.ts:5-12, 56-66, 113-119`

**Interfaces:**
- Produces `parentBayKey(key: string): string`, `channelizationKey(parentKey: string): string`, and `reviewKey(parentKey: string): string`.
- Produces `buildOffsetTurnBayMarkings(journal: EnhancementRecord[], bays: TurnBay[]): OffsetTurnBayMarkingRecord[]`.
- `OffsetTurnBayMarkingRecord` has `{ key, offset_bay, channelization, review }`; `channelization.state` is `none | auto | override | disabled`.
- `StaticEditorState` gains `offset_turn_bay_markings: OffsetTurnBayMarkingRecord[]` with `[]` as its backward-compatible default.

- [ ] **Step 1: Write the failing model tests**

Create `src/core/channelization.test.mjs` with these exact assertions:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOffsetTurnBayMarkings, channelizationKey, reviewKey,
} from './channelization.ts'

const parent = 'way/7@node/9'
const bay = { key: parent, turns: 'left', bayLenM: 30, taperLenM: 15, widthM: 3,
  source: 'manual', singleMode: 'capped', back: false }
const rec = (type, key, fields, seq) => ({ seq, ts: '2026-07-29T00:00:00.000Z',
  author: 'test', op: 'set', target: { type, key }, fields })

test('one offset bay creates one review index record even without channelization', () => {
  assert.deepEqual(buildOffsetTurnBayMarkings([], [bay]), [{
    key: parent,
    offset_bay: { state: 'active', turns: 'left', source: 'manual', bay_len_m: 30,
      taper_len_m: 15, width_m: 3 },
    channelization: { state: 'none' },
    review: { status: 'unreviewed' },
  }])
})

test('channelization and review child records do not overwrite each other', () => {
  const records = [
    rec('channelization', channelizationKey(parent), { mode: 'override', closure: 'unused-side', s_start_m: 8, s_end_m: 34, width_start_m: 0.2, width_end_m: 3 }, 1),
    rec('approach_marking_review', reviewKey(parent), { status: 'verified', evidence_url: 'https://example.test/pano', note: '現地封閉' }, 2),
  ]
  const [actual] = buildOffsetTurnBayMarkings(records, [bay])
  assert.equal(actual.channelization.state, 'override')
  assert.equal(actual.channelization.closure, 'unused-side')
  assert.equal(actual.review.status, 'verified')
  assert.equal(actual.review.note, '現地封閉')
})

test('disabled channelization stays reviewable and produces no active geometry', () => {
  const [actual] = buildOffsetTurnBayMarkings([
    rec('channelization', channelizationKey(parent), { mode: 'disabled' }, 1),
  ], [bay])
  assert.deepEqual(actual.channelization, { state: 'disabled' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/core/channelization.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `channelization.ts`.

- [ ] **Step 3: Implement the model and schema changes**

Create the following public type and helper surface in `src/core/channelization.ts`:

```ts
export type ChannelizationState = 'none' | 'auto' | 'override' | 'disabled'
export interface OffsetTurnBayMarkingRecord {
  key: string
  offset_bay: { state: 'active'; turns: string; source: 'default' | 'manual'; bay_len_m: number; taper_len_m: number; width_m: number }
  channelization: { state: ChannelizationState; closure?: 'none' | 'unused-side'; s_start_m?: number; s_end_m?: number; width_start_m?: number; width_end_m?: number; style?: 'taiwan-yellow-hatch-v1' }
  review: { status: 'unreviewed' | 'reviewed' | 'verified' | 'needs_review'; evidence_url?: string; evidence_captured_at?: string; reviewed_by?: string; reviewed_at?: string; confidence?: number; note?: string }
}

export const channelizationKey = (parentKey: string) => `${parentKey}#channelization`
export const reviewKey = (parentKey: string) => `${parentKey}#review`
export const parentBayKey = (key: string) => key.replace(/#(?:channelization|review)$/, '')
```

Implement `buildOffsetTurnBayMarkings` by reading only the latest `set` fields for each exact child key, then iterating effective `TurnBay[]`. Do not make a record for a child journal key whose parent is not an effective bay. Extend `EnhancementRecord.target.type` with `'channelization' | 'approach_marking_review'`; add `offset_turn_bay_markings` to both `StaticEditorState` and `emptyEditor`; include it in `updateStaticEditor` calls and enhancement exports. Persist it only as a derived snapshot, never as a second editable source.

- [ ] **Step 4: Run model tests and type check**

Run: `node --test src/core/channelization.test.mjs && npm run build`

Expected: all three tests pass and TypeScript/Vite build succeeds.

- [ ] **Step 5: Commit**

```powershell
git add src/core/channelization.ts src/core/channelization.test.mjs src/core/enhancements.ts src/core/staticDatabase.ts
git commit -m "新增偏心道槽化帶回查資料模型"
```

## Task 2: Replace inconsistent hatch drawing with one metric profile

**Files:**
- Modify: `src/core/channelization.ts`
- Modify: `src/core/channelization.test.mjs`
- Modify: `src/core/turnbays.ts:610-930`
- Modify: `src/app/mapCore.ts:344-360`

**Interfaces:**
- Produces `resolveChannelization(parentKey, bay, journal): EffectiveChannelization | null`.
- Produces `buildHatchDistances(startM, endM, pitchM = 1.25): number[]`.
- `buildChannelization(graph, bays, journal)` replaces the existing two-argument call.

- [ ] **Step 1: Write failing hatch-profile tests**

Append these tests:

```js
import { buildHatchDistances, resolveChannelization } from './channelization.ts'

test('hatch distances retain the same 1.25 m pitch for narrow and wide tapered regions', () => {
  assert.deepEqual(buildHatchDistances(0.3, 5.4), [1.25, 2.5, 3.75, 5])
  assert.deepEqual(buildHatchDistances(0.3, 9.1), [1.25, 2.5, 3.75, 5, 6.25, 7.5, 8.75])
})

test('single capped bay defaults to an unused-side closure but ignore produces none', () => {
  assert.equal(resolveChannelization(parent, { ...bay, singleMode: 'capped' }, []).closure, 'unused-side')
  assert.equal(resolveChannelization(parent, { ...bay, singleMode: 'ignore' }, []), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/core/channelization.test.mjs`

Expected: FAIL because `buildHatchDistances` and `resolveChannelization` are not exported.

- [ ] **Step 3: Implement the profile and render integration**

Implement the exact profile constants in `channelization.ts`:

```ts
export const TAIWAN_YELLOW_HATCH_V1 = {
  style: 'taiwan-yellow-hatch-v1' as const,
  stripeWidthM: 0.18,
  stripePitchM: 1.25,
  insetM: 0.30,
  minLengthM: 3,
}
```

`resolveChannelization` must return `null` for: no effective parent bay; a paired bay; `singleMode === 'ignore'`; or an explicit `disabled` child record. For a single `capped` bay with no child record it returns the auto `unused-side` closure. For an override it uses the stored road-relative start/end and endpoint widths, clamped to the parent bay's usable range.

In `turnbays.ts`, remove the repeated `if (onlyFwdBay || onlyBwdBay)` branches after the early `singleMode === 'ignore'` branch. Retain the paired-bay S-line path. For a resolved single-bay closure, draw exactly two road-relative boundary lines, optional start/end caps, and diagonals at distances returned by `buildHatchDistances`; use `TAIWAN_YELLOW_HATCH_V1` constants rather than the existing 4 m / 3.5 m / 1.25 m literals. Pass `core.journalRef.current` from `mapCore.ts` whenever `buildChannelization` runs.

- [ ] **Step 4: Run geometry tests, existing tests, and build**

Run: `node --test src/core/channelization.test.mjs src/core/graph.test.mjs src/core/laneGuidance.test.mjs && npm run build`

Expected: all tests pass; no TypeScript errors; no duplicate or unreachable one-sided hatch branch remains.

- [ ] **Step 5: Commit**

```powershell
git add src/core/channelization.ts src/core/channelization.test.mjs src/core/turnbays.ts src/app/mapCore.ts
git commit -m "統一偏心道槽化帶繪製規格"
```

## Task 3: Add editor controls for automatic, override, disabled, and review states

**Files:**
- Modify: `src/edit/useEditor.ts:119-150, 863-875, 936-944`
- Modify: `src/edit/EditPanels.tsx:494-530`
- Modify: `src/App.css`

**Interfaces:**
- `Editor.overrideChannelization(parentKey: string, fields: Record<string, string | number>): void` appends one `channelization` record at `channelizationKey(parentKey)`.
- `Editor.saveOffsetTurnBayReview(parentKey: string, fields: Record<string, string | number>): void` appends one `approach_marking_review` record at `reviewKey(parentKey)`.
- Both call `core.refreshBays()`, `core.redrawRoads()`, and persist a refreshed `offset_turn_bay_markings` snapshot.

- [ ] **Step 1: Add a failing manual acceptance checklist before UI code**

Create this checklist in the task commit message body or `docs/superpowers/plans/2026-07-29-offset-turn-bay-channelization.md` under this task, then use it during Step 4:

```text
1. Select 偏心道 and choose a road with an effective single-sided bay.
2. Confirm 「槽化帶與人工回查」 shows 自動封閉、人工覆寫、停用三種 choices.
3. Select 停用 and save: the unused-side boundary/hatches disappear but the bay remains.
4. Select 人工覆寫, set closure=未使用側封閉 and values 8, 34, 0.2, 3.0: redraw follows the changed road-relative range.
5. Enter evidence URL and note, save, reload the map, and confirm they remain visible.
6. Select a road without an effective偏心道: no 槽化帶 controls appear.
```

- [ ] **Step 2: Implement the narrow editor methods**

Add these methods next to `overrideBay` in `useEditor.ts`:

```ts
function overrideChannelization(parentKey: string, fields: Record<string, string | number>) {
  core.journalRef.current = appendRecord(core.journalRef.current, {
    op: 'set', target: { type: 'channelization', key: channelizationKey(parentKey) }, fields,
  })
  core.refreshBays()
  core.redrawRoads()
}
function saveOffsetTurnBayReview(parentKey: string, fields: Record<string, string | number>) {
  core.journalRef.current = appendRecord(core.journalRef.current, {
    op: 'set', target: { type: 'approach_marking_review', key: reviewKey(parentKey) }, fields,
  })
  core.refreshBays()
}
```

Add a section below the current 「偏心道格式」 controls only when the selected side has an effective bay. Use buttons labelled 「自動判定」、「人工覆寫」、「停用槽化帶」; show closure select, four numeric inputs (`s_start_m`, `s_end_m`, `width_start_m`, `width_end_m`) only for override; and show evidence URL, review status, confidence, and note. Do not add a new top-level tool.

- [ ] **Step 3: Build and open the local editor**

Run: `npm run build && npm run dev -- --host 127.0.0.1`

Expected: build succeeds and the dev server reports a local URL.

- [ ] **Step 4: Perform the six-point manual checklist and capture screenshots**

Use the existing A/B/C evidence locations from the specification. Capture one baseline and one updated image for each changed candidate; record the screenshot paths and the `OffsetTurnBayMarkingRecord.key` used for the edit. Do not accept a visual result if stripes differ in density merely because width changes.

- [ ] **Step 5: Commit**

```powershell
git add src/edit/useEditor.ts src/edit/EditPanels.tsx src/App.css
git commit -m "加入偏心道槽化帶與回查編輯介面"
```

## Task 4: Verify data persistence, existing behavior, and field-evidence cases

**Files:**
- Modify: `src/core/channelization.test.mjs`
- Modify: `docs/superpowers/specs/2026-07-29-channelization-editor-design.md`
- Modify: `docs/superpowers/specs/2026-07-29-channelization-editor-design.zh-TW.md`

**Interfaces:**
- Consumes `buildOffsetTurnBayMarkings`, `exportEnhancements`, and the local editor save API.
- Produces documented before/after evidence for the three agreed locations and a verified acceptance record for each.

- [ ] **Step 1: Add export and key-remap tests**

Add tests asserting that: (a) exported enhancements contain `offset_turn_bay_markings`; (b) a `#channelization` and `#review` child key follows its parent when a couplet node is remapped; and (c) a disabled child remains visible in the index with `state: 'disabled'`. Use parent `way/7@node/9`, remapped parent `way/7@node/19`, and assert both suffixes survive exactly.

- [ ] **Step 2: Run the complete automated verification**

Run: `node --test src/core/channelization.test.mjs src/core/graph.test.mjs src/core/laneGuidance.test.mjs scripts/build_lane_guidance.test.mjs src/nav/lanePreview.test.mjs && npm run build`

Expected: all tests pass and `dist/` is produced.

- [ ] **Step 3: Validate the agreed field cases**

Check the following in the local map and record each result in both specification files:

```text
A  援中路 → 高雄大學路, 22.7232222,120.2859722:
   one-sided actual unused area; override or auto must create a closed, consistently hatched unused side.
B1 後昌路／西濱, 22.7116111,120.2950000:
   no usable unused-side closure; offset bay must not gain hatching solely because it is single-sided.
B2 後昌路 747, 22.7098302,120.2967033:
   inspect the unused side and confirm a closure is available only when field evidence supports it.
C  後昌路 761, 22.7101883,120.2963853:
   dual-sided case; keep the S-line and use a documented geometry approximation only when needed.
```

- [ ] **Step 4: Update bilingual evidence summary**

Append a compact A/B1/B2/C table to both specification files with: parent key, auto/override/disabled state, evidence URL, screenshot path, reviewer, and result. Keep English and Traditional Chinese rows aligned.

- [ ] **Step 5: Commit**

```powershell
git add src/core/channelization.test.mjs docs/superpowers/specs/2026-07-29-channelization-editor-design.md docs/superpowers/specs/2026-07-29-channelization-editor-design.zh-TW.md
git commit -m "驗證偏心道槽化帶資料與實景案例"
```

## Self-review

- Spec coverage: Task 1 preserves journal history and adds the offset-turn-bay review index; Task 2 fixes the universal hatch profile and red-line-equivalent closure; Task 3 supplies automatic/manual/disabled controls and manual evidence; Task 4 covers A/B/C visual and persistence acceptance.
- No standalone channelization: Tasks 1–3 all require an effective parent bay and hide controls otherwise.
- Type consistency: child journal keys always derive from the same parent key with `#channelization` or `#review`; the persisted and exported derived field is always `offset_turn_bay_markings`.
- Placeholder scan: all task steps name exact files, signatures, commands, expected results, and acceptance inputs.
