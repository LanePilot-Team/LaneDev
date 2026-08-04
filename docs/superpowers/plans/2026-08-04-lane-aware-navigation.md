# Lane-Aware Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 LaneDev 的初次規劃與重新規劃遵守車道方向，並讓導航線、HUD 主要／次要車道與換道提示共用同一份可測試的車道計畫。

**Architecture:** 新增純函式 `laneDecision.ts`，集中處理車道方向相容性、主要車道、推測狀態與換道成本；`RoadGraph` 在 A* transition 階段套用硬性合法性與軟性換道成本，並把決策保存到 `Maneuver`。`laneBand()` 與 HUD 只消費保存後的決策，兩段式左轉則透過 route policy 在搜尋前提供，避免事後才改變動作語意。

**Tech Stack:** TypeScript 6、React 19、MapLibre GL、Node.js built-in test runner、Vite 8、既有 Turf／Three.js runtime。

## Global Constraints

- 只有所有可靠車道都明確不相容時才禁止 transition；未知資料維持可通行並顯示 `車道建議（系統推測）`。
- 主要車道依序採用：純轉向道、複合轉向道、最少換道、右轉最外側／左轉最內側、下一 maneuver 前瞻。
- HUD 主要車道、導航線目標車道與準備距離必須來自同一份 lane decision。
- 準備距離基準為 250 公尺，可因道路速度、跨越車道數、槽化道與相近 maneuver 提前。
- 機車兩段式左轉使用最外側可直行車道，純右轉道不可用；機車一般轉彎後靠最外側合法車道。
- GPS 不判斷實際車道；只在道路層級偏離確認後重新規劃。
- 換道距離較短時增加成本並顯示黃色小字，不要求駕駛急切換道。
- 不修改 `public/data/road_database.json` 或其他正式道路標註資料。
- 不新增 npm dependency。
- 每個功能 task 先寫失敗測試、確認紅燈、最小實作、確認綠燈，再以中文 commit message 提交。

## File Structure

- Create `src/core/laneDecision.ts`: 純函式車道 action 正規化、相容性、主要／次要選擇、準備距離與換道成本。
- Create `src/core/laneDecision.test.mjs`: 車道合法性、推測、迴轉、兩段式與 tie-breaker 單元測試。
- Modify `src/core/graph.ts`: route policy、A* 車道狀態、transition 過濾／成本、maneuver lane decision 與 lane-band 消費。
- Create `src/core/graphLaneDecision.test.mjs`: 替代路線、無合法路線、兩段式 policy、成本與重新規劃等 graph 測試。
- Create `src/core/laneBandLaneDecision.test.mjs`: 導航線目標 offset、同步準備距離、相近 maneuver 與轉彎後落點測試。
- Modify `src/plan/usePlanner.ts`: 在規劃前提供兩段式 policy、使用詳細失敗原因、移除事後才決定兩段式語意的落差。
- Create `src/plan/routeFailure.ts`: 將 graph failure 轉為穩定的繁體中文錯誤文案。
- Create `src/plan/routeFailure.test.mjs`: 車道限制與一般不可達文案測試。
- Modify `src/nav/lanePreview.ts`: 直接消費 lane decision，輸出 primary／secondary／inactive 與警告文字。
- Modify `src/nav/lanePreview.test.mjs`: HUD 三態、推測、準備距離與短距離警告 model 測試。
- Modify `src/nav/LanePreviewView.tsx`: 呈現主要、次要、不相容車道及兩種小字。
- Modify `src/nav/DriveHUD.tsx`: 傳入保存後的 lane decision，不再以固定 250 公尺重新猜測。
- Modify `src/App.css`: 主要／次要車道與黃色警告的可讀樣式。
- Modify `src/nav/useDrive.ts`: 初次、replay、detour 與 GPS reroute 都保留同一 route policy 與 lane decision。
- Modify `package.json`: 將新增測試納入聚焦 script 與 `test:all`。

---

### Task 1: 純函式車道決策解析器

