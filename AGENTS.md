# LaneDev Android／iOS 用戶端

- 適用於本工作區的 `web-source/` 共用前端、`app/` Android 用戶端及 `ios/` 原生專案。使用者已授權在目前分支進行 Swift＋WKWebView 的 iOS 移植、本機內建資產、原生定位／語音與前期 Simulator 虛擬導航；此授權不解除下列其他用戶端約束。

- 所有後续修改留在目前 Git 工作區與分支；不要切換分支或建立另一工作樹。
- 這是用戶端，不是 LaneDev 網頁開發工具。不得重新引入道路／待轉區編輯、資料匯入寫入、Demo、錄影展示、模擬駕駛或播放倍率、大眾運輸功能。
  - 例外（dev 限定）：`web-source/src/dev/` 的開發測試工具（`?sim` 地圖點選起終點＋模擬駕駛），只在 `npm run dev` 且網址帶 `?sim` 時生效，必須以 `import.meta.env.DEV` 守住，不得進入 prod build／APK。
  - 例外（iOS 前期、使用者已明確授權）：可提供 Mac iOS Simulator 的虛擬定位／導航工具，僅限 `DEBUG && targetEnvironment(simulator)`；不得進入實體 iPhone 或 Release 的原生執行路徑，不得擴大到 Android 正式包。虛擬與真實定位必須共用原有導航核心，每次只能有一個啟用的定位來源，不得另寫一套模擬用路由、通行或待轉判斷。
  - 進入實體 iPhone 階段前，必須完整刪除 iOS 虛擬來源、工具 UI、橋接指令、共用前端 hook，以及相關虛擬測試／腳本／專案與文件入口，並重跑共用、iOS、Android 驗證；只隱藏 UI 或留著條件編譯區塊不算移除。具體清單維護於 `docs/ios-port-plan.md`。
- 僅實作使用者明確要求的問題；另外發現的問題列入 docs/CLIENT_REVIEW.md，未經要求不直接修正。
- web-source 是 64a1fd8 的 Android 客戶端衍生來源。修改來源後重新打包，不手改 minified JS。一般 Android Studio 建置仍只依赖已提交的 APK assets。
- 前端更新：在 web-source 執行 npm ci --ignore-scripts、npm test、npm run build；在根目錄執行 tools/import-web-assets.ps1 -WebProject ./web-source。
  - Mac 可使用等價的 `node tools/sync-web-assets.mjs` 校驗並匯入共用資產；保留 Windows PowerShell 入口。iOS 與 Android 均須打包已驗證前端及預計算路網，不能依賴 Mac 開發伺服器才能啟動。
  - iOS 前端使用 `node ios/tools/build-web.mjs all` 準備 `ios/.web/`。Xcode 的 Debug Simulator 使用 `ios-simulator` 模式，其餘使用 `ios-release`，兩者都以 `vite build` 產生。以明確模式控制 iOS Simulator 接點，不能用 Xcode Debug 推論 `import.meta.env.DEV`。
- Android 驗證：tools/gradle.ps1 assembleDebug 與 tools/gradle.ps1 testDebugUnitTest；裝置能力變動需在模擬器／實機測試，清楚區分已測試及待驗證項目。
- 保留使用者的 .idea 設定與未提交變動。道路、待轉區的官方內建資料須保留作為唯讀導航輸入。
- iOS 各階段須實際執行適當的檢查／測試／建置／操作驗證，並更新 `docs/ios-port-plan.md` 的完成項目、證據、問題與下一階段；盤點階段不得把既有測試紀錄寫成本輪新執行結果。缺少 key、簽章、runtime 或實體裝置時列出受阻項目，不用 Simulator 結果宣稱實機完成。
- 本輪以 iOS 前景導航為範圍；背景與鎖屏的支援、暫停／恢復及實際驗證須分別說明，不得以 Home 測試當作已驗證鎖屏持續導航。
