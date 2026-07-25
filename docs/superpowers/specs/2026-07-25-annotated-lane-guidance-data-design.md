# Annotated Lane Guidance Data Design

**Date:** 2026-07-25
**Status:** Awaiting user review
**Branch:** `codex/lane-guidance-preview`

## Problem

The lane preview currently falls back to `車道建議（系統推測）` even when LanePilot contains manually annotated `lane_movements`.

The runtime has three separate problems:

1. The bundled `annotations.jsonl` is loaded automatically only for two-stage-turn zones. Its lane profiles are applied only through the manual import UI.
2. Ground arrows can be inferred from intersection topology, so a visible map arrow does not prove that explicit lane-movement data reached the HUD.
3. The HUD reads the vehicle's current road properties even though each route maneuver already identifies the relevant approach road and intersection.

The default shard currently contains 3,184 segments, but only 11 have explicit OSM turn-lane tags. Among the bundled annotations matching that shard, 943 records contain at least one known lane movement. Those annotations must be available automatically.

## Goals

- Automatically use bundled LanePilot lane annotations without requiring manual import.
- Preserve intersection-specific approach annotations instead of flattening every annotation onto an entire OSM way.
- Make manually annotated values authoritative over OSM values.
- Fill an annotated `unknown` lane from the same OSM lane when an explicit OSM value exists.
- Use inference only when neither annotation nor OSM provides usable information.
- Prevent navigation from starting before the compact lane-guidance index is ready.
- Keep navigation-time lookups small and synchronous for a future mobile application.

## Non-goals

- Changing the annotation schema or source `annotations.jsonl`.
- Editing or correcting annotation content.
- Replacing the existing ground-arrow generation system.
- Adding network synchronization or a backend service.
- Refactoring unrelated route-planning or map-rendering code.

## Data priority

Lane data is resolved in this order:

1. Matching `intersection_approach` annotation for the approach way, intersection node, and travel direction.
2. Matching `segment_direction` annotation for the way and travel direction.
3. Matching legacy way annotation for the way and travel direction.
4. Explicit OSM `turn:lanes`, `turn:lanes:forward`, or `turn:lanes:backward`.
5. Geometry-based system inference.

Priority applies per lane:

- A known manual value replaces the corresponding OSM value.
- Manual `unknown`, an empty string, or a missing manual lane uses the corresponding OSM value.
- If neither source knows the lane, it remains unknown until the preview model decides whether inference is necessary.
- Manual lane count is authoritative when valid. Otherwise the road-direction lane count is used.

An annotation for one intersection must not alter guidance for another intersection on the same OSM way.

## Compact runtime artifact

`annotations.jsonl` remains the source of truth. A build script generates:

`public/data/lanepilot/lane-guidance.json`

The artifact contains only fields required by navigation:

```ts
interface LaneGuidanceRecord {
  wayId: number
  direction: 'forward' | 'backward'
  scope: 'intersection_approach' | 'segment_direction' | 'legacy'
  intersectionNodeId?: number
  laneCount?: number
  laneMovements: string[]
}
```

The generator:

- reads the bundled `annotations.jsonl`;
- extracts valid lane profiles;
- normalizes context and intersection identities;
- writes records in deterministic order;
- fails on malformed identities that would create an ambiguous key;
- produces identical output for `LaneDev` and `LaneNav`.

The current 9.1 MB annotation file produces approximately 136 KB of uncompressed navigation data, or about 7.6 KB when gzip-compressed.

Generation runs before development and production builds so committed source annotations and the runtime artifact cannot silently drift.

## Runtime index

The runtime loads the compact artifact in parallel with the road shard. It builds two maps:

```ts
approachByKey: Map<`${wayId}@${nodeId}/${direction}`, LaneGuidanceRecord>
segmentByKey: Map<`${wayId}/${direction}`, LaneGuidanceRecord>
```

Before building the maps, records pass through the same `nodeRemap` and `wayRemap` produced by the road-preparation pipeline. A record for a dropped way is cloned onto its surviving way ID or IDs. When the existing couplet metadata says the absorbed road direction is reversed relative to the surviving road, `forward` and `backward` are exchanged. Approach intersection node IDs are remapped at the same boundary.

The map-loading state is not considered ready until both the road graph and lane-guidance index have either:

- loaded successfully; or
- failed explicitly and activated the documented OSM/inference fallback.

Route planning and navigation controls stay unavailable during the loading state. Therefore navigation cannot begin with an index that is still arriving.

Index lookup occurs only when maneuvers are built or when the current span changes. No JSON parsing or linear annotation scan occurs during a navigation animation frame.

## Route and HUD integration

When a maneuver is created, its approach road already supplies:

- approach way ID;
- intersection node ID;
- forward/backward travel direction;
- road lane count;
- OSM turn-lane array.

A lane-guidance resolver combines those values with the annotation index and stores the resolved result on the maneuver:

```ts
interface ResolvedLaneGuidance {
  laneCount: number
  laneMovements?: string[]
  source: 'annotation' | 'annotation+osm' | 'osm' | 'inferred'
}
```

HUD selection is distance-based:

- At more than 250 metres, show the current span's lane guidance.
- At 250 metres or less, show the next maneuver's resolved approach guidance.

The preview displays `車道建議（系統推測）` only when `source === 'inferred'`. Annotation, annotation-plus-OSM, and OSM data are not labelled as system inference.

## Failure handling

- Missing compact artifact: log one clear warning and continue with OSM/inference after map initialization.
- Invalid individual record: exclude it during generation and fail the generator with its source identity, so invalid committed data is caught before shipping.
- No matching approach annotation: fall back through segment, legacy, OSM, then inference.
- Lane-count mismatch: resolve per lane instead of rejecting the complete array.
- Unknown movement token: preserve it as unknown; do not activate a lane from an unrecognized token.
- More than ten lanes: preserve the existing preview truncation behavior.

## Tests

### Generator tests

- Extracts forward and backward lane profiles.
- Preserves an intersection node in approach records.
- Produces deterministic ordering.
- Rejects ambiguous or malformed approach identities.
- Produces a compact artifact from the bundled annotation fixture.

### Resolver tests

- Approach annotation overrides segment annotation and OSM.
- Segment annotation applies when no approach record matches.
- Legacy annotation remains supported.
- Manual known lanes override OSM lane-by-lane.
- Manual `unknown` lanes use the corresponding OSM value.
- Reverse-direction lookup does not reuse forward data.
- Couplet way/node remapping preserves a matching annotation and reverses its direction when required.
- A different intersection on the same way does not reuse an approach annotation.
- Partial arrays retain known data rather than forcing full inference.

### HUD/model tests

- More than 250 metres uses current-span guidance.
- Exactly 250 metres switches to maneuver approach guidance.
- Annotation and OSM sources do not show the inference note.
- Geometry fallback still shows `車道建議（系統推測）`.

### Integration verification

- Run lane-guidance tests in both `LaneDev` and `LaneNav`.
- Build both projects.
- Confirm generated artifacts are identical.
- Run a simulated route through an annotated approach and verify the HUD uses the annotated movements.
- Verify no navigation control becomes active before lane-guidance readiness.

## Source and release synchronization

Implementation is authored in `LaneDev`, then copied with the existing synchronization workflow into `LaneNav`. Generated runtime artifacts and generation scripts are included in the synchronization contract. Existing user lockfile and source-artwork changes remain outside feature commits.