**Files:**
- Create: `src/core/laneDecision.ts`
- Create: `src/core/laneDecision.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `LaneGuidanceSource` from `src/core/laneGuidance.ts`。
- Produces: `LaneAction`、`LaneDecisionInput`、`LaneDecision`、`resolveLaneDecision()`、`preparationDistanceM()`。

- [ ] **Step 1: 寫入失敗測試，固定合法性與選擇規則**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLaneDecision } from './laneDecision.ts'

const decide = (overrides = {}) => resolveLaneDecision({
  action: 'right',
  profile: 'car',
  laneCount: 3,
  laneMovements: ['through', 'through;right', 'right'],
  guidanceSource: 'annotation',
  currentLaneIndex: 0,
  availableM: 300,
  speedKmh: 50,
  twoStage: false,
  ...overrides,
})

test('dedicated right lane wins and combined lane remains secondary', () => {
  const result = decide()
  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 2)
  assert.deepEqual(result.secondaryLaneIndices, [1])
  assert.deepEqual(result.incompatibleLaneIndices, [0])
  assert.equal(result.inferred, false)
})

test('reliable through-only approach rejects right turn', () => {
  const result = decide({ laneCount: 2, laneMovements: ['through', 'through'] })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'explicitly-incompatible')
})

test('partial unknown selects outer unknown lane and discloses inference', () => {
  const result = decide({ laneMovements: ['through', '', ''] })
  assert.equal(result.allowed, true)
  assert.equal(result.primaryLaneIndex, 2)
  assert.equal(result.inferred, true)
  assert.deepEqual(result.incompatibleLaneIndices, [0])
})

test('two-stage motorcycle uses outermost through lane, not right-only lane', () => {
  const result = decide({
    profile: 'moto', action: 'left', twoStage: true,
    laneMovements: ['through', 'through;right', 'right'],
  })
  assert.equal(result.primaryLaneIndex, 1)
  assert.deepEqual(result.incompatibleLaneIndices, [2])
})
```

- [ ] **Step 2: 執行測試並確認因模組不存在而失敗**

Run: `node --test src/core/laneDecision.test.mjs`

Expected: FAIL，錯誤包含 `Cannot find module './laneDecision.ts'`。

- [ ] **Step 3: 建立明確型別與最小解析器**

```ts
import type { LaneGuidanceSource } from './laneGuidance.ts'

export type LaneAction = 'left' | 'through' | 'right' | 'uturn'
export type LaneDecisionReason = 'compatible' | 'inferred' | 'explicitly-incompatible'

export interface LaneDecisionInput {
  action: LaneAction
  profile: 'car' | 'moto'
  laneCount: number
  laneMovements?: string[]
  guidanceSource: LaneGuidanceSource
  currentLaneIndex?: number
  availableM: number
  speedKmh: number
  twoStage: boolean
}

export interface LaneDecision {
  allowed: boolean
  reason: LaneDecisionReason
  primaryLaneIndex?: number
  secondaryLaneIndices: number[]
  incompatibleLaneIndices: number[]
  inferred: boolean
  preparationM: number
  laneChanges: number
  difficultyS: number
  shortPreparation: boolean
}

export function preparationDistanceM(speedKmh: number, laneChanges: number): number {
  const speedMs = Math.max(0, speedKmh) / 3.6
  return Math.max(250, speedMs * (4 + Math.max(1, laneChanges) * 3.5))
}
```

Implement `resolveLaneDecision()` with these deterministic rules: normalize `slight_*`/`sharp_*`/`merge_to_*`; treat index `0` as innermost and `laneCount - 1` as outermost; rank dedicated before combined; minimize distance from `currentLaneIndex`; use side tie-breakers; use `reverse/uturn` before inferred left for U-turn; switch two-stage motorcycle action to `through`; compute `shortPreparation` from `availableM < preparationM` and `difficultyS` as a positive additive cost only.

- [ ] **Step 4: 加入剩餘單元案例並跑綠燈**

Add cases for multiple dedicated lanes, U-turn explicit/fallback/rejection, no movement data, one lane, motorcycle no-through two-stage rejection, and preparation-distance extension.

