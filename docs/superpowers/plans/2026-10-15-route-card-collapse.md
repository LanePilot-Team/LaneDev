# 路線預覽卡片收合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓地圖選址期間可以把路線預覽卡片縮小，且保留獨立的展開與取消控制，不把 `X` 誤當成縮小按鍵。

**Architecture:** 在 `PlanPanel` 內加入獨立的收合狀態；點擊「在地圖上選取」時自動進入收合狀態，標題列提供展開／縮小按鍵，地圖選取中的窄狀狀態列提供取消操作。收合狀態只影響路線預覽 UI，不改變 `App` 的模式、正式 GPS 導航或地圖點擊邏輯。

**Tech Stack:** React、TypeScript、Vite、CSS、Node test runner、Android WebView assets。

## Global Constraints

- 不切換目前分支 `android-simulation-dev`，不建立 worktree。
- 保留既有正式 GPS 導航、瀏覽模式與 `X` 關閉路線行為。
- 倍速與收合狀態只屬於開發測試 UI，不影響真實 GPS 導航。
- 不修改未追蹤的 `.idea/`、`.superpowers/` 與兩份既有 2026-10-07 plan 檔案。

---

### Task 1: 建立路線卡片收合狀態的可測試邏輯

**Files:**
- Create: `web-source/src/plan/routePanelState.ts`
- Create: `web-source/src/plan/routePanelState.test.mjs`

**Interfaces:**
- Produces `nextRoutePanelCollapsed(collapsed: boolean): boolean`。
- Produces `routePanelToggleLabel(collapsed: boolean): string`，收合時回傳「展開路線卡片」，展開時回傳「縮小路線卡片」。

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { nextRoutePanelCollapsed, routePanelToggleLabel } from './routePanelState.ts'

test('expanded route panel toggles to collapsed with an expand label', () => {
  assert.equal(nextRoutePanelCollapsed(false), true)
  assert.equal(routePanelToggleLabel(true), '展開路線卡片')
})

test('collapsed route panel toggles to expanded with a collapse label', () => {
  assert.equal(nextRoutePanelCollapsed(true), false)
  assert.equal(routePanelToggleLabel(false), '縮小路線卡片')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/plan/routePanelState.test.mjs` from `web-source`.

Expected: FAIL because `routePanelState.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function nextRoutePanelCollapsed(collapsed: boolean): boolean {
  return !collapsed
}

export function routePanelToggleLabel(collapsed: boolean): string {
  return collapsed ? '展開路線卡片' : '縮小路線卡片'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/plan/routePanelState.test.mjs` from `web-source`.

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add web-source/src/plan/routePanelState.ts web-source/src/plan/routePanelState.test.mjs
git commit -m "新增路線卡片收合狀態邏輯"
```

### Task 2: 將收合控制接到路線預覽與地圖選址

**Files:**
- Modify: `web-source/src/plan/PlanPanel.tsx`
- Modify: `web-source/src/App.css`

**Interfaces:**
- `PlanPanel` retains `onClose` as the only `X` action.
- The map-pick button starts picking and collapses the panel; the header toggle expands or collapses without changing route mode.

- [ ] **Step 1: Add the component state and transition wrapper**

Add `panelCollapsed` state, a `startMapPick` callback that calls `onStartMapPick(stopId)` and then sets `panelCollapsed` to `true`, and an effect that re-expands after map selection is completed or cancelled:

```tsx
const [panelCollapsed, setPanelCollapsed] = useState(false)
useEffect(() => {
  if (mapPickingStopId === null) setPanelCollapsed(false)
}, [mapPickingStopId])
function startMapPick(id: number) {
  onStartMapPick(id)
  setPanelCollapsed(true)
}
```

- [ ] **Step 2: Add independent header controls and compact picking status**

Import the two tested helpers and render a button before `sp-close`:

```tsx
<button
  type="button"
  className="route-panel-toggle"
  aria-label={routePanelToggleLabel(panelCollapsed)}
  aria-expanded={!panelCollapsed}
  onClick={() => setPanelCollapsed(nextRoutePanelCollapsed(panelCollapsed))}
>
  {panelCollapsed ? '⌄' : '⌃'}
</button>
<button className="sp-close" aria-label="關閉路線" onClick={onClose}>✕</button>
```

When `panelCollapsed` is true, hide the normal body and render a small map-picking status row with a separate cancel button if `mapPickingStopId !== null`.

- [ ] **Step 3: Connect the map-pick action to auto-collapse**

Change the map-pick button's inactive action from `onStartMapPick(stop.id)` to `startMapPick(stop.id)`. Leave the active action as `onCancelMapPick()` so the same button remains a direct cancel when expanded.

- [ ] **Step 4: Add mobile-sized styles**

Add styles for `.route-panel-toggle`, `.route-preview-card.is-collapsed`, `.route-preview-collapsed-status`, and its cancel button. The collapsed card must retain the header, never overlap the `X`, and expose a visible focus state.

- [ ] **Step 5: Run the focused and full web tests**

Run:

```bash
node --test src/plan/routePanelState.test.mjs
npm test
```

Expected: the focused tests pass and the existing full web suite remains green.

- [ ] **Step 6: Commit**

```bash
git add web-source/src/plan/PlanPanel.tsx web-source/src/App.css
git commit -m "新增路線預覽卡片收合控制"
```

### Task 3: 建置、同步 Android assets 並實機驗證

**Files:**
- Modify: `app/src/main/assets/public/` generated web assets only.

- [ ] **Step 1: Build the web client and import generated assets**

Run from the repository root:

```powershell
.\tools\build-client.ps1
```

Expected: the web build succeeds and `app/src/main/assets/public/` contains the newly generated hashed JS/CSS assets.

- [ ] **Step 2: Build the debug APK**

Run:

```powershell
.\tools\gradle.ps1 assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Install and launch on the connected phone**

Run:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r .\app\build\outputs\apk\debug\app-debug.apk
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" shell am force-stop tw.lanepilot.lanedev
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" shell am start -n tw.lanepilot.lanedev/.MainActivity
```

- [ ] **Step 4: Verify the phone flow**

Confirm manually: enter route preview, edit a stop, tap `⌖ 在地圖上選取`, verify the card shrinks, tap the map, verify the route updates and the card expands, tap the collapse control again, and verify `X` still closes the route preview.

- [ ] **Step 5: Commit generated assets**

```bash
git add app/src/main/assets/public
git commit -m "同步路線卡片收合 Android 前端資源"
```

