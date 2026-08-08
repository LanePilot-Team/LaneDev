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

## Exact-copy search

- `rg -n -F "蝟餌絞?冽葫鞈?嚗?靘?湔?蝺?擏." src` found exactly one production policy definition: `src/nav/lanePreview.ts` (`INFERENCE_NOTE`); the test assertion separately verifies that literal.
- `rg -n -F "車道建議（系統推測）" src` returned no matches, confirming the old inference warning was removed.

## Self-review

- `guidanceIsInferred` uses the resolved guidance source whenever it exists, so distance/preparation timing and `LaneDecision.inferred` cannot reclassify explicit human, LanePilot, mixed annotation+OSM, or OSM guidance.
- For legacy callers without a source, the pre-existing fallback remains, avoiding unrelated preview behavior changes.
- `applyLaneStates` still uses `LaneDecision.primaryLaneIndex` and secondary indices directly while in the preparation range; the view only consumes the resulting model and renders the single `inferenceNote` as the existing small secondary text.
- No raw annotation/legacy guidance inspection was added, and no physical-lane claim is derived from GPS.

## Commit

`8d94345` (amended immediately after this report update so the report is included in the same commit).

## Concerns

None. The required warning copy is preserved byte-for-byte as supplied in the task brief.
