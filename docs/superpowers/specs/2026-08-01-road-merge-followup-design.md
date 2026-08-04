# Road Merge Follow-up and Legacy Data Upgrade Design

**Date:** 2026-08-01  
**Status:** User approved  
**Implementation branch:** `codex/road-merge-safety-implementation`

## Scope

The work is split into three independently reviewable commits:

1. Preserve map and editor context across the safe reload used after merge changes, and add rendering regressions.
2. Upgrade legacy merges using only the latest official `origin/anna` road database; local test edits must not enter the formal dataset.
3. Fix routing endpoint direction selection on opposite sides of the same road.

## Commit 1: Interaction and rendering fixes

The full reload remains because rebuilding a second complete MapLibre layer set in place exhausted renderer memory. Before saving, store a one-shot session snapshot containing camera center, zoom, bearing, pitch, application mode, and road identity. Restore it only after the canonical database and journal finish loading, then remove it. Road restoration tries OSM id, source block key, and merge junction identity in order. Failure to find the road must not prevent camera and mode restoration.

Regression tests must prove that undo restores the two original render segments for both a new v2 merge and an upgraded legacy merge, including the unmerged median appearance.

## Commit 2: Legacy data upgrade

The only formal source is `origin/anna` commit `7d2121d2391e7f4149e2572d3bf7965c00fb0cfe`. Local road database events created for acceptance testing, including events from seq 2903 onward, are excluded.

The source contains 48 active legacy merges:

- 43 upgraded: 40 exact replays and 3 provenance-based recoveries.
- 5 rolled back: 4 ambiguous source resolutions and 1 invalid 21.7 metre endpoint gap.
- 0 records with permanently missing source geometry.

For upgraded rows, append a tombstone for the old record followed by a schema-v2 record containing the junction, source keys, original source snapshots, and superseded sequence. For rolled-back rows, append only the tombstone so rendering falls back to the original `anna` base segments. Never rewrite historical journal entries or base geometry. Migration must be idempotent.

The report has separate `upgraded` and `rolled_back` sections. Each row includes road name, merge key, source sequence, outcome, and review reason. It also records the source commit, input SHA-256, category totals, and migrated output SHA-256.

## Commit 3: Routing direction fix

Snapping currently identifies the selected side, but route construction reprojects onto the shared centerline and connects both directions. The snap result will retain the selected directed edge. Temporary start and destination nodes will connect only to endpoints legal for that directed edge, while preserving one-way and transition restrictions. A side road may turn only into the allowed same-side main-road direction at a merged junction; it must never use the hidden junction to cross the continuous median. Search state continues to include the incoming edge.

Tests cover opposite-side clicks on the same road, one-way roads, a legal side-road right turn, a forbidden median-crossing turn, and a nearby destination that must not produce a long detour.

## Acceptance criteria

- Exactly three scoped commits with primarily Chinese messages.
- Merge and undo retain the safe reload while restoring camera, mode, and edited road.
- The migration report contains exactly 43 upgraded and 5 rolled-back rows and is reproducible from `origin/anna@7d2121d` without local test events.
- Undoing an upgraded record restores its two original road segments.
- Opposite-side clicks produce routes matching the selected travel direction.
- Road-merge tests, routing tests, TypeScript build, and data audits pass.
