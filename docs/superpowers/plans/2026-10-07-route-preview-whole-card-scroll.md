# 路線卡整體滾動 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓路線預覽卡永遠由單一容器處理上下滑動，並固定標題列，避免新增停靠點後觸碰區域互相搶滾動。

**Architecture:** 不改 `PlanPanel` 的資料流或 JSX 結構；將 `.route-preview-card` 設為唯一 scroll container，讓 `.route-preview-secondary` 回到一般文件流，不再建立巢狀 scroll container。標題列用 `position: sticky` 固定在卡片頂端，內容仍受現有手機卡片高度限制。

**Tech Stack:** React 19、既有 CSS、Vite 8、Android WebView assets、Gradle debug APK。

## Global Constraints

- 保留現有卡片高度、地圖可視空間、車種切換、關閉、起終點搜尋與路線步驟行為。
- 不更換路線計算、定位、搜尋或導航資料流。
- 不新增第二個可滾動容器。
- 不 push、建立 PR 或 merge；不修改其他既有工作區變更。

---

### Task 1: Make the route card the only scroll container

**Files:**
- Modify: `web-source/src/App.css:450-474`
- Modify: `web-source/src/native/client.css:76-84`
- Test: `web-source` existing `npm test` and `npm run build`

**Interfaces:**
- Consumes: existing `.route-preview-card`, `.route-preview-head`, `.route-preview-primary`, and `.route-preview-secondary` classes.
- Produces: one vertical scroll surface for all route card content.

- [ ] **Step 1: Change the base card and secondary region styles**

Apply these CSS behaviors:

```css
.route-preview-card {
  display: flex; flex-direction: column; min-height: 0;
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scrollbar-width: thin; padding: 12px 14px 14px;
}
.route-preview-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px; margin: -12px -14px 10px;
  padding: 12px 14px 10px; background: #fff;
  border-bottom: 1px solid #edf0f4;
}
.route-preview-primary { flex: none; min-height: 0; }
.route-preview-secondary { flex: none; min-height: 0; overflow: visible; }
```

The existing route contents remain in document order. `position: sticky` keeps the close and vehicle controls available without taking the card out of the scroll flow.

- [ ] **Step 2: Apply the same single-scroll rule on phones**

In the mobile `.side-panel.route-preview-card` rule, use:

```css
.side-panel.route-preview-card {
  height: min(52dvh, 480px); max-height: min(52dvh, 480px);
  overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
}
.side-panel.route-preview-card.is-searching {
  height: auto; max-height: calc(100dvh - 96px); overflow-y: auto;
}
.side-panel.route-preview-card.is-searching .route-preview-secondary { overflow: visible; }
```

Do not add `overflow-y: auto` back to `.route-preview-secondary`; the card must remain the only scroll surface.

- [ ] **Step 3: Run web verification**

```powershell
npm test
npm run build
```

Expected: 50 tests pass and the production build exits with code 0. Existing data-precompute, missing Google Maps environment, chunk-size, and Gradle deprecation warnings are non-blocking.

- [ ] **Step 4: Commit CSS changes**

```powershell
git add -- web-source/src/App.css web-source/src/native/client.css
git diff --cached --check
git commit -m "讓路線卡使用單一滾動容器"
```

### Task 2: Package and verify the Android build

**Files:**
- Generate through `tools/import-web-assets.ps1`.
- Build `app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 1: Import assets and assemble APK**

```powershell
& 'C:\Users\Cindy\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\tools\import-web-assets.ps1 -WebProject .\web-source
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug
```

Expected: assets update and Gradle reports `BUILD SUCCESSFUL`.

- [ ] **Step 2: Install and launch on the authorized phone**

```powershell
$adb='C:\Users\Cindy\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb -s R5CRA1DK3TE install -r .\app\build\outputs\apk\debug\app-debug.apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $adb -s R5CRA1DK3TE shell monkey -p tw.lanepilot.lanedev 1
```

Expected: ADB reports `Success` and the app launches.

- [ ] **Step 3: Check scrolling on the phone**

1. Open route preview without a via stop and swipe anywhere inside the card; the whole card should scroll.
2. Add a via stop and swipe over the stop rows, blank card space, and route steps; all areas should scroll the same card.
3. Confirm the title row remains visible with vehicle buttons and close control.
4. Confirm the map remains visible below the card and locate/settings controls remain at bottom-right.
