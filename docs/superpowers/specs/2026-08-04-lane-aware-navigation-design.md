# Lane-Aware Navigation and HUD Synchronization Design

## Status

Approved in design review on 2026-08-04. This document defines the behavior to implement; it does not authorize canonical road-data migration or publication.

## Purpose

Make route planning respect the permitted movements of individual approach lanes, and make the route line, lane HUD, and lane-change advice use one shared lane plan. A turn must not be routed through a lane that explicitly permits only an incompatible movement. When reliable lane data is missing, navigation may remain available, but the HUD must disclose that the recommendation is inferred.

## Scope

- Apply lane-movement legality during initial route planning and every reroute.
- Select one primary recommended lane and retain other compatible lanes as secondary choices.
- Draw the route line through the selected lane and synchronize its lane-change transition with the HUD.
- Add lane-change difficulty to route cost without treating ordinary short preparation distance as an absolute prohibition.
- Preserve car, motorcycle, two-stage-left-turn, turn-bay, right-turn-lane, and GPS navigation behavior.
- Add explicit inferred-data and short-preparation-distance notices.

## Non-Goals

- Do not infer or verify the vehicle's actual lane from consumer GPS.
- Do not reroute merely because the driver did not follow the recommended lane while remaining on the routed road.
- Do not build a full lane-connector graph; the current data does not contain complete intersection lane connectivity.
- Do not edit, migrate, or publish canonical road annotations as part of this feature.
- Do not merge or push the feature branch without separate approval.

## Shared Lane Decision Model

Introduce a focused lane-decision resolver used by routing, route geometry, and the HUD. For an incoming directed road, maneuver, vehicle profile, and optional following maneuver, it returns a lane decision containing:

- the primary lane index;
- compatible secondary lane indices;
- explicitly incompatible lane indices;
- whether the decision is reliable or inferred;
- the preparation distance at which lane guidance begins;
- lane-change count and difficulty cost;
- whether a short-preparation warning is required;
- the target lateral offset used by route geometry.

The resolver consumes the already resolved annotation/OSM lane guidance. Existing precedence remains: matching intersection annotation, then segment-direction annotation, then OSM; missing values may be inferred but never override an explicit movement.

The resulting decision is stored on the route/maneuver. `laneBand()` and the HUD consume that stored decision instead of independently interpreting lane movements. This makes the primary HUD highlight and route-line lane deterministic and consistent.

## Route Search Integration

Lane legality is evaluated while `RoadGraph` considers a transition from an incoming edge to an outgoing edge.

1. Classify the transition into its effective maneuver action.
2. Resolve compatible lanes for that action and vehicle profile.
3. If every lane is reliably known and none permits the action, reject the transition.
4. If at least one lane permits the action, retain the transition and select a primary lane.
5. If some or all relevant lane movements are unknown, retain the transition using an inferred candidate and mark the decision as inferred.
6. Add lane-change difficulty to route cost so an otherwise reasonable route with easier lane preparation is preferred.
7. Reject a transition absolutely only for explicit movement incompatibility, a physical barrier, an existing access restriction, or another established hard routing rule.

If the shortest road-level route contains a prohibited turn, search continues for a legal alternative. If no legal alternative exists, planning reports that no route satisfies lane-direction restrictions.

## Compatible Movement Rules

- `right` and `slight-right` require a right-compatible lane.
- `left` and `slight-left` require a left-compatible lane.
- `through` requires a through-compatible lane.
- A combined lane such as `through;right` is compatible with either named action.
- A lane explicitly marked only `through` is not compatible with a right turn.
- Unknown movement data is not an explicit prohibition.
- For U-turns, an explicit `reverse` or `uturn` lane is preferred. If none exists but a left-compatible lane exists, the innermost left lane may be used as an inferred U-turn recommendation. If all lanes explicitly permit only through/right movements, the U-turn transition is prohibited.

## Primary and Secondary Lane Selection

Choose the primary lane in this order:

1. Remove explicitly incompatible lanes.
2. Prefer a dedicated lane for the maneuver over a combined lane.
3. Among candidates of equal type, minimize lane changes from the planned current lane.
4. If still tied, choose the outermost lane for a right turn and the innermost lane for a left turn.
5. Use the following maneuver as lookahead so two close maneuvers do not create an unnecessary outward movement followed by an abrupt inward movement.

Other compatible lanes remain secondary legal choices. Unknown lanes may be considered only when reliable compatible lanes are unavailable; an explicitly incompatible lane is never selected as an inferred fallback.

## Motorcycle Rules

- A two-stage left turn validates the first-stage through movement, not a direct left movement.
- It selects the outermost lane that permits through travel.
- A dedicated right-only lane must not be used to enter a two-stage waiting box.
- If no lane permits the required first-stage through movement, that two-stage route is unavailable.
- After a turn, motorcycle navigation normally returns to the outermost legally usable lane because motorcycles and slow vehicles generally keep right in Taiwan.
- Close following maneuvers override the normal post-turn outer-lane settling rule when lookahead requires an immediate safe preparation for the next action.
- Existing motorcycle-only lanes, motorcycle left-turn lanes, and two-stage waiting-box annotations remain authoritative.

