# Cross-Side-Road Merge and Save Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow safe median-continuous merges at OSM four-way nodes by restricting each side road independently, and show truthful road-edit save progress.

**Architecture:** Extend the existing one-side entry rule with an optional split-road key and resolve one access direction per side road during merge replay. Navigation matches keyed rules against the counterpart road while legacy unkeyed rules remain valid. Road-edit persistence feedback is isolated in a small async helper so saving, success, failure, and retained generation warnings can be tested without React.

**Tech Stack:** TypeScript 6, Node test runner, React 19, MapLibre road graph, Vite.

## Global Constraints

- `public/data/road_database.json` is protected local test data and must never be staged or committed.
- A merge is rejected completely when any side road cannot be classified uniquely.
- Rejection text must include side-road name when present, exact `way/{osmId}@b/{blockNode}`, and the concrete reason.
- Existing unkeyed T-junction rules and append-only road-merge journals remain compatible.
- Main-road through movement remains legal; seam U-turns, side-to-side crossing, and crossing-median turns remain illegal.
- Journal timestamps and canonical road records are unchanged by this feature.
- Commit messages are primarily Traditional Chinese.

---

### Task 1: Key one-side access by counterpart side road

**Files:**
- Modify: `src/core/roads.ts`
- Modify: `src/core/oneSideEntry.ts`
- Test: `src/core/oneSideEntry.test.mjs`

**Interfaces:**
- Produces: `OneSideEntryAccess { nodeId: number; allowedBack: boolean; sideRoadKey?: string }`.
- Consumes: counterpart `RoadFeature` in `oneSideEntryTransitionAllowed(...)` to select a keyed rule.

- [ ] **Step 1: Write failing keyed-transition tests**

Add roads with `blockNode` and two main-road rules:

```js
const westKey = 'way/201@b/20'
const eastKey = 'way/202@b/20'
const keyedMain = road(100, [NODE], [
  { nodeId: NODE, allowedBack: false, sideRoadKey: eastKey },
  { nodeId: NODE, allowedBack: true, sideRoadKey: westKey },
])

assert.equal(allow(side(201), false, keyedMain, false), true)
assert.equal(allow(side(201), false, keyedMain, true), false)
assert.equal(allow(keyedMain, false, side(202), false), true)
assert.equal(allow(keyedMain, true, side(202), false), false)
```

Also assert that an unkeyed legacy rule still applies to any counterpart side road.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/core/oneSideEntry.test.mjs`

Expected: keyed cases fail because `accessAt` currently selects only by `nodeId`.

- [ ] **Step 3: Add the keyed access type and pair-aware lookup**

In `roads.ts` export and reuse:

```ts
export interface OneSideEntryAccess {
  nodeId: number
  allowedBack: boolean
  sideRoadKey?: string
}
```

In `oneSideEntry.ts`, derive the counterpart key and prefer a keyed rule before the legacy fallback:

```ts
const roadKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

const accessAt = (road: RoadFeature, counterpart: RoadFeature) => {
  const entries = road.properties.oneSideEntryAccess
    ?.filter((entry) => entry.nodeId === nodeId) ?? []
  return entries.find((entry) => entry.sideRoadKey === roadKey(counterpart))
    ?? entries.find((entry) => !entry.sideRoadKey)
    ?? (road.properties.oneSideEntryNodes?.includes(nodeId)
      ? { nodeId, allowedBack: false } : undefined)
}
```

Call it as `accessAt(incomingRoad, outgoingRoad)` and `accessAt(outgoingRoad, incomingRoad)`.

- [ ] **Step 4: Run the unit tests and verify GREEN**

Run: `node --test src/core/oneSideEntry.test.mjs src/core/graph.test.mjs`

Expected: all tests pass, including legacy unkeyed behavior.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/core/roads.ts src/core/oneSideEntry.ts src/core/oneSideEntry.test.mjs
git commit -m "支援逐側路導航進出限制"
```

### Task 2: Resolve every side road and report exact rejection reasons

**Files:**
- Modify: `src/core/roadMerge.ts`
- Test: `src/core/roadMerge.test.mjs`

