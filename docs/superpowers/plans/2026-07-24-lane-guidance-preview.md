# Lane Guidance Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the navigation HUD's glyph lane row with a responsive, image-based preview that highlights every lane compatible with the driver's immediate route action.

**Architecture:** A React-independent `buildLanePreview` function converts live navigation inputs into a normalized display model. `LanePreviewView.tsx` renders that model with bundled PNG assets, while `DriveHUD.tsx` retains composition and passes current route state into the model. Shared files are authored in `LaneDev` and mirrored to `LaneNav`.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Node 24 built-in test runner, CSS.

## Global Constraints

- Work only on branch `codex/lane-guidance-preview`.
- `LaneDev` is the source of shared navigation code; mirror it with `npm run sync-lanenav`.
- Mobile HUD width is 88% of the viewport with a desktop maximum width.
- The lane preview surface always stays blue and supports 320 px viewports.
- Render 1–10 lanes; truncate larger source counts to 10 and mark the model abnormal.
- At more than 250 m, highlight through-compatible lanes; at 250 m or less, highlight lanes compatible with the upcoming maneuver.
- White PNG arrows are active and gray PNG arrows are inactive.
- Never stage the pre-existing `LaneNav/package-lock.json`, repository-root `package-lock.json`, or the full source-artwork directory.

---

### Task 1: Pure lane-preview decision model

**Files:**
- Create: `LaneDev/src/nav/lanePreview.ts`
- Create: `LaneDev/src/nav/lanePreview.test.mjs`
- Modify: `LaneDev/package.json`

**Interfaces:**
- Consumes: lane count, movement strings, maneuver kind, distance, and two-stage-left state.
- Produces:
  - `buildLanePreview(input: LanePreviewInput): LanePreviewModel`
  - `LaneArrowKind`
  - `LanePreviewLane`
  - `LanePreviewModel`

- [ ] **Step 1: Add the Node test command and write the failing model tests**

Add this script to `LaneDev/package.json`:

```json
"test:lane-preview": "node --test src/nav/lanePreview.test.mjs"
```

Create `LaneDev/src/nav/lanePreview.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanePreview } from './lanePreview.ts'

const ready = (overrides = {}) => buildLanePreview({
  laneCount: 3,
  turnLanes: ['through', 'through;right', 'right'],
  maneuverKind: 'right',
  distanceM: 200,
  twoStage: false,
  ...overrides,
})

test('highlights every lane compatible with a near right turn', () => {
  const model = ready()
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, true, true])
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through-right', 'right'])
})

test('uses through as the immediate action beyond 250 metres', () => {
  const model = ready({ distanceM: 251 })
  assert.equal(model.immediateAction, 'through')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, true, false])
})

test('switches to the maneuver at exactly 250 metres', () => {
  const model = ready({ distanceM: 250 })
  assert.equal(model.immediateAction, 'right')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, true, true])
})

test('infers a rightmost combined lane and marks the result inferred', () => {
  const model = ready({ turnLanes: undefined })
  assert.equal(model.inferred, true)
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through', 'through-right'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, false, true])
})

test('infers through guidance beyond 250 metres', () => {
  const model = ready({ turnLanes: undefined, distanceM: 600 })
  assert.equal(model.immediateAction, 'through')
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, true, true])
})

test('returns no-data when lane count is invalid', () => {
  const model = ready({ laneCount: undefined })
  assert.equal(model.status, 'no-data')
  assert.deepEqual(model.lanes, [])
})

test('shows two-stage guidance only within 250 metres', () => {
  const near = ready({ twoStage: true, maneuverKind: 'left', distanceM: 250 })
  assert.equal(near.showTwoStageSign, true)
  assert.deepEqual(near.lanes.map((lane) => lane.active), [false, false, true])
  assert.deepEqual(near.lanes.map((lane) => lane.arrow), ['through', 'through-right', 'through'])

  const far = ready({ twoStage: true, maneuverKind: 'left', distanceM: 251 })
  assert.equal(far.showTwoStageSign, false)
  assert.equal(far.immediateAction, 'through')
})

test('uses left artwork for a u-turn and prefers a reverse lane', () => {
  const model = ready({
    turnLanes: ['reverse', 'left;through', 'through'],
    maneuverKind: 'uturn',
  })
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['left', 'through-left', 'through'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, false, false])
})

test('falls back from u-turn to a left-compatible lane', () => {
  const model = ready({
    turnLanes: ['left', 'through', 'right'],
    maneuverKind: 'uturn',
  })
  assert.deepEqual(model.lanes.map((lane) => lane.active), [true, false, false])
})

test('renders one, six, and ten lanes without truncating', () => {
  for (const count of [1, 6, 10]) {
    const model = ready({ laneCount: count, turnLanes: undefined })
    assert.equal(model.lanes.length, count)
    assert.equal(model.truncated, false)
  }
})

test('truncates abnormal lane counts above ten', () => {
  const model = ready({ laneCount: 12, turnLanes: undefined })
  assert.equal(model.lanes.length, 10)
  assert.equal(model.truncated, true)
})

test('unknown and incomplete movement strings do not throw or activate turn lanes', () => {
  const model = ready({ turnLanes: ['unknown-token', '', 'right'] })
  assert.deepEqual(model.lanes.map((lane) => lane.arrow), ['through', 'through', 'right'])
  assert.deepEqual(model.lanes.map((lane) => lane.active), [false, false, true])
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cd LaneDev
npm.cmd run test:lane-preview
```

