# 導航 HUD 語音指引設計 / Navigation HUD Voice Guidance Design

**日期 / Date:** 2026-08-18  
**基線 / Base:** `origin/main` at `e6cfb56`  
**分支 / Branch:** `codex/navigation-voice-guidance`  
**狀態 / Status:** 待使用者審閱 / Pending user review

## 1. 目標 / Goal

### 繁體中文

讓 LaneDev 目前導航 HUD 的指引文字可以同步以繁體中文語音播放，涵蓋模擬駕駛與真 GPS 導航。語音必須使用和 HUD 相同的路徑、轉向、車道與兩段式左轉資料，避免畫面與聲音分歧。

第一版使用瀏覽器內建 Web Speech API，不新增音檔、不呼叫第三方雲端 TTS、不需要 API key。瀏覽器或作業系統沒有可用語音時，導航仍須正常運作。

### English

Add Traditional Chinese spoken guidance to the existing LaneDev navigation HUD for both simulated driving and live GPS navigation. Speech must consume the same route, maneuver, lane, and two-stage-turn data as the HUD so visual and spoken guidance cannot diverge.

The first version uses the browser's built-in Web Speech API. It adds no audio assets, makes no third-party cloud TTS request, and requires no API key. Navigation must continue to work when speech synthesis is unavailable.

## 2. 現況與約束 / Current Context and Constraints

### 繁體中文

- 最新 `main` 已是扁平化專案結構，導航程式位於 `src/nav/`。
- `src/nav/DriveHUD.tsx` 已集中距離階段與 `guidanceText()`；`src/nav/useDrive.ts` 將模擬與 GPS 更新成同一個 `DriveState`。
- `DriveState` 提供 `next`、`next2`、`nextDistM`、`arrived`、`roadLaneGuidance`；`Maneuver` 提供轉向種類、道路名稱、兩段式左轉、機車左轉專用道與偏心左轉道資訊。
- HUD 現有距離階段是 250m、60m、25m；此功能沿用這三個門檻，不另建第二套導航狀態。
- 原本 `main` 工作樹有未提交修改；本分支以最新 `origin/main` 建立隔離 worktree，不帶入那些修改。

### English

- The latest `main` uses the flattened project layout, with navigation code under `src/nav/`.
- `src/nav/DriveHUD.tsx` owns the current distance phases and `guidanceText()`. `src/nav/useDrive.ts` feeds both simulation and GPS into the same `DriveState`.
- `DriveState` exposes `next`, `next2`, `nextDistM`, `arrived`, and `roadLaneGuidance`. `Maneuver` exposes turn kind, road name, two-stage-turn, motorcycle-only left-turn-lane, and offset-turn-bay data.
- The HUD already uses 250m, 60m, and 25m phases. Speech will reuse these thresholds instead of introducing another navigation state machine.
- The original `main` worktree was dirty; this branch is isolated from those changes and is based on the fetched `origin/main`.

## 3. 方案比較與選擇 / Options and Decision

### 方案 A：只在 `DriveHUD` 內直接呼叫語音 / Option A: Call speech directly inside `DriveHUD`

繁中：改動少，但文字組合、瀏覽器 API、去重狀態會全部混在 UI 元件中，測試與後續替換語音引擎較困難。  
English: This is the smallest change, but text composition, browser API access, and deduplication would be mixed into the UI component, making tests and future engine replacement harder.

### 方案 B：純語音 hook 加上獨立文案工具（採用） / Option B: Dedicated text helpers plus a speech hook (Selected)

繁中：把 HUD/語音共用的距離、階段、文案組合抽成純函式；由 `useSpeechGuidance` 管理 `speechSynthesis`、播放佇列與去重，再由 `DriveHUD` 使用同一份 `DriveState` 呼叫。這保留現有 UI 邊界，也能直接測試動態中文文案。  
English: Extract shared distance, phase, and speech-text composition into pure helpers. Let `useSpeechGuidance` own `speechSynthesis`, queue policy, and deduplication, while `DriveHUD` invokes it with the same `DriveState`. This keeps the existing UI boundary and makes dynamic Chinese text directly testable.

### 方案 C：新增第三方 TTS 服務 / Option C: Add a third-party TTS service

繁中：聲音可能較自然，但需要 API key、網路、成本與後端或金鑰保護；超出目前純前端與「先用第 2 種」的範圍。  
English: Voice quality may be better, but this introduces API keys, network dependence, cost, and backend or key protection concerns. It is outside the current pure-frontend scope.

## 4. 設計 / Design

### 4.1 元件與資料流 / Components and Data Flow

```text
DriveState + profile + twoStage
          │
          ▼
shared guidance helpers
  (phase, distance, HUD-derived wording)
          │
          ▼
useSpeechGuidance
  (threshold events, dedup, Web Speech API)
          │
          ▼
window.speechSynthesis → device/browser voice
```

