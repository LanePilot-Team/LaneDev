# LaneDev iOS（前景導航）

最低目標為 **iOS 16.4**，與 Vite 的打包目標一致。目前操作驗證使用 iOS 26.3.1 Simulator。App 在 WKWebView 從 `lanedev://app` 讀取內建資源。

在 repository 根目錄準備資產。工具會依 lockfile 安裝套件、執行共用測試、預計算路網、建置前端，再驗證雜湊並同步到 `ios/.web/`。可用 `simulator` 或 `release` 只更新一種模式。

```sh
node ios/tools/build-web.mjs all
```

| 共用 Xcode scheme | Xcode 組態／SDK | Vite 模式 | 虛擬定位 |
| --- | --- | --- | --- |
| `LaneDev` | Debug／`iphonesimulator` | `ios-simulator` | 開發用來源選擇及既有手動前進／偏航 |
| `LaneDevRelease` | Release／`iphonesimulator` 或 `iphoneos` | `ios-release` | 排除 Swift 能力與前端接點 |
| `LaneDev`（選實機 SDK） | Debug／`iphoneos` | `ios-release` | 排除 Swift 能力與前端接點 |

兩種 iOS 前端都是 `vite build` 的靜態成品，`import.meta.env.DEV` 在兩種模式均為 `false`。Xcode 依 SDK／組態複製對應的 `public/`，並拒絕模式不符的驗證清單。Android 維持 `npm run build` → `node tools/sync-web-assets.mjs`（或 PowerShell）的正式資產流程。

準備資產後可直接開啟 `ios/LaneDev.xcodeproj`，選 scheme 與 iPhone Simulator 後按 Run。命令列建置、安裝、啟動與截圖如下。若使用其他手機，從 `simctl list devices available` 取代 `LANE_DEVICE`。

```sh
xcrun simctl list devices available
LANE_DEVICE=6CDD24DC-9DEE-4DDD-A9E5-2EAF4E61D981
xcrun simctl bootstatus "$LANE_DEVICE" -b
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDev -configuration Debug \
  -destination "id=$LANE_DEVICE" -derivedDataPath ios/.build build CODE_SIGNING_ALLOWED=NO
xcrun simctl install "$LANE_DEVICE" ios/.build/Build/Products/Debug-iphonesimulator/LaneDev.app
xcrun simctl launch "$LANE_DEVICE" tw.lanepilot.lanedev.ios
xcrun simctl io "$LANE_DEVICE" screenshot /tmp/lanedev-ios.png
```

正式 Simulator 包使用 `-scheme LaneDevRelease -configuration Release`，安裝路徑改為 `ios/.build/Build/Products/Release-iphonesimulator/LaneDev.app`。

關閉 Vite 後，可重跑離線地圖、手勢及重開驗證。Debug 另檢查 WKWebView 資源能力、錯誤及重試。

```sh
node ios/tools/test-simulator.mjs map
node ios/tools/test-simulator.mjs release-map
```

前景導航整合測試可執行下列指令。

```sh
node ios/tools/test-simulator.mjs debug
node ios/tools/test-simulator.mjs release
node ios/tools/test-simulator.mjs denied
```

測試工具會建置、安裝 App、授予／暫時撤銷 Simulator 權限、注入 Core Location 座標，並執行 XCTest／XCUITest。
結果放在 `ios/.build/test-results/`。拒絕授權測完恢復權限，定位情境測完清除。
UI 測試執行器可能重設系統模擬定位，工具在 App 啟動後重設注入路徑；這仍是 Simulator 座標，不是真實 GPS。
`LaneDevRelease` scheme 用於無虛擬工具的 Release 操作驗證。

在 `LaneDev` 的 Simulator Debug 成品上，於頂部選「虛擬定位」。

1. 點「選起終點」，依序點地圖或利用規劃面板的「更換起點」「更換終點」搜尋。路線就緒後點開發面板的「開始」。
2. 以 `1x`、`3x` 或 `8x` 切換播放頻率。「暫停」凍結車輛與模擬時間，「繼續」從原處接續，「結束」清除這一趟的路線和訂閱。
3. 要重現應轉未轉，在已開始前進且轉向前，從「情境」選「保持直行」。重規劃後仍沿當時的行向走。以「結束」回到規劃下一趟。
4. 「停車」送出速度 0，「定位抖動」加入固定的定位誤差。「中斷訊號」停止回傳 fix，但車仍在前進，選「恢復訊號」後送出新的位置。