**Interfaces:**
- Consumes: `OneSideEntryAccess` from Task 1.
- Produces: `ResolvedRoadMerge.sideAccess: { sideRoadKey: string; allowedBack: boolean }[]`.

- [ ] **Step 1: Write a failing four-way merge test**

Create north/south main blocks and east/west side roads sharing the seam node. Assert:

```js
const view = buildRoadMergeViews([primary, secondary, eastSide, westSide], [mergeRecord()])
assert.equal(view.resolved.length, 1)
assert.deepEqual(view.resolved[0].sideAccess, [
  { sideRoadKey: 'way/200@b/2', allowedBack: false },
  { sideRoadKey: 'way/201@b/2', allowedBack: true },
])
```

Add a second test with a side road passing through the seam and assert `needs_manual_review` detail contains its name, block key, and `接縫不是側路端點`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern "雙側側路|指出無法判定的側路" src/core/roadMerge.test.mjs`

Expected: the valid four-way merge is rejected with the current junction-wide ambiguity message.

- [ ] **Step 3: Replace junction-wide resolution with per-side resolution**

Use a discriminated result:

```ts
type SideAccessResolution =
  | { ok: true; access: { sideRoadKey: string; allowedBack: boolean }[] }
  | { ok: false; reason: string }
```

Resolve each side independently. Reject immediately with `側路名稱（way/...@b/...）：原因` for fewer than two coordinates, a non-endpoint seam, or `forward === backward`. Set `adjacentBack` only when all resolved side roads share one direction; otherwise leave it `null` and preserve the full `sideAccess` list.

- [ ] **Step 4: Register multiple rules without overwriting them**

Change access-map identity from `nodeId` to:

```ts
const accessKey = (entry: OneSideEntryAccess) =>
  `${entry.nodeId}:${entry.sideRoadKey ?? '*'}`
```

Use it in `registerOneSideAccess` and `applyVisualMergeInPlace`. For one direction, retain an unkeyed rule; for opposite directions, register one keyed rule per side road. Convert `allowedBack` for the secondary main block using the existing `primaryAt === secondaryAt` transformation.

- [ ] **Step 5: Preserve and restore all previous access entries**

Change `roadMergeDerived.previousAccess` to `OneSideEntryAccess[] | undefined`. Snapshot every entry at the seam before registering derived rules; cleanup removes derived entries at that node and restores the complete snapshot.

- [ ] **Step 6: Run merge tests and verify GREEN**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: four-way merge, detailed rejection, T-junction, replay, and undo tests all pass.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- src/core/roadMerge.ts src/core/roadMerge.test.mjs src/core/roads.ts
git commit -m "允許連續中央帶十字節點逐側路捏合"
```

### Task 3: Verify full routing behavior at the keyed four-way seam

**Files:**
- Modify: `src/core/graphRoadMergeBarrier.test.mjs`
- Test: `src/core/graphRoadMergeBarrier.test.mjs`

**Interfaces:**
- Consumes: keyed access entries produced by Tasks 1 and 2.
- Produces: integration evidence through `RoadGraph.route(...)`.

- [ ] **Step 1: Write failing route-matrix assertions**

Construct two one-way main directions, two opposite side roads, barrier nodes on both main blocks, and keyed access entries. Assert:

```js
assert.ok(graph.route(eastPoint, northPoint, 'car'))
assert.equal(graph.route(eastPoint, southPoint, 'car'), null)
assert.ok(graph.route(westPoint, southPoint, 'car'))
assert.equal(graph.route(westPoint, northPoint, 'car'), null)
assert.equal(graph.route(eastPoint, westPoint, 'car'), null)
assert.ok(graph.route(southMainPoint, northMainPoint, 'car'))
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `node --test --test-name-pattern "逐側路" src/core/graphRoadMergeBarrier.test.mjs`

Expected: at least one keyed direction is incorrectly allowed or blocked before Task 1 behavior is fully integrated.

- [ ] **Step 3: Make only the minimal transition correction if RED reveals a graph-level gap**

Keep median-barrier classification in `transitionAllowed`. Do not duplicate geometry inference in `RoadGraph`; pass incoming/outgoing roads to `oneSideEntryTransitionAllowed` and rely on the keyed rules.

- [ ] **Step 4: Run graph suites and verify GREEN**

Run: `node --test src/core/oneSideEntry.test.mjs src/core/graphRoadMergeBarrier.test.mjs src/core/graphRouteState.test.mjs`

Expected: all transition-state and routing tests pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- src/core/graphRoadMergeBarrier.test.mjs src/core/graph.ts src/core/oneSideEntry.ts
git commit -m "驗證十字型連續中央帶導航限制"
```

