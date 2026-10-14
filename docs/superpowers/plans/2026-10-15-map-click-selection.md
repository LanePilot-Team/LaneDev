# Map Click Location Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let route-planning users select the start, destination, or via stop by tapping the map, while preserving place search, browse-mode map behavior, and real GPS navigation.

**Architecture:** Reuse the existing `pick` mode, `useMapCore` map-click dispatch, planner lane snapping, and route recalculation. A small pure helper will replace one stop with a snapped map coordinate and clear stale place metadata. `App` will own the currently selected stop ID for map picking; `PlanPanel` will expose the phone-sized action, instruction, and cancel control.

**Tech Stack:** React 19, TypeScript 6, MapLibre GL, Node built-in test runner, Vite, Android WebView packaging.

## Global Constraints

- Work only in `C:\Users\Cindy\Desktop\GraduationProject\LaneDev-android-standalone` on branch `android-simulation-dev`.
- Do not create another worktree, switch branches, push, create a PR, or merge.
- Preserve the existing untracked `.idea/`, `.superpowers/`, and the two existing route-preview plan files.
- Browse-mode map taps keep their current POI selection and road-information behavior.
- Real GPS navigation and Google Places API configuration remain unchanged.
- Reuse the existing planner snap distance guard (`180m`) for map-picked stops.
- Production code must be preceded by a failing test for the new pure stop-update behavior.
- Commit messages must be primarily Chinese.

---

### Task 1: Add a pure map-selected stop update with tests

**Files:**
- Modify: `web-source/src/plan/placeRoute.ts`
- Test: `web-source/src/plan/placeRoute.test.mjs`

**Interfaces:**
- Consumes: `Stop[]`, a stop ID, and an already-snapped `[lng, lat]` coordinate.
- Produces: `mapSelectionLabel(position)` and `withMapSelectedStop(stops, id, position)` for the planner.

- [ ] **Step 1: Write the failing tests**

Add these imports to `placeRoute.test.mjs`:

```js
import {
  createPlaceRouteStops, withCurrentStart,
  firstUnsetStopId, mapSelectionLabel, withMapSelectedStop,
} from './placeRoute.ts'
```

Add these tests after the existing `withCurrentStart` test:

```js
test('地圖選址只更新指定停靠點並清除舊地標資料', () => {
  const stops = [
    { id: 1, pos: [120, 22], label: '舊起點', address: '舊地址', placeId: 'old-start', placePosition: [120, 22], placeProvider: 'local' },
    { id: 3, pos: [120.1, 22.1], label: '舊停靠點', address: '舊停靠地址', placeId: 'old-via', placePosition: [120.1, 22.1], placeProvider: 'local' },
    { id: 2, pos: [120.2, 22.2], label: '終點', placeId: 'destination' },
  ]
  const position = [120.15, 22.15]

  const changed = withMapSelectedStop(stops, 3, position)

  assert.deepEqual(changed, [
    stops[0],
    { id: 3, pos: position, label: mapSelectionLabel(position) },
    stops[2],
  ])
  assert.deepEqual(stops[1], {
    id: 3, pos: [120.1, 22.1], label: '舊停靠點', address: '舊停靠地址',
    placeId: 'old-via', placePosition: [120.1, 22.1], placeProvider: 'local',
  })
})

test('地圖選址找不到指定停靠點時回傳 null', () => {
  assert.equal(withMapSelectedStop([{ id: 1, pos: null }], 2, [120, 22]), null)
})

test('地圖選址標籤包含容易辨識的緯經度', () => {
  assert.equal(mapSelectionLabel([120.2847, 22.7339]), '地圖選取位置 · 22.73390, 120.28470')
})
```

- [ ] **Step 2: Run the focused test and verify it fails for the intended reason**

Run from `web-source`:

```powershell
node --test src/plan/placeRoute.test.mjs
```

Expected: FAIL because `mapSelectionLabel` and `withMapSelectedStop` are not exported yet. Do not implement production code until this failure is observed.

