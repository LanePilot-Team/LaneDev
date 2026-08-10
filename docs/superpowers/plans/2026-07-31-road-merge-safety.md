# 道路捏合安全性與舊資料復原實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓道路捏合同時正確改變繪圖與導航，保留來源路口及側路連接，並讓既有捏合紀錄可由日誌與 `sourceSegments` 安全回溯。

**Architecture:** 將「導航用來源道路」與「繪圖用捏合視圖」分開：導航永遠使用未被破壞的來源拓撲，繪圖才使用接合後的複本。新版解析器依日誌順序解析精確 key 與 `sourceSegments`，產生轉向限制、繪圖視圖及逐筆復原報告；舊紀錄先相容讀取，不自動覆寫歷史。

**Tech Stack:** TypeScript 6、React 19、MapLibre GL、Node.js test runner、Vite 8、既有 JSON journal 與離線 audit scripts。

## Global Constraints

- 組員選擇「捏合」本身就是語意宣告，不新增第二種模式，也不再次詢問中央島是否有開口。
- 主路樣式及中央島跨接縫連續；不得因捏合新增主路停止線、箭頭、槽化帶或路口缺口。
- 側路仍連接物理上相鄰的主路方向；禁止跨中央島左轉、直穿與迴轉。
- 被前處理吸收或 drop 的第二段必須能由 `sourceSegments` 回溯，原本指向它的側路不得成為孤兒。
- 未通過來源唯一性、連通性、轉向及繪圖稽核前，不批次改寫 `public/data/road_database.json` 的舊日誌。
- 舊紀錄原文永遠保留；正式遷移只能追加 tombstone 與 V2 取代紀錄。
- 每項功能先寫失敗測試，再做最小實作；每個任務完成後使用中文 commit。
- 程式實作只在新分支 `codex/road-merge-safety-implementation` 進行，不直接修改或推送 `main`。
- 不修改與道路捏合無關的既有使用者變更。

## File map

- Create `src/core/roadMerge.ts`: V1/V2 日誌正規化、來源解析、逐筆重播、導航限制與繪圖視圖。
- Create `src/core/roadMerge.test.mjs`: 精確解析、`sourceSegments` 回溯、連鎖捏合、側路保留及原子性測試。
- Modify `src/core/enhancements.ts`: 保留既有匯出介面，將捏合工作委派給 `roadMerge.ts`。
- Modify `src/core/roads.ts`: 加入只影響繪圖的隱藏欄位，禁止用 `deleted` 隱藏捏合碎段。
- Modify `src/core/graph.ts`: A* 狀態改為節點加進入邊，並沿完整狀態重建路徑。
- Create `src/core/graphRouteState.test.mjs`: 同節點不同進入邊及短路徑不被排除的回歸測試。
- Modify `src/app/mapCore.ts`: 分別保存導航來源道路與繪圖捏合視圖。
- Modify `src/core/medians.ts`: 捏合接縫的中央島與中央線不收邊。
- Modify `src/core/turnbays.ts`: 捏合接縫不生成主路停止線、箭頭、槽化帶或路口端帽。
- Create `src/core/roadMergeRendering.test.mjs`: 主路樣式連續與側路端點樣式回歸測試。
- Modify `src/edit/useEditor.ts`: 寫入前預覽驗證、V2 欄位、失敗不落日誌及撤銷入口。
- Modify `src/edit/EditPanels.tsx`: 顯示來源追蹤、捏合狀態與撤銷按鈕。
- Create `scripts/road_merge_recovery.ts`: 對完整舊日誌產生逐筆復原報告；預設唯讀。
- Create `scripts/road_merge_recovery.test.mjs`: 報告分類與 append-only 遷移資料測試。
- Modify `scripts/orphan_audit.ts`: 改用逐筆重播結果，不再從最終快照誤判連鎖捏合。
- Modify `scripts/severed_route_audit.ts`: 直接稽核所有解析成功的捏合接縫，而不是只找舊負節點。
- Modify `scripts/merged_junction_render_audit.ts`: 使用捏合解析結果定位全部接縫。
- Modify `package.json`: 納入新增測試及復原稽核命令。

---

### Task 1: 建立可回溯的捏合解析器

**Files:**
- Create: `src/core/roadMerge.ts`
- Create: `src/core/roadMerge.test.mjs`
- Modify: `src/core/enhancements.ts`

**Interfaces:**
- Consumes: `RoadFeature[]`、`EnhancementRecord[]`、既有 `foldJournal()` 結果。
- Produces:

```ts
export interface ResolvedRoadMerge {
  mergeKey: string
  primary: RoadFeature
  secondary: RoadFeature
  primaryKey: string
  secondaryKey: string
  junctionNodeId: number
  primaryAt: 'start' | 'end'
  secondaryAt: 'start' | 'end'
  adjacentBack: boolean | null
  resolvedBy: 'exact' | 'active-node' | 'source-segment' | 'already-absorbed'
  sourceSeq?: number
  sourceTs?: string
  sourceAuthor?: string
}

export interface RoadMergeReplayRow {
  mergeKey: string
  primaryKey: string
  secondaryKey: string
  status: 'replayable' | 'recoverable_via_provenance'
    | 'needs_manual_review' | 'legacy_destructive' | 'invalid'
  detail: string
  resolved?: ResolvedRoadMerge
}

export function resolveRoadMerges(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): { resolved: ResolvedRoadMerge[]; rows: RoadMergeReplayRow[] }
```

