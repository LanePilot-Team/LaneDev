# 路線預覽緊湊滾動介面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將手機路線預覽卡縮成固定高度的上方卡片，讓汽車／機車只以圖標與短提示同列，並固定保留起終點與「新增停靠點」可見，其餘路線資訊在卡片內滾動。

**Architecture:** 保留 `PlanPanel` 既有的 stop、planner、搜尋與導航資料流，只調整 JSX 的視覺分區。路線卡分成「固定主要操作區」與「可滾動次要資訊區」；正常預覽時前者包含標題、車種、起終點、停靠點與新增停靠點，後者包含錯誤、距離／時間、開始導航與路線步驟。編輯 stop 時暫時讓整張卡片在手機視窗內滾動，確保搜尋結果與取消操作可用。

**Tech Stack:** React 19、TypeScript 6、Vite 8、既有 CSS、Android WebView asset packaging、Gradle debug APK。

## Global Constraints

- 不更換路線計算、路網資料、Google Places API、定位服務或導航資料流。
- 汽車／機車仍使用 `planner.toggleProfile('pick')`，只改呈現方式。
- 「新增停靠點」在正常預覽狀態不得因卡片內容變長而需要滑動才能找到。
- 手機路線卡目標高度約為 `52dvh`，保留約 45–50% 的視窗給地圖與路線預覽。
- 車種圖標按鈕必須保留 `aria-label`、`title` 與 `aria-pressed`。
- 起點／終點搜尋、取消、目前位置、錯誤訊息與開始導航行為不可退化。
- 不修改或提交工作區中與本次介面無關的既有變更；不 push、建立 PR 或 merge。

---

## File Map

- Modify `web-source/src/plan/PlanPanel.tsx`: 將路線卡 JSX 分成固定主要操作區與可滾動次要資訊區；把車種切換移到短提示同列並改為圖標按鈕。
- Modify `web-source/src/App.css`: 定義緊湊標題列、圖標車種控制、固定區／滾動區與錯誤／摘要在滾動區內的版面。
- Modify `web-source/src/native/client.css`: 手機將路線卡改為固定高度且自身不整張滾動；搜尋 stop 時切換為視窗內可滾動狀態。
- Test with `web-source/package.json` scripts: 使用既有 `npm test`、`npm run build`，不新增測試依賴。
- Build Android assets with `tools/import-web-assets.ps1`, then verify `app/src/main/assets/public` and debug APK installation on `R5CRA1DK3TE`.

## Task 1: Refactor `PlanPanel` into fixed and scrolling regions

**Files:**
- Modify: `web-source/src/plan/PlanPanel.tsx:52-106`
- Test: existing `web-source/src/plan/placeRoute.test.mjs` and the full `web-source` test script

**Interfaces:**
- Consumes: existing `Planner` fields `stops`, `routeError`, `routeSummary`, `profile`, `toggleProfile`, `addVia`, `removeStop`, `selectStop`, `setStopDestination`, `routeRef`.
- Produces: unchanged callback behavior for `onClose`, `startGpsNav`, stop editing, stop selection, current-location lookup, and route calculation.

- [ ] **Step 1: Record the current behavior baseline**

Run from `web-source`:

```powershell
npm test
```

Expected: all existing tests pass, including the route and native client tests. This confirms the refactor starts from a working planner behavior baseline.

- [ ] **Step 2: Replace the header and vehicle block with one compact row**

Keep the close button and route title, but replace the separate full-width vehicle control with this structure:

```tsx
<div className="sp-head route-preview-head">
  <div className="route-preview-title">
    <span className="sp-kicker">路線預覽</span>
    <b>確認起終點後即可開始導航</b>
  </div>
  <div className="route-profile" role="group" aria-label="交通工具">
    <button type="button" className={`route-profile-option${profile === 'car' ? ' on' : ''}`}
      aria-label="汽車" title="汽車" aria-pressed={profile === 'car'}
      onClick={() => profile !== 'car' && planner.toggleProfile('pick')}>🚗</button>
    <button type="button" className={`route-profile-option${profile === 'moto' ? ' on' : ''}`}
      aria-label="機車" title="機車" aria-pressed={profile === 'moto'}
      onClick={() => profile !== 'moto' && planner.toggleProfile('pick')}>🛵</button>
  </div>
  <button className="sp-close" aria-label="關閉路線" onClick={onClose}>✕</button>
</div>
```

Do not change the `profile` value or the `toggleProfile` call. The only behavior change is that the buttons no longer render visible vehicle text.

- [ ] **Step 3: Wrap the existing stop controls in the fixed primary region**

