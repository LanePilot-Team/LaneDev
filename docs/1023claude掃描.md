# 2026-10-23 程式碼全面掃描

範圍：`web-source/`（Android 用戶端前端）與 `app/`（原生殼）。資料標註與實際路況不符者不在此列。
標「實測」者已用預計算路網（`public/data/runtime`）或實跑測試確認；其餘為讀碼判斷。
每項的「狀態」欄在修復後更新。

## 🔴 嚴重：直接造成導航錯誤

### S1. 偏航重規劃約四成接到對向車道（實測）
- 位置：`src/core/graph.ts` `projectToDirectedLanes`／`routeDetailed`；呼叫端 `src/nav/useDrive.ts` `rerouteFrom`。
- 起點行向只依「離哪個方向的車道中心較近」決定，不看車頭方向。
- 實測：600 個雙向道路點，真實位置在順向車道、加 5／10／15 m 隨機 GPS 誤差，
  分別有 40%／46%／45% 被吸到反方向。
- 後果：新路線要求迴轉；藍線在對向但距離只有數公尺，不觸發偏離，車頭與鏡頭翻轉 180°。
- 方向：`routeDetailed` 接受起點方位；重規劃傳 GPS 平滑方位。

### S2. 路線計算過慢且在主執行緒（實測）
- 位置：`src/core/graph.ts` A* 的 open set 以 `Map` 線性掃描取最小值（O(n²)）。
- 桌機 Node：6–8 km 路線 0.3–2.9 s；不可達 5.6–9.7 s（失敗時再整圖搜一次 road-only）。
- 偏航重規劃在 GPS callback 內同步執行，手機上會凍住畫面，每 5 s 冷卻後可能再觸發。
- 方向：binary heap；之後再考慮 Web Worker。

### S3. 停紅燈可能被判定「已抵達」
- 位置：`src/nav/gpsNav.ts` `STOP_ARRIVE_M = 70`、`STOP_HOLD_MS = 6000`。
- 剩餘 < 70 m、車速 < 3 km/h、持續 6 s 即抵達並停止定位；目的地在路口後 70 m 內時停紅燈就會結束導航。

### S4. 同一句轉向語音反覆播報
- 位置：`src/nav/useSpeechGuidance.ts` `resetIfProgressMovedBackwards`（倒退 > 5 m 清空已播紀錄）。
- `mapMatch` 允許倒退 25 m，停車 GPS 抖動即可觸發，「前方 40 公尺，右轉」重講。

### S5. 重要語音可能被丟棄／切斷
- `app/.../NativeServices.java` 佇列達 3 句時直接丟棄**新**句子（通常是最緊急的「現在右轉」）。
- JS `speak(text, priority)` 的 `priority` 原生端從未讀取。
- 每次重規劃 `SpeedCameraVoice.reset()` → `stopSpeech()`，切斷正在播的轉向指示。

## 🟠 邏輯缺陷／不一致

| 編號 | 問題 | 位置 |
|---|---|---|
| L1 | 機車專用左轉道、偏心左轉道：語音說「靠右進入機車左轉道」，看板只顯示「左轉」 | `src/nav/DriveHUD.tsx` TopBanner |
| L2 | 看板「隨後…」不分兩段式，也沒檢查 next2 在 next 之後；語音有 | `src/nav/DriveHUD.tsx` |
| L3 | 重規劃失敗訊息在下一筆定位立刻被 `setGpsMsg(null)` 清掉 | `src/nav/useDrive.ts` |
| L4 | 開始導航時定位授權失敗，只能按「結束」，而結束會清掉整條規劃路線 | `src/App.tsx` `endDrive`、`DriveHUD` |
| L5 | 有中途停靠點時偏航重規劃只導向最後一站（CLIENT_REVIEW 已記錄未修） | `src/nav/useDrive.ts` |
| L6 | 邊成本只看道路等級預設速度，不讀 maxspeed、無路口／號誌延遲，ETA 偏樂觀 | `src/core/graph.ts` `makeEdge` |
| L7 | 建築資料由 MapLibre worker 載一次，又在主執行緒 fetch + parse 一次 | `src/app/mapCore.ts` |
| L8 | 羅盤 5 Hz 更新整包 publish，所有 `useClientState` 元件（含 DriveHUD）跟著重繪；LocateControl 每次重建 interval | `src/native/client.ts`、`LocateControl.tsx` |

## 🟡 死碼與誤導

- 用戶端不可達模組：`src/edit/*`、`src/app/importFlow.ts`、`src/core/{editorMerge,mergedJunctions,roadMergeReload,transit}.ts`
  （仍有測試引用者需一併處理）。
- `MapCore` 保留編輯版介面：`refreshBays`／`redrawRoads`／`replaceBaseMap` 等呼叫即 throw；`Mode` 含 `'edit'`。
- `mapCore.ts` `canvasContextAttributes: false ? ...`（註解稱 ?screenshot 才開，實際永不成立）、多餘 `void 0`。
- `SpeedCameraVoice.enabled` 從未被設定；`DriveHUD` 的 `isDesktop`、`guidanceText`、`bay` 未使用。
- 過時註解：`App.tsx` 開頭（開發版／sync-lanenav）、`useDrive.ts` 兩段疊在一起的 JSDoc 與「否則走模擬」、DriveHUD props 的「再跑一次」「決策按鈕」。
- 開啟 `noUnusedLocals` 時非編輯模組約 25 處未使用。

## 🟡 測試與 repo 整理

- `npm test` 只列 11 個測試檔，另 34 個未執行；全部手動跑 276 項中 267 過，
  9 個檔因正式程式使用無副檔名 import，Node type stripping 找不到模組而無法載入
  （同一份程式混用 `'./laneBase.ts'` 與 `'./roads'`）。
- 本分支歷史追蹤了根目錄 `node_modules/`（6,570 檔、約 203 MB）、根目錄 `dist/`（約 50 MB，含用戶端禁止的 `transit.json`，
  建置流程實際用的是 `web-source/dist`）、`.gstack/`（含本機使用者路徑）、`tsconfig.tsbuildinfo`。
- Android：manifest 宣告未使用的 `FileProvider`；Java 端只有範本測試。
- 方向感測器輸出磁北，未做磁偏角修正（高雄約 4° 以內，影響小）。

## 修復狀態

| 編號 | 狀態 |
|---|---|
| S1 | 待修 |
| S2 | 待修 |
| S3 | 待修 |
| S4 | 待修 |
| S5 | 待修 |
| L1–L8 | 待修 |
| 死碼 | 待修 |
| 測試 | 待修 |
| repo 整理 | 待修 |
