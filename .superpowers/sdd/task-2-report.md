# Task 2 Report: Lane base extraction, remapping, and field resolution

## Scope and implementation

- Added `src/core/laneBase.ts`, a pure domain layer with:
  - `extractLaneBase(raw)` for schema-v2 and legacy LanePilot annotations;
  - per-source accounting, stable source keys, explicit validation/error output, and duplicate canonical-key rejection;
  - `remapLaneBase(records, options)` using the same `DropRemap` direction alignment as `remapLaneGuidanceRecords`, with node remapping, cloning to every surviving keep id, and explicit unmapped source reporting;
  - `buildLaneBaseIndex(records)` and `resolveLaneBase(index, input)` for field-level source precedence.
- Field precedence is resolved independently for lane count, movements, per-lane motorcycle access, and movement rules: human block, human way, LanePilot approach, LanePilot segment/legacy, OSM, then inference. Missing approach fields do not erase a segment value.
- Added the source identity/context fields to `AnnotationRecord` and a shared `isLaneDirection` guard without changing existing lane-guidance output behavior.
- Added `src/core/laneBase.test.mjs` and included it in the existing `test:lane-guidance` chain.
- No runtime consumer (`mapCore`, roads, graph, HUD, or zones) and no canonical road data were changed.

## TDD evidence

### RED

Command:

```text
node --test src/core/laneBase.test.mjs
```

Before production code existed, it failed with `ERR_MODULE_NOT_FOUND` for `src/core/laneBase.ts` (exit 1). The test specified extraction, legacy/movement-only accounting, explicit errors, duplicate conflicts, field-level priority, and couplet remapping behavior.

### GREEN

Command:

```text
node --test src/core/laneBase.test.mjs src/core/laneGuidance.test.mjs
```

Result: 14 passing, 0 failing (exit 0).

## Verification

- `npx.cmd tsc --noEmit`: exit 0.
- Final `npm.cmd run test:all`: exit 0. The related `test:lane-guidance` command ran 35 passing tests, including all 6 new Lane Base tests; the complete chained suite passed.
- `git diff --check`: exit 0.
- Reviewed the final diff and confirmed `public/data/road_database.json` has no diff.

## Files

- `src/core/laneBase.ts`
- `src/core/laneBase.test.mjs`
- `src/core/importmap.ts`
- `src/core/laneGuidance.ts`
- `package.json`
- `.superpowers/sdd/task-2-report.md`

## Self-review

- Checked canonical-key validation, all source-accounting error paths, the required DropRemap alignment expression, field-by-field rather than record-by-record precedence, immutable array copies in resolved output, and compatibility of the existing Lane Guidance tests.
- Confirmed the new layer only imports domain types and does not introduce a runtime/canonical-data write path.

## Commit

The Task 2 commit contains this report and only the task-scoped files listed above.

## Concerns

None. This task deliberately exposes the pure domain API only; runtime consumers remain for later tasks.