Immediately after the compact header, add a `route-preview-primary` wrapper. Keep the existing locating message, location error, `route-stops` map, and add-stop button inside it in this order:

```tsx
<div className="route-preview-primary">
  {locating && <p className="route-status" role="status">正在取得目前位置…</p>}
  {locationError && <p role="alert" className="sp-error route-status-error">{locationError}；可直接搜尋起點。</p>}
  <div className="route-stops">{/* existing stops.map(...) unchanged */}</div>
  <button className="sp-add route-add-stop" onClick={() => { planner.addVia(); setEditing(null) }}>
    ＋ 新增停靠點
  </button>
</div>
```

Keep all existing stop row markup, labels, address rendering, `PlaceSearch`, current-location suggestion, cancel action, and via-stop removal behavior unchanged. This prevents the layout refactor from changing route data behavior.

- [ ] **Step 4: Put secondary route information in the internal scroll region**

Wrap the existing `routeError`, `route-preview-summary`, and `route-steps` blocks in a sibling `route-preview-secondary` element:

```tsx
<div className="route-preview-secondary">
  {routeError && <div role="alert" className="sp-error route-status-error">{routeError}</div>}
  {routeSummary && <div className="route-preview-summary">
    <div className="route-preview-metrics">
      <span><b>{routeSummary.km.toFixed(1)}</b> 公里</span>
      <span>約 {Math.max(1, Math.ceil(routeSummary.min))} 分鐘</span>
    </div>
    <button className="route-start-button" disabled={editing !== null || locating} onClick={startGpsNav}>
      {editing !== null ? '請先選好地點' : '開始導航'}
    </button>
  </div>}
  {routeSummary && planner.routeRef.current && <details className="route-steps">
    <summary>查看路線步驟</summary>
    <ManeuverList route={planner.routeRef.current} profile={profile} />
  </details>}
</div>
```

The `routeError` block must remain before the route summary so a failure is visible before the disabled/absent navigation action. Keep the existing `routeSummary` and `routeRef` guards exactly as shown.

- [ ] **Step 5: Run the typecheck and behavior tests**

Run from `web-source`:

```powershell
npm test
npm run build
```

Expected: all tests pass; TypeScript and Vite build complete without errors. The existing large-chunk and data-precompute warnings may remain, but there must be no new TypeScript or JSX errors.

- [ ] **Step 6: Commit the component refactor**

After confirming only the intended `PlanPanel.tsx` change is staged:

```powershell
git add -- web-source/src/plan/PlanPanel.tsx
git diff --cached --check
git commit -m "調整路線預覽卡片內容分區"
```

## Task 2: Style the compact header and nested scroll behavior

**Files:**
- Modify: `web-source/src/App.css:450-501`
- Modify: `web-source/src/native/client.css:42-82`
- Test: `npm run build` and manual responsive inspection

**Interfaces:**
- Consumes: the `.route-preview-head`, `.route-profile`, `.route-preview-primary`, `.route-preview-secondary`, `.route-add-stop`, and `.route-preview-card.is-searching` class names from Task 1.
- Produces: a bounded card where primary controls remain visible and secondary route information scrolls independently.

- [ ] **Step 1: Replace the full-width vehicle styles with compact icon controls**

In `web-source/src/App.css`, replace the existing `.route-profile` block with:

```css
.route-preview-card { padding: 12px 14px 14px; }
.route-preview-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.route-preview-title { min-width: 0; display: grid; gap: 2px; flex: 1; }
.route-preview-head .sp-kicker { color: #1769e8; }
.route-preview-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.route-profile {
  display: flex; flex: none; align-items: center; gap: 3px; height: 32px;
  padding: 3px; border-radius: 10px; background: #eef2f7;
}
.route-profile-option {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 26px; padding: 0; border: 0; border-radius: 7px;
  background: transparent; color: #718096; font-size: 16px; line-height: 1; cursor: pointer;
}
.route-profile-option.on { background: #fff; color: #1769e8; box-shadow: 0 1px 4px rgba(33, 52, 77, 0.11); }
.route-profile-option:focus-visible { outline: 2px solid #1769e8; outline-offset: 2px; }
.route-preview-primary { flex: none; min-height: 0; }
.route-preview-secondary { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
```

Keep the existing stop-card, address, error, summary, start-button, and route-step styles below this block unless a later rule specifically overrides their spacing.

- [ ] **Step 2: Make the normal mobile card bounded and internally scrollable**

In the mobile block of `web-source/src/native/client.css`, replace the current whole-card `overflow-y: auto` rule with:

```css
.side-panel.route-preview-card {
  left: 12px; right: 12px; top: max(12px, env(safe-area-inset-top)); bottom: auto;
  width: auto; max-width: none; height: min(52dvh, 480px); max-height: min(52dvh, 480px);
  overflow: hidden; border-radius: 20px; padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
}
.side-panel.route-preview-card.is-searching {
  height: auto; max-height: calc(100dvh - 96px); overflow-y: auto;
}
```

The normal card uses `overflow: hidden` so the map is never pushed and the secondary region owns its scroll. Search mode is the explicit exception: it lets the stop search form and result list use the phone viewport while the close and cancel buttons remain inside the same scrollable card.

- [ ] **Step 3: Ensure the secondary region has enough visual separation**

Add the following CSS after the primary/secondary rules:

```css
.route-preview-secondary:empty { display: none; }
.route-preview-secondary > .route-status-error { margin-top: 10px; }
.route-preview-secondary .route-preview-summary { margin-top: 10px; }
```

Do not use `position: fixed` for the add-stop button; it must stay attached to the route card and remain visible when the map is panned or the device rotates.

- [ ] **Step 4: Run the build and inspect the responsive result**

Run from `web-source`:

```powershell
npm run build
```

Check the generated build at the existing local preview or Android WebView and verify:

1. The title hint and two icon buttons fit on one line without horizontal overflow.
2. The route card occupies roughly the upper half of a phone screen.
3. Origin, destination, and “新增停靠點” remain visible without scrolling in normal preview mode.
4. Route summary and route steps scroll inside the lower region rather than moving the map controls.
5. Editing a stop expands the card enough to use the search result list and still exposes `取消` and `✕`.
6. The selected car/motorcycle icon remains visually distinct and both buttons still switch the planner profile.

- [ ] **Step 5: Commit the style changes**

After checking the staged diff contains only the two intended CSS files:

```powershell
git add -- web-source/src/App.css web-source/src/native/client.css
git diff --cached --check
git commit -m "縮短路線預覽卡片並加入內部滾動"
```

## Task 3: Package, build, and verify on the Android device

**Files:**
- Modify generated assets through: `tools/import-web-assets.ps1 -WebProject .\web-source`
- Build output: `app/build/outputs/apk/debug/app-debug.apk`
- Do not manually edit generated files under `app/src/main/assets/public`.

**Interfaces:**
- Consumes: the successful web build from Tasks 1–2 and the existing Android WebView asset import pipeline.
- Produces: a debug APK installed on Samsung `SM-A528B` (`R5CRA1DK3TE`) and a manual confirmation of the UI behavior.

- [ ] **Step 1: Import the production web bundle into Android assets**

Run from the Android project root:

```powershell
& 'C:\Users\Cindy\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\tools\import-web-assets.ps1 -WebProject .\web-source
```

Expected: the command reports that Android assets were updated under `app\src\main\assets\public`.

- [ ] **Step 2: Assemble the debug APK with Android Studio's JDK**

Run from the Android project root:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug
```

Expected: `BUILD SUCCESSFUL` and the APK exists at `app\build\outputs\apk\debug\app-debug.apk`.

- [ ] **Step 3: Install and launch on the authorized phone**

Run:

```powershell
$adb='C:\Users\Cindy\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb -s R5CRA1DK3TE install -r .\app\build\outputs\apk\debug\app-debug.apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $adb -s R5CRA1DK3TE shell monkey -p tw.lanepilot.lanedev 1
```

Expected: `Success` from install and `Events injected: 1` from launch. If ADB reports `unauthorized`, unlock the phone and accept the USB debugging prompt before retrying.

- [ ] **Step 4: Perform the device acceptance check**

On the phone:

1. Open a place result and tap `路線`.
2. Confirm the top card shows the hint and icon-only car/motorcycle buttons on one row.
3. Confirm the origin, destination, and `＋ 新增停靠點` are visible before scrolling.
4. Scroll inside the card and confirm distance/time, `開始導航`, and route steps appear without the map controls moving.
5. Switch car and motorcycle and confirm the selected icon changes without the card jumping or resizing.
6. Tap `更換`, search a new stop, cancel once, then select a result; confirm the stop and route update correctly.
7. Close the route card and confirm the map returns to browse mode with locate/settings controls still at the bottom-right.

- [ ] **Step 5: Run the final regression checks**

Run from `web-source`:

```powershell
npm test
npm run build
```

Run from the Android project root:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug
```

Expected: all web tests pass, the web production build completes, and Android reports `BUILD SUCCESSFUL`. Record any existing data-precompute, chunk-size, or Gradle deprecation warnings separately; they are not failures unless they prevent the build or change route behavior.
