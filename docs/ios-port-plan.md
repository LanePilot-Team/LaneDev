# iOS 移植計畫與階段紀錄

## 本輪第一階段：環境與移植盤點（2026-11-18）

本節回應本輪「先完成環境與移植盤點」的 8 項要求。工作區仍為 `/Users/wang/Desktop/iosdev/LaneDev`、分支 `feat/ios-navigation`、基底 HEAD `69cbd15`。開始時已有前次移植的未提交程式、資產及 `ios/` 專案；全部保留。本輪只更新規範、盤點文件與證據，不新增或修改 App 功能，不另開分支／worktree。

**第一階段完成；最低版本、儲存、Google 與實機資格仍有下列門檻。** 文末「先前實作與驗證紀錄」是前次工作歷史，不是本輪重新執行的建置／操作結果。特別是先前原生 target 16.0 不代表已驗收 iOS 16.0。

### 1. 已閱讀的規範、來源與打包鏈

適用的 AGENTS 只有根目錄 `AGENTS.md`：已檢查祖先路徑及工作區內的 AGENTS，未發現額外版本。已補入使用者授權的 iOS 適用範圍與前期虛擬導航例外，保留原有同分支、Android 建置、唯讀資料、禁止編輯／匯入／大眾運輸等約束。

| 範圍 | 已閱讀／盤點的入口與責任 |
| --- | --- |
| 說明與既有證據 | `README.md`、`ios/README.md`、`docs/NANZIH_REFERENCE.md`、原移植紀錄及 `docs/ios-evidence/`。根 README 主要描述 Android，不能直接當作 iOS 能力聲明。 |
| React／地圖 | `web-source/package.json`、lockfile、`vite.config.ts`、`tsconfig.json`；`src/App.tsx` 的 browse／pick／drive，`src/app/mapCore.ts` 載入地圖與預計算層。 |
| 共用導航 | `src/core/graph.ts`、`runtimeData.ts`／`runtimeCodec.ts`、`nanzihPreferred.ts`／`nanzihRouteData.json`／`nanzihConnections.ts`；`src/nav/gpsNav.ts`、`useDrive.ts`、定位、車道、偏航與語音測試。原路由、汽機車限制、待轉與參考路線維持共用。 |
| 前端原生介面 | `src/native/client.ts`、`platform.ts`、`ClientSettings.tsx`、`src/nav/geolocation.ts`、`src/places/PlaceAddress.tsx`／`savedPlaces.ts`。 |
| Android 原生 | `app/src/main/java/tw/lanepilot/lanedev/MainActivity.java`、`NativeServices.java`、Manifest 及 Gradle 設定。 |
| 原生 iOS 現況 | `ios/LaneDev/` 的 WK 容器、資源 handler、定位／語音／Scene 生命週期、Bridge、Info.plist，以及專案與產生器；確認為先前已存在的實作。 |
| 建置與唯讀封裝 | `tools/build-client.ps1`、`import-web-assets.ps1`、`gradle.ps1`、`sync-web-assets.mjs`；`web-source/tools/build-runtime.mjs`、`runtime-inputs.mjs`、`package-client.mjs`。正式包排除 dev／編輯／大眾運輸模組並驗證 script／runtime SHA-256；沒有新增資料寫入 endpoint。 |

打包鏈：`npm ci --ignore-scripts` → `npm test` → `npm run build`（prebuild 預計算、tsc／Vite、postbuild 用戶端政策檢查）→ PowerShell 匯入或 Mac 的 `node tools/sync-web-assets.mjs` → Gradle／Xcode 打包。兩個原生平台共用已提交的 `app/src/main/assets/public/`；一般原生建置不需要開 Vite 或重新安裝 Node 套件。`web-source/public/data/runtime/` 是可重建中間產物，APK／App 內的已驗證成品須保留。原始官方資料維持唯讀。

### 2. 本輪實際環境檢查

原始命令與結果：[stage1-inventory.json](ios-evidence/stage1-inventory.json)，擷取時間 2026-11-18 17:11:46（Asia/Taipei）。下表不以歷史結果代替本輪檢查。

| 項目 | 已確認結果 | 限制／尚待確認 |
| --- | --- | --- |
| Mac | macOS 15.7.9（24G830）、arm64。 | Simulator GPU／CPU 結果不能當成 iPhone 效能。 |
| Xcode | `xcode-select -p` 指向 `/Applications/Xcode.app/Contents/Developer`；`xcodebuild -version` 為 26.2（17C52）。 | 部分 sandbox 呼叫有 FSEvents／cache 警告；SDK 查詢仍成功，未把它誤判為 Xcode 不可用。 |
| SDK | `xcodebuild -showsdks`、`xcrun --sdk … --show-sdk-version`：iPhoneOS 26.2、iPhoneSimulator 26.2。 | SDK 版本與 runtime 分開列示；沒有查到 16.x runtime。 |
| Simulator runtime | `simctl list runtimes --json`：名稱 iOS 26.3，實際 `version=26.3.1`、build `23D8133`，arm64、available。 | 舊 iOS 18.6／26.0 的裝置集合仍存在，但 runtime profile 缺失，不能選作可用環境；本輪未刪除或重建它們。 |
| 可用 iPhone | iPhone 17 Pro、17 Pro Max、Air、17、16e；17 Pro 已開機，其餘關機但 available。主測 UDID `6CDD24DC-9DEE-4DDD-A9E5-2EAF4E61D981`。 | 這是已建立且可用的 5 台模擬器，不把 runtime 支援的其他 device type 當成已建立裝置。未另建模擬器。 |
| Node／npm | Node `v26.0.0`、npm `11.12.1`；Vite 的 Node engine 為 `^20.19.0 \|\| >=22.12.0`，目前符合。 | README 的 22.18+ 建議保留；本輪沒有升級／降級 Node 或相依套件。 |
| 套件與 lock | `npm ls --depth=0` exit 0；14 個直接依賴皆與 lockfile 的實際解析版本相同。React／React DOM 19.2.7、MapLibre 5.24.0、Three 0.185.1、Vite 8.1.2、TypeScript 6.0.3。 | package.json 使用範圍版本，不能只看宣告下限判定安裝版本。未重新安裝依賴。 |
| Web build 設定 | 實際 `resolveConfig({}, 'build')`：base `./`，worker format `iife`，JS／CSS targets 包含 `safari16.4`、`ios16.4`。 | 現有 Xcode deployment target 16.0 與前端目標不一致，見最低版本決策。 |
| 目前內建資料 | 11,033 道路、346 待轉區、9 個預計算繪圖來源；navigation hash 與 manifest 見環境 JSON。 | 數量只描述目前資料版本，不是所有道路都已實地驗證。 |
| 金鑰／簽章／實機 | 本輪僅查存在狀態：`local.properties`／`web-source/.env.local` 均不存在，環境未設 VITE Google key，內建首頁仍有 key placeholder；原生專案未設定 DEVELOPMENT_TEAM。 | 不讀取／列印金鑰或 Keychain 私鑰，不建立簽章，不把先前 unsigned arm64 build 說成實機安裝。Google 實際授權、可用 Team、iPhone 連線／道路測試仍未驗證。 |

