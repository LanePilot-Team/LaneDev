# Unified LanePilot Base and HUD/Road-Network Data Design

## Status

- Date: 2026-08-08
- Status: design approved section by section; awaiting written-spec review
- Related design: `2026-08-04-lane-aware-navigation-design.md`

## Background

LanePilot annotations currently have multiple runtime authorities:

- `road_database.json.segments` stores geometry, but only about 22 of 5,481 segments directly contain lane base fields.
- `road_database.json.annotations` is empty.
- 731 LanePilot lane records are materialized as `author=lanepilot` entries in `editor.journal` for road rendering.
- A separate `lane-guidance.json` contains 1,007 records for navigation and the HUD.
- Motorcycle and two-stage-turn data follow another annotation conversion path.

The renderer, navigation graph, route ribbon, and HUD can therefore resolve different lane counts or movements for the same road. This design creates a real LanePilot base and one resolved model for every consumer.

The current `annotations.jsonl` contains 1,485 records: 927 `intersection_approach`, 552 `segment_direction`, and 6 legacy or unscoped records. Of these, 1,008 contain a lane profile.

## Goals

1. Make `road_database.json.annotations` the canonical LanePilot base for segment, approach, lane, motorcycle, and two-stage-turn data.
2. Remove the 731 legacy `author=lanepilot` journal entries.
3. Preserve all human journal, road merges, new roads, waiting zones, deletions, and drawing settings.
4. Produce one effective lane model shared by rendering, `RoadGraph`, the route ribbon, and the HUD.
5. Reject canonical writes when mapping or validation fails; never skip failures silently.
6. Regenerate the human-journal comparison after the new base is complete.

## Non-goals

- Inferring the driver's physical lane from GPS.
- Automatically deleting human fields that match the new base.
- Changing the rule that human data has highest priority.
- Repackaging LanePilot base data as another kind of journal.

## Canonical Data Model

`road_database.json` remains the single static database:

```text
road_database.json
├─ segments       geometry, OSM, and static segment data
├─ annotations    canonical LanePilot segment/approach/motorcycle/turn base
└─ editor
   ├─ journal     human and structural overrides
   ├─ waiting_zones
   └─ deleted_waiting_zone_ids
```

Annotations remain traceable normalized records. Intersection-approach data must not be flattened incorrectly across an entire way. Each record retains segment identity, scope, direction, intersection node, lane profile, motorcycle/two-stage rules, and source metadata.

Road merges remain `road_merge` records in `editor.journal`. Records authored by `anna`, `rex`, `unknown`, `road-merge-recovery-v2`, and every other non-LanePilot source are preserved.

## Field-level Resolution Priority

Highest to lowest:

1. Human block journal: `way/W@b/N`
2. Human way journal: `way/W`
3. LanePilot `intersection_approach`
4. LanePilot `segment_direction`
5. Segment/OSM fields
6. System inference

This is a field-level overlay. If a human changes only `turn_lanes`, lane count may still come from LanePilot base; omitted human fields do not clear base values.

## Effective Lane Model

A single resolver creates a model for each road block, travel direction, and approached intersection:

```text
EffectiveLaneModel
├─ laneCount
├─ laneMovements
├─ motorcycleAccess
├─ twoStageLeftTurn
├─ waitingZone
├─ fieldSources
└─ inferredFields
```

`fieldSources` tracks whether each value came from a human block, human way, LanePilot approach, LanePilot segment, OSM, or inference. `inferredFields` controls the HUD warning.

The resolver runs after road splitting and couplet/way/node remapping so approach nodes match real blocks. Human road fields are overlaid, then new roads, deletions, and road merges are replayed to produce final routing and rendering views.

## Shared Consumers

- Road rendering uses `EffectiveLaneModel` for lane count and pavement arrows.
- Each `RoadGraph` edge carries or references the same model.
- Lane selection permits only lanes compatible with the next maneuver.
- The HUD displays the model used by the active navigation edge.
- `lane-guidance.json` stops being a runtime authority. It may remain temporarily as a derived compatibility/audit artifact, but production code must not silently fall back to it when canonical base loading fails.

## Navigation and Motorcycle Behavior

