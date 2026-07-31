# Road Merge Safety and Recovery Design

**Date:** 2026-07-31
**Status:** Awaiting user review
**Branch:** `codex/road-merge-safety-design`

## Problem

LaneDev road merge currently behaves too much like destructive geometry consolidation. It can remove or replace the identities and junction nodes that connected other roads, copy the first segment's properties over the result, and leave routing to infer turn legality from an incomplete graph.

This creates four related failures:

1. A side road that was connected before the merge can become an orphan that routing cannot enter or leave.
2. A merge can suppress otherwise valid route-search states, causing a short trip to be replaced by a large detour.
3. A divided main road can be drawn as a full intersection at a one-sided entrance even though the physical median is continuous.
4. Routing can allow a left turn or crossing through that continuous median.

The intended operation is not “erase two roads and replace them with one road.” It is:

> Declare visual and navigational continuity across an OSM segmentation seam while preserving source-road topology, provenance, and annotations.

For the divided-road case in scope, a merge also declares that the median remains physically continuous. The side entrance connects only to its adjacent carriageway. A median opening that permits a left turn is explicitly outside this merge case.

## Confirmed domain rules

- If a physical median opening permits a left turn, the entrance must not be merged under the continuous-median mode.
- The main-road median, lane markings, and ordinary road style continue through the seam.
- The seam does not add a main-road stop line, turn arrow, channelization bay, or intersection opening.
- A side road may retain its own endpoint markings when its own annotation requires them.
- Both directions of main-road through movement remain routable.
- The side entrance supports only transitions to and from its adjacent carriageway, subject to the source roads' one-way restrictions.
- Routing must not cross the median, make a left turn through it, or use the seam as a U-turn.
- OSM intersection identity and annotation provenance remain available even when the renderer suppresses full-intersection styling.

## Goals

- Preserve every pre-merge road connection unless an explicit transition restriction disallows it.
- Prevent a road merge from making unrelated roads unreachable or excluding valid short routes.
- Draw a continuous physical median and continuous main-road style at a one-sided entrance.
- Enforce no-cross-median navigation at the same seam.
- Preserve source nodes, source segments, per-span attributes, and annotation identities.
- Reject unsafe or ambiguous merges instead of silently inheriting the first segment's fields.
- Make journal-based merges traceable, previewable, and reversible.
- Recover existing merge work without requiring blanket manual reannotation.
- Provide audits and tests that detect connectivity loss, illegal turns, route inflation, and visual seam regressions.

## Non-goals

- Automatically deciding from geometry alone whether a real-world median has an opening.
- Editing or correcting unrelated lane annotations.
- Replacing the complete road-preparation, couplet, rendering, or routing architecture.
- Automatically merging roads with conflicting directionality or incompatible lane/divider styles.
- Deleting historical journal records.
- Reconstructing every historical destructive edit without evidence from source provenance or repository history.

## Before and after

| Concern | Before | After |
| --- | --- | --- |
| Merge meaning | Consolidate road geometry and inherit the first segment's properties | Add a continuity constraint over preserved source roads |
| Side-road connection | Can disappear with a removed junction node | Junction node and incident edges remain in the routing graph |
| Turn legality | Inferred from the surviving node graph | Evaluated by an explicit transition policy at the merge seam |
| A* search state | Keyed only by current node | Keyed by current node and incoming directed edge |
| Median rendering | Seam may be drawn as a full intersection | Main-road median and styles continue through the seam |
| Main-road markings | May gain stop lines, arrows, or intersection styles | No seam-generated main-road stop line, arrow, bay, or opening |
| Field conflicts | First segment silently wins | Source fields stay per span; incompatible seam fields reject the merge |
| Failure persistence | A partially valid merge can remain recorded | Validation is atomic; failed merges produce no active constraint |
| Undo | UI can imply recovery without an actual journal tombstone | Undo appends a tombstone and deterministically rebuilds from source roads |
| Old records | Missing current key can be labelled orphaned | Sequential replay resolves active keys, provenance, snapshots, then history |

