# Pure central-band hatch rendering

## Goal

When a bidirectional road is edited with a positive central-band width and
`center_kind=hatch`, render the hatch marking even when neither end has an
offset turn bay. The existing accepted offset-turn-bay channelization geometry
must remain unchanged.

## Existing source of truth

No new stored field or index is required. Rendering uses the existing road
configuration:

- `oneway=no`
- `center_m > 0`
- `center_kind=hatch`
- the road block's existing junction setbacks and skew clipping

Turn-bay records remain optional. Their absence means the full valid
central-band range is available for pure hatch rendering.

## Geometry

The renderer reuses the current `hs` and `he` longitudinal limits. These limits
already clip the road block to its central-band extent and keep markings clear
of both junctions. The lateral limits remain `-center_m / 2` and
`+center_m / 2`.

If offset turn bays exist, their existing openings, S-shifts, one-sided
closures, caps, and triangular hatches continue through the current branches
without modification. A physical central island and a zero-width central band
produce no pure hatch lines.

## Shared style

Pure central-band hatches use `TAIWAN_YELLOW_HATCH_V1`, the same style as the
accepted offset-turn-bay channelization:

- stripe width: 0.18 m
- longitudinal pitch: 1.25 m
- lateral inset: 0.30 m
- minimum drawable length: 3 m

Road length changes only the stripe count. Central-band width changes only the
stripe endpoints. Neither changes stripe width or longitudinal density.

## Implementation boundary

Reuse `buildHatchDistances()` and the existing central-band boundary geometry
inside `buildChannelization()`. Remove only the requirement that an
`activeBayKey` must exist before the ordinary central-band hatch loop runs.
Do not create a second renderer and do not modify the accepted one-sided
offset-turn-bay branch.

The temporary left-turn-arrow cleanup exception created for diagnosis is out
of scope and must not be included.

## Acceptance criteria

1. A hatch central band with no turn bay renders stripes throughout `hs..he`.
2. Two valid ranges with different lengths retain the same 1.25 m pitch.
3. Two central bands with different widths retain the same station sequence and
   0.18 m stroke; only stripe endpoints differ.
4. Physical islands and zero-width central bands produce no pure hatch lines.
5. All accepted offset-turn-bay channelization tests remain unchanged and pass.
6. The result is visually verified on an editable map example before handoff.