### Task 4: Report truthful road-edit persistence progress

**Files:**
- Create: `src/edit/roadSaveFeedback.ts`
- Create: `src/edit/roadSaveFeedback.test.mjs`
- Modify: `src/edit/useEditor.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `reportRoadEditSave(flush, report, warnings): Promise<void>`.
- Consumes: `flushStaticEditorSave` and the editor's existing `warn(message)` callback.

- [ ] **Step 1: Write failing async-stage tests**

Use a deferred promise and assert the first report happens synchronously:

```js
const messages = []
const pending = deferred()
const result = reportRoadEditSave(() => pending.promise, (m) => messages.push(m), [])
assert.deepEqual(messages, ['道路設定已套用，正在儲存…'])
pending.resolve()
await result
assert.equal(messages.at(-1), '道路設定已儲存並套用')
```

Add failure and retained-warning cases. Failure must contain `設定仍保留在此瀏覽器，但尚未寫入資料庫` and the thrown message. Success with warnings must retain warning text.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/edit/roadSaveFeedback.test.mjs`

Expected: module-not-found failure before implementation.

- [ ] **Step 3: Implement the focused async helper**

```ts
export async function reportRoadEditSave(
  flush: () => Promise<void>,
  report: (message: string) => void,
  warnings: string[],
) {
  const warning = warnings.join('；')
  report(warning ? `${warning}；其餘道路設定正在儲存…` : '道路設定已套用，正在儲存…')
  try {
    await flush()
    report(warning ? `道路設定已儲存；${warning}` : '道路設定已儲存並套用')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    report(`設定仍保留在此瀏覽器，但尚未寫入資料庫：${detail}`
      + (warning ? `；${warning}` : ''))
  }
}
```

- [ ] **Step 4: Integrate after redraw and aggregate existing generation warnings**

In `saveRoadEdit`, collect failed turn-bay and motorcycle-box messages into `saveWarnings`, close the panel as today, then call:

```ts
void reportRoadEditSave(flushStaticEditorSave, warn, saveWarnings)
```

Remove the two immediate `warn(...)` calls so persistence status cannot overwrite them.

- [ ] **Step 5: Add the test script and verify GREEN**

Add `test:road-save-feedback` to `package.json` and to `test:all`.

Run: `npm.cmd run test:road-save-feedback`

Expected: saving, success, failure, and warning-retention tests all pass.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- package.json src/edit/useEditor.ts src/edit/roadSaveFeedback.ts src/edit/roadSaveFeedback.test.mjs
git commit -m "加入道路編輯儲存進度提示"
```

### Task 5: Full verification and acceptance handoff

**Files:**
- Verify only: `public/data/road_database.json`

**Interfaces:**
- Consumes all previous tasks.
- Produces a browser-ready acceptance build without canonical-data changes.

- [ ] **Step 1: Run all automated tests**

Run: `npm.cmd run test:all`

Expected: exit code 0 with no failed tests.

- [ ] **Step 2: Run production build**

Run: `npm.cmd run build`

Expected: TypeScript and Vite exit code 0; existing chunk-size warnings are acceptable.

- [ ] **Step 3: Check diff and protected data**

Run:

```powershell
git diff --check
git status --short
git diff --cached --name-only
```

Expected: `public/data/road_database.json` remains only an unstaged local modification and is absent from every commit.

- [ ] **Step 4: Verify the acceptance server**

Confirm `http://127.0.0.1:4175/` serves the updated `roadMerge.ts` and `roadSaveFeedback.ts`, then ask the user to validate the original four-way junction and road-save feedback.