Expected: FAIL because `src/nav/lanePreview.ts` does not exist.

- [ ] **Step 3: Implement the pure model**

Create `LaneDev/src/nav/lanePreview.ts` with these public types and rules:

```ts
export type LaneArrowKind =
  | 'left'
  | 'through'
  | 'right'
  | 'through-left'
  | 'through-right'

export type LanePreviewAction = 'left' | 'through' | 'right' | 'uturn'

export interface LanePreviewInput {
  laneCount?: number
  turnLanes?: string[]
  maneuverKind: 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'arrive'
  distanceM: number
  twoStage: boolean
}

export interface LanePreviewLane {
  arrow: LaneArrowKind
  active: boolean
}

export interface LanePreviewModel {
  status: 'ready' | 'no-data'
  lanes: LanePreviewLane[]
  immediateAction: LanePreviewAction
  inferred: boolean
  truncated: boolean
  showTwoStageSign: boolean
}

const MAX_LANES = 10
const TURN_GUIDANCE_M = 250

type NormalMove = 'left' | 'through' | 'right' | 'reverse'

function normalizeMove(token: string): NormalMove | null {
  const value = token.trim().toLowerCase()
  if (value === 'left' || value === 'slight_left' || value === 'sharp_left' ||
      value === 'merge_to_left') return 'left'
  if (value === 'right' || value === 'slight_right' || value === 'sharp_right' ||
      value === 'merge_to_right') return 'right'
  if (value === 'through' || value === 'none') return 'through'
  if (value === 'reverse' || value === 'uturn') return 'reverse'
  return null
}

function parseMoves(value: string): Set<NormalMove> {
  return new Set(value.split(/[;+]/).map(normalizeMove).filter((move): move is NormalMove => move !== null))
}

function arrowFor(moves: Set<NormalMove>): LaneArrowKind {
  if (moves.has('through') && moves.has('left')) return 'through-left'
  if (moves.has('through') && moves.has('right')) return 'through-right'
  if (moves.has('reverse') || moves.has('left')) return 'left'
  if (moves.has('right')) return 'right'
  return 'through'
}

function maneuverAction(kind: LanePreviewInput['maneuverKind']): LanePreviewAction {
  if (kind === 'left' || kind === 'slight-left') return 'left'
  if (kind === 'right' || kind === 'slight-right') return 'right'
  if (kind === 'uturn') return 'uturn'
  return 'through'
}

function inferredLanes(count: number, action: LanePreviewAction, twoStageNear: boolean): LanePreviewLane[] {
  return Array.from({ length: count }, (_, index) => {
    if (twoStageNear) {
      const active = index === count - 1
      return { arrow: 'through', active }
    }
    if (action === 'through') return { arrow: 'through', active: true }
    if (action === 'left' || action === 'uturn') {
      const active = index === 0
      return { arrow: active ? 'through-left' : 'through', active }
    }
    const active = index === count - 1
    return { arrow: active ? 'through-right' : 'through', active }
  })
}

export function buildLanePreview(input: LanePreviewInput): LanePreviewModel {
  const near = Number.isFinite(input.distanceM) && input.distanceM <= TURN_GUIDANCE_M
  const twoStageNear = input.twoStage && near
  const immediateAction: LanePreviewAction = near ? maneuverAction(input.maneuverKind) : 'through'
  const countValue = Number(input.laneCount)
  if (!Number.isFinite(countValue) || countValue < 1) {
    return {
      status: 'no-data',
      lanes: [],
      immediateAction,
      inferred: false,
      truncated: false,
      showTwoStageSign: twoStageNear,
    }
  }

  const sourceCount = Math.floor(countValue)
  const count = Math.min(sourceCount, MAX_LANES)
  const truncated = sourceCount > MAX_LANES
  const realMovements = Array.isArray(input.turnLanes) && input.turnLanes.length >= count
  if (!realMovements) {
    return {
      status: 'ready',
      lanes: inferredLanes(count, immediateAction, twoStageNear),
      immediateAction,
      inferred: true,
      truncated,
      showTwoStageSign: twoStageNear,
    }
  }

  const parsed = input.turnLanes.slice(0, count).map(parseMoves)
  const hasKnownMovement = parsed.some((moves) => moves.size > 0)
  if (!hasKnownMovement) {
    return {
      status: 'ready',
      lanes: inferredLanes(count, immediateAction, twoStageNear),
      immediateAction,
      inferred: true,
      truncated,
      showTwoStageSign: twoStageNear,
    }
  }

  const hasReverse = parsed.some((moves) => moves.has('reverse'))
  const lanes = parsed.map((moves, index) => {
    let active = false
    if (twoStageNear) {
      active = index === count - 1
      return { arrow: active ? 'through' : arrowFor(moves), active }
    }
    else if (immediateAction === 'uturn') {
      active = hasReverse ? moves.has('reverse') : moves.has('left')
    } else active = moves.has(immediateAction)
    return { arrow: arrowFor(moves), active }
  })

  return {
    status: 'ready',
    lanes,
    immediateAction,
    inferred: false,
    truncated,
    showTwoStageSign: twoStageNear,
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd run test:lane-preview
```