## Architecture

The change introduces five focused units.

### 1. Merge constraint model

A versioned merge record describes an overlay on source roads rather than a replacement road:

```ts
interface RoadMergeConstraintV2 {
  schemaVersion: 2
  mode: 'visual_continuity' | 'continuous_median_side_access'
  primarySegmentKey: string
  secondarySegmentKey: string
  junctionNodeId: number
  sourceSegmentKeys: string[]
  sourceNodeIds: number[]
  supersedesMergeKey?: string
}
```

`visual_continuity` covers a simple OSM split with no special side-access restriction. `continuous_median_side_access` covers the confirmed divided-road case and activates the no-cross-median transition policy.

The journal continues to provide sequence, timestamp, author, operation, and target identity. V2 stores only the stable semantic and provenance fields required to replay the operation.

Source `RoadFeature` objects are not replaced. Their identities, nodes, geometry, directionality, lane attributes, and `sourceSegments` remain authoritative.

### 2. Sequential merge resolver

The resolver processes active journal records in sequence order. Each source reference is resolved through:

1. the active road's exact segment/block key;
2. the active road's `sourceSegments` provenance;
3. the record's stored source node snapshot and geometry;
4. an offline migration lookup against Git-held historical road databases.

The runtime uses the first two sources and already-migrated stable V2 records. Historical Git lookup is an offline recovery tool, not a production runtime dependency.

Resolution is logged per journal record at the point it is applied. It must not infer success or failure solely from the final post-replay road snapshot because a valid source may be absorbed by a later merge.

### 3. Transition policy

The routing graph keeps every source edge and junction node. A merge seam provides an allowed-transition function:

```ts
isTransitionAllowed(incomingEdge, junctionNode, outgoingEdge): boolean
```

For `continuous_median_side_access`:

- main-road through transitions in both legal travel directions are allowed;
- side-road transitions connect only to the physically adjacent carriageway;
- source one-way restrictions remain authoritative;
- cross-median left turns, cross-median straight movements, and U-turns are rejected;
- no new connection is synthesized between roads that were not incident before the merge.

Adjacency and turn class are determined from directed edge geometry around the junction and the two carriageway/source identities. If the geometry cannot uniquely identify the adjacent carriageway, validation fails and requires review. The system must not guess from road-array order.

### 4. Rendering seam policy

The renderer receives a seam descriptor separate from routing topology:

```ts
interface RoadMergeRenderSeam {
  junctionNodeId: number
  mainSourceSegmentKeys: string[]
  suppressMainIntersectionStyle: boolean
  keepMedianContinuous: boolean
}
```

At a continuous-median seam it:

- joins the main-road median and ordinary lane/edge styles across the node;
- suppresses only seam-generated main-road stop lines, arrows, channelization bays, gaps, and intersection caps;
- keeps the side-road geometry connected to its adjacent carriageway;
- preserves explicitly annotated side-road endpoint markings;
- does not delete or hide a routing road merely because a short visual stub is suppressed.

Rendering suppression is presentation metadata only. It cannot set a road to deleted or remove a graph edge.

### 5. Recovery and audit service

An offline audit produces one row per active legacy merge with:

- original sequence, timestamp, author, and merge key;
- original primary and secondary keys;
- resolved source identities and junction;
- mode candidate;
- compatibility and geometry checks;
- route/connectivity comparison;
- classification and reason.

Classifications are:

- `replayable`: current identities resolve and validation passes;
- `recoverable_via_provenance`: an exact active identity is gone but a unique `sourceSegments` or snapshot match exists;
- `needs_manual_review`: multiple candidates or physical semantics cannot be determined safely;
- `legacy_destructive`: the source is absent from the current database and requires historical reconstruction;
- `invalid`: evidence proves the recorded segments cannot form the requested seam.