## Post-Turn Lane Placement

- A car completing a right turn initially enters the outermost legal lane of the outgoing road.
- A car completing a left turn initially enters the innermost legal lane of the outgoing road.
- A motorcycle completing a turn initially enters the outermost legal lane unless close-maneuver lookahead requires another continuous lane plan.
- The route line must not immediately sweep back to a generic center lane when doing so would create an unnecessary or unsafe extra lane change.

## Preparation Distance and Route Geometry

The HUD and route line share one computed preparation distance.

- The baseline is 250 metres before the maneuver.
- The resolver may extend it for higher road speed, multiple lane changes, a turn bay, a right-turn pocket, or nearby maneuvers.
- At the same route distance, the HUD activates the primary lane, shows lane-change advice, and the route line begins its smooth lateral transition.
- The transition completes before the junction or at the applicable bay/pocket entry geometry.
- Existing slew limits and physical bay/taper windows remain in force; the line must not jump laterally.
- Overlapping preparation windows are resolved as one continuous lane plan using maneuver lookahead.

## Lane-Change Difficulty

When the available distance is shorter than the preferred preparation window, the transition remains legal if a compatible lane and physical access exist. The route receives an additional difficulty cost so an otherwise reasonable easier route is preferred.

If no reasonable alternative exists, keep the legal route and show this small amber HUD notice until the maneuver completes or a reroute replaces it:

> 前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。

The notice is advisory. It must not tell the driver to make an unsafe immediate lane change.

## HUD Presentation

The lane HUD has three visual states:

- **Primary:** strongest highlight; exactly matches the lane containing the planned route line.
- **Secondary compatible:** weaker highlight; communicates that the lane is legal but not preferred.
- **Incompatible:** inactive/grey presentation.

When any selected movement relies on missing lane-direction data, show `車道建議（系統推測）`. Reliable annotation/OSM guidance does not show the inference note. A partially missing record may infer an unknown lane, but a known incompatible lane remains inactive.

The HUD may say, for example, `請向右變換 1 個車道，進入右轉道`. This is route advice only; it does not claim that the system detected completion of the lane change.

## GPS and Rerouting Behavior

- Keep the vehicle marker at the real GPS position; do not force it onto the recommended lane geometry.
- Do not detect, confirm, or penalize lane-level compliance from GPS lateral position.
- Remaining on the routed road in a different lane does not trigger a reroute.
- When road-level deviation is confirmed, reroute from the latest GPS position and apply the same lane-legality resolver to the new route.
- Preserve consecutive-fix jitter protection and reroute cooldown so one inaccurate fix does not repeatedly redraw the route.

## Error Handling

- If a prohibited transition has an alternative, choose the alternative without presenting an error.
- If no legal route remains, show `找不到符合車道方向限制的路線`.
- Missing lane data is not a route error; disclose it through the inference note.
- A short lane-preparation window is not a route error; disclose it through the amber notice and route-cost preference.
- Existing hard restrictions, including medians, one-side-entry rules, vehicle access, and road-merge barriers, continue to win over inference.

## Tests

### Lane Decision Unit Tests

- Through-only lanes reject a right-turn transition.
- A dedicated right lane wins over a `through;right` lane.
- A combined lane remains legal when no dedicated lane exists.
- Multiple dedicated lanes use minimum lane changes, then the side-specific tie-breaker.
- Partial unknown data may infer an unknown lane but never an explicitly incompatible lane.
- U-turns prefer `reverse/uturn` and use a left-lane fallback only as inferred guidance.
- Two-stage motorcycle turns choose the outermost through-compatible lane and reject a right-only lane.

### Routing Tests

- `RoadGraph` finds an alternative when the shortest transition has no compatible lane.
- No legal alternative returns the lane-direction-specific error state.
- Lane-change difficulty influences route cost without overriding hard legality.
- Close maneuvers produce a continuous lookahead plan.
- Reroutes use the same lane restrictions as initial planning.

### Geometry and HUD Tests

- The route-line target lane equals the HUD primary lane.
- Secondary compatible lanes remain distinguishable from primary and incompatible lanes.
- HUD activation and route-line transition use the same preparation distance.
- Turn-bay/right-pocket geometry controls the transition entry window.
- Motorcycle post-turn placement is outermost unless lookahead overrides it.
- Inferred and short-preparation notices appear only under their corresponding conditions.

### Regression and Visual Verification

- Run the focused lane-decision, `RoadGraph`, lane-band, lane-preview, and HUD tests.
- Run `npm.cmd run test:all`.
- Run `npm.cmd run build` and `git diff --check`.
- Verify in a real browser that the route line remains inside the primary highlighted lane, transitions are smooth at different zoom levels, and HUD primary/secondary states remain readable.

## Acceptance Criteria

The feature is accepted when every explicitly incompatible turn is absent from planned and rerouted paths; inferred guidance remains available and disclosed; the route line and HUD always share the same primary lane and preparation distance; motorcycle/two-stage exceptions follow the rules above; close maneuvers remain geometrically continuous; and all focused, regression, build, and browser checks pass.
