# Central-band channelization renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inferred and manually edited central-band configurations with one renderer, including the correct one-sided triangular closure.

**Architecture:** `buildChannelization()` remains the only yellow-marking producer. A pure metric-range helper defines a capped triangle from an effective turn bay's taper start to its approach-side stop boundary. Existing road and turn-bay journal values converge before this renderer; no second left/right shape authority remains.

**Tech Stack:** TypeScript, Turf geometry helpers, Node built-in test runner, Vite.

## Global Constraints

- `center_m`, `center_kind`, the two `turn_bay` end uses, and `single_mode` are the source of truth.
- `single_mode=capped`: triangle tip = physical turn-bay taper start; triangle cap = central double-yellow boundary immediately before the stop line.
- Never hatch a traversable turn bay, arrow, or through lane.
- `ignore` has no triangle; dual-ended use stays S-shaped; unused hatch central bands stay pure channelization.
- All hatches use `TAIWAN_YELLOW_HATCH_V1` (0.18m stroke, 1.25m pitch, 0.30m inset).
- Preserve journal v1 compatibility and do not stage user-generated `public/data/road_database.json` changes.
- Use Traditional Chinese Git commit messages.

---

### Task 1: Add a pure capped-triangle range contract

**Files:**
- Modify: `src/core/channelization.ts`
- Modify: `src/core/channelization.test.mjs`
- Delete: `src/core/turnbays-channelization.test.mjs`

**Interfaces:**
- Produces `buildCappedTriangleRange({ taperStartM, stopBoundaryM, movingAt, fixedOffsetM })`.
- Returns `null` below the shared minimum length; otherwise returns the unchanged metric bounds and lateral functions.

- [ ] **Step 1: Write the failing test**

```js
test('capped triangle begins at its taper and ends at its stop boundary', () => {
  const actual = buildCappedTriangleRange({
    taperStartM: 18, stopBoundaryM: 54, movingAt: () => 1.6, fixedOffsetM: -1.6,
  })
  assert.equal(actual.startM, 18)
  assert.equal(actual.endM, 54)
  assert.equal(actual.fixedOffsetM, -1.6)
})
test('too-short or reversed capped triangles are suppressed', () => {
  assert.equal(buildCappedTriangleRange({
    taperStartM: 54, stopBoundaryM: 18, movingAt: () => 1.6, fixedOffsetM: -1.6,
  }), null)
})
```

- [ ] **Step 2: Verify failure**

Run `node --test src/core/channelization.test.mjs`.

Expected: failure because the helper is not exported.

- [ ] **Step 3: Implement the smallest helper**

```ts
export function buildCappedTriangleRange(input: {
  taperStartM: number; stopBoundaryM: number
  movingAt: (distanceM: number) => number; fixedOffsetM: number
}) {
  if (input.stopBoundaryM - input.taperStartM < TAIWAN_YELLOW_HATCH_V1.minLengthM) return null
  return { startM: input.taperStartM, endM: input.stopBoundaryM,
    movingAt: input.movingAt, fixedOffsetM: input.fixedOffsetM }
}
```

- [ ] **Step 4: Verify pass and commit**

Run `node --test src/core/channelization.test.mjs` and expect all tests to pass.

Commit only these files with `git commit -m "建立單邊槽化三角幾何契約"`.

### Task 2: Render the one-sided triangle to the pre-stop-line boundary

**Files:**
- Modify: `src/core/turnbays.ts:615-845`
- Modify: `src/core/channelization.test.mjs`

**Interfaces:**
- Consumes `buildCappedTriangleRange()`, effective forward/backward bay data, and existing `s0`, `s1`, `setbackM` road-block limits.
- Produces `single-bay-unused`, `channel-hatch`, and `channel-cap` lines only inside the triangle.

- [ ] **Step 1: Write the failing regression test**

```js
test('a capped bay hatch ends at the pre-stop-line central boundary', () => {
  const lines = buildFixtureChannelization({ singleMode: 'capped', forwardBay: true })
  const outline = lines.find((line) => line.style === 'single-bay-unused')
  assert.ok(maxDistanceAlongFixture(outline.coords) <= fixture.preStopLineM)
  assert.ok(minDistanceAlongFixture(outline.coords) >= fixture.taperStartM)
})
```

