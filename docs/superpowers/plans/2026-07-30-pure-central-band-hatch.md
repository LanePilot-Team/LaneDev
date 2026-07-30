# Pure Central-band Hatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render fixed-density yellow hatches inside a hatch-type central band even when the road has no offset turn bay.

**Architecture:** Reuse the existing `buildChannelization()` central-band bounds and `buildHatchDistances()` station generator. The ordinary central-band hatch loop will be enabled by the road's existing hatch configuration instead of by the presence of a turn-bay key; all one-sided turn-bay geometry stays on its current branch.

**Tech Stack:** TypeScript 6, GeoJSON, Node test runner, Vite SSR test loader, MapLibre GL.

## Global Constraints

- Trigger only for bidirectional roads with `centerM > 0` and `centerKind === 'hatch'`.
- Use `TAIWAN_YELLOW_HATCH_V1`: 0.18 m stroke, 1.25 m pitch, 0.30 m inset, and 3 m minimum length.
- Different road lengths change only stripe count; different widths change only stripe endpoints.
- Do not modify accepted offset-turn-bay channelization geometry.
- Do not include the temporary left-turn-arrow cleanup exception.
- Do not stage or modify `public/data/road_database.json`.

---

### Task 1: Remove the diagnostic arrow preview

**Files:**
- Modify: `src/core/intersectionCleanup.ts:65-75`
- Delete: `src/core/intersectionCleanup.test.mjs`

**Interfaces:**
- Consumes: the committed pre-diagnosis intersection-cleanup behavior.
- Produces: a clean baseline where this feature changes only central-band hatch rendering.

- [ ] **Step 1: Remove the temporary exception**

Restore the preserved-feature condition to:

```ts
if (f.properties?.style === 'left-wait-side'
  || f.properties?.style === 'left-wait-front') {
  features.push(f)
  continue
}
```

- [ ] **Step 2: Remove the diagnostic-only test**

Delete `src/core/intersectionCleanup.test.mjs`, which tests a behavior the user explicitly deferred.

- [ ] **Step 3: Verify the source diff**

Run:

```powershell
git diff -- src/core/intersectionCleanup.ts src/core/intersectionCleanup.test.mjs
```

Expected: no remaining diff for either path.

### Task 2: Enable pure central-band hatch rendering with TDD

**Files:**
- Modify: `src/core/channelization.test.mjs`
- Modify: `src/core/turnbays.ts:880-895`

**Interfaces:**
- Consumes: `buildChannelization(graph, bays, journal)` and `buildHatchDistances(startM, endM)`.
- Produces: `PaintLine[]` entries with `style === 'channel-hatch'` for a hatch central band without bays.

- [ ] **Step 1: Add a failing no-bay regression test**

Extend the existing fixture helper so its road width and center kind can be selected, then add:

```js
test('a hatch central band without turn bays fills its valid central range', () => {
  const hatches = buildFixtureChannelization({
    forwardBay: false,
    bays: [],
    centerM: 3.2,
  }).filter((line) => line.style === 'channel-hatch')

  assert.ok(hatches.length > 2)
})
```

The helper must pass an empty bay array to `buildChannelization()` rather than creating a disabled bay.

- [ ] **Step 2: Add fixed-density and exclusion assertions**

Add assertions that:

```js
for (let i = 1; i < hatches.length; i++) {
  assert.ok(Math.abs(
    distanceAlongFixture(hatches[i].coords[0])
      - distanceAlongFixture(hatches[i - 1].coords[0])
      - TAIWAN_YELLOW_HATCH_V1.stripePitchM
  ) < 0.02)
}
```

Run the same stations with `centerM: 1.6` and `centerM: 4.8`; assert that station sequences match while endpoint separation changes. Assert that `centerM: 0` and `centerKind: 'island'` yield no pure hatch lines.

- [ ] **Step 3: Run the focused test and observe RED**

Run:

```powershell
node --test src/core/channelization.test.mjs
```

Expected: the no-bay regression fails because the hatch count is zero, while existing offset-turn-bay tests pass.

- [ ] **Step 4: Implement the minimal renderer change**

In the ordinary central-band hatch loop, replace the bay-key gate with the already-established road kind:

```ts
const shouldPaintCentralHatch = p.centerKind === 'hatch'
for (const d of shouldPaintCentralHatch ? buildHatchDistances(hs, he) : []) {
```

Retain the existing `hs`, `he`, `dv ± c`, inset, owner key, and
`channel-hatch` style. Do not edit the one-sided branch above it.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run:

```powershell
node --test src/core/channelization.test.mjs
```

Expected: all central-band and offset-turn-bay channelization tests pass.

### Task 3: Verify build and map output

**Files:**
- Verify: `src/core/channelization.ts`
- Verify: `src/core/turnbays.ts`
- Verify: `src/core/channelization.test.mjs`
- Output: a local PNG screenshot outside the repository

**Interfaces:**
- Consumes: the completed renderer and the existing editor selection `centerKind='hatch'`.
- Produces: an acceptance-ready map view on `http://127.0.0.1:5176/`.

- [ ] **Step 1: Run the full relevant test suite**

Run:

```powershell
node --test src/core/channelization.test.mjs src/core/graph.test.mjs src/core/laneGuidance.test.mjs
```

Expected: all tests pass without changing accepted turn-bay assertions.

- [ ] **Step 2: Build production assets**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript and Vite build successfully; existing bundle-size warnings are acceptable.

- [ ] **Step 3: Verify exact source scope**

Run:

```powershell
git diff --check
git diff --stat
git status --short
```

Expected: implementation changes are limited to the channelization test and renderer, plus this plan; `public/data/road_database.json` remains an unstaged user change.

- [ ] **Step 4: Perform browser visual verification**

On the existing fixed port `5176`, select or retain a road with positive central width, `centerKind='hatch'`, and no turn bay. Confirm:

- yellow diagonal hatches fill only the central band;
- stripe spacing remains uniform from start to end;
- changing central width alters stripe length but not density;
- accepted offset-turn-bay channelization remains visually unchanged.

- [ ] **Step 5: Commit the implementation**

Stage only:

```powershell
git add -- src/core/turnbays.ts src/core/channelization.test.mjs docs/superpowers/plans/2026-07-30-pure-central-band-hatch.md
git commit -m "新增無偏心道中央帶槽化線"
```