繁中：新增 `src/nav/speechGuidance.ts` 作為無副作用的文案與階段工具，並新增 `src/nav/useSpeechGuidance.ts` 管理瀏覽器播放。`DriveHUD.tsx` 只負責把目前已收到的導航資料傳入 hook；不在 `useDrive` 內另造語音狀態，確保模擬與 GPS 共用同一條 HUD 資料流。

English: Add `src/nav/speechGuidance.ts` for side-effect-free wording and phase helpers, and `src/nav/useSpeechGuidance.ts` for browser playback. `DriveHUD.tsx` only passes the current navigation data to the hook. Speech state will not be duplicated inside `useDrive`, so simulation and GPS continue to share one HUD data flow.

為了讓「HUD 與語音同文案」，`guidanceText()` 及其距離門檻會移到共用的 guidance module，再由 `DriveHUD`、`ManeuverList` 與語音工具使用；這是必要的邊界整理，不改變既有視覺文案語意。

To keep HUD and speech text identical, `guidanceText()` and its distance thresholds will move into the shared guidance module, then be consumed by `DriveHUD`, `ManeuverList`, and speech helpers. This is a focused boundary extraction and does not change existing visual wording semantics.

### 4.2 播報時機 / Announcement Timing

| 階段 / Stage | 觸發 / Trigger | 播報重點 / Spoken content |
|---|---|---|
| 開始 / Start | 第一個有效 `DriveState` | `開始導航` |
| 預告 / Far | 每個 maneuver 首次進入 `nextDistM <= 250` 且 `> 60` | `前方 250 公尺後向右轉，請提早變換車道` 類似文案 |
| 接近 / Near | 首次進入 `nextDistM <= 60` 且 `> 25` | 距離、方向與 HUD 的車道提示 |
| 現在 / Now | 首次進入 `nextDistM <= 25` | `現在右轉`、`現在靠右進入待轉區` 等即時動作 |
| 抵達 / Arrived | `drive.arrived === true` 首次成立 | `已抵達目的地` |

繁中：距離超過 250 公尺時不提前播報完整轉向，避免導航剛開始就連續念很遠的路徑。當 `next2` 與目前 maneuver 距離小於 60 公尺時，接近階段可附帶「隨後左轉／右轉」；若語音內容過長，仍以目前 maneuver 為優先。

English: No full turn announcement is made while the next maneuver is more than 250m away, avoiding an early stream of distant instructions. When `next2` is within 60m of the current maneuver, the near announcement may append “then turn left/right”; the current maneuver always takes priority if the sentence would become too long.

### 4.3 文案規則 / Wording Rules

繁中：

- 距離使用 HUD 相同的四捨五入規則；小於 100m 以 10m 為單位，100m 以上以 50m 為單位，超過 1km 使用公里。
- 方向與特殊車道提示直接取自共用 `guidanceText()`；將視覺用的 `・` 轉成語音較自然的停頓。
- 預告階段對需要變換車道的轉向補上「請提早變換車道」；兩段式左轉改為「請提早靠右進入待轉區」。
- 保留道路名稱、左轉專用道、機車左轉專用道、偏心左轉道與兩段式左轉資訊。
- `arrive` maneuver 播放「即將抵達目的地」；真正抵達事件播放「已抵達目的地」。

English:

- Use the same rounding rules as the HUD: 10m increments below 100m, 50m increments at or above 100m, and kilometers above 1km.
- Take direction and special-lane wording from shared `guidanceText()`, replacing the visual `・` separator with a natural spoken pause.
- Add “請提早變換車道” to far-stage turns that require preparation; use “請提早靠右進入待轉區” for two-stage left turns.
- Preserve road names, dedicated left-turn lanes, motorcycle-only left-turn lanes, offset turn bays, and two-stage-turn information.
- Speak “即將抵達目的地” for the `arrive` maneuver and “已抵達目的地” for the actual arrival event.

### 4.4 去重、重規劃與重播 / Deduplication, Reroute, and Replay

繁中：每次播報以「maneuver identity + stage」作為 key。maneuver identity 優先使用 `nodeId`，沒有時使用 `distM + kind`。同一階段不重複播放。若 `DriveState.traveledM` 明顯倒退，視為重播或重新規劃，清除本次 session 的去重集合；導航停止或 HUD 卸載時取消未完成語音。

English: Each announcement is keyed by maneuver identity plus stage. Prefer `nodeId` for identity and fall back to `distM + kind`. The same stage is spoken only once. A clear backward jump in `DriveState.traveledM` indicates replay or rerouting and clears the session dedup set. Stopping navigation or unmounting the HUD cancels unfinished speech.