- [ ] **Step 1: 寫下精確 key、來源追溯及連鎖捏合的失敗測試**

```js
test('精確 block key 可解析', () => {
  const { resolved, rows } = resolveRoadMerges([primary(), secondary()], [mergeRecord()])
  assert.equal(resolved.length, 1)
  assert.equal(rows[0].status, 'replayable')
  assert.equal(resolved[0].resolvedBy, 'exact')
})

test('次段被 couplet drop 後由 sourceSegments 找回', () => {
  const keep = primary({
    sourceSegments: [{
      osmId: 267715892,
      navSegmentKey: 'way/267715892',
      splitIndex: 0,
      nodeRefs: [2401176460, 2401176462, 2401176466],
    }],
  })
  const record = mergeRecord({
    secondary: 'way/267715892@b/2401176462',
    secondary_nodes: '[2401176460,2401176462,2401176466]',
  })
  const { resolved, rows } = resolveRoadMerges([keep], [record])
  assert.equal(resolved.length, 1)
  assert.equal(rows[0].status, 'recoverable_via_provenance')
  assert.equal(resolved[0].resolvedBy, 'source-segment')
})

test('前一筆次段被後一筆吸收不會在最終快照被誤判失敗', () => {
  const result = resolveRoadMerges([block(1), block(2), block(3)], [
    mergeRecord({ primary: key(1), secondary: key(2), seq: 1 }),
    mergeRecord({ primary: key(1), secondary: key(3), seq: 2 }),
  ])
  assert.deepEqual(result.rows.map((row) => row.status), ['replayable', 'replayable'])
})
```

- [ ] **Step 2: 執行測試並確認缺少模組而失敗**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: FAIL，訊息包含 `Cannot find module './roadMerge.ts'`。

- [ ] **Step 3: 實作 key 解析與來源候選索引**

```ts
const parseBlockKey = (key: string) => {
  const match = key.match(/^way\/(-?\d+)@b\/(-?\d+)$/)
  return match ? { wayId: Number(match[1]), blockNode: Number(match[2]) } : null
}

const sourceCandidates = (roads: RoadFeature[], key: string) => {
  const parsed = parseBlockKey(key)
  if (!parsed) return []
  return roads.filter((road) =>
    road.properties.sourceSegments.some((source) =>
      source.osmId === parsed.wayId && source.nodeRefs.includes(parsed.blockNode)))
}

const uniqueCandidate = (
  exact: RoadFeature | undefined,
  activeNode: RoadFeature[],
  provenance: RoadFeature[],
) => {
  if (exact) return { road: exact, resolvedBy: 'exact' as const }
  if (activeNode.length === 1) return { road: activeNode[0], resolvedBy: 'active-node' as const }
  if (provenance.length === 1) return { road: provenance[0], resolvedBy: 'source-segment' as const }
  return null
}

const cloneRoad = (road: RoadFeature): RoadFeature => ({
  ...road,
  geometry: {
    ...road.geometry,
    coordinates: road.geometry.coordinates.map((coordinate) => [...coordinate]),
  },
  properties: {
    ...road.properties,
    nodes: [...road.properties.nodes],
    sourceSegments: road.properties.sourceSegments.map((source) => ({
      ...source,
      nodeRefs: [...source.nodeRefs],
    })),
    oneSideEntryNodes: road.properties.oneSideEntryNodes
      ? [...road.properties.oneSideEntryNodes] : undefined,
  },
})
```

- [ ] **Step 4: 實作依 journal 順序的解析與逐筆分類**

```ts
export function resolveRoadMerges(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
) {
  const working = roads.map(cloneRoad)
  const rows: RoadMergeReplayRow[] = []
  const resolved: ResolvedRoadMerge[] = []
  for (const record of activeMergeRecordsInSequence(journal)) {
    const result = resolveOneMerge(working, record)
    rows.push(result.row)
    if (!result.merge) continue
    resolved.push(result.merge)
    applyVisualMergeInPlace(working, result.merge)
  }
  return { resolved, rows }
}
```

同一檔案內的 helper 介面固定為：

```ts
function activeMergeRecordsInSequence(journal: EnhancementRecord[]): EnhancementRecord[]
function resolveOneMerge(
  working: RoadFeature[],
  record: EnhancementRecord,
): { row: RoadMergeReplayRow; merge?: ResolvedRoadMerge }
function applyVisualMergeInPlace(
  working: RoadFeature[],
  merge: ResolvedRoadMerge,
): void
function resolveAdjacentDirection(
  main: RoadFeature,
  sideRoads: RoadFeature[],
  junctionNodeId: number,
): boolean | null
```

