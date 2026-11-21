# LaneDev iOS（前景導航）

LaneDev 使用 WKWebView 從 `lanedev://app` 載入內建前端及預計算路網。位置由 Core Location 提供。最低部署目標為 **iOS 16.4**，本次操作環境為 iPhone 17 Pro Simulator（iOS 26.3.1）及 iPhone 12（iOS 18.3）。

## 從原始碼重建

準備完整的 Xcode、iOS SDK、所需的 Simulator runtime、Git、Node.js（建議 22.18+）和 npm。本次交付使用 Xcode 26.2、Node 26.0.0 與 npm 11.12.1。在全新 Mac 可先開啟 Xcode 完成首次設定，並在 Xcode「Settings → Components」安裝 iOS Simulator runtime。 [Apple 的 Xcode 命令列工具](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference) · [Xcode 元件安裝](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)

```sh
git clone --branch feat/ios-navigation https://github.com/LanePilot-Team/LaneDev.git
cd LaneDev
xcode-select -p
xcodebuild -version
node --version
node ios/tools/build-web.mjs
xcodebuild -resolvePackageDependencies -project ios/LaneDev.xcodeproj \
  -scheme LaneDevRelease -derivedDataPath ios/.build \
  -clonedSourcePackagesDirPath ios/.build/SourcePackages
open ios/LaneDev.xcodeproj
```

使用包含第九階段內容的修訂版本。第一個 Node 指令在 repository 根目錄執行，依序處理以下工作。修改共用來源後重新執行它。

| 工作 | 工具與輸出 |
| --- | --- |
| 安裝依賴、共用回歸 | 在 `web-source/` 執行 `npm ci --ignore-scripts` 及 `npm test`。 |
| 產生路網 | `web-source/tools/build-runtime.mjs` 將唯讀道路與待轉區生成至 `web-source/public/data/runtime/`，包含路由圖、繪圖資料、校驗值及 24 組路線比對。 |
| 編譯及封裝 | TypeScript 型別檢查後，以 Vite `ios` 模式生成 `web-source/.ios-dist/`，由 `web-source/tools/package-client.mjs ios` 校驗版本、路網及模組，產生 `client-policy.json`。 |
| 同步 | `node tools/sync-web-assets.mjs ios` 將成品校驗後同步至 `ios/.web/public/`。Xcode 的兩個 scheme 均使用這份資產。 |
| Swift 套件 | Xcode 採用專案的 `Package.resolved`，解析固定版 GooglePlacesSwift 10.15.0。 |

## iPhone 17 Pro Simulator Release

獨立 Simulator 成品用於地圖、搜尋、手勢、偏航等回歸，由 Simulator 的 Core Location 提供測試位置。此組態可直接建置與安裝，開發 Team 和 Google 金鑰可留空。

```sh
xcrun simctl list devices available
xcrun simctl bootstatus "iPhone 17 Pro" -b
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDevRelease -configuration Release \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=latest' \
  -derivedDataPath ios/.build/stage9-standalone \
  -clonedSourcePackagesDirPath ios/.build/SourcePackages \
  -hideShellScriptEnvironment CODE_SIGNING_ALLOWED=NO LANE_IOS_GOOGLE_PLACES_API_KEY= build
node ios/tools/audit-app.mjs ios/.build/stage9-standalone/Build/Products/Release-iphonesimulator/LaneDev.app
xcrun simctl install "iPhone 17 Pro" ios/.build/stage9-standalone/Build/Products/Release-iphonesimulator/LaneDev.app
xcrun simctl launch "iPhone 17 Pro" tw.lanepilot.lanedev.ios
```

## iPhone 12 實機 Release