Expected: 12 tests pass, 0 fail.

- [ ] **Step 5: Commit the model**

```powershell
git add -- LaneDev/package.json LaneDev/src/nav/lanePreview.ts LaneDev/src/nav/lanePreview.test.mjs
git commit -m "feat: model route-aware lane guidance"
```

### Task 2: Runtime artwork and responsive preview component

**Files:**
- Create: `LaneDev/src/nav/assets/lane-guidance/*.png`
- Create: `LaneDev/src/nav/LanePreviewView.tsx`
- Modify: `LaneDev/src/nav/DriveHUD.tsx`
- Modify: `LaneDev/src/App.css`

**Interfaces:**
- Consumes: `LanePreviewModel` from Task 1.
- Produces:
  - `LanePreviewPanel({ model }: { model: LanePreviewModel })`
  - `TwoStageWaitSign()`

- [ ] **Step 1: Copy only the required PNG runtime assets**

Create `LaneDev/src/nav/assets/lane-guidance/` and copy:

```text
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/白色箭頭(顯示)/png/白_左.png
  -> LaneDev/src/nav/assets/lane-guidance/active-left.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/白色箭頭(顯示)/png/白_直.png
  -> LaneDev/src/nav/assets/lane-guidance/active-through.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/白色箭頭(顯示)/png/白_右.png
  -> LaneDev/src/nav/assets/lane-guidance/active-right.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/白色箭頭(顯示)/png/白_直左.png
  -> LaneDev/src/nav/assets/lane-guidance/active-through-left.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/白色箭頭(顯示)/png/白_直右.png
  -> LaneDev/src/nav/assets/lane-guidance/active-through-right.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/灰色箭頭(隱藏)/png/灰_左.png
  -> LaneDev/src/nav/assets/lane-guidance/inactive-left.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/灰色箭頭(隱藏)/png/灰_直.png
  -> LaneDev/src/nav/assets/lane-guidance/inactive-through.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/灰色箭頭(隱藏)/png/灰_右.png
  -> LaneDev/src/nav/assets/lane-guidance/inactive-right.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/灰色箭頭(隱藏)/png/灰_直左.png
  -> LaneDev/src/nav/assets/lane-guidance/inactive-through-left.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/灰色箭頭(隱藏)/png/灰_直右.png
  -> LaneDev/src/nav/assets/lane-guidance/inactive-through-right.png
製作地圖圖檔資料夾/車道預覽圖(箭頭圖案)/二段式待轉牌.png
  -> LaneDev/src/nav/assets/lane-guidance/two-stage-wait-sign.png
```