Run: `node --test src/core/laneDecision.test.mjs`

Expected: PASS，所有 lane decision cases 為 `fail 0`。

- [ ] **Step 5: 把測試納入 package script 並提交**

Update `test:lane-guidance` to include `src/core/laneDecision.test.mjs`.

```powershell
git add -- src/core/laneDecision.ts src/core/laneDecision.test.mjs package.json
git commit -m "新增車道方向決策解析器"
```

---

### Task 2: 在 RoadGraph 套用硬性車道合法性與兩段式 policy

**Files:**
- Modify: `src/core/graph.ts`
- Create: `src/core/graphLaneDecision.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `resolveLaneDecision()` and `LaneDecision` from Task 1。
- Produces: `LaneRoutePolicy`、`RouteFailureReason`、`RouteSearchResult`、`RoadGraph.routeDetailed()`；既有 `route()` 保持相容。

- [ ] **Step 1: 寫入 graph 紅燈測試**

Create synthetic three-road intersections with explicit `turnLanes` and assert:

```js
test('graph rejects right turn when every incoming lane is through-only', () => {
  const graph = new RoadGraph(throughOnlyIntersection())
  const result = graph.routeDetailed(P.south, P.east, 'car')
  assert.equal(result.route, null)
  assert.equal(result.failure, 'lane-direction')
})

test('graph chooses legal detour around an incompatible shortest turn', () => {
  const graph = new RoadGraph(intersectionWithLegalDetour())
  const result = graph.routeDetailed(P.start, P.goal, 'car')
  assert.ok(result.route)
  assert.deepEqual(
    result.route.spans.map((span) => span.road?.properties.osm_id),
    [10, 30, 40],
  )
})

test('two-stage policy evaluates motorcycle left as through', () => {
  const graph = new RoadGraph(twoStageIntersection())
  const result = graph.routeDetailed(P.south, P.west, 'moto', {
    isTwoStage: ({ nodeId }) => nodeId === 2,
  })
  assert.ok(result.route)
  assert.equal(result.route.maneuvers[0].laneDecision.primaryLaneIndex, 1)
})
```

- [ ] **Step 2: 執行測試並確認缺少 `routeDetailed()`**

Run: `node --test src/core/graphLaneDecision.test.mjs`

Expected: FAIL，錯誤包含 `graph.routeDetailed is not a function`。

- [ ] **Step 3: 新增 route policy 與詳細結果介面**

```ts
export interface LaneRoutePolicy {
  isTwoStage?: (input: {
    nodeId?: number
    fromBearing: number
    kind: Maneuver['kind']
    motoLeftTurnLane: boolean
  }) => boolean
}

export type RouteFailureReason = 'no-projection' | 'unreachable' | 'lane-direction'

export interface RouteSearchResult {
  route: RouteResult | null
  failure?: RouteFailureReason
}
```

Keep `route(from, to, profile)` as a wrapper returning `routeDetailed(...).route`. Implement `routeDetailed()` so a failed lane-aware search runs one diagnostic search with lane enforcement disabled; return `lane-direction` only when the diagnostic search finds a road-level route.

- [ ] **Step 4: 在 transition 階段解析 effective action 並硬性過濾**

Add a helper that computes node id, bearings, classified action, approach guidance, and `twoStage` from `LaneRoutePolicy`. Call `resolveLaneDecision()` after existing barrier and one-side-entry checks. Reject only when `decision.allowed === false`; store the decision with the accepted transition for later assembly.

Do not weaken `roadMergeBarrierNodes`, `oneSideEntryTransitionAllowed()`, `edgeAllowed()`, or endpoint-direction behavior.

- [ ] **Step 5: 跑聚焦與既有 graph 測試**

Run: `node --test src/core/graphLaneDecision.test.mjs src/core/graph.test.mjs src/core/graphRouteState.test.mjs src/core/graphRoadMergeBarrier.test.mjs`

Expected: PASS，`fail 0`。

- [ ] **Step 6: 納入 package script 並提交**

Add `src/core/graphLaneDecision.test.mjs` to `test:road-merge` before the chained rendering tests.

```powershell
git add -- src/core/graph.ts src/core/graphLaneDecision.test.mjs package.json
git commit -m "讓道路搜尋遵守車道方向限制"
```

---

### Task 3: 將換道狀態、成本與決策保存到 RouteResult

**Files:**
- Modify: `src/core/graph.ts`
- Modify: `src/core/graphLaneDecision.test.mjs`

**Interfaces:**
- Consumes: `LaneDecision` and accepted transition metadata from Tasks 1–2。
- Produces: `Maneuver.laneDecision`、lane-aware A* state、stable lookahead decisions in assembled routes。

- [ ] **Step 1: 寫入換道成本與多 lane-state 紅燈測試**

```js
test('route cost prefers an easier legal approach over a short two-lane weave', () => {
  const graph = new RoadGraph(equalTimeAlternatives())
  const route = graph.route(P.start, P.goal, 'car')
  assert.ok(route)
  assert.deepEqual(route.spans.map((span) => span.road?.properties.osm_id), [10, 20, 40])
  assert.equal(route.maneuvers[0].laneDecision.shortPreparation, false)
})