## Merge validation

Validation runs before a V2 record becomes active and is atomic.

### Required checks

- Both source references resolve uniquely.
- The two main-road spans meet at the declared junction and form a plausible continuation.
- Mode is explicit.
- Directionality and one-way behavior are compatible with the requested through movement.
- Lane count, divider type, center style, road class, and other routing/render-critical seam fields are compatible.
- For continuous-median side access, the adjacent carriageway and permitted side transitions are unambiguous.
- The operation does not remove an incident edge, source identity, or annotation reference.
- A preview graph passes connectivity and route checks.

Road name and noncritical metadata differences are reported. They are never resolved by “take the primary value.” Because source spans remain separate, harmless metadata can remain per span. A difference that makes the seam visually or navigationally ambiguous blocks activation.

### Atomic result

- Success appends one active V2 constraint.
- Failure appends no active merge constraint and returns a structured reason.
- A failed preview cannot leave partially modified roads, deleted stubs, or routing restrictions.

## Routing design

### Search state

A* state changes from a node ID to:

```ts
interface RouteState {
  nodeId: number
  incomingEdgeId: string | null
}
```

`gScore`, `fScore`, `closed`, and `cameFrom` use this complete state identity. This is required because two arrivals at the same node may have different legal outgoing transitions. Suppressing the second arrival solely because the node was already visited can eliminate the valid short route.

### Graph construction

- Every pre-merge directed edge remains present.
- Turn restrictions are consulted while expanding an outgoing edge.
- Costs and heuristics remain unchanged unless a transition is prohibited.
- A render-only hidden stub remains routable.
- Route reconstruction maps state edges back to the preserved source-road identities.

### Route safety invariants

For every successful merge:

- the weakly connected component membership of all incident roads is unchanged;
- all pre-merge legal main-road through paths remain legal;
- only explicitly disallowed cross-median transitions are removed;
- no new cross-median or nonincident transition is added;
- routes unaffected by the merge retain their reachable alternatives;
- route inflation beyond a configured tolerance fails validation unless every shorter candidate uses a newly prohibited transition.

## Existing merge recovery

The current inspected journal contains 48 active unique legacy merge keys. In the inspected snapshot:

- 42 replay through the current pipeline;
- 6 fail exact-key lookup, but the source OSM road still exists in current data under couplet `sourceSegments`;
- 47 contain a secondary-node snapshot;
- all retain journal trace information such as sequence, timestamp, author, and source keys.

These counts are migration inputs, not a guarantee that all physical semantics are correct.

### Migration procedure

1. Freeze a raw database and journal snapshot for reproducibility.
2. Replay legacy records sequentially and produce the recovery report.
3. Resolve absorbed sources through provenance before declaring them orphaned.
4. Build V2 candidates without modifying the live journal.
5. Run compatibility, rendering, graph-connectivity, forbidden-turn, and route-inflation checks.
6. Preview records classified as `recoverable_via_provenance` or `needs_manual_review`.
7. For an approved candidate, append a tombstone for the legacy active target and append the V2 constraint with `supersedesMergeKey`.
8. Rebuild deterministically from the raw source database and complete journal.
9. Publish only after all active V2 records pass the release audits.

The migration never edits or deletes a historical record in place.

### Unusable records

An unusable record is not silently retained and is not erased.

- If a source can be reconstructed uniquely, migration creates a reviewable V2 candidate.
- If physical median semantics are ambiguous, a teammate confirms only the local seam and permitted turns; the complete road does not need to be reannotated.
- If the source was destructively removed, the recovery tool extracts a candidate from Git history and compares it with current geometry and annotations.
- After review, an invalid legacy effect is disabled with an append-only tombstone and the graph is rebuilt from source roads.
- Existing dependent annotations are remapped through stable provenance. They are reported rather than discarded when a unique mapping is impossible.