Do not copy SVG files or stage the source-artwork directory.

- [ ] **Step 2: Create the presentational component**

Create `LaneDev/src/nav/LanePreviewView.tsx`:

```tsx
import type { CSSProperties } from 'react'
import type { LaneArrowKind, LanePreviewModel } from './lanePreview'
import activeLeft from './assets/lane-guidance/active-left.png'
import activeThrough from './assets/lane-guidance/active-through.png'
import activeRight from './assets/lane-guidance/active-right.png'
import activeThroughLeft from './assets/lane-guidance/active-through-left.png'
import activeThroughRight from './assets/lane-guidance/active-through-right.png'
import inactiveLeft from './assets/lane-guidance/inactive-left.png'
import inactiveThrough from './assets/lane-guidance/inactive-through.png'
import inactiveRight from './assets/lane-guidance/inactive-right.png'
import inactiveThroughLeft from './assets/lane-guidance/inactive-through-left.png'
import inactiveThroughRight from './assets/lane-guidance/inactive-through-right.png'
import twoStageWaitSign from './assets/lane-guidance/two-stage-wait-sign.png'

const ACTIVE: Record<LaneArrowKind, string> = {
  left: activeLeft,
  through: activeThrough,
  right: activeRight,
  'through-left': activeThroughLeft,
  'through-right': activeThroughRight,
}

const INACTIVE: Record<LaneArrowKind, string> = {
  left: inactiveLeft,
  through: inactiveThrough,
  right: inactiveRight,
  'through-left': inactiveThroughLeft,
  'through-right': inactiveThroughRight,
}

const ARROW_LABEL: Record<LaneArrowKind, string> = {
  left: '左轉',
  through: '直行',
  right: '右轉',
  'through-left': '直行或左轉',
  'through-right': '直行或右轉',
}

function previewLabel(model: LanePreviewModel): string {
  if (model.status === 'no-data') return '暫無車道資料'
  const active = model.lanes
    .map((lane, index) => lane.active ? `第 ${index + 1} 車道` : null)
    .filter((value): value is string => value !== null)
  const source = model.inferred ? '，系統推測' : ''
  const truncated = model.truncated ? '，來源超過十車道，僅顯示前十條' : ''
  return `共 ${model.lanes.length} 車道，建議 ${active.join('、') || '無'}${source}${truncated}`
}

export function TwoStageWaitSign() {
  return <img className="two-stage-sign" src={twoStageWaitSign} alt="機車兩段式左轉待轉標誌" />
}

export function LanePreviewPanel({ model }: { model: LanePreviewModel }) {
  if (model.status === 'no-data') {
    return (
      <div className="lane-preview lane-preview-empty" aria-label={previewLabel(model)}>
        暫無車道資料
      </div>
    )
  }

  return (
    <div className="lane-preview" aria-label={previewLabel(model)}>
      <div className="lane-preview-row" style={{ '--lane-count': model.lanes.length } as CSSProperties}>
        {model.lanes.map((lane, index) => (
          <div className="lane-preview-cell" key={index}>
            <img
              className="lane-preview-arrow"
              src={(lane.active ? ACTIVE : INACTIVE)[lane.arrow]}
              alt={`第 ${index + 1} 車道：${ARROW_LABEL[lane.arrow]}${lane.active ? '，建議' : ''}`}
            />
          </div>
        ))}
      </div>
      {model.inferred && <div className="lane-preview-note">車道建議（系統推測）</div>}
    </div>
  )
}
```

