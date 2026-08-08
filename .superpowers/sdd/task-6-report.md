# Task 6 report: HUD provenance and inference warning

## Scope

- Changed only `src/nav/lanePreview.ts`, `src/nav/LanePreviewView.tsx`, and `src/nav/lanePreview.test.mjs`.
- `DriveHUD.tsx` was inspected: it already selects the effective current/maneuver `ResolvedLaneGuidance` and forwards its `laneCount`, `laneMovements`, and `source` together with the route `LaneDecision`. No parser, fetch, fallback authority, or GPS lane inference was added.
- No canonical road-data file was changed.

## RED

Added provenance and primary-index tests before production changes, then ran `npm.cmd run test:lane-preview`.

- `only shows the exact inference note from inferred effective guidance` failed because the old note text was returned instead of the required exact copy.
- `does not reclassify explicit effective guidance from an inferred decision` failed because explicit `annotation` guidance was marked inferred from `LaneDecision.inferred`.
- The saved `LaneDecision` primary-index test was already green; it documents the existing shared-index behavior rather than introducing a second selection rule.

## GREEN and verification

- `npm.cmd run test:lane-preview` — 20 passed.
- `npm.cmd run test:graph-lane-decision` — 9 passed.
- `npx.cmd tsc --noEmit` — passed.
- `npm.cmd run test:all` — passed (all configured suites green).
- `git diff --check` — passed.

## Superseded exact-copy search

- `rg -n -F "蝟餌絞?冽葫鞈?嚗?靘?湔?蝺?擏." src` found exactly one production policy definition: `src/nav/lanePreview.ts` (`INFERENCE_NOTE`); the test assertion separately verifies that literal.
- `rg -n -F "車道建議（系統推測）" src` returned no matches, confirming the old inference warning was removed.

## Self-review

- `guidanceIsInferred` uses the resolved guidance source whenever it exists, so distance/preparation timing and `LaneDecision.inferred` cannot reclassify explicit human, LanePilot, mixed annotation+OSM, or OSM guidance.
- Correction: callers without effective provenance now conservatively receive no inference note; `LaneDecision.inferred` and local defaults are not warning authorities.
- `applyLaneStates` still uses `LaneDecision.primaryLaneIndex` and secondary indices directly while in the preparation range; the view only consumes the resulting model and renders the single `inferenceNote` as the existing small secondary text.
- No raw annotation/legacy guidance inspection was added, and no physical-lane claim is derived from GPS.

## Commit

- `8d94345` — initial HUD provenance implementation.
- `a9f3e03` — initial Task 6 report (separate commit; `8d94345` was not amended).
- `01a9ece` — review correction for UTF-8 warning text and exclusive effective-provenance authority.

## Concerns

None after the review corrections below.

## Review correction evidence

This section supersedes the earlier exact-copy and missing-provenance claims.

### Correction RED

After updating tests first, `npm.cmd run test:lane-preview` failed exactly twice:

- `only shows the exact inference note from inferred effective guidance` received the mojibake literal instead of `系統推測資料，請依現場標線行駛`.
- `missing effective provenance does not invent an inference warning` received `inferred: true` instead of `false`, proving the fallback to `LaneDecision.inferred` was still active.

### Correction GREEN and full verification

- `npm.cmd run test:lane-preview` — 21 passed.
- `npm.cmd run test:graph-lane-decision` — 9 passed.
- `npx.cmd tsc --noEmit` — passed.
- `npm.cmd run test:all` — passed, including all configured suites.
- `git diff --check` — passed.

### Byte-safe and search evidence

- A Node check read `src/nav/lanePreview.ts` as bytes and UTF-8 text, compared against Unicode escapes, and reported `{"utf8":true,"productionOccurrences":1,"oldMojibakeOccurrences":0,"hex":"e7b3bbe7b5b1e68ea8e6b8ace8b387e69699efbc8ce8ab8be4be9de78fbee5a0b4e6a899e7b79ae8a18ce9a79b"}`.
- `rg -n -F "系統推測資料，請依現場標線行駛" src/nav/lanePreview.ts` found exactly one production occurrence at the `INFERENCE_NOTE` definition.
- `rg -n "蝟餌絞|車道建議（系統推測）"` across the production HUD/preview files returned no matches.
- The test independently asserts the complete literal `系統推測資料，請依現場標線行駛` rather than deriving its expected value from the production constant.

### Authority and scope review

- `guidanceIsInferred` is now exclusively `input.guidanceSource === 'inferred'`.
- Missing provenance, explicit annotation, mixed annotation+OSM, and OSM sources do not show the inference note, even when `LaneDecision.inferred` is true.
- The route `LaneDecision.primaryLaneIndex` remains the view's primary-lane authority; distance/preparation behavior is unchanged.
- Comparing the Task 6 range through `01a9ece` shows only `.superpowers/sdd/task-6-report.md`, `src/nav/LanePreviewView.tsx`, `src/nav/lanePreview.test.mjs`, and `src/nav/lanePreview.ts`; canonical road data is unchanged.
- No push, PR, or merge was performed.