No migration may publish a junction that has neither a validated original topology nor an explicit transition policy.

## Undo and trace UI

The merge inspector shows:

- current status and mode;
- author, timestamp, sequence, and original merge key;
- source roads, junction node, and absorbed provenance;
- allowed and forbidden transition preview;
- rendering preview;
- affected annotations and route audit result.

`Undo merge` appends a delete/tombstone operation for the active constraint and rebuilds from the raw source roads. It does not erase history. The preview states that full undo restores both the original intersection rendering and original turn behavior. If a physical median still exists, the user should replace or correct the constraint rather than publish a plain undo.

`Reapply as V2` creates a new validated constraint linked by `supersedesMergeKey`.

## Failure handling

- Missing exact source key: search provenance before reporting an orphan.
- Multiple provenance matches: do not choose automatically; classify for manual review.
- Incompatible seam fields: reject with the conflicting field names and values.
- Ambiguous adjacent carriageway: reject continuous-median activation.
- Routing invariant failure: reject and include the affected origin/destination and pre/post route comparison.
- Rendering invariant failure: reject and identify the extra or missing seam styles.
- Journal write failure: leave the old active state unchanged.
- Rebuild failure after journal append: do not publish; report the sequence at which replay diverged.
- Historical reconstruction unavailable: preserve the old trace and mark it `legacy_destructive`; do not claim the road is unrecoverable without exhausting repository history.

## Tests

### Resolver and validation tests

- Resolve an exact active segment key.
- Resolve a segment absorbed into couplet `sourceSegments`.
- Replay chained merges sequentially without misclassifying an earlier source as orphaned.
- Reject multiple provenance matches.
- Reject opposite or incompatible one-way directionality.
- Reject critical lane/divider/style conflicts without first-segment inheritance.
- Reject ambiguous adjacent-carriageway geometry.
- A failed merge leaves source roads and the active journal state unchanged.

### Routing tests

- A connected side road remains reachable after merge.
- Main-road through routing works in both legal directions.
- Right-in/right-out transitions to the adjacent carriageway work.
- Left turn, crossing, and U-turn through a continuous median fail.
- Two arrivals at the same node with different incoming edges remain distinct A* states.
- A short valid path is not replaced by a large detour.
- A render-hidden stub remains in the graph.
- Unrelated route reachability and cost remain unchanged.

### Rendering tests

- Median and main-road styles remain continuous through the seam.
- The main road gains no stop line, arrow, bay, median opening, or intersection cap.
- Explicit side-road endpoint markings remain visible.
- A median-opening/nonmerge fixture retains ordinary intersection rendering.
- Visual suppression never marks a road deleted for routing.

### Recovery tests

- Produce a deterministic report for the frozen current journal fixture.
- Classify exact, provenance-recovered, ambiguous, destructive, and invalid cases.
- Preserve original author, timestamp, sequence, and key in the trace.
- Tombstone plus V2 replacement replays deterministically.
- Full undo restores original source topology.
- Annotation remapping preserves uniquely attributable records and reports ambiguous records.

### Integration and release audits

- Run the complete existing test suite.
- Run merge replay and orphan audits on the full current journal.
- Compare incident-road connected components before and after every merge.
- Test all allowed and forbidden seam transition classes.
- Compare representative shortest paths before and after each merge.
- Render every active merge and detect median breaks and unexpected main-road markings.
- Verify that no active record is unresolved at release time.

## Delivery order

1. Add regression fixtures for the known orphan, detour, continuous-median, and provenance-recovery cases.
2. Add the V2 constraint model and sequential resolver without changing active output.
3. Preserve graph topology and add incoming-edge route state plus transition policies.
4. Separate rendering seam suppression from routing-road existence.
5. Add atomic validation and preview.
6. Add recovery report, migration, trace, and undo.
7. Migrate approved legacy records and run full release audits.

No legacy migration is published until the implementation and recovery report have been reviewed.