`resolveAdjacentDirection()` 分別計算主路 forward/back 與側路進出接縫的有向角度；只有其中一個主路方向同時形成右進及右出時回傳該方向的 `back`，兩個方向都符合或都不符合時回傳 `null` 並要求確認。`resolveOneMerge()` 必須把多個候選列為 `needs_manual_review`，目前資料完全找不到來源列為 `legacy_destructive`，幾何確定不相接列為 `invalid`；只有唯一候選才可繼續。`activeMergeRecordsInSequence()` 必須依 `(seq, ts)` 排序、以 target key 折疊 `set/delete`，同時保留每筆活躍 set 的原始 `seq/ts/author`。

- [ ] **Step 5: 在 `enhancements.ts` 重新匯出既有名稱**

```ts
export {
  checkRoadMerge,
  replayRoadMerge,
  resolveRoadMerges,
  buildRoadMergeViews,
  type RoadMergeReplayRow,
  type ResolvedRoadMerge,
} from './roadMerge'
```

刪除 `enhancements.ts` 中已搬移的重複實作，其他 journal 函式維持原位。

- [ ] **Step 6: 執行解析器測試**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: PASS，至少包含精確解析、來源追溯、連鎖重播、多候選拒絕及 tombstone 五組案例。

- [ ] **Step 7: 提交**

```powershell
git add src/core/roadMerge.ts src/core/roadMerge.test.mjs src/core/enhancements.ts
git commit -m "建立可追溯的道路捏合解析器"
```

### Task 2: 分離導航來源道路與繪圖捏合視圖

**Files:**
- Modify: `src/core/roadMerge.ts`
- Modify: `src/core/roadMerge.test.mjs`
- Modify: `src/core/roads.ts`

**Interfaces:**
- Consumes: Task 1 的 `ResolvedRoadMerge[]`。
- Produces:

```ts
export interface RoadMergeViews {
  routingRoads: RoadFeature[]
  renderRoads: RoadFeature[]
  resolved: ResolvedRoadMerge[]
  rows: RoadMergeReplayRow[]
}

export function buildRoadMergeViews(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): RoadMergeViews

function clearDerivedMergeState(roads: RoadFeature[]): void
function applyRoutingConstraints(
  roads: RoadFeature[],
  merges: ResolvedRoadMerge[],
): void
function applyVisualMergeByIdentity(
  renderRoads: RoadFeature[],
  merge: ResolvedRoadMerge,
): void
function suppressOverlappedRenderStubs(
  renderRoads: RoadFeature[],
  merges: ResolvedRoadMerge[],
): void
```

- [ ] **Step 1: 寫下來源道路不可被 splice、側路節點須保留的測試**

```js
test('導航道路保留主段、次段與側路，只有繪圖視圖接合', () => {
  const base = [primary(), secondary(), sideRoadAt(JOIN)]
  const view = buildRoadMergeViews(base, [mergeRecord()])
  assert.equal(view.routingRoads.length, 3)
  assert.ok(view.routingRoads.some((road) => road.properties.osm_id === SECONDARY_ID))
  assert.ok(view.routingRoads.some((road) => road.properties.nodes.includes(JOIN)))
  assert.equal(view.renderRoads.filter(isMainSpan).length, 1)
})

test('重疊碎段只設 renderHidden，不設 deleted', () => {
  const stub = overlappedStub()
  const view = buildRoadMergeViews([primary(), secondary(), stub], [mergeRecord()])
  const routingStub = view.routingRoads.find((road) => road.properties.navSegmentKey === stubKey)
  assert.equal(routingStub.properties.deleted, undefined)
  assert.equal(view.renderRoads.some((road) => road.properties.navSegmentKey === stubKey), false)
})
```

- [ ] **Step 2: 執行測試並確認目前次段被移除而失敗**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: FAIL，導航道路數量或次段存在性斷言失敗。

- [ ] **Step 3: 加入只供繪圖使用的欄位**

```ts
export interface RoadProps {
  // existing fields...
  renderHidden?: boolean
  oneSideEntryAccess?: { nodeId: number; allowedBack: boolean }[]
}
```

並將 `roadsForRendering()` 的第一個過濾條件改為：

```ts
if (road.properties.renderHidden) return false
```

`deleted` 仍只代表人工刪除，不能被捏合碎段抑制器設定。

- [ ] **Step 4: 實作雙視圖**

```ts
export function buildRoadMergeViews(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
): RoadMergeViews {
  const routingRoads = roads
  clearDerivedMergeState(routingRoads)
  const replay = resolveRoadMerges(routingRoads, journal)
  applyRoutingConstraints(routingRoads, replay.resolved)

  const renderRoads = routingRoads.map(cloneRoad)
  for (const merge of replay.resolved) applyVisualMergeByIdentity(renderRoads, merge)
  suppressOverlappedRenderStubs(renderRoads, replay.resolved)
  return { routingRoads, renderRoads: roadsForRendering(renderRoads), ...replay }
}
```

`applyRoutingConstraints()` 只加入 `oneSideEntryNodes`、含 `allowedBack` 的 `oneSideEntryAccess` 與來源別名，不改幾何、不 splice；`applyVisualMergeByIdentity()` 只在複本接合幾何。