test('accepted maneuver stores one primary lane and compatible secondary lanes', () => {
  const graph = new RoadGraph(multiRightLaneIntersection())
  const route = graph.route(P.south, P.east, 'car')
  assert.ok(route)
  assert.equal(route.maneuvers[0].laneDecision.primaryLaneIndex, 2)
  assert.deepEqual(route.maneuvers[0].laneDecision.secondaryLaneIndices, [1])
})
```

- [ ] **Step 2: 確認測試因 lane state／保存資訊缺失而失敗**

Run: `node --test src/core/graphLaneDecision.test.mjs`

Expected: FAIL，至少一個 assertion 顯示 route choice 或 `laneDecision` 不符。

- [ ] **Step 3: 將 entry lane 加入 A* state identity**

Extend search state to:

```ts
interface RouteState {
  node: number
  incoming: Edge
  entryLaneIndex?: number
}

const stateKey = (node: number, incoming: Edge, entryLaneIndex?: number) =>
  `${node}|${edgeIdentity(incoming)}|lane:${entryLaneIndex ?? 'unknown'}`
```

Add `decision.difficultyS` to `tentative`; propagate post-turn entry lane as outermost for right turns, innermost for car left turns, and outermost for motorcycle turns. Preserve multiple states when the same incoming edge is reached with different entry lanes.

- [ ] **Step 4: 保存每個 transition decision 並在 assemble 建立 maneuver metadata**

Extend `cameFrom` and the best-goal record to retain the transition decision. Add to `Maneuver`:

```ts
laneDecision?: LaneDecision
```

During `assemble()`, match accepted decisions by node and incoming/outgoing edge identity. For close maneuvers, perform a backward lookahead pass that updates the earlier decision's planned exit lane without changing its hard legality.

- [ ] **Step 5: 驗證聚焦測試與現有 lane guidance**

Run: `node --test src/core/graphLaneDecision.test.mjs src/core/laneGuidance.test.mjs src/core/graphRouteState.test.mjs`

Expected: PASS，`fail 0`。

- [ ] **Step 6: 提交**

```powershell
git add -- src/core/graph.ts src/core/graphLaneDecision.test.mjs
git commit -m "加入車道換道成本與路線決策狀態"
```

---

### Task 4: 讓導航線消費 lane decision 與共用準備距離

**Files:**
- Modify: `src/core/graph.ts`
- Create: `src/core/laneBandLaneDecision.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Maneuver.laneDecision` from Task 3 and existing bay/right-lane annotations。
- Produces: lane-band geometry whose target lane and preparation window exactly match the saved decision。

- [ ] **Step 1: 寫入 lane-band 紅燈測試**

```js
test('route band targets the saved primary right-turn lane', () => {
  const route = routeFixture({ primaryLaneIndex: 1, preparationM: 250 })
  const band = laneBand(route)
  assert.ok(offsetAtRouteDistance(route, band, 20) < offsetAtRouteDistance(route, band, 220))
  assert.equal(roundOffset(offsetAtRouteDistance(route, band, 295)), 5.25)
})