本輪實際重跑：

- `cd web-source && npm test`：**302/302 通過**，包含 35 組參考路線測試及連接／通行標記測試；[完整日誌](ios-evidence/stage1-shared-tests.log)。
- `cd web-source && node tools/build-runtime.mjs`：exit 0，**24 組前後路由結果一致、22 組成功**；預計算約 11,880ms，導航資料 25.41MiB；[完整日誌](ios-evidence/stage1-precomputed-routes.log)。只生成忽略的建置中間產物，未匯入／覆寫現有 App assets。
- 本輪沒有重跑 iOS App／Android APK 建置或裝置操作；它們的前次證據保留於文末。盤點文件完成不表示後續階段已重新驗收。

### 3. Android 專屬功能與 iOS 對照

| 能力 | Android 現況（程式盤點） | iOS 對應決策／目前實作 | 驗收要點 |
| --- | --- | --- | --- |
| 本機網頁 | WebViewAssetLoader：`https://appassets.androidplatform.net/assets/public/index.html`；JS／DOM Storage／Geolocation 開啟，file／content access 與 mixed content 關閉；本機非 GET 回 403。 | Swift＋WKWebView，`lanedev://app/index.html`，WKURLSchemeHandler 僅供應 bundle `public/` 的 GET，防路徑逸出。 | 關閉 Mac 開發伺服器仍能冷啟動、讀路網與搜尋；寫入／非法路徑被拒。 |
| 定位／權限 | MainActivity 要求 FINE／COARSE，審核 WebChromeClient 的定位 origin；`requestLocation` 只處理授權與手機定位開關，座標由 WebView Geolocation 提供。 | CLLocationManager、When In Use、BestForNavigation；Bridge 提供 Geolocation-compatible 的一次性／watch／clear，沿用 GpsDriver。 | 同一時間只選一種來源；明確拒絕、概略精度、冷啟動暫無訊號、超時、過期位置及清理 watch；模擬精度不是實測精度。 |
| 中文語音 | TextToSpeech，優先可用中文／台灣、離線 voice；優先訊息 flush、一般 queue 上限 3；start／audio bytes／finish／error 回報。實際 AudioAttributes 使用 MEDIA／SPEECH。 | AVSpeechSynthesizer／AVAudioSession voicePrompt，優先 zh-TW，回退已安裝中文；同樣優先播報、停止與 queue 上限。 | 不另寫語音導航決策；原核心決定說什麼。回呼只證明引擎流程，實際喇叭、音量、靜音與藍牙須實機聽測。 |
| 手機朝向 | SensorManager TYPE_ROTATION_VECTOR，依螢幕旋轉重映射，每 200ms 最多一筆；不可靠時送 null，前景 resume／pause 註冊／移除。 | CLLocationManager heading，真北不可用時採磁北；accuracy 無效送 null，行進方向仍可來自 GPS course。 | 既有共同介面以度數與 null 表達；真北／磁北、橫直向、停車、磁場與車架仍須實機確認，不能以 Simulator 方向當作校正完成。 |
| 反向地理編碼 | Android Geocoder／Locale.TAIWAN，2 執行緒、16 佇列，回 `addressResult`；無服務／錯誤回空字串。 | CLGeocoder、zh_TW、同一時間一個請求；busy 時現有實作直接回空字串。 | 離線／缺地址仍可規劃，標示座標查詢非確認門牌。共用前端允許 2 筆同時查詢，與 iOS 1 筆容量不同，需後續操作核對；本輪不改排程。 |
| 系統設定 | TTS_SETTINGS、ACTION_INSTALL_TTS_DATA、LOCATION_SOURCE_SETTINGS、APPLICATION_DETAILS_SETTINGS；處理沒有可開啟頁面的 fallback。 | 只用公開 `UIApplication.openSettingsURLString` 開 App 設定；iOS 無相同 Android TTS 下載 Activity，顯示到輔助使用／朗讀與語音的操作說明。 | 不使用私有 Settings URL，不假設開過設定就代表已授權／已下載。返回後重新讀取狀態。 |
| 防熄屏 | FLAG_KEEP_SCREEN_ON 僅 `resumed && navigating`，pause 清除；GPS driver 另有可用時的 Web Wake Lock。 | `UIApplication.shared.isIdleTimerDisabled = foreground && navigating`；Scene 暫停定位、語音與亮屏。 | 開始／結束／Home／返回分別驗證；保持亮屏不是背景或鎖屏持續導航能力。 |
| 生命週期 | Activity resume／pause、WebView resume／pause、停止 TTS／方向感測；沒有導航 foreground service／背景定位權限設計。 | UIWindowSceneDelegate 前景控制；沒有 UIBackgroundModes 或 Always 定位要求，WK 核心只承諾前景。 | Home 與實際鎖屏分開測。前次 Home 已測；本輪沒有新增操作，鎖屏仍未驗證且不承諾持續導航。 |
| Google key | Android 由 local.properties → BuildConfig → 回應 index.html 時替換 placeholder；只供 Maps JavaScript／Places Text Search，不是原生 Maps SDK。 | 現有 iOS bundle handler 沒有對等的 Android BuildConfig 注入；可評估建置期注入，但不能當作已完成 Google 授權。 | 缺 key 與來源限制分開處理；本地 POI／路由不依賴 Google，不能改成必須由 Mac 伺服器供應 App。 |