播放策略採「最新指引優先」：新的 threshold 事件到來時取消尚未完成的舊 utterance，再播放最新指引，避免語音落後於車輛位置。

The playback policy is “latest guidance wins”: when a new threshold event arrives, cancel an unfinished utterance and speak the newest instruction so audio does not lag behind the vehicle position.

### 4.5 瀏覽器限制與錯誤處理 / Browser Constraints and Error Handling

繁中：

- 以 `typeof window !== 'undefined'` 與 `window.speechSynthesis` 檢查支援度；不支援時靜默停用語音，不阻斷 HUD、模擬或 GPS。
- 設定 `SpeechSynthesisUtterance.lang = 'zh-TW'`，優先選擇 `zh-TW` 語音，找不到時仍讓瀏覽器依語言 fallback。
- 第一段語音在導航開始後的第一個有效狀態才播放，避免頁面載入時自動發聲。
- 不儲存錄音、不傳送路名或位置到外部服務。

English:

- Guard with `typeof window !== 'undefined'` and `window.speechSynthesis`; unsupported browsers silently disable speech without blocking HUD, simulation, or GPS.
- Set `SpeechSynthesisUtterance.lang = 'zh-TW'`, prefer a `zh-TW` voice, and let the browser fall back by language when no such voice is installed.
- The first utterance is emitted only after the first valid driving state following navigation start, never on page load.
- No recordings are stored and no road names or positions are sent to an external service.

## 5. 實作範圍 / Implementation Scope

### 繁體中文

預計修改：

1. `src/nav/speechGuidance.ts`：共用 phase、距離與語音文案純函式；抽出目前 HUD 使用的共用文案。
2. `src/nav/useSpeechGuidance.ts`：Web Speech API、語音選擇、threshold 觸發、去重、重播/重規劃 reset、卸載清理。
3. `src/nav/DriveHUD.tsx`：使用共用 guidance helper，接入語音 hook；不改變既有 HUD 版面或導航資料來源。
4. `src/plan/ManeuverList.tsx`：改由共用 guidance module 取得既有轉彎文案。
5. `src/nav/speechGuidance.test.mjs` 與 `package.json`：測試語音階段與文案，納入 `test:all`。

不包含：預錄音檔、第三方 TTS、後端、語音辨識、自然語言重寫引擎、路由演算法改動、HUD 視覺重設計。

### English

Expected changes:

1. `src/nav/speechGuidance.ts`: shared phase, distance, and speech-text pure helpers; extract the existing HUD wording source.
2. `src/nav/useSpeechGuidance.ts`: Web Speech API, voice selection, threshold triggers, deduplication, replay/reroute reset, and unmount cleanup.
3. `src/nav/DriveHUD.tsx`: consume the shared guidance helper and attach the speech hook without changing the existing HUD layout or navigation data source.
4. `src/plan/ManeuverList.tsx`: consume the shared guidance module for existing maneuver wording.
5. `src/nav/speechGuidance.test.mjs` and `package.json`: test speech phases and wording and include the tests in `test:all`.

Out of scope: prerecorded audio, third-party TTS, backend services, speech recognition, a natural-language rewriting engine, route algorithm changes, and HUD visual redesign.

## 6. 驗證與驗收 / Verification and Acceptance

### 繁體中文

- 純函式測試涵蓋 250m、60m、25m 邊界、超過 250m 不播報、兩段式左轉、道路名稱、隨後轉向與抵達文案。
- `npm run test:speech-guidance` 通過。
- `npm run test:all` 通過。
- `npm run build` 通過。
- 瀏覽器手動驗證：模擬導航中每個 maneuver 的 far/near/now 各只播一次，HUD 仍正常更新；GPS 導航沿同一規則播放；結束導航後不再播放舊語音；瀏覽器不支援語音時導航仍可使用。
- 以開發者工具確認沒有語音網路請求、沒有未處理例外，且目前 dirty `main` 工作樹未被修改。

### English

- Pure-function tests cover the 250m, 60m, and 25m boundaries; no speech above 250m; two-stage left turns; road names; subsequent turns; and arrival wording.
- `npm run test:speech-guidance` passes.
- `npm run test:all` passes.
- `npm run build` passes.
- Browser verification confirms that each maneuver's far/near/now stages are spoken once during simulation, HUD updates remain intact, GPS follows the same rules, ending navigation prevents stale speech, and navigation remains usable without speech support.
- Developer tools show no speech network request and no unhandled exception; the existing dirty `main` worktree remains untouched.

## 7. 決策確認 / Decision Checkpoint

本設計已依使用者確認採用 Web Speech API；開始寫入程式碼前，請先審閱此規格文件。  
This design reflects the user's approval of Web Speech API; please review this specification before implementation begins.
