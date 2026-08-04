# 道路捏合範圍、疊層選取與台灣時間實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. 本次依目前協作限制由同一工作階段逐項執行。

**Goal:** 修正捏合道路編輯範圍過度擴張，移植 Anna 的疊層道路選取工具，並將修改歷程以台灣時間顯示。

**Architecture:** 捏合關聯只使用切割後道路的精確 block key、明確捏合邊與 replay 後承載道路建立連通元件，不再用整條 OSM way 的來源節點當作群組依據。疊層選取沿用 Anna 的 MapLibre feature 查詢與循環選取邏輯，但整合到目前分支的編輯器狀態。時間戳維持 ISO UTC 儲存，只在 UI 顯示層轉成 `Asia/Taipei`。

**Tech Stack:** React 19、TypeScript、MapLibre GL、Node test runner、Vite。

---

### Task 1：限制道路捏合編輯範圍

**Files:**
- Modify: `src/core/roadMerge.ts`
- Test: `src/core/roadMerge.test.mjs`

- [x] 新增同一 OSM way 上兩組不相連捏合的失敗測試。
- [x] 確認舊邏輯會把兩組錯誤合併。
- [x] 改用精確 block key、resolved carrier 與明確捏合邊計算群組。
- [x] 執行 road merge 測試確認鏈式 A+B+C 仍可共同編輯、無關路段不受影響。

### Task 2：移植 Anna 疊層道路選取工具

**Files:**
- Create: `src/edit/stackPick.ts`
- Create: `src/edit/stackPick.test.mjs`
- Modify: `src/edit/useEditor.ts`
- Modify: `src/edit/EditPanels.tsx`
- Modify: `src/core/mapStyle.ts`
- Modify: `src/App.css`
- Modify: `package.json`

- [x] 先加入 Anna 的疊層選取測試並確認缺少實作時會失敗。
- [x] 移植精確 `osmId + blockNode` 去重、同位置循環選取與 Ctrl 保持選取邏輯。
- [x] 在地圖上顯示候選道路、目前候選與直接選取面板。
- [x] 保留目前分支既有捏合、導航與道路編輯行為。
- [x] 執行疊層工具測試與 TypeScript 建置。

### Task 3：修改歷程顯示台灣時間

**Files:**
- Create: `src/edit/timeFormat.ts`
- Create: `src/edit/timeFormat.test.mjs`
- Modify: `src/edit/EditPanels.tsx`
- Modify: `package.json`

- [x] 新增 UTC 轉台灣時間與無效值測試。
- [x] 實作 `Asia/Taipei` 顯示格式並標示 UTC+8。
- [x] 保留 journal 內原始 UTC ISO 時間戳。

### Task 4：整體驗證與資料保護

**Files:**
- Verify only: `public/data/road_database.json`

- [x] 執行相關單元測試、完整測試與 production build。
- [x] 比對 git diff，確認未納入 Anna 或使用者的道路資料。
- [x] 啟動本機驗收環境並提供從舊行為到新行為的具體說明。
