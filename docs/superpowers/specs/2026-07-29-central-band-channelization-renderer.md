# Central-band channelization renderer

## Goal

Channelization is rendered from the existing lane-editor central-band configuration, not from a competing shape model. The editor controls central-band width and kind, turn-bay use at both ends, and one-sided behavior. Automatic detection only supplies equivalent defaults when no manual configuration exists.

## Source of truth and precedence

The road-block settings are `center_m`, `center_kind`, turn-bay use at both ends, and `single_mode`. A manual journal record always wins over inferred values. A channelization record must not change lane-use semantics independently.

## Render outcomes

| Central-band/end use | Result |
| --- | --- |
| Both ends use an offset bay | Smooth S-shifted double-yellow boundaries. No mandatory triangular hatch area. |
| One end uses an offset bay with `single_mode=capped` | Draw a triangular hatch area on the unused side. Its tip is the physical start of the turn-bay taper; its junction end meets the central-band double-yellow boundary immediately before the approach stop line. It must not cover an arrow, the turn bay, or a traversable lane. |
| One end uses an offset bay with `single_mode=ignore` | Draw no hatch area; hold the double-yellow boundary where the active bay remains traversable. |
| Neither end uses an offset bay and the central band is hatch | Draw a pure central-band hatch area, clipped clear of junctions. |
| Central band is a physical island | Delegate to the island renderer. |

## Geometry and style

The triangular area is bounded by the moving offset-bay double-yellow edge and the opposite fixed central-band double-yellow edge. Its junction cap follows the central-band boundary immediately before the stop line. Hatches only appear inside that triangle and use `TAIWAN_YELLOW_HATCH_V1`: 0.18m stroke, 1.25m pitch, and 0.30m inset, regardless of the area's dimensions.

## Automatic and manual paths

Automatic inference creates only an effective central-band/turn-bay configuration and uses the same renderer as the editor. Manual central-band and one-/two-ended selections redraw immediately through that same renderer. The turn-bay panel may confirm exceptional turn use, but does not select a separate channelization side.

## Acceptance

1. A one-sided capped area starts at the turn-bay split and ends at the pre-stop-line central-band boundary, without entering the left-turn lane or arrow.
2. Forward and backward one-sided areas are mirrored.
3. Dual-sided use remains S-shaped without a mandatory triangle.
4. Pure and triangular hatches share density and stroke.
5. Identical inferred and manually edited settings produce identical geometry.