- A right-turn route ribbon uses the outermost suitable right-turn-capable lane and cannot return to a through-only center lane.
- Route-ribbon lane changes and HUD highlighting occur together.
- A motorcycle normally enters the legal outer lane after a turn.
- For a required two-stage left turn, guidance uses the outermost through-capable lane; a right-only outer lane is not a valid waiting-zone approach lane.
- The system does not claim to know the driver's physical lane. Existing rerouting applies after road deviation.
- The HUD shows “System-inferred data; follow on-site markings” only when an effective field actually uses OSM/geometry inference.

## New Base Build Pipeline

1. Read LanePilot segment shards and the latest `annotations.jsonl`.
2. Deduplicate and validate segment identity, `node_refs`, and `nav_segment_key + split_index`.
3. Normalize annotations and build segment, approach, motorcycle, and two-stage-turn indexes.
4. Separate legacy LanePilot materializations from human/structural editor data.
5. Remove all `author=lanepilot` journal entries and retain all non-LanePilot records.
6. Write `road_database.candidate.json` plus a machine-readable audit report.
7. Run data, replay, navigation, rendering, test, and production-build checks.
8. Only after every required check passes, back up the old database and replace the canonical database through an explicit `--write-canonical` operation.

The default build writes only a candidate.

## Mapping and Failure Rules

Every annotation must be classified as:

- successfully mapped and consumed;
- valid but not containing that data kind, such as a movement-only record without a lane profile, while still being accounted for by another consumer; or
- an explicit error requiring review.

Canonical writing is forbidden when:

- an annotation way or approach node cannot be found after remapping;
- duplicate canonical keys have different content;
- lane count and movement-array length conflict without an explicit repair rule;
- an old segment disappears without explanation or identity conflicts remain;
- human journal content or order changes unexpectedly; or
- road merges, new roads, waiting zones, or human deletions cannot be replayed.

A valid record that does not apply to a field is not an error. A record unaccounted for by every parser is an error.

## Human Data Protection

Before canonical replacement, record and compare:

- the full-content hash of all non-LanePilot journal entries;
- record count, author distribution, target-type distribution, and sequence order;
- `waiting_zones` and `deleted_waiting_zone_ids`;
- road merges, new roads, and dependent `turn_bay`, `right_lane`, and `moto_box` records.

The build does not remove human fields that match the base. Older editor saves may contain fields the user did not intentionally edit. Any cleanup is a later, field-level decision based on the regenerated review report.

## Tests and Verification

### Conversion

- Segment and approach scopes map correctly.
- Way/node remaps and direction reversals are correct.
- Motorcycle, two-stage-left, and waiting-zone rules survive conversion.
- Unmapped records and conflicts produce a nonzero exit code.

### Overlay

- Human block beats human way.
- Human beats LanePilot approach/segment.
- Approach beats segment; segment beats OSM/inference.
- Partial human edits do not clear untouched base fields.
- Road merge and new-road replay still resolve the correct model.

### Cross-consumer consistency

- Rendered lane count equals HUD lane count.
- Rendered arrows equal HUD arrows.
- The route ribbon uses only lanes compatible with the next maneuver.
- A right-turn ribbon does not return to a through-only center lane.
- A two-stage-turn motorcycle does not enter a right-only lane.
- Only inferred fields trigger the HUD inference note.

### Project checks

- `npm.cmd run test:all`
- new-base candidate audit
- human-journal hash/replay audit
- navigation/rendering consistency audit
- `npm.cmd run build`
- `git diff --check`

## Regenerated Human Review Report

After the canonical base is complete, overwrite the current Markdown and CSV reports with categories for:

- exact match;
- matching explicitly set fields;
- equivalent allowed movements but different arrow notation;
- movement difference;
- lane-count difference;
- lane-count and movement difference;
- no matching new-base record; and
- annotation present but unmapped, which must be zero before canonical publication.

Each row retains road name, way/block, direction, coordinates, Google Maps, OSM, base value, human value, author/seq/target provenance, and review guidance. The old figure of 488 exact matches is an old-pipeline result and is not the final new-base count.

## Acceptance Criteria

1. `road_database.annotations` is non-empty and all 1,485 source annotations have an auditable outcome.
2. The count of `author=lanepilot` journal records is zero.
3. All non-LanePilot human and structural data is preserved and replayable.
4. HUD, road rendering, navigation graph, and route ribbon share one effective lane model.
5. Disallowed lane movements cannot carry the route ribbon.
6. Motorcycle outer-lane and two-stage-turn behavior matches this specification.
7. Unmapped count is zero, and all tests, audits, and build checks pass before canonical replacement.
8. The updated human comparison report is generated successfully.