- [ ] **Step 5: 加入被 drop 次段的側路目標不變量**

```ts
const unresolvedSideTargets = roads
  .filter((side) => side !== merge.primary && side !== merge.secondary)
  .filter((side) =>
    side.properties.nodes.includes(merge.junctionNodeId)
    || side.properties.sourceSegments.some((source) =>
      source.nodeRefs.includes(merge.junctionNodeId)))
  .filter((side) =>
    !side.properties.nodes.some((node) =>
      merge.primary.properties.nodes.includes(node)
      || merge.secondary.properties.nodes.includes(node)))
if (unresolvedSideTargets.length) {
  return {
    status: 'needs_manual_review',
    detail: `side_target_unresolved:${unresolvedSideTargets
      .map((road) => road.properties.navSegmentKey).join(',')}`,
  }
}
```

此檢查失敗時，不得把該筆 merge 放入 `resolved`，並須在 row 中保存側路 key。

- [ ] **Step 6: 執行道路捏合與繪圖過濾測試**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: PASS，導航來源陣列不減少、繪圖視圖只有一條連續主路、碎段仍可導航。

- [ ] **Step 7: 提交**

```powershell
git add src/core/roadMerge.ts src/core/roadMerge.test.mjs src/core/roads.ts
git commit -m "分離道路捏合的導航拓撲與繪圖視圖"
```

### Task 3: 修正 A* 狀態與中央島轉向限制

**Files:**
- Modify: `src/core/graph.ts`
- Modify: `src/core/oneSideEntry.ts`
- Modify: `src/core/oneSideEntry.test.mjs`
- Create: `src/core/graphRouteState.test.mjs`

**Interfaces:**
- Consumes: `oneSideEntryNodes` 及 Task 2 保留的來源邊。
- Produces: 以 `(nodeId, incomingEdge)` 為身分的 A* 搜尋；同一節點可保留不同轉向權限。

- [ ] **Step 1: 加入同節點不同進入邊的路徑回歸測試**

```js
test('較便宜但不能轉出的抵達狀態不會壓掉合法短路徑', () => {
  const graph = new RoadGraph(routeStateFixture())
  const route = graph.route(START, GOAL, 'car')
  assert.ok(route)
  assert.ok(route.lengthM < 500, `不應繞行 ${route.lengthM.toFixed(0)}m`)
  assert.deepEqual(route.spans.map((span) => span.road?.properties.osm_id),
    [10, 20, 30])
})
```

測試圖必須讓兩條進入邊抵達同一節點，其中成本較低者因中央島限制不能進入目標側路，成本稍高者可以。

- [ ] **Step 2: 執行測試並確認 node-only 狀態造成失敗**

Run: `node --test src/core/graphRouteState.test.mjs`

Expected: FAIL，結果為 `null` 或路徑長度大於 500m。

- [ ] **Step 3: 定義完整搜尋狀態**

```ts
interface RouteSearchState {
  key: string
  nodeId: number
  incoming: Edge
}

const edgeIdentity = (edge: Edge) =>
  `${edge.road.properties.navSegmentKey}:${edge.road.properties.blockNode}`
  + `:${edge.from}>${edge.to}:${edge.back ? 1 : 0}`

const stateKey = (nodeId: number, incoming: Edge) =>
  `${nodeId}|${edgeIdentity(incoming)}`
```

- [ ] **Step 4: 將 A* map 與路徑重建改成完整狀態**

```ts
const g = new Map<string, number>()
const states = new Map<string, RouteSearchState>()
const cameFrom = new Map<string, { previous: string | null; edge: Edge }>()
const open = new Map<string, number>()
const closed = new Set<string>()
```

展開 outgoing edge 時以 `nextKey = stateKey(e.to, e)` 比較成本，並使用目前 state's `incoming` 呼叫 `transitionAllowed()`。`bestGoal` 保存 `stateKey`；回溯時沿 `cameFrom.previous` 取邊，不再以 node ID 回溯。

- [ ] **Step 5: 補齊禁止穿越規則測試**

```js
test('側路只可與主路相鄰方向互通', () => {
  assert.equal(allow(main(), false, side(), false), true)
  assert.equal(allow(side(), false, main(), false), true)
  assert.equal(allow(main(), true, side(), false), false)
  assert.equal(allow(side(), false, main(), true), false)
})

test('主路幾何反向時允許方向跟著 adjacentBack，不可固定假設 forward', () => {
  const reversedMain = main({ allowedBack: true })
  assert.equal(allow(reversedMain, true, side(), false), true)
  assert.equal(allow(side(), false, reversedMain, true), true)
  assert.equal(allow(reversedMain, false, side(), false), false)
})

test('同一接縫不可作為主路迴轉', () => {
  assert.equal(allow(main(), false, main(), true), false)
})
```

修改 `oneSideEntryTransitionAllowed()`：

