# Lane Guidance Preview Design

Date: 2026-07-24  
Branch: `codex/lane-guidance-preview`

## Purpose

Replace the current text-glyph lane row in the navigation HUD with a responsive,
image-based lane preview. The preview must update from the active route and
current road, highlight every lane that can perform the immediate navigation
action, and remain portable enough for a later mobile-app UI.

`LaneDev` remains the source project. Shared code and assets are copied to
`LaneNav` with `npm run sync-lanenav`.

## Goals

- Show the current travel direction's complete lane arrangement in a fixed-width
  blue preview area.
- Use the supplied white PNG arrows for recommended lanes and supplied gray PNG
  arrows for other lanes.
- Recompute lane guidance as the vehicle moves, the current road changes, or the
  next maneuver changes.
- Preserve a legible, compact layout from 320 px mobile screens through desktop
  simulation.
- Isolate lane-selection rules from React rendering so the rules can be reused
  when the web UI is replaced by an app.

## Non-goals

- Rebuild the whole navigation HUD.
- Determine which of several legal lanes is optimal; all compatible lanes are
  highlighted.
- Add new routing or map-matching algorithms.
- Convert the supplied artwork into true vector paths.
- Change the existing map editor or lane annotation schema.

## Guidance behavior

### Immediate action

The preview represents the action the driver should perform now:

- When the next maneuver is more than 250 m away, the immediate action is
  `through`.
- At 250 m or less, the immediate action is derived from the next maneuver:
  `left`, `right`, `through`, or `uturn`.
- For a motorcycle two-stage left turn at 250 m or less, the immediate action is
  to continue straight in the rightmost lane and enter the waiting area.

The boundary is inclusive: a maneuver at exactly 250 m uses the upcoming
maneuver guidance.

### Compatible lanes

- Highlight every lane whose movement list contains the immediate action.
- A combined lane such as `through;right` is highlighted for both the distant
  through phase and the near right-turn phase.
- Non-highlighted lanes remain visible with gray arrows.
- U-turn guidance uses the supplied left-turn arrow. With real movement data,
  `reverse` lanes are preferred, followed by `left`-compatible lanes. With
  inferred data, the leftmost lane is highlighted.

### Real and inferred data

- If current-road lane count and `turn:lanes` movements are available, use them.
- If lane count is available but movements are missing or unusable, infer a
  layout:
  - distant through phase: highlight through lanes;
  - left or U-turn phase: highlight the leftmost lane;
  - right phase: highlight the rightmost lane;
  - inferred turn lanes use the combined supplied artwork (`through+left` or
    `through+right`) while ordinary lanes use the through artwork.
- Inferred output displays the annotation `車道建議（系統推測）`.
- If lane count is missing, zero, non-finite, or otherwise invalid, render the
  fixed preview area with `暫無車道資料` and no arrows.

### Lane-count protection

- Render the actual lane count from 1 through 10.
- Do not retain the existing six-lane truncation.
- If source data exceeds 10 lanes, render the first 10 lanes and expose an
  abnormal-data state for accessible text and diagnostics.

### Two-stage left turn

- The waiting-area sign appears only for a motorcycle two-stage left turn at
  250 m or less.
- Use the supplied `二段式待轉牌.png`.
- Place the sign to the right of the distance and instruction text (approved
  layout B), not inside the lane row.
- Highlight the rightmost lane with the white through arrow.

## Visual design

### Preview surface

- Separate the lane preview surface from the existing distance-based banner
  tones.
- The instruction banner may keep its current blue, orange-red, and yellow
  phases.
- The lane preview itself always uses a stable blue background so white and gray
  arrow semantics do not change with distance.
- Use white arrow PNGs for compatible lanes and gray arrow PNGs for other lanes.

### Responsive geometry

- On mobile, the top navigation HUD uses the approved balanced width: 88% of the
  available viewport width.
- Apply a desktop maximum width so the HUD does not grow indefinitely.
- The lane row keeps a fixed available width. Each lane receives an equal share:
  fewer lanes create wider spacing, and more lanes create narrower spacing.
- Scale arrow size and gaps down as lane count grows; do not add horizontal
  scrolling.
