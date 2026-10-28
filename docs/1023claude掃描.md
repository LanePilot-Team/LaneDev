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

## 修復過程中新發現

- **L9 路線車道判定認不出「機車左轉專用」**：`graph.ts` laneTransitionPlan 比對字串寫成「機慢車左轉專用道」，
  資料（5 筆）與其他程式都是「機車左轉專用」。機車在這類路口左轉被判違規而繞路
  （實測後昌路 way 23683301：繞 1,875 m → 修正後直接左轉 111 m）。
- **T1 `tools/*.ps1` 是無 BOM 的 UTF-8**：Windows PowerShell 5.1 以系統碼頁（Big5）讀取，中文字串變亂碼，
  `import-web-assets.ps1` 直接解析失敗、`gradle.ps1` 錯誤訊息亂碼。

## 10/28 實機測試追加

- **S6 路線規劃就畫進對向車道（實測，德民路）**：`couplet.ts` 合併時，交叉路接在 drop 側的路口 node
  若離 keep 既有頂點 < 4 m，會被改名成 keep node，但新座標只登記在舊 id，座標傳播用改名後的 id 查不到，
  交叉路端點留在 drop 側舊位置（`mergeCouplets` 步驟 3 與 `absorbSideWays` 同一模式）。
  全路網 21 個 node 在不同路上座標差 10–27 m，集中在德民路兩側。德民路×外環西路差 18 m：路線中心線從
  舊點斜拉 212 m，左轉後藍線在中心線左側 −8.8 m（機車 −4.2 m），雙黃線斜切過藍線。與 S1 無關（不需 GPS）。
- **S7 偏航重規劃後像 GPS 斷線（實測，數十秒無定位）**：重規劃後 `runGpsNav(true)` 會 `clearWatch`
  再 `new GpsDriver` 重新 `watchPosition`。Android WebView 在所有監聽清掉時關閉定位 provider，
  重新註冊（高精度）等於冷啟動，手機上數十秒等不到下一筆定位；手動重開 GPS 只會稍微恢復。
  另外路線搜尋在 GPS callback 內同步執行（桌機偏航起點 p50 356 ms／p90 1.26 s，手機數倍），
  冷卻用 fix 時間戳記算、不含計算時間，偏離狀態下會「卡幾秒 → 3 筆後又重算」循環。

## 修復狀態

| 編號 | 狀態 | 說明 |
|---|---|---|
| S1 | ✅ 已修 | `routeDetailed` 新增 `startBearing`，偏航重規劃傳 GPS 平滑方位。真實路網 600 點重測：起步方向錯誤 40–46% → 0–1.7%（剩餘為誤差大到落在別條路） |
| S2 | ⚠️ 部分 | binary heap、放寬可達預檢（真正不連通時免掃全圖）、跨查詢轉向判定快取。120 條路線結果逐條與舊版相同；重規劃情境快約 1.3–3 倍。根因是啟發函式以 90 km/h 估、幾乎掃全圖，要徹底解決需把路線計算移到 Web Worker（架構變更，待決定） |
| S3 | ✅ 已修 | 停車保底抵達改為「最後一段 + 剩 35 m 內」 |
| S4 | ✅ 已修 | 倒退超過 30 m（大於貼合容許的 25 m）才視為換路線 |
| S5 | ✅ 已修 | near/now 轉向與抵達語音 priority → 原生 QUEUE_FLUSH 且不受上限丟棄；重規劃只清測速紀錄不 stopSpeech。**本機無 Android SDK，Java 未經 Gradle 編譯驗證** |
| L1 | ✅ 已修 | 新增 `bannerActionText`，看板與語音同一套判斷 |
| L2 | ✅ 已修 | 新增 `thenText`，看板與語音共用 |
| L3 | ✅ 已修 | 重規劃失敗訊息保留到成功或回到路線上 |
| L4 | ✅ 已修 | 尚未取得定位前失敗：顯示「重試」，「結束」退回規劃且保留路線 |
| L5 | ✅ 已修 | `mergeRoutes` 記錄 `viaDistM`，重規劃依序繞經未到的停靠點 |
| L6 | ⏸ 未修 | 邊成本模型（maxspeed、路口延遲）會改變路線結果，需另行討論與驗證 |
| L7 | ⏸ 不改 | 重新評估：主執行緒本來就需要建築資料做遮擋判斷，worker 載入是為了不讓繪圖解析卡主執行緒，多的只是一次本機檔案讀取 |
| L8 | ✅ 已修 | 新增 `useClientValue` selector；HUD 只訂閱語音開關，定位標記直接改 DOM |
| L9 | ✅ 已修 | 共用常數 `MOTO_LEFT_TURN_MARK`；專用道左轉車道定位靠外側，回報 twoStage 仍為真實值 |
| 死碼 | ✅ 已修 | 刪除 edit/、importFlow、editorMerge、mergedJunctions、roadMergeReload、transit、模擬 Driver；MapCore 精簡為唯讀介面；開 `noUnusedLocals` |
| 測試 | ✅ 已修 | 相對 import 統一帶副檔名；`npm test` 改跑全部（274 項全過；刪除的是編輯器專屬測試） |
| repo 整理 | ⚠️ 部分 | 根目錄 node_modules／dist／.gstack／tsbuildinfo 已停止追蹤並加入 .gitignore；**歷史紀錄仍含這些檔案**，要瘦身需改寫遠端歷史，由使用者決定 |
| T1 | ✅ 已修 | `tools/*.ps1` 加 UTF-8 BOM |
| FileProvider／磁偏角 | ⏸ 未修 | 無法在本機編譯 Android，未動 manifest |
| S6 | ✅ 已修 | 改名時連 keep node 的座標一起登記（兩處）。錯位 node 21 → 0；德民路左轉後藍線 +1.6 → +4.8 m（機車 +8.5 m）。`build-runtime.mjs` 加建置期檢查：同一 OSM node 各路座標差 > 1 m 即建置失敗 |
| S7 | ✅ 已修（待實機） | 重規劃改 `GpsDriver.replaceRoute`，定位監聽不中斷；偏離觸發後延 100 ms 才算路線（先畫出跟著實際定位的那一幀）；冷卻從算完起算 = max(5 s, 耗時 × 4)，連續重規劃未回到路線上每次加倍、上限 30 s（`nav/rerouteClock.ts`）。路線計算本身仍在主執行緒（見 S2） |

## 驗證

- `npm ci --ignore-scripts`、`npm test`（274/274）、`npm run build`（含建置期 24 組路線還原比對）通過。
- 預計算道路／待轉區／導航資料檔的內容雜湊與修改前完全相同；官方資料保留原始位元組（匯入時產生的換行差異已還原）。
- `tools/import-web-assets.ps1` 匯入成功。
- 未驗證：Gradle `assembleDebug`／`testDebugUnitTest`（本機無 Android SDK）、實機 GPS 導航與語音。
- 10/28（S6／S7）：`npm test` 277/277、`npm run build` 通過（含新的 node 座標一致性檢查）；預計算路網因 S6
  重新產生（navigation `913fee5f…` → `4b43897f…`），APK 內導航檔 sha256 與 manifest 一致、錯位 node 0；
  官方資料保留原始位元組。S7 未經實機驗證。