```ts
const accessAt = (road: RoadFeature, nodeId: number) =>
  road.properties.oneSideEntryAccess?.find((entry) => entry.nodeId === nodeId)

if (incomingRoad.properties.osm_id === outgoingRoad.properties.osm_id) {
  const restricted = accessAt(incomingRoad, nodeId)
  return !restricted || incomingBack === outgoingBack
}
const incomingAccess = accessAt(incomingRoad, nodeId)
if (incomingAccess && incomingBack !== incomingAccess.allowedBack) return false
const outgoingAccess = accessAt(outgoingRoad, nodeId)
if (outgoingAccess && outgoingBack !== outgoingAccess.allowedBack) return false
return true
```

同一路段同方向直行可用，在限制節點切換 `back` 視為 U-turn 並拒絕；不同道路只允許 `adjacentBack` 指定的相鄰方向。

- [ ] **Step 6: 執行導航測試**

Run: `node --test src/core/oneSideEntry.test.mjs src/core/graphRouteState.test.mjs`

Expected: PASS，包含右進右出、禁止左轉／穿越／迴轉及短路徑案例。

- [ ] **Step 7: 提交**

```powershell
git add src/core/graph.ts src/core/oneSideEntry.ts src/core/oneSideEntry.test.mjs src/core/graphRouteState.test.mjs
git commit -m "修正捏合接縫轉向與路徑搜尋狀態"
```

### Task 4: 接入地圖繪圖與導航重建流程

**Files:**
- Modify: `src/app/mapCore.ts`
- Modify: `src/edit/useEditor.ts`
- Modify: `src/core/medians.ts`
- Modify: `src/core/turnbays.ts`
- Create: `src/core/roadMergeRendering.test.mjs`
- Modify: `src/core/roadMerge.test.mjs`

**Interfaces:**
- Consumes: `buildRoadMergeViews()`。
- Produces: `roadsRef` 保存導航來源道路、`renderRoadsRef` 保存接合後視圖、`refreshRoadMergeViews()` 原子更新兩者。

- [ ] **Step 1: 寫下重建結果的整合測試**

```js
test('同一份 journal 產生保留拓撲的導航集合與連續繪圖集合', () => {
  const result = buildRoadMergeViews(fixtureRoads(), fixtureJournal())
  assert.equal(result.routingRoads.length, fixtureRoads().length)
  assert.equal(result.renderRoads.filter(isMain).length, 1)
  assert.deepEqual(result.routingRoads.find(isPrimary).properties.oneSideEntryNodes, [JOIN])
})
```

- [ ] **Step 2: 在 `mapCore.ts` 保存兩份視圖**

```ts
const roadsRef = useRef<RoadFeature[]>([])
const renderRoadsRef = useRef<RoadFeature[]>([])
const mergeReplayRef = useRef<RoadMergeReplayRow[]>([])

const refreshRoadMergeViews = useCallback(() => {
  const view = buildRoadMergeViews(roadsRef.current, journalRef.current)
  renderRoadsRef.current = view.renderRoads
  mergeReplayRef.current = view.rows
  graphRef.current = new RoadGraph(view.routingRoads, laneGuidanceIndexRef.current)
  for (const row of view.rows) {
    if (row.status === 'needs_manual_review'
      || row.status === 'legacy_destructive'
      || row.status === 'invalid') {
      console.warn(`未套用道路捏合 ${row.mergeKey}：${row.detail}`)
    }
  }
  return true
}, [])
```

`MapCore` 對編輯器新增兩個明確介面：

```ts
previewJournal: (journal: EnhancementRecord[]) => RoadMergeViews | null
refreshRoadMergeViews: (journal?: EnhancementRecord[]) => boolean
```

`previewJournal()` 只建立複本與驗證新增或撤銷的目標紀錄，不改 ref；`refreshRoadMergeViews()` 會跳過個別無法解析的舊紀錄、保留其報告，並更新其餘有效視圖。個別舊紀錄失敗不得阻止其他捏合與整張地圖載入。

- [ ] **Step 3: 將所有繪圖入口改讀 `renderRoadsRef`**

`redrawRoads()`、`buildRoadSurfaces()`、`buildDividers()`、`buildMedians()` 與道路文字以繪圖視圖輸出；`RoadGraph`、可達性及編輯來源查找仍使用 `roadsRef`。

```ts
const renderRoads = renderRoadsRef.current
src('roads').setData({ type: 'FeatureCollection', features: roadsWithCleanupFlags(renderRoads) } as never)
src('roadSurfaces').setData(buildRoadSurfaces(renderRoads) as never)
```

- [ ] **Step 4: 將 `replaceBaseMap()` 改為重建雙視圖**

```ts
const replaceBaseMap = useCallback((roads: RoadFeature[]) => {
  roadsRef.current = roads.filter((road) => !road.properties.deleted)
  if (!refreshRoadMergeViews()) return false
  redrawRoads()
  rebuildElevation(renderRoadsRef.current)
  return true
}, [refreshRoadMergeViews, redrawRoads, rebuildElevation])
```

- [ ] **Step 5: 執行捏合與既有核心測試**

先建立繪圖回歸測試：