- [ ] **Step 3: Implement the minimal pure helpers**

Add the following functions to `web-source/src/plan/placeRoute.ts` after `withCurrentStart`:

```ts
export function mapSelectionLabel(position: [number, number]): string {
  const [lng, lat] = position
  return `地圖選取位置 · ${lat.toFixed(5)}, ${lng.toFixed(5)}`
}

/** Replace exactly one stop with a snapped map coordinate and discard stale place metadata. */
export function withMapSelectedStop(
  stops: Stop[],
  id: number,
  position: [number, number],
): Stop[] | null {
  if (!stops.some((stop) => stop.id === id)) return null
  return stops.map((stop) => stop.id === id
    ? { id: stop.id, pos: position, label: mapSelectionLabel(position) }
    : stop)
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
node --test src/plan/placeRoute.test.mjs
```

Expected: all `placeRoute` tests pass, including the three new map-selection tests.

- [ ] **Step 5: Commit the self-contained data change**

```powershell
git add -- web-source/src/plan/placeRoute.ts web-source/src/plan/placeRoute.test.mjs
git commit -m "新增地圖選址停靠點資料處理"
```

---

### Task 2: Route map clicks to an explicitly selected stop

**Files:**
- Modify: `web-source/src/plan/usePlanner.ts:1-70,326-345`
- Modify: `web-source/src/App.tsx:20-56,100-143,175-180`

**Interfaces:**
- Consumes: `withMapSelectedStop` from Task 1 and a target stop ID from the UI.
- Produces: `Planner.handlePickClick(point, targetStopId?) => boolean`, where an explicit target replaces exactly that stop and a missing target preserves the existing active/first-unset behavior.

- [ ] **Step 1: Update the planner contract and implementation**

In `usePlanner.ts`:

1. Import `withMapSelectedStop` with the existing `placeRoute` imports.
2. Change the `Planner` interface method to:

```ts
handlePickClick: (p: [number, number], targetStopId?: number) => boolean
```

3. Replace the existing `handlePickClick` body with this behavior:

```ts
function handlePickClick(p: [number, number], targetStopId?: number): boolean {
  const list = stopsRef.current
  let targetId = targetStopId
  if (targetId === undefined) {
    const active = list.find((stop) => stop.id === activeStopRef.current)
    targetId = active && !active.pos
      ? active.id
      : list.find((stop) => !stop.pos)?.id
  }
  if (targetId === undefined) return false

  const targetIndex = list.findIndex((stop) => stop.id === targetId)
  if (targetIndex < 0) return false
  const pointLabel = targetIndex === 0
    ? '起點'
    : targetIndex === list.length - 1 ? '終點' : '停靠點'
  const snapped = snapRoutePoint(p, 180, pointLabel)
  if (!snapped) return false
  const next = withMapSelectedStop(list, targetId, snapped)
  if (!next) return false

  setRouteError(null)
  stopsRef.current = next
  setStopsState(next)
  setActiveStop(firstUnsetStopId(next))
  syncEndpoints()
  routeFromStops()
  return true
}
```

This keeps the old implicit behavior for existing callers while making explicit map picking deterministic and clearing stale metadata through the Task 1 helper.

- [ ] **Step 2: Add App-level map-picking state and dispatch**

In `App.tsx`:

1. Add `const [mapPickingStopId, setMapPickingStopId] = useState<number | null>(null)` beside the existing mode and destination state.
2. In the `useMapCore` callback, replace the unconditional pick-mode branch:

```ts
else if (m === 'pick' && mapPickingStopId !== null) {
  const selected = planner.handlePickClick(p, mapPickingStopId)
  if (selected) setMapPickingStopId(null)
}
```

This is deliberately scoped: ordinary taps in `pick` mode no longer overwrite a stop unless the user explicitly activated `Select on map`.
3. At the beginning of `switchMode`, call `setMapPickingStopId(null)` so closing the route panel cannot leave a stale picker active.
4. Pass these props to `PlanPanel`:

```tsx
mapPickingStopId={mapPickingStopId}
onStartMapPick={setMapPickingStopId}
onCancelMapPick={() => setMapPickingStopId(null)}
```

- [ ] **Step 3: Run TypeScript compilation before adding UI**

Run from `web-source`:

```powershell
npm run build
```

Expected: the build passes with the new optional planner argument and App dispatch. If TypeScript reports that `planner` or the new state is not available inside the callback, move only the state declaration before `useMapCore`; keep the existing hook ordering and do not restructure the map core.

- [ ] **Step 4: Commit the explicit dispatch change**

```powershell
git add -- web-source/src/plan/usePlanner.ts web-source/src/App.tsx
git commit -m "讓地圖點擊指定更新路線停靠點"
```

---

### Task 3: Add the phone-sized PlanPanel control and picker feedback

**Files:**
- Modify: `web-source/src/plan/PlanPanel.tsx:10-120`
- Modify: `web-source/src/App.tsx:170-182`
- Modify: `web-source/src/App.css:199,500-506`

**Interfaces:**
- Consumes: `mapPickingStopId`, `onStartMapPick`, and `onCancelMapPick` from Task 2.
- Produces: an accessible per-stop `在地圖上選取` action, a compact active-picker instruction, and a cancel path that does not affect search or routing data.

- [ ] **Step 1: Extend PlanPanel props and reset picker state when editing changes**

Change the component props to:

```ts
export function PlanPanel({
  core, planner, onClose, startGpsNav, startSimulation, simulationEnabled,
  mapPickingStopId, onStartMapPick, onCancelMapPick,
}: {
  core: MapCore; planner: Planner; onClose: () => void
  startGpsNav: () => void; startSimulation: () => void; simulationEnabled: boolean
  mapPickingStopId: number | null
  onStartMapPick: (stopId: number) => void
  onCancelMapPick: () => void
}) {
```

When `editStop` is called for a different stop, call `onCancelMapPick()` before selecting the new stop. In `selectPlace`, call `onCancelMapPick()` before closing the editor. When adding or removing a via stop, also cancel an active picker. The existing Escape handler should cancel the picker before closing the editor as well.

- [ ] **Step 2: Add the map-pick button and status inside the editing branch**

Immediately after the existing `PlaceSearch` and before the current-location suggestion, add:

```tsx
<button
  type="button"
  className={`map-pick-button${mapPickingStopId === stop.id ? ' on' : ''}`}
  aria-pressed={mapPickingStopId === stop.id}
  onClick={() => mapPickingStopId === stop.id
    ? onCancelMapPick()
    : onStartMapPick(stop.id)}
>
  {mapPickingStopId === stop.id ? '取消地圖選取' : '⌖ 在地圖上選取'}
</button>
{mapPickingStopId === stop.id && (
  <div className="map-pick-hint" role="status">
    <span>請在地圖上點選{label(i)}；系統會吸附到附近道路。</span>
    <button type="button" onClick={onCancelMapPick}>取消</button>
  </div>
)}
```

Leave `PlaceSearch` mounted so the user can still choose a search result instead of tapping the map. After a successful map tap, App clears the active picker; the editor may remain open, allowing the user to inspect or change the selected coordinate, and the existing `取消` action closes the editor before navigation starts.

- [ ] **Step 3: Add compact styles and limit the crosshair to active picking**

Add these styles near the route-stop controls in `App.css`:

```css
.map-pick-button {
  width: 100%; margin-top: 6px; padding: 8px 10px;
  border: 1px solid #b8c8df; border-radius: 9px;
  background: #f4f8ff; color: #1769e8;
  font-size: 12px; font-weight: 700; cursor: pointer;
}
.map-pick-button.on { background: #1769e8; color: #fff; }
.map-pick-button:focus-visible, .map-pick-hint button:focus-visible {
  outline: 2px solid #1769e8; outline-offset: 2px;
}
.map-pick-hint {
  display: flex; align-items: center; gap: 7px; margin-top: 6px;
  padding: 8px 9px; border-radius: 8px;
  background: #eaf2ff; color: #24538e; font-size: 11px; line-height: 1.35;
}
.map-pick-hint span { min-width: 0; flex: 1; }
.map-pick-hint button {
  flex: none; border: 0; padding: 3px 0; background: transparent;
  color: #1769e8; font-size: 11px; font-weight: 800; cursor: pointer;
}
```

Change the broad cursor rule from:

```css
.app[data-mode='pick'] .maplibregl-canvas { cursor: crosshair; }
```

to:

```css
.app[data-mode='pick'][data-map-picking='true'] .maplibregl-canvas { cursor: crosshair; }
```

Also add `data-map-picking={mapPickingStopId !== null}` to the root `.app` element in `App.tsx` so the cursor communicates only the explicit map-picking state.

- [ ] **Step 4: Run the full web test suite and build**

Run from `web-source`:

```powershell
npm test
npm run build
```

Expected: all existing tests and the new `placeRoute` tests pass; TypeScript and Vite build complete without errors.

- [ ] **Step 5: Inspect the diff and commit the UI change**

```powershell
git diff --check
git diff -- web-source/src/App.tsx web-source/src/plan/PlanPanel.tsx web-source/src/App.css
git add -- web-source/src/App.tsx web-source/src/plan/PlanPanel.tsx web-source/src/App.css
git commit -m "新增路線規劃地圖選址介面"
```

Review points: browse-mode taps still show road information, search selection still closes editing, map selection is scoped to the selected stop, and no map-picking state remains after switching modes.

---

### Task 4: Package the debug APK and perform phone verification

**Files:**
- Generated/modified by build only: `app/build/outputs/apk/debug/app-debug.apk`
- No source changes expected unless a verification failure requires a new TDD cycle.

**Interfaces:**
- Consumes: the web client produced by Task 3 and the existing Android WebView packaging.
- Produces: an installable debug APK and verified on-device map-selection behavior.

- [ ] **Step 1: Build the Android debug APK**

Run from the repository root:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug
```

Expected: `BUILD SUCCESSFUL` and a fresh `app\build\outputs\apk\debug\app-debug.apk`.

- [ ] **Step 2: Confirm the phone is authorized before installation**

Run:

```powershell
$adb = 'C:\Users\Cindy\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb devices -l
```

Expected: the connected device status is `device`, not `unauthorized` or `offline`. If authorization is pending, ask the user to unlock the phone and accept the USB debugging dialog before continuing.

- [ ] **Step 3: Install and launch the APK**

Run:

```powershell
$apk = (Resolve-Path '.\app\build\outputs\apk\debug\app-debug.apk').Path
& $adb install -r $apk
& $adb shell am start -n 'tw.lanepilot.lanedev/.MainActivity'
```

Expected: `Success` from install and `Starting: Intent { cmp=tw.lanepilot.lanedev/.MainActivity }` from launch. Notify the user before this step that the phone test is ready.

- [ ] **Step 4: Perform the manual acceptance checklist on the phone**

1. Enter route planning and open a stop for editing.
2. Tap `⌖ 在地圖上選取`; confirm the instruction and crosshair appear.
3. Tap a road near the desired start; confirm the start marker and coordinate label update.
4. Repeat for the destination and one via stop; confirm the blue route redraws after all points are valid.
5. Tap the editor cancel control, confirm the route start buttons become usable, and start development simulation.
6. Confirm normal browse-mode map taps still show road information after ending planning.

- [ ] **Step 5: Record verification output and final repository state**

Run:

```powershell
git status --short --branch
git log -5 --oneline --decorate
```

Expected: branch remains `android-simulation-dev`; only the intentionally preserved untracked local files remain. Do not push or create a PR.