- [ ] **Step 2: Verify failure**

Run `node --test src/core/channelization.test.mjs`.

Expected: the old geometry ends at `bay.endM`, not at the stop boundary.

- [ ] **Step 3: Replace wedge bounds with the triangle contract**

```ts
const triangle = buildCappedTriangleRange({
  taperStartM: activeBay.d0M,
  stopBoundaryM: total - activeBay.setbackM,
  movingAt: movingOff,
  fixedOffsetM: fixedOff,
})
```

Normalize the backward direction to the same road frame before creating the range. Emit outline, hatches, and the stop-side cap with `triangle.startM` and `triangle.endM`; retain the existing opposite-side offset rule.

- [ ] **Step 4: Verify pass and commit**

Run `node --test src/core/channelization.test.mjs; npm.cmd run build`.

Expected: all focused tests pass and Vite reports `built`.

Commit `src/core/turnbays.ts`, `src/core/channelization.ts`, and the focused test with `git commit -m "改用停止線邊界繪製單邊槽化三角面"`.

### Task 3: Converge manual central-band settings and inference

**Files:**
- Modify: `src/core/turnbays.ts:245-335,615-845`
- Modify: `src/edit/EditPanels.tsx:495-535`
- Modify: `src/edit/useEditor.ts:704-755`
- Modify: `src/core/channelization.test.mjs`

**Interfaces:**
- Consumes the existing central-band road journal and turn-bay journal.
- Produces identical geometry for equivalent automatic and manual settings.

- [ ] **Step 1: Write the failing parity test**

```js
test('equivalent manual and inferred capped settings have the same marking styles', () => {
  const inferred = buildFixtureChannelization({ singleMode: 'capped', forwardBay: true })
  const manual = buildFixtureChannelization({
    singleMode: 'capped', forwardBay: true, journal: manualCentralBandJournal,
  })
  assert.deepEqual(stylesAndOwners(manual), stylesAndOwners(inferred))
})
```

- [ ] **Step 2: Verify failure**

Run `node --test src/core/channelization.test.mjs`.

Expected: independent channelization overrides can currently alter capped geometry.

- [ ] **Step 3: Keep only central-band authority**

Use `singleBay.singleMode === 'capped'` to select the triangle. Keep `channelization` records as compatibility/review data, but do not let side or width overrides move a capped triangle. In the existing panel replace editable side text with `中央帶設定決定槽化形狀`.

- [ ] **Step 4: Verify pass and commit**

Run `node --test src/core/channelization.test.mjs; npm.cmd run build`.

Commit source and test changes with `git commit -m "統一中央帶編輯與自動槽化繪製來源"`.

### Task 4: A-area visual and local-data verification

**Files:**
- Test: `src/core/channelization.test.mjs`
- Modify only if needed: `docs/superpowers/specs/2026-07-29-central-band-channelization-renderer-zh-TW.md`

**Interfaces:**
- Consumes the renderer from Tasks 1–3 and the A-area local map case.
- Produces evidence that automatic and existing editor settings render the accepted four outcomes.

- [ ] **Step 1: Run final focused checks**

Run `node --test src/core/channelization.test.mjs; npm.cmd run build`.

Expected: all focused tests pass and production build succeeds.

- [ ] **Step 2: Inspect A area in the isolated-worktree map**

Confirm the triangle begins at the left-turn split, ends at the central double-yellow boundary immediately before the stop line, and does not cover the left-turn arrow/lane. Toggle capped, ignore, and dual-ended central-band choices; confirm the specified triangle, no-triangle, and S-shift outcomes.

- [ ] **Step 3: Check staging scope**

Run `git status --short`.

Expected: do not stage `public/data/road_database.json`; it is local editor state. Stage only intentional source, test, and documentation edits.

## Self-review

- Tasks 1–2 cover the exact capped triangle and shared hatch profile.
- Task 3 converges automatic and manual central-band data before rendering.
- Task 4 covers the requested A-area visual acceptance and protects local user data.
- The plan has no unassigned requirements or placeholder implementation steps.
