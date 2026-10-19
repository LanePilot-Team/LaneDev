# 路線預覽車種標籤與步驟提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓路線預覽的汽車／機車控制恢復圖標加文字，並讓有效路線的步驟預設展開且明確提示使用者向下滑動。

**Architecture:** 保留現有 `PlanPanel` 的 planner 狀態、路線卡固定高度與內部滾動架構，只調整車種按鈕的內容／尺寸與 `details` 的預設狀態及提示文案。CSS 會讓兩個車種選項仍在標題列同一行，不重新佔滿整張卡片。

**Tech Stack:** React 19、TypeScript 6、Vite 8、既有 CSS、Android WebView assets、Gradle debug APK。

## Global Constraints

- 汽車／機車仍呼叫既有 `planner.toggleProfile('pick')`。
- 路線步驟仍使用原本的 `ManeuverList` 與 `planner.routeRef.current`。
- 不更換路線計算、路網、定位、搜尋或導航資料流。
- 不 push、建立 PR 或 merge；保留工作區中其他既有未提交變更。

---

### Task 1: Update the route preview controls

**Files:**
- Modify: `web-source/src/plan/PlanPanel.tsx:58-114`
- Test: `web-source/package.json` existing `npm test` and `npm run build`

**Interfaces:**
- Consumes: existing `profile`, `planner.toggleProfile`, `routeSummary`, `planner.routeRef.current`, and `ManeuverList`.
- Produces: icon-and-text vehicle buttons and an open-by-default route-step disclosure without changing planner behavior.

- [ ] **Step 1: Restore the compact vehicle labels**

Change only the button contents from icon-only to icon plus text while retaining accessible metadata and the existing profile callback:

```tsx
<button type="button" className={`route-profile-option${profile === 'car' ? ' on' : ''}`}
  aria-label="汽車" title="汽車" aria-pressed={profile === 'car'}
  onClick={() => profile !== 'car' && planner.toggleProfile('pick')}>🚗 汽車</button>
<button type="button" className={`route-profile-option${profile === 'moto' ? ' on' : ''}`}
  aria-label="機車" title="機車" aria-pressed={profile === 'moto'}
  onClick={() => profile !== 'moto' && planner.toggleProfile('pick')}>🛵 機車</button>
```

- [ ] **Step 2: Make route steps discoverable by default**

Replace the existing collapsed disclosure with an open disclosure and an explicit scroll cue:

```tsx
{routeSummary && planner.routeRef.current && <details className="route-steps" open>
  <summary>路線步驟・向下滑動查看更多</summary>
  <ManeuverList route={planner.routeRef.current} profile={profile} />
</details>}
```

The native `<details>` behavior still lets users click the summary to collapse the steps. The steps remain inside `.route-preview-secondary`, so the map is not pushed down.

- [ ] **Step 3: Run the existing web checks**

Run from `web-source`:

```powershell
npm test
npm run build
```

Expected: 50 existing tests pass and Vite/TypeScript build succeeds; existing data-precompute, missing Google Maps environment, chunk-size, or deprecation warnings are non-blocking.

- [ ] **Step 4: Commit only the component change**

```powershell
git add -- web-source/src/plan/PlanPanel.tsx
git diff --cached --check
git commit -m "補回車種文字並展開路線步驟"
```

### Task 2: Fit labelled vehicle controls in the header

**Files:**
- Modify: `web-source/src/App.css:458-468`
- Test: `npm run build` and Android device inspection

**Interfaces:**
- Consumes: existing `.route-profile` and `.route-profile-option` classes from `PlanPanel`.
- Produces: compact equal-width labelled controls that remain beside the hint and close button.

- [ ] **Step 1: Adjust button dimensions for short labels**

Use the following CSS values, keeping the selected state and focus outline:

```css
.route-profile-option {
  display: inline-flex; align-items: center; justify-content: center; gap: 3px;
  min-width: 58px; height: 26px; padding: 0 6px; border: 0; border-radius: 7px;
  background: transparent; color: #718096; font-size: 11px; font-weight: 700;
  line-height: 1; white-space: nowrap; cursor: pointer;
}
```

Keep `.route-profile` as the compact flex container and retain `.on` and `:focus-visible` rules. If the title is too narrow on a very small phone, the existing ellipsis on `.route-preview-head b` must truncate the hint before the vehicle controls wrap.

- [ ] **Step 2: Build and package the web result**

Run:

```powershell
npm run build
```

Expected: the generated CSS contains the labelled compact controls and the build exits with code 0.

- [ ] **Step 3: Commit only the CSS change**

```powershell
git add -- web-source/src/App.css
git diff --cached --check
git commit -m "調整車種文字按鈕寬度"
```

### Task 3: Build and install the Android preview

**Files:**
- Generate through `tools/import-web-assets.ps1`.
- Build `app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 1: Import web assets**

```powershell
& 'C:\Users\Cindy\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\tools\import-web-assets.ps1 -WebProject .\web-source
```

Expected: Android assets update under `app\src\main\assets\public`.

- [ ] **Step 2: Assemble and install the debug APK**

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug
$adb='C:\Users\Cindy\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb -s R5CRA1DK3TE install -r .\app\build\outputs\apk\debug\app-debug.apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $adb -s R5CRA1DK3TE shell monkey -p tw.lanepilot.lanedev 1
```

Expected: Gradle reports `BUILD SUCCESSFUL`, ADB reports `Success`, and the app launches.

- [ ] **Step 3: Check the two requested behaviors on the phone**

1. Open a route with a valid summary and confirm the controls show `🚗 汽車` and `🛵 機車` without taking a full row.
2. Confirm route steps are already visible below the summary and the title says `路線步驟・向下滑動查看更多`.
3. Swipe upward inside the card to read more steps; tap the title to confirm the steps can still collapse.
