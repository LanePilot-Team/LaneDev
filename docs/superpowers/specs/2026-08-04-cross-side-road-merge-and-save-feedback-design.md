# Cross-Side-Road Median Merge and Save Feedback Design

## Purpose

Support a junction that appears as a four-way intersection in OSM but has a physically continuous median. Each side road may only enter and leave the adjacent carriageway; neither side road may cross the median, turn across it, or travel directly into the opposite side road. Also provide accurate progress feedback after saving road edits.

## Scope

- Extend safe road merging to a main-road seam with two or more side roads when every side road can be classified independently.
- Keep the main road traversable in both existing legal directions.
- Preserve current T-junction behavior and existing journal compatibility.
- Reject the whole merge if any side road is ambiguous.
- Add immediate, successful, and failed save feedback to road editing.
- Do not modify or migrate canonical road data as part of this feature.

## Side-Road-Specific Access Model

The existing `oneSideEntryAccess` entry gains an optional `sideRoadKey`:

```ts
interface OneSideEntryAccess {
  nodeId: number
  allowedBack: boolean
  sideRoadKey?: string
}
```

`sideRoadKey` uses the split road identity `way/{osmId}@b/{blockNode}`. An entry without `sideRoadKey` remains a legacy junction-wide rule. An entry with `sideRoadKey` applies only when the transition enters or leaves that specific side road.

For a single side road, the runtime may retain the legacy unkeyed representation so existing serialized and test expectations remain compatible. For multiple side roads with different adjacent directions, keyed entries are required.

## Merge Resolution

At the selected main-road seam:

1. Collect every road other than the two selected main-road blocks that contains the seam node.
2. Require each side road to terminate at the seam node. A side road passing through the node is ambiguous.
3. Calculate independently whether that side road is adjacent to the main road's forward or backward carriageway.
4. Require exactly one legal adjacent direction for each side road.
5. If all side roads resolve:
   - accept the merge;
   - register a keyed access rule for each side road on both routing main-road blocks;
   - preserve the continuous median barrier at the seam.
6. If any side road does not resolve, reject the entire merge without writing a journal record.

The rejection message identifies the side road by name when available, includes its block key, and explains the cause: not an endpoint, geometry too short, or direction not unique.

## Navigation Behavior

- Main road to the adjacent side road: allowed.
- Adjacent side road to its permitted main-road direction: allowed.
- Main road to a side road across the median: blocked.
- Side road to the opposite main-road direction: blocked.
- Side road to side road through the seam: blocked by the median barrier.
- U-turn at the merged seam: blocked.
- Main-road through movement in the same physical direction: allowed.

Transition evaluation first matches a keyed rule using the counterpart road's split-road key. If no keyed rule matches, it falls back to an unkeyed legacy rule. This preserves existing T-junction behavior.

## Replay and Undo

Side-road-specific rules are derived during road-merge replay from current road geometry; they are not new canonical annotations. The road-merge journal remains append-only and keeps the existing primary/secondary road snapshots. Undo removes every rule derived by that merge and restores any pre-existing access rule and barrier state.

When visually merging carriers, access entries are keyed by both `nodeId` and `sideRoadKey` so rules for opposite side roads do not overwrite one another.

## Road Edit Save Feedback

After the user presses **Save and Apply**:

1. Apply the edit to the in-memory road and redraw as today.
2. Immediately show `Road settings applied; saving…`.
3. Flush the static editor save rather than waiting only for the debounce timer.
4. On successful persistence, show `Road settings saved and applied`.
5. On failure, show `Settings remain in this browser but have not been written to the database`, followed by the actual error detail.

The editor panel continues to close after submission. Existing warnings about an unrenderable turn bay or motorcycle box remain visible in the final result message and are not silently replaced by the save-success message.

## Tests

- A four-way OSM node with a continuous median and two opposite side roads merges successfully.
- Each side road can right-enter and right-exit only its adjacent carriageway.
- Neither side road can cross to the opposite carriageway or the other side road.
- Main-road through movements remain available and seam U-turns remain blocked.
- One ambiguous side road rejects the entire merge and reports its road identity and reason.
- Existing one-side T-junction and legacy unkeyed access tests remain green.
- Multiple keyed entries survive cloning, visual carrier merging, replay, and undo cleanup.
- Save feedback reports saving, success, and failure only at the corresponding persistence stage.
