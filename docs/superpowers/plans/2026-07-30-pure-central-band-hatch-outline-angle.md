# Pure Central-band Hatch Outline and Angle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close both ends of a pure central-band hatch and keep its diagonal stripes at the accepted 3.2 m reference angle for every band width.

**Architecture:** Keep the accepted offset-turn-bay renderer unchanged. In the existing ordinary central-band branch, detect the no-bay case, scale each stripe's longitudinal run from its usable lateral span, clip only the final endpoint against `he`, and emit transverse caps at `hs` and `he`.

**Tech Stack:** TypeScript 6, GeoJSON, Node test runner, Vite SSR test loader, MapLibre GL.

## Global Constraints

- Modify only a hatch central band with no forward or backward offset turn bay.
- Keep the accepted 3.2 m band appearance: 2.6 m usable width and 1.25 m longitudinal stripe run.
- Keep stripe start pitch at 1.25 m and stroke width at 0.18 m.
- Add one transverse cap at `hs` and one at `he`.
- Preserve all accepted offset-turn-bay triangle, cap, and hatch geometry.
- Do not stage or modify `public/data/road_database.json`.

---

### Task 1: Specify caps and width-independent angle with failing tests

**Files:**
- Modify: `src/core/channelization.test.mjs`

**Interfaces:**
- Consumes: `buildChannelization(graph, bays, journal)`.
- Produces: regression assertions over `PaintLine[]` geometry.

- [ ] **Step 1: Add the pure-band cap regression**

Build the existing no-bay 3.2 m fixture, select `style === 'channel-cap'`, and assert that it has exactly two nonzero transverse lines at the two ends of the drawable central-band range.

- [ ] **Step 2: Add the reference-angle regression**

Build no-bay fixtures at 1.6 m, 3.2 m, and 4.8 m. For every diagonal line, calculate its longitudinal run and lateral run in the fixture road frame. Assert that `longitudinalRun / lateralRun` equals `1.25 / 2.6` within geographic projection tolerance, including the last clipped stripe.

- [ ] **Step 3: Preserve density and turn-bay assertions**

Keep the existing assertion that stripe start stations remain 1.25 m apart. Do not edit the existing forward and backward capped-bay expectations.

- [ ] **Step 4: Run the focused test and observe RED**

Run:

```powershell
node --test src/core/channelization.test.mjs
```

Expected: the new cap test reports zero instead of two, and the new angle test reports different ratios across widths.

### Task 2: Implement pure-band caps and reference-angle clipping

**Files:**
- Modify: `src/core/channelization.ts`
- Modify: `src/core/turnbays.ts`

**Interfaces:**
- Consumes: `TAIWAN_YELLOW_HATCH_V1`, `hs`, `he`, `dv`, and `c`.
- Produces: pure-band `channel-hatch` lines at a constant angle and two `channel-cap` lines.

- [ ] **Step 1: Record the 3.2 m reference width**

Add `referenceBandWidthM: 3.2` to `TAIWAN_YELLOW_HATCH_V1`.

- [ ] **Step 2: Scale only pure-band stripe run**

For a no-bay pure hatch, calculate:

```ts
const usableWidthM = Math.max(0, 2 * c - 2 * TAIWAN_YELLOW_HATCH_V1.insetM)
const referenceUsableWidthM = TAIWAN_YELLOW_HATCH_V1.referenceBandWidthM
  - 2 * TAIWAN_YELLOW_HATCH_V1.insetM
const stripeRunM = usableWidthM
  * TAIWAN_YELLOW_HATCH_V1.stripePitchM / referenceUsableWidthM
```

Keep the old `stripePitchM` run in every turn-bay branch.

- [ ] **Step 3: Clip the last stripe without changing its angle**

When `d + stripeRunM` exceeds `he - insetM`, set the endpoint station to
`he - insetM` and linearly interpolate the endpoint's lateral offset by the
remaining longitudinal fraction.

- [ ] **Step 4: Add the two pure-band caps**

When no forward or backward bay exists and the pure hatch meets the minimum
length, emit `channel-cap` lines at `hs` and `he`, each spanning `dv - c` to
`dv + c`.

- [ ] **Step 5: Run the focused test and observe GREEN**

Run:

```powershell
node --test src/core/channelization.test.mjs
```

Expected: all channelization tests pass, including unchanged offset-turn-bay tests.

### Task 3: Verify production behavior and hand off for visual acceptance

**Files:**
- Verify: `src/core/channelization.ts`
- Verify: `src/core/turnbays.ts`
- Verify: `src/core/channelization.test.mjs`
- Verify: both English and Traditional Chinese design specifications

**Interfaces:**
- Consumes: the completed renderer and the existing editor selection `centerKind='hatch'`.
- Produces: acceptance-ready output on the fixed local port `5176`.

- [ ] **Step 1: Run all relevant automated tests**

Run:

```powershell
node --test src/core/channelization.test.mjs
npm.cmd run test:lane-guidance
npm.cmd run test:lane-preview
```

Expected: every command exits zero.

- [ ] **Step 2: Build production assets**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript and Vite build successfully.

- [ ] **Step 3: Inspect the exact diff**

Run:

```powershell
git diff --check
git diff --stat
git status --short
```

Expected: only the renderer, regression tests, bilingual specification, and this plan are part of the implementation; the road database remains unstaged user data.

- [ ] **Step 4: Visually verify at the fixed port**

At `http://127.0.0.1:5176/`, compare pure hatch bands of different widths and confirm both short caps, equal diagonal angle, equal start density, and unchanged accepted offset-turn-bay triangles.

- [ ] **Step 5: Commit only the feature files**

Stage only the renderer, tests, bilingual specifications, and this plan. Use a primarily Chinese commit message.