- [ ] **Step 3: Integrate the model with `TopBanner`**

In `LaneDev/src/nav/DriveHUD.tsx`:

1. Import `buildLanePreview`, `LanePreview`, and `TwoStageWaitSign`.
2. Replace `LaneRow` construction with:

```tsx
const lanePreview = buildLanePreview({
  laneCount: drive.roadLanes,
  turnLanes: drive.roadTurnLanes,
  maneuverKind: m.kind,
  distanceM: dist,
  twoStage,
})
```

3. Add `{lanePreview.showTwoStageSign && <TwoStageWaitSign />}` as the last
   child of `.banner-main`.
4. Replace `<LaneRow ... />` with `<LanePreview model={lanePreview} />`.
5. Delete `TURN_GLYPH`, `laneGlyph`, and `LaneRow`; preserve
   `guidanceText`, `ManeuverArrow`, decision controls, and distance behavior.

- [ ] **Step 4: Implement the responsive CSS**

In `LaneDev/src/App.css`:

- Change `.banner` to center an 88% width with `max-width: 480px`.
- Make `.banner-main` a non-wrapping flex row and give `.banner-dist`
  `min-width: 0; flex: 1`.
- Add `white-space: nowrap` to `.banner-dist b`.
- Add `.two-stage-sign` at 48 px desktop and 42 px below 360 px.
- Remove the old `.lane-row`, `.lane-box`, `.lane-box.on`,
  `.lane-box.multi`, and `.lane-box.bay` rules.
- Add:

```css
.lane-preview {
  margin: 10px -6px -4px;
  padding: 10px 10px 7px;
  border-radius: 10px;
  background: linear-gradient(180deg, #0f6be0, #1058b8);
  color: #fff;
}
.lane-preview-row {
  display: grid;
  grid-template-columns: repeat(var(--lane-count), minmax(0, 1fr));
  align-items: center;
  width: 100%;
}
.lane-preview-cell {
  min-width: 0;
  display: grid;
  place-items: center;
}
.lane-preview-arrow {
  display: block;
  width: clamp(20px, calc(145px / var(--lane-count)), 42px);
  max-width: 100%;
  height: 42px;
  object-fit: contain;
}
.lane-preview-note {
  margin-top: 4px;
  text-align: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.82);
}
.lane-preview-empty {
  min-height: 54px;
  display: grid;
  place-items: center;
  font-size: 13px;
}
.two-stage-sign {
  flex: none;
  width: 48px;
  height: 48px;
  object-fit: contain;
}
```

At `max-width: 360px`, keep `.banner-dist b` on one line, reduce padding,
reduce `.man-arrow`, set `.two-stage-sign` to 42 px, and hide
`.banner-then` before allowing overlap.

- [ ] **Step 5: Run tests and build**

Run:

```powershell
cd LaneDev
npm.cmd run test:lane-preview
npm.cmd run build
```

Expected: lane-preview tests pass and Vite build exits 0.

- [ ] **Step 6: Commit the component and runtime assets**

Stage only:

```powershell
git add -- LaneDev/src/nav/lanePreview.ts LaneDev/src/nav/LanePreviewView.tsx LaneDev/src/nav/DriveHUD.tsx LaneDev/src/nav/assets/lane-guidance LaneDev/src/App.css
git commit -m "feat: render responsive lane guidance preview"
```

### Task 3: Mirror the release navigation project

