# Road Merge Seam Undo Design

**Date:** 2026-08-01

**Status:** User-approved design, pending written-spec review

**Implementation branch:** `codex/road-merge-safety-implementation`

## Goal

Undoing a road merge removes the selected seam, not every later merge that happened to reuse the same primary carrier. For an ordered source chain `A -> B -> C`, after `A + B -> A` and then `AB + C -> A`, undoing the `A-B` seam must produce `A | BC`. The surviving `B-C` component is rebased to carrier `B` without creating a new OSM way id.

## Approaches considered

1. **Rebase connected source components (selected).** Reconstruct the ordered source-block chain, remove the selected seam, and emit replacement merge records for each remaining multi-block component. This preserves user intent and uses stable source identities rather than geometric distance.
2. **Cascade-delete all dependent merges.** Safe but too destructive: undoing `A-B` would also undo the independently desired `B-C` seam.
3. **Find a nearby replacement road geometrically.** Rejected because long roads, parallel carriageways, and junction branches make proximity ambiguous.

## Model and algorithm

- Treat every schema-v2 merge as a seam between two adjacent source components.
- Derive ordered atomic blocks from `primary_source`, `secondary_source`, `junction_node`, and the resolved merge provenance already present in the replay result.
- To undo a selected seam:
  1. Find the selected active merge and every later active merge whose resolved primary component contains it.
  2. Build the unique ordered atomic chain represented by those records.
  3. Remove only the selected adjacency edge.
  4. Split the chain into connected components.
  5. Append tombstones for the selected record and every dependent record being replaced.
  6. For every remaining component containing two or more atomic blocks, append schema-v2 replacement records in adjacency order. The first atomic block is the component carrier.
- Example: active `A+B` and `AB+C`; remove `A-B`; tombstone both old records and append `B+C`, producing `A | BC`.
- Replacement records preserve the surviving component's effective merged presentation attributes while retaining atomic source snapshots for future undo operations.
- OSM ids and canonical static segment geometry are never rewritten. The operation changes only append-only journal records and their in-memory replay.

## Safety and ambiguity

Automatic rebasing is allowed only when:

- every atomic block has a stable block key and source snapshot;
- every surviving seam joins exactly one pair of adjacent blocks;
- chain ordering is unique; and
- replaying the proposed journal resolves every replacement merge.

If the history forms a fork, has missing legacy provenance, has multiple possible block orders, or fails replay validation, no journal record is appended. The UI reports that automatic seam undo is unavailable and leaves the current map unchanged.

## UI and persistence

- The existing button remains labelled `撤銷捏合`; its meaning becomes “remove this merge seam”.
- Before saving, preview the complete transaction against the current road-merge view.
- The success message states how many old records were retired and how many surviving merges were rebased.
- Append every tombstone and replacement record before one database flush and one safe page reload.
- On write failure, do not reload; retain the current view and show the save error.
- Preserve the existing camera/editor restoration behavior across the reload.

## Tests

- `A+B`, `AB+C`; undo `A-B` produces active `B+C`, with `A` separate.
- Undo `B-C` produces active `A+B`, with `C` separate.
- A four-block chain preserves both unaffected components when an interior seam is removed.
- Replacement carrier uses the first block of the surviving component and creates no OSM way id.
- Dependent historical records are tombstoned and cannot revive after a later merge.
- Ambiguous forks and missing source snapshots fail without appending records.
- The transaction preview must resolve before persistence and reload.
- Existing independent merge undo and routing/rendering tests remain green.

## Acceptance criteria

- Undoing `1080697514 + 1080697102` retires its dependent `1080697514 + 1080697358` record and replaces it with `1080697102 + 1080697358`.
- The resulting render view is `A | BC`; navigation and rendering continue to treat only the surviving `B-C` seam as merged.
- No new OSM way id is generated and `public/data/road_database.json` base segments are not modified by the implementation commit.
- Unsupported legacy/branched histories fail safely with a visible reason.
- Focused road-merge tests, the full relevant test suite, and the TypeScript build pass.