test('line begins changing at the same saved preparation distance used by HUD', () => {
  const route = routeFixture({ primaryLaneIndex: 2, preparationM: 320 })
  const band = laneBand(route)
  assert.equal(roundOffset(offsetAtRouteDistance(route, band, -25)), 1.75)
  assert.ok(offsetAtRouteDistance(route, band, 5) > 1.75)
})

test('close right then left maneuvers do not settle outward and reverse abruptly', () => {
  const offsets = sampledCloseManeuverOffsets()
  assert.ok(maxSecondDifference(offsets) <= 0.45)
})
```

- [ ] **Step 2: 確認現有 `turnTarget()`／`leadWindow()` 未使用保存決策而失敗**

Run: `node --test src/core/laneBandLaneDecision.test.mjs`

Expected: FAIL，primary lane 或 preparation boundary assertion 不符。

- [ ] **Step 3: 新增 lane index 到 offset 的唯一轉換函式**

```ts
function laneIndexOffset(
  span: RouteResult['spans'][number],
  laneIndex: number,
): number {
  const count = Math.max(1, span.laneGuidance?.laneCount ?? 1)
  const clamped = Math.max(0, Math.min(count - 1, laneIndex))
  if (count === 1) return span.leftM
  return span.leftM + (span.rightM - span.leftM) * clamped / (count - 1)
}
```

Update `turnTarget()` to prefer physical `bayOffM`／`rightOffM` when present, otherwise use `laneDecision.primaryLaneIndex`; use current legacy side fallback only when no saved decision exists.

- [ ] **Step 4: 共用 preparationM 並保留實體入口限制**

Use `laneDecision.preparationM` as the non-bay ramp start. Continue clamping it by `bayMouthM`, `bayTaperM`, `lastWeaveBefore()`, slew limits, and previous maneuver exit geometry. Use lookahead output to join overlapping windows into one continuous target sequence.

- [ ] **Step 5: 驗證線形、既有 band audit 與 build**

Run: `node --test src/core/laneBandLaneDecision.test.mjs`

Run: `node scripts/run_offline.mjs scripts/band_audit.ts`

Run: `npm.cmd run build`

Expected: tests PASS、band audit 不新增失敗、build exit 0。

- [ ] **Step 6: 納入 test script 並提交**

Add `src/core/laneBandLaneDecision.test.mjs` to `test:lane-guidance`.

```powershell
git add -- src/core/graph.ts src/core/laneBandLaneDecision.test.mjs package.json
git commit -m "同步導航線與車道準備距離"
```

---

### Task 5: HUD 主要／次要車道、推測與短距離提示

**Files:**
- Modify: `src/nav/lanePreview.ts`
- Modify: `src/nav/lanePreview.test.mjs`
- Modify: `src/nav/LanePreviewView.tsx`
- Modify: `src/nav/DriveHUD.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `Maneuver.laneDecision` and its `preparationM`、`inferred`、`shortPreparation` fields。
- Produces: `LanePreviewLane.state` and stable advisory copy for the React view。

- [ ] **Step 1: 將現有 model 測試改成三態並先看紅燈**

```js
test('marks one primary lane, another compatible lane secondary, and others inactive', () => {
  const model = ready({
    laneDecision: {
      primaryLaneIndex: 2,
      secondaryLaneIndices: [1],
      incompatibleLaneIndices: [0],
      preparationM: 280,
      inferred: false,
      shortPreparation: false,
    },
    distanceM: 200,
  })
  assert.deepEqual(model.lanes.map((lane) => lane.state), ['inactive', 'secondary', 'primary'])
})

test('uses saved preparation distance instead of a hard-coded 250 metres', () => {
  const model = ready({ distanceM: 275, laneDecision: decision({ preparationM: 280 }) })
  assert.equal(model.immediateAction, 'right')
})

test('shows inference and short-preparation notices independently', () => {
  const model = ready({ laneDecision: decision({ inferred: true, shortPreparation: true }) })
  assert.equal(model.inferenceNote, '車道建議（系統推測）')
  assert.equal(model.warningNote, '前方換道距離較短，請注意安全；若無法換道請繼續行駛，系統將重新規劃。')
})
```