```js
test('捏合接縫的主路中央島與中央線不收邊', () => {
  const { graph, renderRoads, junction } = mergedRenderFixture()
  const medians = buildMedians(renderRoads)
  const channel = buildChannelization(graph, [])
  assert.ok(coversJunction(medians, junction))
  assert.equal(hasEndpointNear(channel, junction, 1), false)
})

test('主路沒有路口樣式，側路明確端點樣式仍保留', () => {
  const { graph, journal, junction, mainWayId, sideWayId } = mergedRenderFixture()
  const stops = buildStopLines(graph, [], [], journal)
  const arrows = buildLaneArrows(graph, [], [], new Map(), journal)
  assert.equal(featuresForWay(stops, mainWayId, junction).length, 0)
  assert.equal(featuresForWay(arrows, mainWayId, junction).length, 0)
  assert.equal(featuresForWay(stops, sideWayId, junction).length, 1)
})
```

Run: `node --test src/core/roadMergeRendering.test.mjs`

Expected: FAIL，至少重現主路多餘停止線／箭頭或中央線在接縫收邊。

- [ ] **Step 6: 將接縫呈現判斷集中成共用 helper**

在 `roadMerge.ts` 匯出：

```ts
export const isRoadMergeThroughNode = (road: RoadFeature, nodeId: number) =>
  road.properties.oneSideEntryAccess?.some((entry) => entry.nodeId === nodeId) ?? false
```

`medians.ts` 對承載該節點的主路把接縫收邊設為 0，讓中央島及中央線連續；`turnbays.ts` 在生成主路停止線、路口箭頭、槽化帶與端帽前以此 helper 排除。側路不是承載者，因此仍依自己的人工 `stopLine`／`arrowDisplay` 設定生成。

```ts
const mergeThroughStart = isRoadMergeThroughNode(edge.road, edge.fromNode)
const mergeThroughEnd = isRoadMergeThroughNode(edge.road, edge.toNode)
const startSetbackM = mergeThroughStart ? 0 : ordinaryStartSetbackM
const endSetbackM = mergeThroughEnd ? 0 : ordinaryEndSetbackM
```

- [ ] **Step 7: 執行捏合與繪圖核心測試**

Run: `node --test src/core/roadMerge.test.mjs src/core/oneSideEntry.test.mjs src/core/mergedJunctions.test.mjs src/core/roadMergeRendering.test.mjs`

Expected: PASS。

- [ ] **Step 8: 執行 TypeScript build**

Run: `npm.cmd run build`

Expected: exit 0，無 TypeScript 錯誤。

- [ ] **Step 9: 提交**

```powershell
git add src/app/mapCore.ts src/edit/useEditor.ts src/core/roadMerge.ts src/core/medians.ts src/core/turnbays.ts src/core/roadMerge.test.mjs src/core/roadMergeRendering.test.mjs
git commit -m "接入捏合的導航來源與繪圖視圖"
```

### Task 5: 新捏合原子寫入、追蹤與撤銷

**Files:**
- Modify: `src/core/roadMerge.ts`
- Modify: `src/edit/useEditor.ts`
- Modify: `src/edit/EditPanels.tsx`
- Modify: `src/core/roadMerge.test.mjs`

**Interfaces:**
- Produces:

```ts
export interface RoadMergePreview {
  ok: boolean
  reason?: string
  record?: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>
  resolved?: ResolvedRoadMerge
}

export function previewRoadMerge(
  roads: RoadFeature[],
  journal: EnhancementRecord[],
  primary: RoadFeature,
  secondary: RoadFeature,
): RoadMergePreview

export function activeMergeForRoad(
  rows: RoadMergeReplayRow[],
  road: RoadFeature,
): RoadMergeReplayRow | undefined
```

- [ ] **Step 1: 寫下失敗不可落日誌及 V2 追蹤欄位測試**

```js
test('預覽失敗不產生可追加紀錄', () => {
  const preview = previewRoadMerge(ambiguousRoads(), [], primary(), secondary())
  assert.equal(preview.ok, false)
  assert.equal(preview.record, undefined)
})

test('V2 紀錄保存接縫與來源快照', () => {
  const preview = previewRoadMerge(validRoads(), [], primary(), secondary())
  assert.equal(preview.record.fields.schema_version, 2)
  assert.equal(preview.record.fields.junction_node, JOIN)
  assert.match(preview.record.fields.primary_source, /navSegmentKey/)
  assert.match(preview.record.fields.secondary_source, /nodeRefs/)
})

test('新捏合的繪圖與導航關鍵欄位衝突時拒絕，不採第一段值', () => {
  const preview = previewRoadMerge(validRoads(), [], primary({
    centerM: 2.4, centerKind: 'island',
  }), secondary({
    centerM: 0.6, centerKind: 'hatch',
  }))
  assert.equal(preview.ok, false)
  assert.match(preview.reason, /centerM|centerKind/)
})
```

- [ ] **Step 2: 先預覽成功，再追加 journal**

`previewRoadMerge()` 先逐欄比較以下固定集合；任一不同就回傳欄位名稱及兩側值，舊日誌重播則不重新套用此新建檢查：

