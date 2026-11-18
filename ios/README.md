# LaneDev iOS（前景導航）

以 Xcode 26.2 開啟 `LaneDev.xcodeproj`，選 LaneDev scheme 及 iOS Simulator，Build / Run。
第一階段盤點將最低支援基線定為 **iOS 16.4**，與目前 Vite 的 Safari／iOS 16.4 打包目標一致。現有 Xcode／產生器的 deployment target 仍是 16.0，須在下一實作階段對齊；目前沒有 16.x runtime 的操作驗證，不宣稱最低版本已驗收。無第三方原生依賴、無開發伺服器、無本機 HTTP server。
Xcode 直接將已提交的 `../app/src/main/assets/public/` 打包進 App；Android 與 iOS 共用同一份前端與預計算路網。

更新前端：

```sh
cd web-source
npm ci --ignore-scripts
npm test
npm run build
cd ..
node tools/sync-web-assets.mjs
xcodebuild -project ios/LaneDev.xcodeproj -scheme LaneDev -sdk iphonesimulator -configuration Debug -derivedDataPath ios/.build build CODE_SIGNING_ALLOWED=NO
```

已啟動 iPhone Simulator 後，可重跑整合驗證（僅測試需要 Node；App 啟動不需要）：

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