1. 用可傳資料的 USB 線接上並解鎖 iPhone，完成信任與 Xcode 配對。到「設定 → 隱私權與安全性 → 開發者模式」啟用，依提示重開並確認。 [Apple 的 Developer Mode 說明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
2. 在 Xcode「Settings → Accounts」登入 Apple Account。用有權註冊 `tw.lanepilot.lanedev.ios` 的 Team，自動產生 Apple Development 憑證與包含該 iPhone 的開發佈建描述檔。將 Team ID 放在已忽略的 `ios/Signing.local.xcconfig`。可在 Xcode 的 `LaneDev` target「Signing & Capabilities」查看自動簽章設定。若採用自有 Bundle ID，命令中的 Bundle ID 和 Google 金鑰限制也須對應調整。 [Apple 的實機簽章步驟](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)

```xcconfig
DEVELOPMENT_TEAM = YOUR_TEAM_ID
```

連線裝置在 Xcode 或 `devicectl` 可能顯示使用者自訂名稱。從 `-showdestinations` 中找出這支 iPhone 12 的 `id`，填入下方的環境變數。

```sh
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDevRelease -showdestinations
xcrun devicectl list devices
LANE_IPHONE_UDID='<iPhone 12 的 id>'
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDevRelease -configuration Release \
  -destination "platform=iOS,id=$LANE_IPHONE_UDID" \
  -derivedDataPath ios/.build-device/stage9-standalone \
  -clonedSourcePackagesDirPath ios/.build/SourcePackages \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration -hideShellScriptEnvironment build
LANE_RELEASE_APP=ios/.build-device/stage9-standalone/Build/Products/Release-iphoneos/LaneDev.app
node ios/tools/audit-app.mjs "$LANE_RELEASE_APP"
codesign --verify --deep --strict "$LANE_RELEASE_APP"
xcrun devicectl device install app --device "$LANE_IPHONE_UDID" "$LANE_RELEASE_APP"
xcrun devicectl device process launch --device "$LANE_IPHONE_UDID" tw.lanepilot.lanedev.ios
```

若首次顯示開發者尚未受信任，讓 iPhone 連網並到「設定 → 一般 → VPN 與裝置管理」依畫面確認信任。開啟 App 後點「目前位置」，選「使用 App 期間允許」並開啟精確位置。 [Apple 的開發者信任步驟](https://help.apple.com/xcode/mac/current/en.lproj/dev96a12fb84.html)

這份 Release 使用開發簽章，供已佈建 iPhone 安裝與驗收。TestFlight 或 App Store 發佈需要發佈簽章、Archive 與 App Store Connect 流程。若要在 Xcode 進行一般開發，選 `LaneDev` scheme（Debug）和這支 iPhone，再按 `⌘R`。 [Apple 的發佈流程](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)

真機驗證可在路網外使用本地地標和手動起點，並另外讀取 iPhone 的實際位置。先在 LaneDev 點「目前位置」完成授權，保持裝置解鎖，再執行以下 XCTest。測試只輸出定位耗時與水平精度。

```sh
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDev \
  -xcconfig ios/Signing.local.xcconfig -destination "platform=iOS,id=$LANE_IPHONE_UDID" \
  -derivedDataPath ios/.build-device/physical-tests \
  -clonedSourcePackagesDirPath ios/.build/SourcePackages \
  -allowProvisioningUpdates -hideShellScriptEnvironment \
  -only-testing:LaneDevTests/ForegroundNavigationTests/testDeviceOfflineRoutePreview \
  -only-testing:LaneDevTests/ForegroundNavigationTests/testDeviceCoreLocationFix \
  -only-testing:LaneDevTests/ForegroundNavigationTests/testNativeSpeechCallbacks test
```

以 Release 驗證真機啟動及常用地點可執行以下命令。計時從 XCTest 呼叫啟動至「目前位置」按鈕啟用。

```sh
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDevRelease -configuration Release \
  -xcconfig ios/Signing.local.xcconfig -destination "platform=iOS,id=$LANE_IPHONE_UDID" \
  -derivedDataPath ios/.build-device/stage9-release-tests \
  -clonedSourcePackagesDirPath ios/.build/SourcePackages \
  -allowProvisioningUpdates -hideShellScriptEnvironment -parallel-testing-enabled NO \
  -only-testing:LaneDevUITests/ForegroundUITests/testReleaseStartupTiming \
  -only-testing:LaneDevUITests/ForegroundUITests/testTapSavedPlaceShortcutsWithKeyboardOpen test
```

## Simulator 回歸

先啟動測試用 iPhone Simulator。用 `LANE_SIMULATOR_UDID` 可指定裝置。以下工具以 App 外的 XCTest 與 `simctl` 驗證 Core Location、搜尋、重規劃、拒絕授權與前景返回。測試組態會清空 Google Places 金鑰，結果位於 `ios/.build/test-results/`。

```sh
node ios/tools/test-simulator.mjs debug
node ios/tools/test-simulator.mjs system
node ios/tools/test-simulator.mjs release
node ios/tools/test-simulator.mjs denied
```

要查離線地圖資產與手勢可用 `map` 或 `release-map`。測試會在結束時清除 OS 測試軌跡，並恢復測試 App 的定位授權。對獨立 `xcodebuild build` 產生的 `LaneDev.app` 執行 `node ios/tools/audit-app.mjs <App 路徑>`，核對實際資源位元組、原生主程式與測試排除。Xcode 的 `build-for-testing` 會在 Debug 測試宿主加入 XCTest 插件，稽核出貨成品時使用獨立 build。

## App 執行時的網路需求

| 功能 | 網路需求 |
| --- | --- |
| 啟動、地圖、路網、本地地標及常用地點 | 直接使用 App 內建資源與本機儲存。可關閉 Mac 的 Vite 或其他開發伺服器。 |
| 路線預覽與前景導航 | 使用包內路網。手動選點可直接規劃；目前位置起點與行進更新需要有效的 Core Location 位置。 |
| 中文語音 | 使用已安裝的 iOS 中文聲音。缺少聲音時，下載系統聲音需要網路。 |
| Google Places、地址反查 | Google Places 須連網及有效 iOS 金鑰。系統地址反查取決於網路及 Apple 的服務可用性，查不到時保留內建地址或座標。 |
| 首次重建、裝置佈建 | npm、Swift 套件與 Xcode runtime 首次下載需要網路。初次配對後的程式簽章或開發者信任也可能需要連線至 Apple。 |

路線預覽中的「更換」可搜尋地點；點「在地圖上選」可直接設定該站。停靠點以下方的上移、下移調整順序，預覽使用同一份道路限制重新計算。

## 語音、定位與前景導航

- 「設定 → 語音設定」可試聽、停止語音與重新檢查。關閉「語音導航」會停止現有播報，並關閉後續自動播報。試聽仍可手動啟動。缺少中文聲音時，可按「iOS 語音說明」，依系統版本到「設定 → 輔助使用 → 朗讀與語音／語音內容」下載中文聲音。 [Apple 聲音下載指引](https://support.apple.com/zh-tw/111798)
- 「設定 → 定位與方向 → App 定位權限」開啟 LaneDev 的 iOS 設定。規劃目前位置和前景導航需要允許使用 App 期間定位並開啟精確位置。若整部手機關閉定位，可按「iOS 定位服務說明」查看系統操作路徑。 [Apple 定位服務指引](https://support.apple.com/zh-tw/102647)
- 導航視距、語音開關及常用地點存在 App 本機。導航期間 App 維持亮屏。按「結束」或離開前景後，系統可恢復自動休眠。返回前景會等下一筆有效位置，原本待播語音已清除。WKWebView 重載後需重新規劃。
- App 支援前景導航，離開前景時暫停定位和語音。背景與鎖屏持續導航尚未支援。實際 Home、鎖屏及人工聽音的驗證狀態見[功能驗收表](../docs/ios-port-plan.md#stage9)。

## Google Places（可選）

iOS 從 Swift 呼叫原生 Places UI Kit 的 `PlaceSearchView`。App 只在使用者按「使用 Google Places 搜尋」時提交查詢，結果與來源標示由 Google 元件顯示。LaneDev 只在當次規劃使用選取結果的 Place ID、座標與使用者輸入的查詢文字。iOS 資產不載入 Maps JavaScript API，原生 SDK 的授權使用 App 的 Bundle ID。 [Google iOS UI Kit 設定](https://developers.google.com/maps/documentation/places/ios-sdk/places-ui-kit-get-started) · [Places UI Kit 與非 Google 地圖條款](https://cloud.google.com/maps-platform/terms/maps-service-terms#places-ui-kit)

1. 在已連結帳單帳戶的 Google Cloud 專案啟用 **Places UI Kit API** 和 **Places API (New)**。到「API 和服務 → 憑證 → 建立憑證 → API 金鑰」為 LaneDev 建立一把 iOS 專用金鑰。把應用程式限制設為 **iOS apps**，加入 `tw.lanepilot.lanedev.ios`。API 限制選這兩個服務並儲存。改用其他 Bundle ID 時一併更新限制。 [Google iOS 金鑰設定](https://developers.google.com/maps/documentation/places/ios-sdk/get-api-key)
2. 用 VS Code 開啟或建立 `ios/GooglePlaces.local.xcconfig`，加入下列設定，將 `YOUR_RESTRICTED_IOS_KEY` 換成實際金鑰。此檔案列在 `.gitignore`。

   ```xcconfig
   LANE_IOS_GOOGLE_PLACES_API_KEY = YOUR_RESTRICTED_IOS_KEY
   ```

3. 在 Xcode 開啟 `ios/LaneDev.xcodeproj`，選擇 `LaneDev` 與實體 iPhone，按 `⌘R` 重新建置並安裝。iPhone 連網後輸入地名，點「使用 Google Places 搜尋」，確認清單顯示 Google Maps 來源。選擇有座標的結果後可規劃路線。沒有金鑰時可繼續使用本地地標及常用地點。

GooglePlacesSwift 固定 10.15.0，支援本專案的 iOS 16.4 部署目標。Xcode 第一次解析套件需要網路；解析後 App 啟動與本地搜尋仍使用內建資源。金鑰經 Info.plist 帶入 App，請使用已限制的金鑰並保持本機設定檔不進 Git。第 3 步的線上成功案例需要有效金鑰。 [固定版官方套件](https://github.com/googlemaps/ios-places-sdk/blob/10.15.0/Package.swift)

[第九階段驗收與交付](../docs/ios-port-plan.md#stage9) · [第八階段真機功能證據](../docs/ios-port-plan.md#stage8)