```ts
const MERGE_CRITICAL_FIELDS = [
  'highway', 'oneway',
  'lanesForward', 'lanesBackward',
  'motoF', 'motoB', 'motoSepF', 'motoSepB',
  'centerM', 'centerKind', 'roadMarkingMode',
] as const
```

將目前「先 `appendRecord()`、後 `applyRoadMerges()`」改成：

```ts
const preview = previewRoadMerge(
  core.roadsRef.current, core.journalRef.current, first, road)
if (!preview.ok || !preview.record) {
  warn(`無法捏合：${preview.reason ?? '驗證失敗'}`)
  return
}
const nextJournal = appendRecord(core.journalRef.current, preview.record)
if (!core.previewJournal(nextJournal)) {
  warn('捏合預覽未通過，未寫入紀錄')
  return
}
core.journalRef.current = nextJournal
core.refreshRoadMergeViews()
```

- [ ] **Step 3: 更新確認文字**

確認視窗必須明確顯示：

```text
捏合後：
・主路與中央島跨接縫連續繪製
・側路仍保留並連接相鄰方向
・禁止跨中央島左轉、直穿及迴轉
・原始道路與路口來源保留，可由歷程撤銷
```

刪除「第二段將退出活躍路網」文字。

- [ ] **Step 4: 實作撤銷**

```ts
function undoRoadMerge(row: RoadMergeReplayRow) {
  const next = appendRecord(core.journalRef.current, {
    op: 'delete',
    target: { type: 'road_merge', key: row.mergeKey },
    fields: { supersedes_seq: row.resolved?.sourceSeq ?? 0 },
  })
  if (!core.previewJournal(next)) return warn('撤銷預覽失敗，未變更歷程')
  core.journalRef.current = next
  core.refreshRoadMergeViews()
}
```

`EditPanels.tsx` 只在目前道路有活躍捏合 row 時顯示作者、時間、來源 key、解析方式與「撤銷捏合」按鈕。

- [ ] **Step 5: 執行測試與 build**

Run: `node --test src/core/roadMerge.test.mjs`

Expected: PASS。

Run: `npm.cmd run build`

Expected: exit 0。

- [ ] **Step 6: 提交**

```powershell
git add src/core/roadMerge.ts src/core/roadMerge.test.mjs src/edit/useEditor.ts src/edit/EditPanels.tsx
git commit -m "加入道路捏合預覽追蹤與安全撤銷"
```

### Task 6: 舊資料復原報告與安全遷移候選

**Files:**
- Create: `scripts/road_merge_recovery.ts`
- Create: `scripts/road_merge_recovery.test.mjs`
- Modify: `scripts/orphan_audit.ts`
- Modify: `scripts/severed_route_audit.ts`
- Modify: `scripts/merged_junction_render_audit.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 的 `resolveRoadMerges()`、目前 `public/data/road_database.json`。
- Produces:

```ts
interface RoadMergeRecoveryReport {
  format: 'lanedev-road-merge-recovery-v2'
  generatedAt: string
  databasePath: string
  totals: Record<RoadMergeReplayRow['status'], number>
  rows: RoadMergeReplayRow[]
  migrationCandidates: EnhancementRecord[]
}
```

- [ ] **Step 1: 寫下報告分類與不改輸入日誌測試**

```js
test('報告分類 exact、provenance、review、invalid 且不改 journal', () => {
  const before = JSON.stringify(journal)
  const report = buildRecoveryReport(roads, journal)
  assert.equal(report.totals.replayable, 1)
  assert.equal(report.totals.recoverable_via_provenance, 1)
  assert.equal(report.totals.needs_manual_review, 1)
  assert.equal(report.totals.invalid, 1)
  assert.equal(JSON.stringify(journal), before)
})