### 4. 專案、最低版本與共用介面決策

**最低支援基線定為 iOS 16.4。** 依據是本機已安裝 Vite 8.1.2 的實際解析目標（JS 與 CSS 都包含 iOS／Safari 16.4），與[官方 build.target 說明](https://vite.dev/config/build-options)相符。這是本階段的相容性決策，不是 16.4 已操作通過的聲明。現有 Xcode／`ios/generate-project.rb` 仍設定 16.0；下一階段須對齊 App 與測試 target，取得可用的最低版本測試環境。不得只改文字宣稱 16.0 支援，或為測試通過悄悄放寬打包目標。本輪不修改原生專案設定。

目錄保持現況：

- `web-source/`：唯一共用 React／MapLibre／路由／車道／汽機車／待轉／偏航核心；`src/native/` 負責平台介面。
- `app/`：Android 原生、Gradle 與已提交共用 `assets/public/`，建置能力保留。
- `ios/LaneDev.xcodeproj`、`ios/LaneDev/`：Swift UIKit／WKWebView、`BundleSchemeHandler`、`LocationService`、`SpeechService`、`Bridge.js`、Scene 與 Info.plist；不加入 Capacitor／React Native 或第二套路由。
- `ios/LaneDevTests/`、`ios/LaneDevUITests/`、`ios/tools/`：整合／操作測試；`ios/.build/`、`.build-device/` 為忽略的產物。
- `docs/ios-port-plan.md`、`docs/ios-evidence/`：階段、證據、問題及移除門檻。

橋接契約維持 Android 已有命名：前端 `window.LaneNative.postMessage(JSON.stringify(command))`，回傳 `lane-native` CustomEvent；iOS 在 document-start、僅主 frame 注入，Swift 收到訊息仍檢查主 frame 與 `lanedev://app`。遠端頁面／popup 不得取得原生能力。

| 方向 | 訊息／介面 | 契約 |
| --- | --- | --- |
| JS → native → JS | `requestLocation {id}` → `locationResult {id,error}` | 授權結果只解鎖相符請求，不是座標；授權等候上限 60 秒。 |
| iOS 定位適配器 | `LaneGeolocation.getCurrentPosition/watchPosition/clearWatch`；內部 `locationStart/locationStop {id}`、`position`／`positionError` | 經 `locationProvider()` 選擇，Android／一般瀏覽器仍用原 provider。座標事件供共用 GpsDriver，禁止另算虛擬里程或導航狀態。 |
| native → JS | `position {timestamp,coords}` | timestamp 為 epoch 毫秒，longitude／latitude 為經緯度，accuracy 公尺、speed 公尺／秒、heading 度數；未知速度／方向為 null。共同定位請求 timeout 15 秒；iOS 拒絕無效／過期 fix。 |
| native → JS | `heading {value}` | 度數或 null，共用端超過 3 秒視為不新鮮；低速／停車朝向的最終採用仍由導航核心判斷。 |
| JS → native | `speak {text,priority}`、`stopSpeech`、`ttsTest/ttsRefresh/ttsSettings/ttsInstall` | 使用同一原生語音佇列；iOS 不捏造 Android 語音下載能力。 |
| JS → native → JS | `reverseGeocode {id,lng,lat}` → `addressResult {id,address}` | 無結果可為空字串；前端 8 秒超時，有本地來源地址時不必反查。 |
| JS → native | `navigation {active}`、`appSettings/locationSettings`、`status` | 只做原生生命週期／設定／狀態，不把路由演算法移到 Swift。 |
| native → JS | `status`、`lifecycle {active}` | 狀態欄位含 ttsReady、tts、speech、audio、location、compass；離開前景停止服務，返回等待新位置。 |

### 5. WKWebView 相容性與來源限制評估

| 項目 | 決策與已知證據 | 尚待確認／驗收方式 |
| --- | --- | --- |
| 本機載入 | 採 WKURLSchemeHandler 供應穩定 `lanedev://app`，相對 base `./`。回應須有正確 MIME／UTF-8；以公開 API 實作，沒有 KVC 放寬 file access 或本機 HTTP 開發伺服器。前次獨立啟動與讀取 runtime 已有證據。 | 本輪未重新操作 WK；最低版本需測 JS modules、JSON／GeoJSON、PNG、CORS header 與錯誤回應。單純 `loadFileURL` 不直接視為 fetch／Worker／權限皆等同 Android HTTPS。 |
| secure context／校驗 | 自訂 scheme 不假設提供 browser Geolocation、randomUUID、SubtleCrypto。既有適配器採原生定位、getRandomValues request ID，以及 native CryptoKit 實際位元組的 X-Lane-SHA256 header；一般網路仍用 WebCrypto。 | 缺失／錯誤 hash 必須拒絕導航；不為測試跳過校驗或偽裝 Google Referer。 |
| WebGL／3D | MapLibre 原始碼先嘗試 WebGL2 再 fallback WebGL；目前 Three 的 WebGLRenderer 明定 WebGL2，故 3D 車模／高架不能只靠 WebGL1。前次 Simulator 車模、路線與指示截圖已有渲染證據。 | iOS 16.4、實機 GPU、context lost／恢復、記憶體與長時間導航尚待測。沒有本輪 GPU capability probe 或 FPS／耗電保證。 |
| Worker | MapLibre 使用 Web Worker，Vite worker format 是 iife；既有成品的 worker 啟動程式內建，原生 handler 提供 custom-origin 資料回應與 CORS。預計算含 9 個繪圖來源，前次整合成功載入。 | 最低版本需確認 blob worker、Worker 中的 custom scheme fetch 與 abort／重載。若引入 CSP，要包含實際需要的 worker/blob 規則，不能把 Worker 關掉就宣稱通過。 |
| 字型 | 不依賴外部 glyph server，MapLibre／canvas 採本機字型，CJK 優先 PingFang TC；先前已修 iOS 表單字型。 | 本機 runtime 缺 AppleColorEmoji.ttc 的問題仍在 CLIENT_REVIEW。最低版本與 iPhone 實際字形／符號／縮放未驗收；不移除授權顯名來換取畫面通過。 |
| 儲存 | 目前使用 WKWebView 預設 data store，沒有選 nonPersistent；[Apple 說明預設 store 會持久化](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/default())。共用 localStorage 只存 `client.voice`、`client.zoom`、`client.savedPlaces` 等使用者偏好；官方道路／journal 的寫入介面會拋唯讀錯誤。 | 這是設定／文件層面的確認，尚未驗證此 custom origin 跨程序重啟／升級仍保留偏好。下一階段須用測試值保存、重載、終止重開並還原原設定；不可把 Node 的 mock storage 測試當成 WK 持久性證明。 |
| Google 搜尋 | 現在是 Maps JavaScript API＋Places API (New) `Place.searchByText`，由使用者明確提交才呼叫；不是原生 iOS SDK 或 Places UI Kit。Google 官方指出本機／非 HTTP(S) 來源可能不送 Referer，網站限制 key 因而不保證可用；[來源與授權限制](https://developers.google.com/maps/api-security-best-practices#host-your-browser-based-apps-on-a-server)。 | 缺 key、iOS key 注入及來源授權均未通過。取得正確設定後還要實測 script／網路／拒絕訊息；iOS bundle ID 限制不能直接當成 Maps JavaScript 的網站授權。若需原生 Places SDK 或受控代理，另行設計；不以關閉 key 限制或讓整個 App 依賴 Mac 伺服器解決。 |
| 反查地址 | CLGeocoder 是可選補充；本地 POI／路由與本機資產啟動不應等待外網。 | 系統服務可用性、網路、地址品質及兩筆並行的降級仍未驗收；不得捏造門牌。 |
| 背景／鎖屏 | 前景限定。Swift 定位／語音在 Scene inactive 停止；WK 的 JS／Worker 不當作背景常駐引擎。 | Home 前次有暫停／恢復證據；實際鎖屏尚未測，兩者都不承諾持續導航。背景功能另案決定，不在本輪加 Background Modes。 |

### 6. 24 組路由與 35 組楠梓參考的驗證方式

| 基準 | 來源與方法 | 本輪結果與限制 |
| --- | --- | --- |
| 24 組預計算一致性 | `web-source/tools/build-runtime.mjs`：依目前 roads 陣列索引抽 12 組端點，各跑 car／moto，比對原 RoadGraph 與 JSON codec 還原 graph 的 `routeDetailed` 完整結果；另比對 graph snapshot、Lane Base Map／Set、待轉區、turnbays、高架高度及共享 node 座標。 | 24 組一致、22 組成功，2 組拒絕也需一致。這是同一演算法預計算前後的驗證，不是獨立人工真值；道路陣列換版會改變抽樣端點，不能說成固定的 24 條人工參考路線。 |
| 35 組楠梓人工參考 | `src/core/nanzihRouteData.json` 保存網站 v16 的 35 組有向路線，汽車 17、機車 18；`nanzihPreferred.test.mjs` 讀取已打包 runtime graph，逐筆比較 exact coords、完整 laneBand、span 數、snap 後命中、允許的 laneDecision 與連續畫線。 | 本輪 npm test 的 `all 35 website cases reconstruct their exact directed path and visible lane band` 通過，不能以「測試只有 1 項」漏算其內部 35 個 case。資料與預期未修改。 |
| 接合／通行標記 | `nanzihConnections.test.mjs` 驗證已確認機車連接只在 runtime 補入、不改原路、汽車不可使用；另一測試確認通行標記只作用於指定 block／方向／車種。 | 本輪 302 項中均通過；保留既有使用者已確認的參考特例，沒有新增或放寬任何規則。 |

固定 anchors（經度、緯度）：north `[120.321029,22.72933]`、station `[120.32437,22.727035]`、east `[120.3290217,22.7236493]`、south `[120.3253565,22.7194044]`、west `[120.3166,22.72246]`。35 個有向組合的 key 清單與車種數量見環境 JSON。不得將網站沒有的方向／車種補成成功案例。

重跑命令：

```sh
cd web-source
npm test
node tools/build-runtime.mjs
# 可單獨選取；本輪已由上面的 npm test 執行這些測試：
node --test src/core/nanzihPreferred.test.mjs src/core/nanzihConnections.test.mjs
```

原始參考的來源提交、適用範圍與非實測車道的說明保留於 [NANZIH_REFERENCE.md](NANZIH_REFERENCE.md)。參考線只對其存在的起終點／方向／車種適用；偏航重規劃仍走一般核心，不能要求偏航結果永遠相同，亦不能用改官方資料讓兩種基準消除差異。

### 7. 後續階段與驗收門檻（本輪編號）

| 階段 | 範圍 | 必須通過的驗收條件 | 目前狀態 |
| --- | --- | --- | --- |
| 第一階段：環境與移植盤點 | 規範、工具、原生功能、版本、WK 風險、路線基準與移除清單。 | 實際環境命令、lock 檢查、兩種基準重跑；明列既有／本輪／待確認，保存原工作區。 | **本輪完成**；證據連結如上。 |
| 第二階段：容器／相容性收斂 | 沿用既有 Swift＋WK 專案，對齊最低 iOS 16.4、原生與共用橋接，補儲存／Worker／錯誤路徑。 | App／測試 target 與產生器對齊；Simulator Debug／Release 與 arm64 build；無 Mac 伺服器載入全部本機資料；localStorage 重啟驗證；非法 origin／寫入／校驗失敗不能啟動導航；確認 WebGL2／Worker／字型。 | 已有前次基礎實作與證據；**不把它當成本輪最低版本門檻已通過**。16.x runtime 不足需實體最低版本裝置或補足相容環境。 |
| 第三階段：前景導航操作 | 搜尋、起終點、汽機車／車道／待轉、語音、偏航、抵達、定位來源與錯誤、Home／返回。 | 共用測試含 24＋35 基準；同一定位核心且來源互斥；權限拒絕／概略精度／掉訊可處理；開始／結束不殘留 watch 或亮屏；實際 UI 操作與截圖；Android assembleDebug／testDebugUnitTest 回歸。 | 前次已有 Simulator 前景成果；需依第二階段調整重跑。Google 若仍受阻，獨立列示，不阻斷本地搜尋與核心驗收。 |
| 第四階段：移除虛擬功能與實機 | 先完成下列實際刪除，再處理 Team／簽章、iPhone 安裝與道路／音訊／效能驗證。 | 刪除來源／UI／橋接／hook／測試／腳本入口；重新產生專案與打包；源码與成品掃描、iOS／Android 回歸；實體移動與聽測有可重現證據。 | 受實體 iPhone／簽章環境限制；不能以 Simulator／unsigned build 替代。 |
| 背景／鎖屏另案 | 不在本輪前景範圍內。 | 若需求成立，另設計 JS 核心被暫停時的執行方式、定位／音訊權限、電量及真正 Home／鎖屏／恢復測試。 | **未支援持續導航，未完成實際鎖屏測試**；不能只加 Background Modes 就視為完成。 |

各實作階段都要更新本文件、執行適當測試與建置，保存失敗與成功證據；不得只交計畫。只有本階段盤點需要的測試在這輪重新執行，未擅自推進功能實作。

### 8. 實體 iPhone 階段前的虛擬功能移除清單

以下是**尚待實際刪除**的清單；現有條件編譯與 Release 不顯示工具不等於已刪除。

- [ ] 刪除 `ios/LaneDev/SimulatorLocationSource.swift` 及其來源／timer／路線推進／偏航注入，不留下虛擬位置預設值或保留開關。
- [ ] 刪除 `LocationService.swift` 的 simulator property、virtual selector、導航鎖定狀態及所有 Simulator 分支，只剩 Core Location 提供器。
- [ ] 刪除 `NavigationViewController.swift` 的原生來源 selector／前進／偏航工具列、控制 handler、`LaneSimulator` 注入及 `simRoute` 指令。
- [ ] 刪除 `web-source/src/native/platform.ts` 的 LaneSimulator 型別及 `src/nav/useDrive.ts` 的兩個 setRoute hook；重新編譯，不能只讓 hook 在執行時是 undefined。
- [ ] 移除／改寫 `ForegroundNavigationTests.swift`、`ForegroundUITests.swift` 中依賴虛擬前進／偏航／控制項的測試；保留可驗證真實定位契約的測試，不留下另一套模擬導航。
- [ ] 移除／改寫 `ios/tools/test-simulator.mjs` 相關虛擬導航與座標情境入口；清除 Simulator 測試定位情境。純測試 Geolocation contract 的 `iosBridge.test.mjs` 應先確認沒有虛擬導航依賴，避免誤刪必要回歸。
- [ ] 從 `ios/generate-project.rb` 產生的 Xcode source／resource references 與專案中移除相關檔案，再檢查產生器不會重新帶回；調整 simulator-specific scheme／測試選取。
- [ ] 更新 `ios/README.md`、本文件與 AGENTS 的前期例外狀態；移除可操作入口指令，過去截圖／日誌可留歷史標示，不當作正式功能。
- [ ] 重新執行 npm test／build、資產政策與 SHA-256 校驗、24＋35 路線、iOS Debug／Release／arm64、Android assembleDebug／testDebugUnitTest。掃描原始碼與實際 bundle，確認沒有虛擬來源、hook、指令、控制項或隱藏入口；先前 `src/dev/?sim` 的 Web 開發例外仍須保持不進正式包。
- [ ] 才進行有簽章的 iPhone 安裝、定位權限、真實 GPS／磁場、待轉／偏航、語音輸出與前景生命週期驗證；缺少裝置／簽章時保持受阻標示。

### 9. 本階段結論與未確認事項

已確認環境足以繼續目前 Simulator 移植與共用導航回歸；第一階段規範與盤點完成。**下一階段先對齊 iOS 16.4 與原生 deployment target，補足 WK 儲存／最低版本資格，再依既有前景成果重跑操作。**

尚未確認：iOS 16.4 真實執行、localStorage 跨程序／升級、Google key／來源授權及 iOS 注入、反查地址並行降級、實機朝向與精度／音訊／效能、有簽章安裝與真正鎖屏行為。Simulator runtime 的 Emoji 字型、來源顯名框與其他既有非本次盤點修正事項保留在 [CLIENT_REVIEW.md](CLIENT_REVIEW.md)。本輪不調整官方資料、不放寬通行規則、不更換路由／參考資料、不修改 App 功能。

## 第二階段：iOS 容器與可重複打包（2026-11-20）

延用 `feat/ios-navigation` 上的 Swift＋WKWebView 專案與共享 `LaneDev`、`LaneDevRelease` schemes。App、測試 targets 與 `ios/generate-project.rb` 已對齊 iOS 16.4。操作使用 iPhone 17 Pro Simulator，runtime iOS 26.3.1（23D8133），Xcode 26.2（17C52）。iOS 16.4 操作仍需環境或裝置。

| Xcode 組態 | Vite 模式 | 資產 | Simulator 能力 |
| --- | --- | --- | --- |
| Debug ＋ `iphonesimulator` | `ios-simulator` | `ios/.web/ios-simulator/public` | Swift 限 `DEBUG && targetEnvironment(simulator)`，網頁接點由 `import.meta.env.MODE` 明確啟用 |
| Release（任一 SDK）、Debug ＋ `iphoneos` | `ios-release` | `ios/.web/ios-release/public` | 前端及 Swift 都排除 App 虛擬導航接點 |
| Android APK | `production` | `app/src/main/assets/public` | 沿用 Android 原生與正式前端打包 |

- `node ios/tools/build-web.mjs all` 依 lockfile 安裝套件、執行測試、生成預計算路網，接著做 TypeScript／Vite 建置與模組稽核。兩種 iOS 模式都是靜態 production build，`import.meta.env.DEV` 均為 false。`node tools/sync-web-assets.mjs ios-simulator` 與 `ios-release` 可分開驗證並同步現有成品。iOS 產物存放在忽略目錄，Android 繼續提交其前端成品。
- Xcode 依 SDK／config 選 `public/`，驗證模式與工具旗標後由內建資源階段複製。Swift 再檢查包種、模式及路網 manifest SHA-256。前端核對路網格式、必要的 9 個來源、檔名雜湊及導航資料 SHA-256。道路、車道、建築、高架、地標及導航圖沿用目前輸入。
- 定案使用 `WKURLSchemeHandler` 的唯讀 `lanedev://app`，能以相對 URL 載入 ES module、Worker、JSON／GeoJSON、樣式及圖示。App 顯示地圖初始化、路網校驗、圖層載入三步。錯誤會阻止導航並提供「重新載入」。如果錯的是打包資產本身，仍需重建或重新安裝。
- 虛擬來源、橋接與測試仍屬前期例外，實體 iPhone 階段依上方清單完整刪除。正式包測試使用 Simulator 系統定位時，該系統測試工具與 App 本身的虛擬來源分開。

可執行的建置、安裝、啟動命令見 [iOS README](../ios/README.md)。Android 以相容 Gradle 8.14.3／JDK 21／API 36 實際完成 `assembleDebug`、`testDebugUnitTest`。工作區原有 wrapper 已改為 9.7.1，同一命令會因 AGP 8.13.0 依賴已移除的 Gradle 內部 API 而失敗。這次回歸直接用 8.14.3，保留 wrapper 變動。現有 Android JUnit 共 1 項。

本輪實際驗收如下。

| 項目 | 結果 |
| --- | --- |
| 共用前端與路網 | 302 項測試通過，含 35 組楠梓參考路線。24 組預計算前後路由一致，其中 22 組有解。內建 11,033 道路、346 待轉區及 9 組繪圖來源。官方道路、待轉區與參考資料維持原位元組。 |
| 自訂來源 | Debug WKWebView 成功執行包內 module、`fetch` 與 blob Worker；Worker 從 `lanedev://app` 讀回 `lanedev-precomputed-v1`，地圖完成全部來源初始化。實際 canvas 為 WebGL2，資源紀錄沒有 HTTP(S) 載入，非 GET 回 403。 |
| 字型 | WKWebView 通過 PingFang TC 字型檢查，實際畫面有繁中地標。此 Simulator 的 `AppleColorEmoji.ttc` 缺檔，部分圖示出現替代字元，見 CLIENT_REVIEW。 |
| 進度／錯誤／重試 | XCTest 只在 WebView 內注入一次不相容 manifest 回應。實測顯示進度與版本錯誤，點重試後從原 bundle 恢復。正式路網檔案未被測試覆寫。 |
| Vite 停止後操作 | 實際開啟 Vite（HTTP 200）後關閉（連線被拒）。Debug／Release 的 XCUITest 均以實際拖曳、雙指捏合與旋轉操作地圖，逐步擷取畫面並比較地圖區域。`localStorage` 語音偏好在 App 終止重開後保留，測試最後還原原值。 |
| App／組態 | Debug 9 項、Release 2 項測試通過。另以 `simctl install`、`simctl launch --terminate-running-process` 獨立啟動 Release，確認進度結束後顯示可操作地圖。Release 驗證腳本拒絕使用 Simulator 開發套件，兩個 Release 成品都沒有虛擬工具的 Swift 字串或 JS 接點。 |
| 實機目標 | `generic/platform=iOS` Release arm64 未簽章建置通過。iOS 16.4 裝置執行、iPhone 簽章與實機驗證仍待安排。 |

- [正式包獨立啟動](ios-evidence/stage2/standalone-release.png)、[拖曳後](ios-evidence/stage2/offline-map-drag.png)、[縮放後](ios-evidence/stage2/offline-map-zoom.png)、[旋轉後](ios-evidence/stage2/offline-map-rotate.png)、[終止後重開](ios-evidence/stage2/offline-map-reopened.png)。
- [載入進度](ios-evidence/stage2/map-loading-progress.png)、[版本錯誤與重試](ios-evidence/stage2/map-loading-error.png)、[重試恢復](ios-evidence/stage2/map-recovered.png)。
- [執行紀錄](ios-evidence/stage2/verification.txt) 與 [成品模式／雜湊稽核](ios-evidence/stage2/package-audit.json)。

第三階段接續既有前景導航，按第一階段的操作門檻驗收與補測。iOS 16.4 runtime 缺席、實體 iPhone、簽章、Google Places 授權，以及實際鎖屏仍是獨立項目。

---

## 先前實作與驗證紀錄（歷史，保留）

下方的「階段 0／1／2」屬先前執行紀錄，保留其原始環境、限制、失敗與成功結果。最低版本政策以本輪第一階段的 **iOS 16.4** 決策為準；先前成功不表示本輪列出的待確認門檻已關閉。

## 範圍與驗收

本輪在原工作區 `feat/ios-navigation` 完成前景導航。沿用 `web-source` 的 React、MapLibre、預計算路網、路由、車道指引、汽機車限制、待轉區、偏航重規劃及楠梓參考路線；官方資料唯讀。不新增編輯、匯入寫入或大眾運輸。

App 必須直接載入內建資產，Mac 無開發伺服器時可啟動、搜尋、規劃、導航。Swift WKWebView 橋接 Core Location 與 AVSpeechSynthesizer。每次只啟用一個定位來源，虛擬座標與真實定位使用相同 GpsDriver。

Simulator 的虛擬工具僅可在 `DEBUG && targetEnvironment(simulator)` 編譯；轉實體 iPhone 階段必須刪除工具來源、接點、測試與文件入口，不能只隱藏按鈕。本輪不宣稱背景或鎖屏導航。

## 階段 0：盤點（2026-11-18，已完成）

- `git status --short --branch`：乾淨的 `feat/ios-navigation`，未建立分支或 worktree。
- 閱讀根目錄 AGENTS.md；本次使用者明確允許的 iOS Simulator 虛擬導航限定於本輪 iOS Debug，不改 Android production 禁用模擬的規則。
- 既有預計算路網已含版本與 SHA-256 驗證；Android 橋接使用 LaneNative／lane-native。將新增 iOS 定位提供器，不複製路由核心。
- Xcode 26.2（17C52）、iOS 26.3 Simulator 可用；Android SDK 尚待尋找。`npm ci --ignore-scripts` 已執行成功（237 packages）。
- 下一階段：內建資源服務、iOS 專案、原生定位與語音、前端提供器接點；接著執行 Web／iOS／Android 驗證並補上證據。

## 待驗證與限制

- 尚未驗證實體 iPhone、簽章、GPS 實際移動、中文喇叭／藍牙輸出。
- 背景、切換 App、鎖屏應暫停定位與語音，返回前景等待新定位；不設定背景定位模式。
- Google Places key、遠端地址查詢屬額外網路能力；內建地點搜尋與路由不應依賴它們。

## 階段 1：原生容器與共用核心（已完成實作與初次建置）

- 新增 `ios/LaneDev.xcodeproj`、Swift WKWebView、唯讀 `lanedev://app` 資源服務。直接把已提交的 Android `assets/public` 作為共用包內資源；開啟 Xcode 不需要先啟動 Vite。
- Core Location 使用 When In Use、精確導航定位、行進方向與可靠羅盤；JS 適配器提供 getCurrentPosition／watchPosition／clearWatch。Android 仍使用原 Geolocation 提供器。
- AVSpeechSynthesizer 中文語音、優先播報、佇列上限、停止與原生播放回呼；設定面板區分 iOS 系統語音入口。
- WK 自訂來源缺少 WebCrypto 時以原生 CryptoKit 計算實際資產位元組 SHA-256；一般網路來源仍強制 WebCrypto。request ID 相容沒有 randomUUID 的 WK 來源。
- Simulator Debug 提供單一來源選擇、每秒固定速度定位、暫停與偏航；都進入原 GpsDriver。導航中禁止切來源，實機與 Release 不編譯這些入口。
- `npm test`：302/302 通過。預計算重建：11,033 道路、346 待轉區、24 組原始／還原路由結果一致（22 組成功）；沒有更改官方來源資料或通行規則。
- TypeScript／Vite／用戶端模組排除稽核與共用資產校驗通過。`node tools/sync-web-assets.mjs` 是 Mac 可用的校驗匯入工具，Windows PowerShell 入口保留。
- Xcode Debug Simulator `build-for-testing` 通過。首輪操作已載入包內 MapLibre 地圖、完成本地搜尋及約 1.1 公里路線預覽；無 5190／5173／4173 開發伺服器。
- 首輪整合測試：原生中文語音收到 start／finish（音量 60%、Speaker）。其他測試暴露了過時 DOM selector 與 WK 封鎖 POST 的測試預期差異，已修正後重跑；不把首輪失敗列為通過。實際畫面發現 WK 表單 CJK fallback 字型問題，已加 iOS 專用字型規則，等待重驗。
- Android 回歸嘗試：Gradle 8.14.3 遇 Java 26 `Unsupported class file major version 70`；正在準備臨時 JDK 21。尚未找到 Android SDK，尚未宣稱 APK 建置通過。
- 下一階段：完成 Simulator 前景操作、偏航／抵達／結束、來源互斥、原生位置與生命週期驗證；建置實機架構與 Release，補上可重現證據與剩餘阻礙。

## 階段 2：前景導航驗收（2026-11-18，已完成）

測試環境：原分支 `feat/ios-navigation`，基底 HEAD `69cbd15`；Xcode 26.2（17C52）、iPhone 17 Pro Simulator、iOS 26.3。沒有建立其他分支／worktree，沒有提交或推送。

### 完成行為與執行證據

| 項目 | 實際結果 |
| --- | --- |
| Web 共用回歸 | `npm ci --ignore-scripts`、最終 `npm test` 302/302、TypeScript／Vite／用戶端打包檢查通過。涵蓋車種、車道方向、待轉、中央島／禁止迴轉、偏航時鐘、楠梓人工參考路線等。 |
| 包內路網 | 11,033 道路、346 待轉區；24 組原始／還原路由結果一致，其中 22 組成功。App 直接載入 `lanedev://app`，不連 Mac 開發伺服器。 |
| Debug 整合 | 5 個 hosted XCTest 全部通過：內建搜尋與汽機車規劃／導航、偏航重規劃及抵達、中文語音回呼、唯讀資產／校驗、Core Location 橋接。另 1 個 XCUITest 實際點按搜尋、導航、Home、返回與結束通過。 |
| 偏航／來源互斥 | 偏航後路線 revision 2 → 3；始終一個原生 watch。導航期間切換來源被拒絕；停止導航後 watch 清空，底層服務停止。虛擬來源只產生定位，進度、匹配、重算、車道與語音仍由原核心決定。 |
| 抵達 | 注入終點定位後，由共用 GpsDriver 判定抵達，顯示目的地與「完成導航」；完成後清空導航與保持亮屏狀態。這是定位注入測試，不是真實道路行駛。 |
| Core Location | 實際收到 Simulator 系統位置，例如 `[120.2758, 22.73301744810952]`、精度 5m；不是 App 虛擬來源。仍不代表 iPhone GPS。 |
| 拒絕授權 | 另外撤銷 Simulator 權限，1 個 XCTest 通過；回覆「未授權定位，請到 App 設定允許使用期間定位」，沒有殘留 watch 或底層定位。測後恢復權限。 |
| 原生語音 | 新的中文播報有 start／finish 回呼，輸出回報 Speaker、音量 60%；停止／優先佇列與前景狀態由 Swift 管理。未驗證實機可聽聲音。 |
| Release 操作 | `LaneDevRelease` 的 XCUITest 通過：無虛擬來源控制項，內建搜尋、規劃、Core Location 導航實際出現方向指引、結束回到搜尋。 |
| iPhone 架構 | 最終 `generic/platform=iOS`、Release、arm64、`CODE_SIGNING_ALLOWED=NO` 建置成功；只有編譯驗證，未簽章、未安裝實機。 |
| Release 工具排除 | Simulator Release 與 iPhone arm64 原生 executable 的 strings 稽核，沒有 SimulatorLocationSource、simRoute、虛擬定位、沿路線前進、location-source、LaneSimulator。共用 JS 仍有沒有原生實作的 optional hook，後續實機階段必須真正刪除。 |
| Android | 臨時 JDK 21／API 36／Build Tools 35.0.0 下，`assembleDebug` 與 `testDebugUnitTest` 通過。既有 Android JUnit 只有 1 個基本測試；路由／限制回歸由 302 個共用 Web 測試提供。本輪沒有 Android 裝置操作測試。 |
| 唯讀與來源 | 官方 Web 輸入、已提交的 raw road_database／journal／LanePilot bytes、核心規則及參考路線 `git diff --quiet` 通過；資產 POST 回 403，導航 SHA-256 與 manifest 一致；載入的 Web UI 資源沒有 HTTP／HTTPS 請求。 |

測試可重跑：`node ios/tools/test-simulator.mjs debug`、`release`、`denied`（先啟動 iPhone Simulator）。工具會建立結果檔、處理 Simulator 權限與系統定位情境，測後清除定位。UI 測試執行器會重設定位情境，因此在 App 啟動後重新注入；沒有在 Release App 加測試定位後門。

最終產物與證據：

- [完整執行摘要與原生日誌](ios-evidence/verification.txt)
- [兩個 Release 成品的校驗與能力稽核](ios-evidence/package-audit.json)：全部 script／runtime SHA-256 驗證、唯讀原始資料位元組、無背景模式／Always 定位／原生虛擬工具。
- [前景導航](ios-evidence/foreground-navigation.png)、[機車預覽](ios-evidence/offline-motorcycle-route.png)、[偏航](ios-evidence/rerouted-navigation.png)、[抵達](ios-evidence/arrival.png)
- [實際點按的 Debug App](ios-evidence/touch-foreground-navigation.png)、[Release Core Location 導航](ios-evidence/release-core-location-navigation.png)
- 全部測試工具結束後，以 `simctl launch` 獨立啟動已安裝 App，確認 loading 消失且內建地圖／搜尋可用；[獨立啟動畫面](ios-evidence/standalone-startup.png)。未啟動 Vite 或其他 Mac 開發伺服器。
- 本機完整 `.xcresult`：`ios/.build/test-results/debug-2026-11-18T08-51-28-568Z/results.xcresult`、`release-2026-11-18T08-53-23-524Z/results.xcresult`、`denied-2026-11-18T08-54-35-409Z/results.xcresult`（不提交建置產物）。
- Android APK：`app/build/outputs/apk/debug/app-debug.apk`；iOS Simulator App：`ios/.build/Build/Products/Debug-iphonesimulator/LaneDev.app`。

### 實際測試找出的問題與處理

- WK 表單控制項原先無法顯示中文字；iOS 專用字型規則後已由實際畫面確認。Emoji 字型缺檔仍屬 Simulator runtime 問題，列入 CLIENT_REVIEW。
- Core Location 冷啟動可能先送出 `locationUnknown`；原先會過早拒絕一次性起點定位。現在保留訂閱，等待後續定位，由 JS 的 15 秒 timeout 處理持續失訊。修正後 Debug 與 Release 操作均通過。
- 修正測試使用的舊版 DOM selector，並將 XCUITest 加強為「實際出現方向文字」後才視為導航成功。首輪失敗結果保留在本機早期 `.xcresult`，沒有混算為成功。
- Mac 重新生成的 15 個靜態輸入原本只有 BOM／換行／外圍空白差異；校驗後保留原始位元組，匯入工具也保留相同內容的既有唯讀資料。
- 重新生成的預計算成品與已提交版本對照：結構與非數字值一致，最大浮點差異 `4.833779598811816e-9`；沒有顯著差異或通行規則更改。成品 hash 依實際位元組重新生成，沒有偽造校驗或手改資料來通過測試。

### 前景、背景與鎖屏的支援界線

| 狀態 | 本輪支援與驗證 |
| --- | --- |
| App 前景 | 支援導航、跟隨鏡頭、方向／車道、偏航重規劃、抵達及中文語音；Simulator Debug 與 Release 已操作驗證。導航期間原生保持亮屏。 |
| 按 Home／切到背景 | **不支援背景持續導航**。XCUITest 實際按 Home，原生日誌為 `foreground=false locationUpdating=false speechForeground=false idleDisabled=false`；定位、語音與保持亮屏都停止。 |
| 返回 App | 實際返回後日誌為 `foreground=true locationUpdating=true speechForeground=true idleDisabled=true`。丟棄過期位置、清除舊朝向，等待新定位再更新；沒有補播背景期間的行程。 |
| 鎖屏 | **不支援鎖屏導航**。設計上 scene resign-active 會走相同暫停路徑，且沒有 UIBackgroundModes／Always 定位／背景音訊；本輪未實際操作鎖屏或驗證鎖屏恢復，不把 Home 測試當成鎖屏測試。 |

### 下一階段與受阻事項

本輪前景範圍完成。轉入實體 iPhone 階段前，必須刪除 `SimulatorLocationSource.swift`、LocationService／NavigationViewController 的 Simulator 區塊、LaneSimulator 宣告及 useDrive 的 setRoute 接點、虛擬測試與相關測試腳本入口，再重新生成 Xcode 專案、前端打包、Android 回歸及 Release 稽核。只編譯排除或隱藏 UI 不等於已完成刪除。

目前缺少實體 iPhone、開發者 Team／配送簽章；阻擋實機安裝、真實 GPS 移動、實際道路偏航／待轉、羅盤姿態與磁場、音訊路由／藍牙、效能與耗電驗證。Google Places key 仍未提供，僅額外線上備援受阻，內建搜尋與前景路由已驗證。未嘗試建立或購買憑證，也沒有用模擬結果宣稱實機完成。

背景與鎖屏若要持續導航，需要另案設計與驗證（包含 WK 被系統暫停時的核心執行、定位／音訊權限及續航）；本輪沒有啟用相關能力。其餘發現見 [CLIENT_REVIEW.md](CLIENT_REVIEW.md)。

原生 API 依據：[WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler)、[Core Location 授權](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services)、[背景定位條件](https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates)、[暫時定位錯誤](https://developer.apple.com/documentation/corelocation/cllocationmanagerdelegate/locationmanager(_:didfailwitherror:))、[AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)。
