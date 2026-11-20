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

Simulator Debug 頂部選「虛擬定位」，先搜尋目的地、規劃、開始導航，再按「沿路線前進」。
固定以每秒定位推進，沒有倍率或另一套導航演算法。「偏航」會移開定位，讓既有核心自行判斷與重規劃。
切換來源需先結束導航，Core Location 與虛擬來源不能同時送資料。虛擬定位不代表真實 GPS 驗證。

實體 iPhone / Release 的虛擬來源、工具列與接收指令全部由條件編譯排除。
**轉入實機階段前仍必須完整刪除** `SimulatorLocationSource.swift`、NavigationViewController／LocationService 的 Simulator 區塊、
`web-source/src/native/platform.ts` 的 LaneSimulator 宣告、useDrive 的兩個 setRoute 接點及相應測試，再重跑驗證與檢查二進位字串。
不能以本輪編譯排除取代後續實際刪除。

只支援前景。離開 App／鎖屏時停止位置與語音並恢復自動休眠；返回前景等待新位置。
未配置 UIBackgroundModes、Always 定位或背景音訊，不保證背景、鎖屏導航。
定位拒絕可由設定 → App 定位權限修正；概略定位會顯示提示。
中文語音使用 iOS 已安裝聲音；下載入口由 iOS 系統管理。
本地 POI、路網與指引可離線；Google 搜尋及反查地址需要網路，缺少資料時顯示座標。

實機簽章需在 Xcode 選自己的 Team 與可用 bundle ID；本工作區沒有配置開發者 Team 或配送簽章。
驗證證據與未完成事項見 `../docs/ios-port-plan.md`。