- [ ] **Step 2: 執行測試並確認既有 boolean `active` model 失敗**

Run: `node --test src/nav/lanePreview.test.mjs`

Expected: FAIL，缺少 `state`、`laneDecision` 或 warning fields。

- [ ] **Step 3: 更新 lane preview model**

```ts
export type LanePreviewState = 'primary' | 'secondary' | 'inactive'

export interface LanePreviewLane {
  arrow: LaneArrowKind
  state: LanePreviewState
}

export interface LanePreviewModel {
  status: 'ready' | 'no-data'
  lanes: LanePreviewLane[]
  immediateAction: LanePreviewAction
  inferred: boolean
  truncated: boolean
  showTwoStageSign: boolean
  inferenceNote?: string
  warningNote?: string
}
```

Use saved lane decision when present. Keep the current inferred-lane fallback only for legacy routes without a decision so existing loading/replay behavior does not crash.

- [ ] **Step 4: 更新 React view 與 CSS**

Render primary with the existing bright active artwork plus a strong outline; render secondary with compatible artwork at reduced opacity and a thinner outline; render inactive with existing inactive artwork. Add `.lane-preview-warning` as small amber text with sufficient contrast. `alt` and `aria-label` must identify primary and secondary lanes.

- [ ] **Step 5: 更新 DriveHUD 使用保存後準備距離**

Pass `m.laneDecision` into `buildLanePreview()`. Remove the fixed 250-metre selection as the source of maneuver timing when a decision exists. Show a lane-change sentence derived from current planned lane and primary lane without claiming that GPS confirmed completion.

- [ ] **Step 6: 跑 HUD 聚焦測試與 build**

Run: `npm.cmd run test:lane-preview`

Run: `npm.cmd run build`

Expected: 既有與新增 lane preview tests 全部 PASS，build exit 0。

- [ ] **Step 7: 提交**

```powershell
git add -- src/nav/lanePreview.ts src/nav/lanePreview.test.mjs src/nav/LanePreviewView.tsx src/nav/DriveHUD.tsx src/App.css
git commit -m "同步 HUD 主要車道與導航線提示"
```

---

### Task 6: 規劃錯誤、兩段式 policy 與所有 reroute 入口

**Files:**
- Create: `src/plan/routeFailure.ts`
- Create: `src/plan/routeFailure.test.mjs`
- Modify: `src/plan/usePlanner.ts`
- Modify: `src/nav/useDrive.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RoadGraph.routeDetailed()`、`LaneRoutePolicy` and `RouteFailureReason` from Task 2。
- Produces: one shared policy factory and stable error copy used by planning and rerouting。

- [ ] **Step 1: 寫入錯誤文案與 policy 紅燈測試**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { routeFailureText } from './routeFailure.ts'

test('lane-direction failure has a specific Traditional Chinese message', () => {
  assert.equal(routeFailureText('lane-direction', 2), '第 2 段找不到符合車道方向限制的路線')
})

test('ordinary unreachable route keeps actionable generic copy', () => {
  assert.equal(routeFailureText('unreachable', 1), '第 1 段規劃失敗，請調整位置')
})
```

- [ ] **Step 2: 執行測試並確認模組不存在**

Run: `node --test src/plan/routeFailure.test.mjs`

Expected: FAIL，錯誤包含 `Cannot find module './routeFailure.ts'`。

- [ ] **Step 3: 建立純函式文案並更新 usePlanner**

```ts
import type { RouteFailureReason } from '../core/graph.ts'