test('遷移候選只追加 tombstone 與 V2，不刪舊紀錄', () => {
  const candidate = buildMigrationCandidate(recoverableRow)
  assert.deepEqual(candidate.map((record) => record.op), ['delete', 'set'])
  assert.equal(candidate[1].fields.schema_version, 2)
  assert.equal(candidate[1].fields.supersedes_merge_key, recoverableRow.mergeKey)
})
```

- [ ] **Step 2: 執行測試並確認缺少復原模組而失敗**

Run: `node --test scripts/road_merge_recovery.test.mjs`

Expected: FAIL，訊息包含找不到 `road_merge_recovery.ts`。

- [ ] **Step 3: 實作預設唯讀 CLI**

```ts
const apply = process.argv.includes('--apply')
const report = buildRecoveryReport(roads, journal)
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (apply) {
  throw new Error(
    '--apply 必須搭配 --approved-report=artifacts/road-merge-recovery-2026-07-31.approved.json'
  )
}
```

只有提供 `--apply --approved-report=artifacts/road-merge-recovery-2026-07-31.approved.json`，且報告內沒有 `needs_manual_review`／`invalid` 時，才可把 append-only candidates 寫入 `artifacts/road_database-road-merge-v2-candidate.json`；禁止就地覆寫輸入 DB。

- [ ] **Step 4: 讓三支既有 audit 共用逐筆解析結果**

- `orphan_audit.ts` 直接輸出 `RoadMergeReplayRow`，不再從最終 active road map 推測早期 merge。
- `severed_route_audit.ts` 對每個 `resolved.junctionNodeId` 建立主路到側路的路徑樣本，不再限定負節點。
- `merged_junction_render_audit.ts` 由 `resolved` 找接縫位置，檢查主路停止線、反向左轉箭頭、中央島與中央線連續性。

- [ ] **Step 5: 加入 npm 命令**

```json
{
  "scripts": {
    "test:road-merge": "node --test src/core/roadMerge.test.mjs src/core/graphRouteState.test.mjs src/core/roadMergeRendering.test.mjs scripts/road_merge_recovery.test.mjs",
    "audit:road-merge-recovery": "node scripts/run_offline.mjs scripts/road_merge_recovery.ts",
    "test:all": "npm run test:lane-preview && npm run test:lane-guidance && npm run test:merge-migration && npm run test:editor-merge && npm run test:one-side-entry && npm run test:merged-junctions && npm run test:segment-dedupe && npm run test:road-merge"
  }
}
```

- [ ] **Step 6: 執行合成資料測試**

Run: `npm.cmd run test:road-merge`

Expected: PASS。

- [ ] **Step 7: 對目前完整資料產生報告**

Run:

```powershell
npm.cmd run audit:road-merge-recovery -- --json=artifacts/road-merge-recovery-2026-07-31.json
```

Expected:

- 48 筆活躍且不重複的舊捏合都出現在 rows；
- 原先 42 筆可重播紀錄歸入 `replayable`；
- 原先 6 筆 `way/267715892` 精確 key 失敗案例由 `sourceSegments` 歸入 `recoverable_via_provenance`；
- 沒有任何紀錄只因「次段已被後續吸收」而誤列失敗；
- CLI 不修改 `public/data/road_database.json`。

若實際數量因 main 資料更新而不同，必須逐筆解釋差異，不可為了符合預期硬編分類。

- [ ] **Step 8: 提交**

```powershell
git add scripts/road_merge_recovery.ts scripts/road_merge_recovery.test.mjs scripts/orphan_audit.ts scripts/severed_route_audit.ts scripts/merged_junction_render_audit.ts package.json
git commit -m "加入舊道路捏合復原報告與安全遷移候選"
```

### Task 7: 完整驗證與遷移決策資料

**Files:**
- Modify only if verification exposes an in-scope defect.
- Do not modify `public/data/road_database.json` in this task.

**Interfaces:**
- Produces: 可供使用者核准的復原報告、路徑稽核、繪圖稽核與完整測試證據。

- [ ] **Step 1: 執行完整測試**

Run: `npm.cmd run test:all`

Expected: exit 0，所有既有與新增測試通過。

- [ ] **Step 2: 執行 TypeScript 與 Vite build**

Run: `npm.cmd run build`

Expected: exit 0。

- [ ] **Step 3: 執行捏合日誌、孤兒與路徑稽核**

```powershell
npm.cmd run audit:journal-merge
npm.cmd run audit:orphans
npm.cmd run audit:severed-routes
```

Expected:

- 活躍捏合沒有未解析來源；
- 側路沒有因第二段被 drop 而失去導航目標；
- 每個接縫的允許方向可達；
- 禁止方向不會穿越中央島；
- 不再出現短路徑被無關搜尋狀態壓掉的異常繞路。

- [ ] **Step 4: 執行完整繪圖稽核**

Run: `npm.cmd run audit:merged-render -- --limit=999`

Expected: exit 0；所有捏合接縫均無主路停止線、反向左轉箭頭、中央線／中央島斷裂。

- [ ] **Step 5: 確認正式資料完全未被改寫**

Run:

```powershell
git diff --exit-code -- public/data/road_database.json
git status --short
```

Expected: `road_database.json` 無 diff；status 只含本計畫明列的程式、測試、文件或報告檔。

- [ ] **Step 6: 提交驗證中必要的範圍內修正**

只有 Step 1–4 發現本功能缺陷時，才回到引入該缺陷的 Task，先補失敗測試，再修改該 Task 已列出的檔案並以該 Task 的中文 commit 規則提交；不得在驗證階段建立無對應測試的臨時修補。

- [ ] **Step 7: 交付舊資料處理結果**

向使用者提供：

- 逐筆分類數量與 6 筆來源追溯結果；
- 每筆需人工確認的道路名稱、位置、作者、時間、舊 key 與原因；
- V2 append-only 遷移候選摘要；
- 明確確認尚未改寫正式資料。

只有使用者核准該報告後，才執行：

```powershell
npm.cmd run audit:road-merge-recovery -- --apply --approved-report=artifacts/road-merge-recovery-2026-07-31.approved.json --output-db=artifacts/road_database-road-merge-v2-candidate.json
```

產出的候選資料庫仍需重新執行 Task 7 全部驗證，通過後才可另行決定是否取代正式資料。
