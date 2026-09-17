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

## 修改前端

所有修改都在本 Git 工作區。可維護來源在 `web-source/`，來自原版
`64a1fd8`，已調整成 Android 用戶端。修改來源後執行：

```powershell
.\tools\build-client.ps1
.\tools\gradle.ps1 assembleDebug
```

此步驟需要 Node.js（建議 22.18+）。它會安裝 lockfile 依賴、測試、建置、
排除開發版模組與大眾運輸資料，再匯入 `app/src/main/assets/public`。
將來源與打包結果一起提交。只建 APK 的人不需執行前端建置。

匯入工具要求 `client-policy.json` 並驗證 JavaScript 雜湊，拒絕直接匯入
未經用戶端處理的網頁開發版。原有官方道路／待轉區資料保留為唯讀導航輸入；
舊版手機 localStorage 的編輯不再套用。

## 用戶端功能

- 首次啟動要求定位權限；請選擇精確位置。GPS 總開關須由使用者在系統設定開啟。
- 「目前位置」以藍點顯示位置、扇形顯示手機朝向；無可靠方向時隱藏扇形。
- 主畫面搜尋目的地後按「路線」，預設取得目前起點；起點、終點與停靠點皆可直接搜尋替換，汽／機車在路線面板切換。
- 搜尋顯示完整來源地址；缺漏時由 Android Geocoder 查詢並標示「附近地址」，無服務／離線時明確標示缺漏，不以類型代替地址。
- 導航僅使用 GPS，沒有模擬、錄影展示、速度倍率、道路編輯或資料匯入操作。
- 語音使用 Android 原生 TextToSpeech。優先離線中文聲音，若只有網路中文聲音則明確顯示需要網路。
  使用「設定 → 下載中文語音」下載；「系統語音設定」選擇引擎，返回時重新初始化。
  「試聽中文」獨立於導航語音開關，顯示引擎播放結果與媒體音量；音量鍵調整媒體音量。
- 畫面使用簡短指令，語音保留完整車道與轉向文案。
- 「設定 → 導航視距」可選 16–22，保存設定並套用至置中與重規劃。
- 方向感測器在前景啟用，低速時用手機朝向；無可用方向資料時沿用路線方向。
- 大眾运輸圖層、資料、交通場站／共享單車搜尋結果已排除，停車場和其他地標保留。

真實磁場方向、各廠牌語音引擎與道路行駛仍須實機驗證。
其他已發現但未修改的問題見 `docs/CLIENT_REVIEW.md`。
## 啟動診斷

地圖初始化各階段記錄在 WebView 的 Performance measures（名稱 `lanedev-boot:*`）
及 logcat 的 `[startup]`。目前每次啟動會在手機重建道路幾何、導航圖、待轉區與地面標線。
2026-09-17 模擬器量測約 34.3 秒，數據與後續優化建議見 `docs/CLIENT_REVIEW.md`；本次未改動計算演算法。
