# LaneDev Android 用戶端

在 Android Studio 開啟本資料夾，Gradle Sync 後選取裝置並執行 app。
一般 APK 建置只需要 Android SDK 36 與 Android Studio 內建 JDK 21，
不需要 Node.js，也不需要另一份網頁專案。

## 建置

```powershell
.\tools\gradle.ps1 assembleDebug
.\tools\gradle.ps1 testDebugUnitTest
```

APK：`app/build/outputs/apk/debug/app-debug.apk`。

## Google Maps API Key（本機 Demo）

Android APK 建置時，請把組員提供的「已限制」Key 放在工作區根目錄的
`local.properties`；這個檔案已被 Git 忽略，不要把 Key 貼到程式碼、README 或對話中：

```properties
sdk.dir=C:\\Users\\你的帳號\\AppData\\Local\\Android\\Sdk
GOOGLE_MAPS_API_KEY=AIzaSy...
```

接著重新建置 APK：

```powershell
.\tools\gradle.ps1 assembleDebug
```

建置時 Android 會把 Key 注入 APK 內的 WebView 首頁；安裝到手機後不需要攜帶
`local.properties`。這只是 Demo 的便利做法，APK 內的 client-side Key 仍可能被取出，
所以 Google Cloud 至少要設定 API 限制，並使用專門給這個 Demo 的 Key。

注意：目前搜尋使用的是 WebView 內的 Maps JavaScript API／Places API (New) Text Search，
不是原生 Maps SDK；因此 Google Cloud 需要啟用 Maps JavaScript API 與 Places API (New)，
不需要另外啟用 Places UI Kit。Google 官方指出，APK 內的 bundled WebView 資源可能不會送出可供網站限制
判斷的 `Referer`；因此 Android app 限制（套件名稱
`tw.lanepilot.lanedev` 與目前 Debug SHA-1）不保證能單獨限制這條 JavaScript 呼叫鏈。
若組員加上 Android restriction 後搜尋失敗，這是 API 平台限制，不是 Key 注入失敗；
屆時要改用適合 WebView 的專用限制策略，或將 Maps／Places 改成原生 SDK／後端代理。

若只在 `web-source` 瀏覽器開發伺服器測試，可另外建立未追蹤的 `web-source/.env.local`：

```properties
VITE_GOOGLE_MAPS_API_KEY=AIzaSy...
```

## 修改前端

所有修改都在本 Git 工作區。可維護來源在 `web-source/`，來自原版
`64a1fd8`，已調整成 Android 用戶端。修改來源後執行：

```powershell
.\tools\build-client.ps1
.\tools\gradle.ps1 assembleDebug
```

此步驟需要 Node.js（建議 22.18+）。它會安裝 lockfile 依賴、測試、預計算唯讀路網及繪圖資料、建置、
排除開發版模組與大眾運輸資料，再匯入 `app/src/main/assets/public`。
將來源與打包結果一起提交。只建 APK 的人不需執行前端建置。

`npm run build` 會先執行 `tools/build-runtime.mjs`（本機約 45–50 秒），
產生 `public/data/runtime`，並比對 24 組汽機車路線、圖結構與高架高度。
這段計算在開發電腦執行，不是在安裝時或手機啟動時執行。
來源、演算法與生成工具的雜湊會一併記錄；舊成品或校驗不符會拒絕打包／匯入。
`public/data/runtime` 是可重建中間產物，不提交；Android assets 內的成品必須提交。

匯入工具要求 `client-policy.json` 並驗證 JavaScript 雜湊，拒絕直接匯入
未經用戶端處理的網頁開發版。原有官方道路／待轉區資料保留為唯讀導航輸入；
舊版手機 localStorage 的編輯不再套用。

## 用戶端功能

- 首次啟動要求定位權限；請選擇精確位置。GPS 總開關須由使用者在系統設定開啟。
- 「目前位置」以藍點顯示位置、扇形顯示手機朝向；無可靠方向時隱藏扇形。
- 主畫面搜尋目的地後按「路線」，預設取得目前起點；起點、終點與停靠點皆可直接搜尋替換，汽／機車在路線面板切換。
- 搜尋顯示完整來源地址；缺漏時由 Android Geocoder 查詢並標示「附近地址」，無服務／離線時明確標示缺漏，不以類型代替地址。
- 正式導航使用 GPS；debug APK 額外提供開發模擬導航，可沿已計算路線以 1x／2x／4x／8x 測試 HUD、鏡頭、車道與語音，release APK 不顯示模擬入口。
- 車輛及鏡頭以真實定位點之間的路線插值平滑更新，最長約一秒追上定位點；不以車速外推位置。
  定位中斷、弱訊號或切到背景時停止動畫，恢復後等待新定位；手動拖圖不會停止車輛更新。
- 語音使用 Android 原生 TextToSpeech。優先離線中文聲音，若只有網路中文聲音則明確顯示需要網路。
  使用「設定 → 下載中文語音」下載；「系統語音設定」選擇引擎，返回時重新初始化。
  「試聽中文」獨立於導航語音開關，顯示引擎播放結果與媒體音量；音量鍵調整媒體音量。
- 畫面與語音皆使用簡短指令；語音保留必要轉向、待轉區及變道安全提醒，可在設定關閉。
- 「設定 → 導航視距」可選 16–22，保存設定並套用至置中與重規劃。
- 方向感測器在前景啟用，低速時用手機朝向；無可用方向資料時沿用路線方向。
- 大眾运輸圖層、資料、交通場站／共享單車搜尋結果已排除，停車場和其他地標保留。

真實磁場方向、各廠牌語音引擎與道路行駛仍須實機驗證。
其他已發現但未修改的問題見 `docs/CLIENT_REVIEW.md`。
## 啟動診斷

地圖初始化各階段記錄在 WebView 的 Performance measures（名稱 `lanedev-boot:*`）
及 logcat 的 `[startup]`。現在直接讀取預計算道路、待轉區、標線、導航圖與高架高度；
汽機車路線及偏航重規劃仍按需計算。字型在本機生成，不等待外部字型服務。
載入錯誤／校驗失敗顯示重試並禁止導航，不退回手機端大量計算。
2026-09-26 同一模擬器：舊版 WebView 啟動至路網可用約 26.3 秒，預計算版約 6–7 秒；
離線亦通過。這不是所有實機的秒數／幀率保證。詳細驗證見 `docs/PERFORMANCE_ASSESSMENT.md`。