- Support viewport widths down to 320 px without overlap or clipping.
- The primary distance string, such as `前方 200 公尺`, must never wrap.
- Secondary guidance may use a shorter mobile phrase when necessary.
- Inference annotation text remains at least 11 px.

## Components and data flow

### `src/nav/lanePreview.ts`

A pure, React-independent model converts navigation inputs into display data.
It consumes:

- current-road lane count;
- current-road movement strings;
- next maneuver kind;
- distance to the next maneuver;
- two-stage-left status.

It produces:

- preview availability;
- normalized lane entries, each with arrow kind and highlighted state;
- whether the result was inferred;
- whether source data exceeded the safe lane limit;
- whether the waiting-area sign is visible;
- the immediate action used for the decision.

No DOM, browser, image, map, or React dependency is allowed in this module.

### `src/nav/LanePreviewView.tsx`

The presentational component renders the model:

- arrow images with useful alternative text;
- fixed blue lane surface;
- inferred-data note;
- no-data message;
- waiting-area sign in the instruction area when requested.

### `src/nav/DriveHUD.tsx`

`DriveHUD` continues to own HUD composition and existing distance text. It passes
live `DriveState`, maneuver, profile, and two-stage status into the preview model
and component. Existing route and GPS drivers remain unchanged except where a
missing-vs-inferred distinction must be preserved.

### Assets

Copy the runtime PNG files into `LaneDev/src/nav/assets/lane-guidance/` with
ASCII filenames:

- `active-left.png`, `active-through.png`, `active-right.png`
- `active-through-left.png`, `active-through-right.png`
- `inactive-left.png`, `inactive-through.png`, `inactive-right.png`
- `inactive-through-left.png`, `inactive-through-right.png`
- `two-stage-wait-sign.png`

The supplied SVG files embed large PNG payloads (approximately 0.9–2.3 MB each)
and are not runtime assets. Preserve the user's original artwork folder as source
material.

## Error handling and accessibility

- Unknown movement tokens degrade to a through arrow without throwing.
- Empty movement entries do not make every lane compatible with a turn.
- Lane and arrow rendering uses stable array order from left to right.
- The preview exposes a concise accessible label describing lane count,
  recommended lane positions, inferred state, and truncated abnormal data.
- Missing image rendering must not remove the textual no-data or inference
  status.

## Testing and verification

Use test-driven development for the pure model. Tests cover:

- multiple compatible right-turn lanes;
- distant through phase and the inclusive 250 m transition;
- combined through/right compatibility in both phases;
- inferred left, right, through, and U-turn output;
- inference annotation state;
- missing lane-count output;
- motorcycle two-stage-left behavior and sign visibility;
- U-turn preference for reverse or left-compatible lanes;
- 1, 6, and 10 lane counts;
- more than 10 lanes;
- unknown and incomplete movement strings.

Verification after implementation:

1. Run the lane-preview unit tests.
2. Build `LaneDev`.
3. Run `npm run sync-lanenav`.
4. Build `LaneNav`.
5. Confirm synchronized shared files have no differences.
6. Inspect the HUD at 320 px, a typical mobile width, and desktop width.
7. Exercise distant through, near turn, inferred data, no data, U-turn, and
   two-stage-left states.

## Repository scope

The following pre-existing user changes are not part of the feature and must not
be staged or committed with it:

- `LaneNav/package-lock.json`
- repository-root `package-lock.json`

The original `製作地圖圖檔資料夾/` is user-supplied source material. Runtime
copies required by the feature may be committed under `LaneDev/src/nav/assets/`;
the full source-material directory must not be swept into a commit without
explicit scope review.

## Acceptance criteria

- The active navigation HUD shows all current-direction lanes up to the 10-lane
  safety limit in a fixed-width blue preview.
- Every compatible lane is white and every other lane is gray.
- Guidance shows through lanes beyond 250 m and upcoming-turn lanes at or below
  250 m.
- Inferred and unavailable data are clearly distinguished.
- The two-stage sign and rightmost through-lane highlight appear only within
  250 m of a required motorcycle two-stage left turn.
- The HUD remains readable at 320 px and uses the approved 88% mobile width.
- Both projects build after the shared-code synchronization.
