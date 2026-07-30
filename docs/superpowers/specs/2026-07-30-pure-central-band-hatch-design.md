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

For a pure central-band hatch with no turn bay, the outline is a closed
four-sided region. The existing two longitudinal boundaries are joined by one
transverse yellow cap at `hs` and one at `he`.

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

The accepted 3.2 m central band is the angle reference. Its usable lateral
span is `3.2 - 2 * 0.30 = 2.6 m`, and one full stripe advances 1.25 m along
the road. For a pure band of another width, the longitudinal stripe run is:

`run_m = usable_width_m * 1.25 / 2.6`

Stripe start stations remain 1.25 m apart, so road length changes only stripe
count and central-band width does not change density. If the final stripe
reaches `he`, it is clipped against the transverse end cap by interpolating
its lateral endpoint; its angle remains unchanged.

## Implementation boundary

Reuse `buildHatchDistances()` and the existing central-band boundary geometry
inside `buildChannelization()`. Apply the reference-angle run and the two
transverse caps only when there is no forward or backward turn bay. Do not
create a second renderer and do not modify the accepted one-sided
offset-turn-bay branch or its triangular hatch geometry.

The temporary left-turn-arrow cleanup exception created for diagnosis is out
of scope and must not be included.

## Acceptance criteria

1. A hatch central band with no turn bay renders stripes throughout `hs..he`.
2. A pure hatch region has two longitudinal boundaries and two transverse caps.
3. Two valid ranges with different lengths retain the same 1.25 m start pitch.
4. Pure central bands of different widths retain the 3.2 m reference angle,
   including any stripe clipped by the end cap.
5. Physical islands and zero-width central bands produce no pure hatch lines.
6. All accepted offset-turn-bay channelization tests remain unchanged and pass.
7. The result is visually verified on an editable map example before handoff.
