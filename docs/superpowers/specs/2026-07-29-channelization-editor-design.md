# Channelization editor and consistent hatch rendering

## Goal

Make channelization a first-class, reviewable marking attached to an offset turn bay. Automatic detection must continue to supply sensible defaults, while editors can adjust, override, or disable the channelization area owned by that bay. A channelization area must never be created on a road without an effective offset turn bay. Every such area must use one rendering specification regardless of its length or width.

## Current behavior

`buildChannelization()` derives yellow boundaries and hatch marks from a merged road's `centerKind`, `centerM`, and generated `turn_bay` records. The editor can configure the centre band and a turn bay, including the existing one-sided `capped` and `ignore` modes, but cannot create or edit a standalone channelization area. Hatch marks are emitted through more than one path with different spacing assumptions.

## Scope

- Keep automatic turn-bay and channelization detection.
- Introduce a persistent `channelization` enhancement record that is owned by an effective `turn_bay`.
- Use one metric rendering profile for every yellow hatch area.
- Support the red-line reference pattern as a general, road-relative unused-side closure.
- Preserve existing `road` and `turn_bay` journal records and their behavior.

Out of scope: freehand polygons, standalone channelization on roads without an offset bay, changes to routing rules, and changing the meaning of physical median islands.

## Data model

Add `target.type = 'channelization'`. A record is anchored to a road block and its owning turn bay, not screen pixels:

```ts
{
  target: { type: 'channelization', key: 'way/W@node/N[~b]#channel' },
  fields: {
    present: 1,
    mode: 'auto' | 'override' | 'disabled',
    owner_turn_bay: 'way/W@node/N[~b]',
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

An automatic candidate is emitted only when its owning `turn_bay` is effective. It uses the same normalized shape internally. A manual record with `override` replaces that automatic candidate; `disabled` suppresses it without deleting history. Creating a channelization area first requires creating or enabling its parent turn bay through the existing offset-bay controls.

## Rendering profile: `taiwan-yellow-hatch-v1`

- Yellow boundary and cap lines use the existing road-marking color family.
- Hatch stroke width, centre-to-centre spacing, and hatch angle are global constants in one renderer.
- Hatch stations are measured in metres along the road, never inferred from the number of sampled geometry points or local band width.
- Each stripe is clipped to the computed channelization polygon with an inset from both boundaries.
- Narrow or short valid areas receive one centred adaptive stripe; areas below the minimum visible width are rendered as boundary/cap lines only.
- The renderer owns all channelization hatches. Turn-bay generation supplies geometry and ownership only, so duplicate or mixed-density hatches cannot occur.

## General unused-side closure (the red-line reference)

For a one-sided offset bay using `closure: 'unused-side'`, and only where its computed cross-section contains an unused central area, the unused side is represented as a tapered channelization region:

1. Begin at the point where the active bay transition starts.
2. Follow the fixed and moving yellow boundaries to form the unused-side polygon.
3. End at the road-intersection clearance boundary or the active bay mouth, whichever is upstream.
4. Add transverse cap lines at valid non-point ends.
5. Render the polygon using `taiwan-yellow-hatch-v1`.

This is independent of the sample image dimensions: short, long, narrow, wide, straight, and curved roads use the same construction and rendering profile.

## Editor behavior

Add a `槽化帶` section to the existing `偏心道` editor panel; it is unavailable unless that selected approach has an effective turn bay.

- Selecting an offset bay shows its automatic candidate and any existing override.
- Editors can accept an automatic candidate, disable it, or create an override for that same bay.
- An override uses road-relative start/end handles and endpoint-width controls; interaction snaps to the parent road block.
- Editors can choose closure type. `unused-side` shows the capped red-line-equivalent geometry; `none` intentionally draws no hatch area.
- Save, export, static-database persistence, and journal folding treat `channelization` like other enhancement types.

## Acceptance cases and visual evidence

For each case, preserve an unmodified baseline screenshot and an after screenshot at the same centre and zoom. Also capture one manual-edit state after creating or overriding the channelization region.

| Case | Location | Required proof |
|---|---|---|
| A | 援中路往高雄大學路左轉 (`22.7232222, 120.2859722`) | Single-sided bay with an actual unused-side closure; current map misses it. The after image must draw a capped, uniformly hatched region. |
| B1 | 後昌路／西濱公路 (`22.7116111, 120.2950000`) | Offset-bay candidate without a usable unused-side closure. It must not gain hatch marks merely because a bay exists. |
| B2 | 後昌路 747 (`22.7098302, 120.2967033`) | Single-sided offset bay. Review whether the unused side is visibly closed; use it to validate the one-sided closure rule. |
| C | 後昌路 761 (`22.7101883, 120.2963853`) | Dual-sided offset bays with existing hatching. Preserve approximate, consistent rendering; exact Street View matching is not required. |

## Tests

- Unit tests: normalize records, derive tapered polygons, metric station spacing, stripe clipping, narrow/short fallback, override precedence, and disabled automatic candidates.
- Existing turn-bay tests: no duplicate hatch lines and unchanged routing/bay semantics.
- Build and targeted tests pass on the isolated feature branch.
- Visual review: before/after/manual captures for A, B, and C.
