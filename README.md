# LaneDev Android

LaneDev 的獨立 Android App 專案。這個 repository 只需要 Android Studio、Android
SDK 與 JDK；不包含 React／Vite 網頁原始碼，也不依賴 Node.js 或 Capacitor。

App 使用 Android `WebViewAssetLoader`，從 APK 內安全的 HTTPS 本機來源載入已編譯
LaneDev 資源。導航、道路資料、MapLibre、TDX 與 UI 都包含在 APK 中；網路只用於
原本就需要的地圖服務或搜尋 API。

## 開發與建置

用 Android Studio 開啟此資料夾，等待 Gradle Sync，選擇手機或模擬器後按 Run。

PowerShell 建置 debug APK：

```powershell
.\tools\gradle.ps1 assembleDebug
```

執行 JVM 單元測試：

```powershell
.\tools\gradle.ps1 testDebugUnitTest
```

APK 輸出：`app/build/outputs/apk/debug/app-debug.apk`。

## 從網頁專案更新 App 畫面

Android 專案可以單獨建置；只有要吸收新版網頁功能時，才需要另外存在的 LaneDev
網頁來源。先在網頁專案執行 Android 相對路徑建置，再匯入：

```powershell
cd C:\code\LaneDev-android
npm run build:android

cd C:\code\LaneDev-android-app
.\tools\import-web-assets.ps1 -WebProject C:\code\LaneDev-android
```

匯入後應提交 `app/src/main/assets/public`，因此任何人只 clone 本 Android repository
也能建置，不需要取得網頁 repository。

## 權限與限制

- 使用網路、前景粗略／精確定位與喚醒權限。
- 外部頁面交由手機瀏覽器開啟，不在 App WebView 中載入。
- 禁止 WebView file/content 存取與 HTTP mixed content。
- APK 沒有桌面 Vite 寫檔 API；道路資料修改仍在網頁開發工具完成後再匯入。
- API 金鑰不可直接提交；公開客戶端金鑰仍須在服務端設定 API／來源限制。
