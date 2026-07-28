# Channelization editor and consistent hatch rendering

## Goal

Make channelization a first-class, reviewable road-marking feature. Automatic detection must continue to supply sensible defaults, while editors can create, adjust, override, or disable individual channelization areas. Every channelization area must use one rendering specification regardless of its length or width.

## Current behavior

`buildChannelization()` derives yellow boundaries and hatch marks from a merged road's `centerKind`, `centerM`, and generated `turn_bay` records. The editor can configure the centre band and a turn bay, including the existing one-sided `capped` and `ignore` modes, but cannot create or edit a standalone channelization area. Hatch marks are emitted through more than one path with different spacing assumptions.

## Scope

- Keep automatic turn-bay and channelization detection.
- Introduce a persistent `channelization` enhancement record and a dedicated map-editor tool.
- Use one metric rendering profile for every yellow hatch area.
- Support the red-line reference pattern as a general, road-relative unused-side closure.
- Preserve existing `road` and `turn_bay` journal records and their behavior.

Out of scope: freehand polygons, changes to routing rules, and changing the meaning of physical median islands.

## Data model

Add `target.type = 'channelization'`. A record is anchored to a road block, not screen pixels:

```ts
{
  target: { type: 'channelization', key: 'way/W@b/N#channel/C' },
  fields: {
    present: 1,
    mode: 'auto' | 'manual' | 'override' | 'disabled',
    s_start_m: number,
    s_end_m: number,
    width_start_m: number,
    width_end_m: number,
    side: 'forward' | 'backward' | 'center',
    closure: 'none' | 'unused-side',
    style: 'taiwan-yellow-hatch-v1'
  }
}
```

`s_start_m` and `s_end_m` are distances along the selected road block. Width changes linearly between the two endpoints. This produces a stable tapered region on straight or curved roads and survives viewport, zoom, and map projection changes.

Automatic candidates use the same normalized shape internally. A manual record with `override` replaces its automatic candidate. `disabled` suppresses an automatic candidate without deleting history. A `manual` record has no automatic predecessor.

## Rendering profile: `taiwan-yellow-hatch-v1`

- Yellow boundary and cap lines use the existing road-marking color family.
- Hatch stroke width, centre-to-centre spacing, and hatch angle are global constants in one renderer.
- Hatch stations are measured in metres along the road, never inferred from the number of sampled geometry points or local band width.
- Each stripe is clipped to the computed channelization polygon with an inset from both boundaries.
- Narrow or short valid areas receive one centred adaptive stripe; areas below the minimum visible width are rendered as boundary/cap lines only.
- The renderer owns all channelization hatches. Turn-bay generation supplies geometry and ownership only, so duplicate or mixed-density hatches cannot occur.

## General unused-side closure (the red-line reference)

For a one-sided offset bay using `closure: 'unused-side'`, the unused side is represented as a tapered channelization region:

1. Begin at the point where the active bay transition starts.
2. Follow the fixed and moving yellow boundaries to form the unused-side polygon.
3. End at the road-intersection clearance boundary or the active bay mouth, whichever is upstream.
4. Add transverse cap lines at valid non-point ends.
5. Render the polygon using `taiwan-yellow-hatch-v1`.

This is independent of the sample image dimensions: short, long, narrow, wide, straight, and curved roads use the same construction and rendering profile.

## Editor behavior

Add a `槽化帶` tool beside the existing lane, waiting-zone, and offset-bay tools.

- Selecting a road block shows automatic candidates and existing manual records.
- Editors can accept an automatic candidate, disable it, or create an override.
- Creating a manual region uses road-relative start/end handles and endpoint-width controls; interaction snaps to the selected road block.
- Editors can choose side and closure type. `unused-side` shows the capped red-line-equivalent geometry; `none` is a normal channelization band.
- Save, export, static-database persistence, and journal folding treat `channelization` like other enhancement types.

## Acceptance cases and visual evidence

For each case, preserve an unmodified baseline screenshot and an after screenshot at the same centre and zoom. Also capture one manual-edit state after creating or overriding the channelization region.

| Case | Location | Required proof |
|---|---|---|
| A | 藍田路, west of Lane 745 | Long central band; compare automatic hatch, one-sided closure, and density over length. |
| B | 援中路 × 德中路 (`22.72114, 120.28026`) | Short/skewed approach; caps and hatches remain inside road clearance. |
| C | 援中路 × 藍昌路 (`22.72520, 120.29150`) | Complex approach; manual override remains aligned on non-uniform usable length. |

## Tests

- Unit tests: normalize records, derive tapered polygons, metric station spacing, stripe clipping, narrow/short fallback, override precedence, and disabled automatic candidates.
- Existing turn-bay tests: no duplicate hatch lines and unchanged routing/bay semantics.
- Build and targeted tests pass on the isolated feature branch.
- Visual review: before/after/manual captures for A, B, and C.