**Files:**
- Modify: `LaneNav/src/nav/lanePreview.ts`
- Create: `LaneNav/src/nav/lanePreview.test.mjs`
- Create: `LaneNav/src/nav/LanePreviewView.tsx`
- Create: `LaneNav/src/nav/assets/lane-guidance/*.png`
- Modify: `LaneNav/src/nav/DriveHUD.tsx`
- Modify: `LaneNav/src/App.css`
- Modify: `LaneNav/package.json`

**Interfaces:**
- Consumes: completed source files from Tasks 1 and 2.
- Produces: matching shared navigation behavior in the release project.

- [ ] **Step 1: Mirror whitelisted shared files**

Run:

```powershell
cd LaneDev
npm.cmd run sync-lanenav
```

Expected: the script reports `src/nav` and `src/App.css` copied to `LaneNav`.

- [ ] **Step 2: Add the same test script to the release package**

Add to `LaneNav/package.json`:

```json
"test:lane-preview": "node --test src/nav/lanePreview.test.mjs"
```

Do not stage `LaneNav/package-lock.json`.

- [ ] **Step 3: Verify release tests and build**

Run:

```powershell
cd ..\LaneNav
npm.cmd run test:lane-preview
npm.cmd run build
```

Expected: lane-preview tests pass and Vite build exits 0.

- [ ] **Step 4: Verify shared source equality**

Run:

```powershell
git diff --no-index -- LaneDev/src/nav LaneNav/src/nav
git diff --no-index -- LaneDev/src/App.css LaneNav/src/App.css
```

Expected: the first comparison may differ only in files intentionally excluded
from synchronization; all mirrored navigation source and assets are equal. The
CSS comparison exits with no differences.

- [ ] **Step 5: Commit only release-project shared files**

```powershell
git add -- LaneNav/src/nav LaneNav/src/App.css LaneNav/package.json
git commit -m "chore: sync lane guidance into LaneNav"
```

### Task 4: Browser verification and final scope audit

**Files:**
- Modify only if a verified defect requires a focused fix.

**Interfaces:**
- Consumes: built `LaneDev` and `LaneNav`.
- Produces: evidence that accepted behavior works at mobile and desktop widths.

- [ ] **Step 1: Start `LaneDev` and exercise representative states**

Run:

```powershell
cd LaneDev
npm.cmd run dev -- --host 127.0.0.1
```

Inspect at 320 px, 390 px, and desktop widths. Verify:

- distance text remains on one line;
- three-lane and high-lane-count rows remain inside the blue surface;
- distant navigation highlights through lanes;
- near right/left navigation highlights all compatible lanes;
- inferred data displays the inference note;
- no-data state displays its message;
- two-stage-left state shows the sign at the right of the instruction text.

- [ ] **Step 2: Run final automated verification**

Run:

```powershell
cd LaneDev
npm.cmd run test:lane-preview
npm.cmd run build
cd ..\LaneNav
npm.cmd run test:lane-preview
npm.cmd run build
```

Expected: all four commands exit 0.

- [ ] **Step 3: Audit the exact final diff**

Run:

```powershell
git status --short
git diff --stat main...HEAD
git diff --check main...HEAD
```

Confirm the feature commits contain only:

```text
docs/superpowers/specs/2026-07-24-lane-guidance-preview-design.md
docs/superpowers/plans/2026-07-24-lane-guidance-preview.md
LaneDev/package.json
LaneDev/src/App.css
LaneDev/src/nav/DriveHUD.tsx
LaneDev/src/nav/LanePreviewView.tsx
LaneDev/src/nav/lanePreview.ts
LaneDev/src/nav/lanePreview.test.mjs
LaneDev/src/nav/assets/lane-guidance/*.png
LaneNav/package.json
LaneNav/src/App.css
LaneNav/src/nav/DriveHUD.tsx
LaneNav/src/nav/LanePreviewView.tsx
LaneNav/src/nav/lanePreview.ts
LaneNav/src/nav/lanePreview.test.mjs
LaneNav/src/nav/assets/lane-guidance/*.png
```

The following remain uncommitted and user-owned:

```text
LaneNav/package-lock.json
package-lock.json
製作地圖圖檔資料夾/
```
