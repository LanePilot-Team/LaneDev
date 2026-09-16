# LaneDev Android 用戶端

- 所有後续修改留在目前 Git 工作區與分支；不要切換分支或建立另一工作樹。
- 這是用戶端，不是 LaneDev 網頁開發工具。不得重新引入道路／待轉區編輯、資料匯入寫入、Demo、錄影展示、模擬駕駛或播放倍率、大眾運輸功能。
- 僅實作使用者明確要求的問題；另外發現的問題列入 docs/CLIENT_REVIEW.md，未經要求不直接修正。
- web-source 是 64a1fd8 的 Android 客戶端衍生來源。修改來源後重新打包，不手改 minified JS。一般 Android Studio 建置仍只依赖已提交的 APK assets。
- 前端更新：在 web-source 執行 npm ci --ignore-scripts、npm test、npm run build；在根目錄執行 tools/import-web-assets.ps1 -WebProject ./web-source。
- Android 驗證：tools/gradle.ps1 assembleDebug 與 tools/gradle.ps1 testDebugUnitTest；裝置能力變動需在模擬器／實機測試，清楚區分已測試及待驗證項目。
- 保留使用者的 .idea 設定與未提交變動。道路、待轉區的官方內建資料須保留作為唯讀導航輸入。