換倍速時每筆仍是 1 模擬秒、正常行駛仍是 8 m/s。面板顯示模擬秒數與行駛公尺。切換 Core Location 前需先結束導航，或等目前的單次定位結束。

實體 iPhone / Release 的虛擬來源、工具列與接收指令全部由條件編譯排除。
**轉入實機階段前必須完整刪除**虛擬來源、面板、橋接、建置旗標與測試入口。完整盤點見[第四階段移植紀錄](../docs/ios-port-plan.md#第四階段前期虛擬導航)。

只支援前景。離開 App／鎖屏時停止位置與語音並恢復自動休眠；返回前景等待新位置。
未配置 UIBackgroundModes、Always 定位或背景音訊，不保證背景、鎖屏導航。
規劃起點與前景導航需要精確位置。若拒絕授權或僅允許概略位置，請到設定的 App 定位權限允許使用期間定位並開啟精確位置。若整部手機的定位服務已關閉，App 會提示從系統設定開啟。定位恢復後，導航會用新的定位繼續更新。
中文語音使用 iOS 已安裝聲音；下載入口由 iOS 系統管理。
本地地標、常用地點、路線與導航可離線操作。路線預覽中的「更換」可搜尋地點；點「在地圖上選」可直接設定該站。停靠點以下方的上移、下移調整順序，預覽使用同一份道路限制重新計算。

## Google Places（可選）

iOS 從 Swift 呼叫原生 Places UI Kit 的 `PlaceSearchView`。App 只在使用者按「使用 Google Places 搜尋」時提交查詢，結果與來源標示由 Google 元件顯示。LaneDev 只在當次規劃使用選取結果的 Place ID、座標與使用者輸入的查詢文字。iOS 資產不載入 Maps JavaScript API，原生 SDK 的授權使用 App 的 Bundle ID。 [Google iOS UI Kit 設定](https://developers.google.com/maps/documentation/places/ios-sdk/places-ui-kit-get-started) · [Places UI Kit 與非 Google 地圖條款](https://cloud.google.com/maps-platform/terms/maps-service-terms#places-ui-kit)

1. 在有帳單帳戶的 Cloud 專案啟用 **Places UI Kit API** 和 **Places API (New)**，建立獨立的 iOS 金鑰。把應用程式限制設為 **iOS apps**，加入 `tw.lanepilot.lanedev.ios`，API 限制選這兩個服務。改用其他 Bundle ID 時一併更新限制。 [Google iOS 金鑰設定](https://developers.google.com/maps/documentation/places/ios-sdk/get-api-key)
2. 在 `ios/GooglePlaces.local.xcconfig` 加一行設定。此檔案已忽略，由 `GooglePlaces.xcconfig` 選擇性載入，重新建置並安裝 App 後生效。

   ```xcconfig
   LANE_IOS_GOOGLE_PLACES_API_KEY = YOUR_RESTRICTED_IOS_KEY
   ```

3. 裝置連網時輸入地名，點 Google Places。確認原生清單顯示 Google Maps 來源，選擇有座標的結果後可在 LaneDev 規劃。未設定金鑰時，搜尋清單會明示狀態，本地結果仍可選取。

GooglePlacesSwift 固定 10.15.0，支援本專案的 iOS 16.4 部署目標。Xcode 第一次解析套件需要網路；解析後 App 啟動與本地搜尋仍使用內建資源。金鑰經 Info.plist 帶入 App，請使用已限制的金鑰並保持本機設定檔不進 Git。第 3 步的線上成功案例需要有效金鑰。 [固定版官方套件](https://github.com/googlemaps/ios-places-sdk/blob/10.15.0/Package.swift)

實機簽章需在 Xcode 選自己的 Team 與可用 bundle ID；本工作區沒有配置開發者 Team 或配送簽章。
驗證證據與未完成事項見 `../docs/ios-port-plan.md`。