export function routeFailureText(reason: RouteFailureReason | undefined, legNumber: number): string {
  if (reason === 'lane-direction') return `第 ${legNumber} 段找不到符合車道方向限制的路線`
  return `第 ${legNumber} 段規劃失敗，請調整位置`
}
```

Refactor the current zone-based two-stage check into a policy callback accepted by `routeDetailed()`. Use that same policy for every leg before assembling and annotating bays/right lanes. Keep post-route annotation only to expose the already-decided flag to existing consumers.

- [ ] **Step 4: 更新所有 useDrive reroute 入口**

Pass one `routePolicyRef` or policy factory through `UseDriveParams`. `rerouteFrom()`, detour, replay, and GPS reroute must not call a policy-free route method. Do not use GPS lateral distance to decide lane compliance; retain existing 60-metre, three-fix, and cooldown road-deviation behavior.

- [ ] **Step 5: 跑 planner helper、GPS 與 graph tests**

Run: `node --test src/plan/routeFailure.test.mjs src/core/graphLaneDecision.test.mjs`

Run: `npm.cmd run test:lane-guidance`

Expected: PASS，`fail 0`。

- [ ] **Step 6: 納入 test:all 並提交**

Add `src/plan/routeFailure.test.mjs` to a focused package script included by `test:all`.

```powershell
git add -- src/plan/routeFailure.ts src/plan/routeFailure.test.mjs src/plan/usePlanner.ts src/nav/useDrive.ts package.json
git commit -m "統一路線重算的車道限制與錯誤提示"
```

---

### Task 7: 完整迴歸、瀏覽器 QA 與最終範圍核對

**Files:**
- Modify only if verification finds an in-scope defect: files already listed in Tasks 1–6。

**Interfaces:**
- Consumes: completed feature from Tasks 1–6。
- Produces: verified branch with no canonical road-data changes and a reproducible test record。

- [ ] **Step 1: 執行全部自動測試**

Run: `npm.cmd run test:all`

Expected: exit 0；所有 suites `fail 0`。

- [ ] **Step 2: 執行 production build 與 diff hygiene**

Run: `npm.cmd run build`

Run: `git diff --check`

Expected: build exit 0；`git diff --check` 無輸出。

- [ ] **Step 3: 核對保護資料與精確變更範圍**

Run: `git status --short --branch`

Run: `git diff --name-status origin/main...HEAD`

Run: `git diff --name-only origin/main...HEAD -- public/data/road_database.json`

Expected: `public/data/road_database.json` 無輸出；變更只包含規格、計畫、lane decision、graph、lane band、planner、drive、HUD、CSS、測試與 package script。

- [ ] **Step 4: 在真實瀏覽器做情境 QA**

Start the app with `npm.cmd run dev -- --host 127.0.0.1` and verify:

1. through-only approach never produces a right-turn route;
2. dedicated right lane is primary and combined right lane is secondary;
3. inferred guidance shows `車道建議（系統推測）`;
4. HUD primary change and route-line lateral transition begin at the same point;
5. two-stage motorcycle guidance uses the outermost through-compatible lane and never a right-only lane;
6. short preparation shows the amber notice;
7. close right/left maneuvers draw one continuous line;
8. GPS marker remains at actual coordinates while route line remains lane-specific.

Expected: all eight scenarios match the approved spec at desktop and narrow-mobile widths。

- [ ] **Step 5: 若 QA 發現缺陷，先增加能重現的失敗測試再修正**

Run the new focused test once to confirm FAIL, implement the minimum correction, then rerun the focused test and `npm.cmd run test:all` to confirm PASS.

- [ ] **Step 6: 提交最終 QA 修正（只有確實產生修正時）**

```powershell
git add -- src/core/laneDecision.ts src/core/laneDecision.test.mjs src/core/graph.ts src/core/graphLaneDecision.test.mjs src/core/laneBandLaneDecision.test.mjs src/plan/routeFailure.ts src/plan/routeFailure.test.mjs src/plan/usePlanner.ts src/nav/lanePreview.ts src/nav/lanePreview.test.mjs src/nav/LanePreviewView.tsx src/nav/DriveHUD.tsx src/nav/useDrive.ts src/App.css package.json
git commit -m "修正車道導航整合驗證問題"
```

Do not create this commit when QA requires no code change.
