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
- 「目前位置」可定位地圖；規劃路線預設取得目前起點，也可切換自訂起終點。
- 導航僅使用 GPS，沒有模擬、錄影展示、速度倍率、道路編輯或資料匯入操作。
- 語音使用 Android 原生 TextToSpeech。優先離線中文聲音，若只有網路中文聲音則明確顯示需要網路。
  沒有中文語音時由「設定 → 安裝／設定中文語音」下載；可試聽或關閉。
- 畫面使用簡短指令，語音保留完整車道與轉向文案。
- 「設定 → 導航視距」可選 16–22，保存設定並套用至置中與重規劃。
- 方向感測器在前景啟用，低速時用手機朝向；無可用方向資料時沿用路線方向。
- 大眾运輸圖層、資料、交通場站／共享單車搜尋結果已排除，停車場和其他地標保留。

真實磁場方向、各廠牌語音引擎與道路行駛仍須實機驗證。
其他已發現但未修改的問題見 `docs/CLIENT_REVIEW.md`。
