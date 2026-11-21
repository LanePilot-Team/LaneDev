# iOS 移植計畫與階段紀錄

目前的建置與驗收以[第九階段](#stage9)及 [iOS README](../ios/README.md) 為準。第一至八階段的命令、畫面與設定保留當時的驗證紀錄。

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
| 第三階段：平台介面與 iOS 原生定位 | 單次、持續定位與授權；精度、時間、行進方向與羅盤；中斷、恢復及取消訂閱。 | Simulator 系統注入經 Core Location、橋接、共用核心進入導航 HUD；權限與生命週期測試；重跑 24＋35 路由基準與 Android 建置。 | 本輪實作與操作結果見第三階段紀錄。 |
| 第四階段：前期虛擬導航 | 獨立位置來源、選起終點、播放控制、1x／3x／8x、應轉未轉及訊號情境。 | 操作正常導航、偏航、暫停／恢復及抵達；核對倍速單位與訂閱；稽核正式包。 | 本輪結果見第四階段紀錄。 |
| 第五階段：主要操作流程 | 本地搜尋、常用地點、起終點、停靠點、重規劃、導引、iPhone 觸控與原生 Google 搜尋。 | 實際操作，保留楠梓參考適用條件，驗證多次重算按同一趟行程順序保留待經停靠點。 | 本輪驗證見第五階段紀錄。 |
| 第六階段：原生語音、設定與 App 生命週期 | 前景中文導航播報、iOS 設定入口與偏好持久化、防熄屏、定位／音訊中斷與 WebView 釋放。 | 在 Simulator 核對語音回呼、設定跨重開、Home 暫停／恢復及重載清理。人工聽音與鎖屏各有獨立紀錄。 | 見第六階段紀錄。 |
| 第七階段：Simulator 完整驗收與回歸 | 分別驗收虛擬及系統定位，量測啟動、HUD 更新與偏航重算。 | 重跑 24＋35 組基準，保存測試指令、結果、畫面與實機清單。 | 見第七階段紀錄。 |
| 第八階段：移除虛擬功能與實機 | 移除 App 內的虛擬導航，統一成品並處理真機簽章與驗收。 | 掃描成品、執行共用、iOS、Android 回歸，保存真機道路、語音和效能實測。 | 見第八階段裝置及簽章紀錄。 |
| 背景／鎖屏另案 | 不在本輪前景範圍內。 | 若需求成立，另設計 JS 核心被暫停時的執行方式、定位／音訊權限、電量及真正 Home／鎖屏／恢復測試。 | **未支援持續導航，未完成實際鎖屏測試**；不能只加 Background Modes 就視為完成。 |

各實作階段都要更新本文件、執行適當測試與建置，保存失敗與成功證據；不得只交計畫。只有本階段盤點需要的測試在這輪重新執行，未擅自推進功能實作。

### 8. 實體 iPhone 階段前的虛擬功能移除清單

第八階段使用下列核對項目。第四階段的表格保留原始檔案、旗標及入口名稱供稽核比對。

- [x] 刪除 `ios/LaneDev/SimulatorLocationSource.swift`、`SimulatorNavigationPanel.swift` 與內建軌跡、倍速及各情境控制。
- [x] 刪除 `LocationService.swift` 的替代來源、切換狀態與特殊時計，唯一位置來源為 `CLLocationManager`。
- [x] 刪除 `NavigationViewController.swift` 的面板、控制 handler、`LaneSimulator` 注入及相關橋接入口。
- [x] 刪除 `platform.ts` 的虛擬型別及 `App.tsx`、`PlanPanel.tsx`、`nav/` 的操作、時鐘及動畫播放接點。保留共用導航與定位生命週期。
- [x] 改寫 XCTest／XCUITest 為 Core Location，保留 App 外的測試工具、系統注入軌跡及 geolocation 契約測試。
- [x] 從 Xcode、專案產生器和前端打包移除 Simulator 能力旗標及分支，Debug 與 Release 採同一份 iOS 靜態資源。共用 scheme 關閉 Xcode 啟動定位模擬。
- [x] 清理前期專用產物及現行文件。歷史截圖和實測紀錄留在原階段。
- [x] 完成共用、Android、iOS 回歸及獨立 App 成品稽核。
- [ ] 完成 iPhone 開發簽章、安裝與實地驗收。

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

第三階段接續既有前景導航，收斂平台定位介面，並使用 Simulator 的系統位置注入驗證。iOS 16.4 runtime 缺席、實體 iPhone、簽章、Google Places 授權，以及實際鎖屏仍是獨立項目。

## 第三階段：平台介面與 iOS 原生定位（2026-11-20）

### 定位資料流與行為

| 入口 | 資料流 |
| --- | --- |
| 單次定位／規劃起點 | `LocateControl`、`PlanPanel` → `geolocation.ts` → `client.ts` 送出 `requestLocation`，等待相同 ID 的 `lane-native/locationResult` → 選定來源的 `getCurrentPosition` → 把 `{longitude, latitude}` 轉為 `[經度, 緯度]`。關閉面板、手動選起點或進入導航時取消等待，iOS 也同步刪除 native 登記。 |
| 持續導航 | `useDrive` 先確認授權，`GpsDriver` 用同一 `LocationSource` 啟停訂閱。`gpsNav.ts` 以共同路線帶、車道、待轉、偏航和抵達策略消化位置，單點重規劃沿用同一訂閱。 |
| iOS 橋接 | `App → window.LaneNative.postMessage → LocationService → CLLocationManager`，`position`、`positionError`、`locationAuthorization`、`heading`、`lifecycle` 由 `lane-native` 回傳。`Bridge.js` 在同一原生來源多工單次與持續請求，用跨文件唯一的 ID 濾掉延遲回覆。重載或 WebKit 程序終止時，原生清除訂閱與定位需求。iOS 橋接無法連線時顯示錯誤。 |
| Android／瀏覽器 | Android 既有授權命令與 WebView `navigator.geolocation` 繼續使用。瀏覽器使用同一 Geolocation 介面。App 內的 Simulator 虛擬工具與 Core Location 各自只提供定位，兩者共用位置檢查和 `GpsDriver`，導航中鎖定來源。 |

- Core Location 送出 Unix 毫秒、m/s、公尺與角度，不合法的必填欄位捨棄，未知高度、速度和航向用 `null`。開始／恢復前的定位、超過 10 秒、超前本機時鐘超過 1 秒、重複及倒退資料皆擋在導航外。車速由共用核心轉為 km/h，缺值時使用連續定位的位移和時間估算。
- 單次起點與車道導航均要求精確位置。首次要求使用期間授權，拒絕、受限、概略與系統定位服務關閉各有提示。系統服務查詢離開主執行緒。授權改變時停止產生進度，持續訂閱在恢復精確授權後等待新位置。Core Location 暫時沒有 fix 時等待後續回呼，前景定位逾時維持既有 15 秒並支援恢復。離開前景時停止定位與羅盤並暫停定位逾時計時，回到前景才重新啟動。
- 導航優先使用可信的路線／路網切線或行進位移，iOS 在移動且精度可靠時可用 course 補足方向。低速保留車頭，羅盤只在尚無車頭時補值。真北可用時優先，否則採磁北，精度不可靠或超過 3 秒即隱藏。 [Apple 精度授權](https://developer.apple.com/documentation/corelocation/cllocationmanager/accuracyauthorization) · [Core Location 航向精度](https://developer.apple.com/documentation/corelocation/cllocation/courseaccuracy)

### 本輪實際驗證

使用 Xcode 26.2、iPhone 17 Pro Simulator、iOS 26.3.1。測試工具使用 `simctl location start` 注入系統座標，測後清除，拒絕測試也恢復了原先的測試授權。

| 入口 | 結果 |
| --- | --- |
| `node ios/tools/build-web.mjs all`；`npm run build`；`node tools/sync-web-assets.mjs` | 306 項共用測試通過，包含 35 組楠梓人工參考。24 組預計算前後路由一致，其中 22 組有解。iOS Debug／Release 資產與 Android 正式資產均同步並通過內容校驗。官方道路、待轉區與參考資料的位元組維持原樣。 |
| `node ios/tools/test-simulator.mjs debug` | 9 項 XCTest、2 項 XCUITest 通過。單次定位由 Core Location 送出 `[120.2758, 22.73310799]`，精度 5 m，回覆後 native watch 歸零。使用 Core Location 規劃到國立高雄大學並開始導航。瀏覽器定位 getter 設為一旦呼叫就拋錯，兩筆系統 fix 仍成功抵達 WKWebView，緯度由 `22.73314414` 更新至 `22.73315317`，時間差約 1 秒。畫面顯示 4 km/h、前方 150 公尺左轉與車道指引。 [Simulator 原始畫面](ios-evidence/stage3/system-location-hud.png) |
| 同一 Debug 測試中的暫停、恢復與重載 | 原生轉入 inactive 後停止更新，畫面顯示暫停，1.25 秒觀察期間收到 0 筆位置。回到前景由新位置清除暫停訊息，訂閱維持 1 個。重載 WKWebView 時降為 0，重新導航為 1，結束後為 0。原有偏航測試仍在同一訂閱重規劃並抵達。 |
| `node ios/tools/test-simulator.mjs release` | 2 項 XCUITest 通過。正式包以系統注入定位啟動前景導航，實際按 Home 再返回後恢復方向指引，並能結束導航。 |
| `node ios/tools/test-simulator.mjs denied` | 1 項 XCTest 通過。實際撤銷 App 的 Simulator 定位授權，確認授權訊息、單次定位 `denied` 錯誤與訂閱清理。概略、全域服務關閉、受限、過期、逾時與無效方向由 Swift／Node 測試覆蓋。 |
| iPhone 目標與 Android 回歸 | Release `generic/platform=iOS` arm64 未簽章建置成功。以 Gradle Wrapper 8.14.3、JDK 21、SDK 36 執行 `assembleDebug testDebugUnitTest --offline --rerun-tasks`，產出 28 MB Debug APK，1 項單元測試通過。Android 此輪使用建置與測試結果驗證，裝置操作仍待測。 |

完整 Xcode log 與 `.xcresult` 位於 `ios/.build/test-results/` 的 `debug-2026-11-20T15-17-59-204Z`、`release-2026-11-20T15-21-12-291Z`、`denied-2026-11-20T15-22-04-752Z`。首輪共用測試有一處沿用舊式單次定位參數，改為新介面後全數重跑通過。

### 待確認及下一階段

- 實體 iPhone 的 GPS、磁場干擾、初次授權彈窗、概略位置和全域服務設定切換待實際操作。iOS 16.4 執行需對應 runtime 或裝置，有簽章的 iPhone 安裝需 Team 與實體裝置。
- Home 已驗證前景導航暫停與恢復。背景持續導航及鎖屏持續導航目前未支援，真正鎖屏的操作行為仍待獨立驗證。
- 第四階段收斂為可移除的開發面板。第五階段串通主要操作，第六階段處理語音、設定與生命週期，第七階段做 Simulator 完整回歸。進入實體 iPhone 時完整刪除虛擬來源。系統注入測試的結果屬 Simulator 操作證據。Google Places 仍需要有效且受限制的金鑰。

## 第四階段：前期虛擬導航

### 行為與時間語意

- 選「虛擬定位」後，可由開發面板進入原有地圖選點和地標搜尋。開始導航仍走 `useDrive` 與 `GpsDriver`。虛擬來源把 `CLLocation` 交給第三階段的 `LocationService`，再以相同的 `LocationSource` 介面回到道路匹配、車道、偏航、測速、語音及抵達。
- 每趟只擷取一次起始路線用作初始行進軌跡。情境中的「保持直行」鎖定當時行向，往前連續行駛。共用核心重算時只通知面板的重算計數，軌跡、進度和行向保留。
- 1x、3x、8x 分別約每 1、⅓、⅛ 個真實秒送一筆位置，每筆都代表 1 模擬秒，正常前進 8 m，車速報 8 m/s（28.8 km/h）。匹配的時間差、停車抵達與 ETA 使用模擬時鐘。位置有效性、定位逾時與重算 CPU 冷卻仍使用系統時間。地圖補間適配播放倍率，轉向與測速繼續用同一套公尺與 km/h 門檻。倍速播放中會略過來不及播完的一般提示，迫近轉向與抵達沿用既有優先級。
- 暫停取消來源的計時器、web 位置逾時與待執行重算，凍結位置與模擬時間。繼續時沿原軌跡送新位置。停車繼續送速度 0，定位抖動只改樣本座標及精度。訊號中斷保留行進但停止送 fix，恢復後以當下位置繼續。結束與離開前景會停止先前的定位工作。

### 後期移除項目

| 範圍 | 檔案、介面與入口 |
| --- | --- |
| 來源與 UI | 改寫的 `ios/LaneDev/SimulatorLocationSource.swift` 與新增的 `SimulatorNavigationPanel.swift`。刪除預設錨點、倍率、模擬時計、原始軌跡、保持直行、停車、抖動、中斷、位置回呼和控制項 `location-source`、`sim-choose`、`sim-playback`、`sim-end`、`sim-scenarios`、`sim-rate`、`sim-status`。 |
| 原生橋接 | `NavigationViewController.swift` 的 `LaneSimulator` document-start 注入、`simulatorControl`、`simulatorPrepare`、`simulatorPlanStatus`、`simulatorRouteChanged`、`simulatorArrived` 及倍速語音佇列限制。`LocationService.swift` 的模擬來源切換、暫停／中斷回報、`motionTimestamp` 和 `playbackRate` payload。`Bridge.js` 的暫停自訂文案及 `SpeechService.swift` 的 `queueIfBusy` 由本階段使用，可隨相關入口移除。 |
| 共用前端 | `native/platform.ts` 的 `LaneSimulator`，`App.tsx` 的點選／結束 handler，`plan/PlanPanel.tsx` 的就緒狀態／開始 handler。`nav/useDrive.ts` 的 prepare、noteReroute 與 arrive，`gpsNav.ts`、`gpsAnimation.ts`、`driveState.ts`、`DriveHUD.tsx` 的模擬時鐘、畫面插值倍率及 ETA 欄位。 |
| 組態與資源 | `project.pbxproj` 的面板／來源引用、`generate-project.rb` 的 `LANE_SIMULATOR_NAVIGATION`、`verify-web-mode.sh` 的旗標比對、`BundleSchemeHandler.swift` 的開發模式條件。Vite `ios-simulator`、`.web/ios-simulator/public`、`client-policy.json.simulatorTools` 與 `build-web.mjs`、`package-client.mjs`、`tools/sync-web-assets.mjs` 中對應的模式／檢查。面板由 UIKit 建立，軌跡從現有規劃或直行操作產生，沒有另包 GPX、道路或地圖資料。 |
| 測試與操作指令 | `ForegroundNavigationTests.swift` 的虛擬用例、`ForegroundUITests.swift` 的開發面板操作、`ios/tools/test-simulator.mjs` 的虛擬測試選取、`ios/README.md`、`AGENTS.md` 的前期例外和移植計畫。保留純 Core Location、Android／瀏覽器、定位契約等回歸。歷史證據可留在 `docs/ios-evidence/stage4/`。 |

### 實際操作與證據

2026-11-20 使用 iPhone 17 Pro Simulator（iOS 26.3.1）與 Xcode 26.2 操作內建資產。

| 項目 | 結果 |
| --- | --- |
| 面板選點與正常導航 | XCUITest 用「選起終點」開啟既有規劃，分別選高雄大學產學育成中心及國立高雄大學，以面板的「開始」進入導航。畫面為 3x，速度顯示 29 km/h，實際有轉向與車道指引。 [行駛畫面](ios-evidence/stage4/driving.png) |
| 應轉未轉 | 起始導航提示左轉後使用「保持直行」。共用核心在累積行駛 136 m 時已完成重算，當時的直行方位約 145.75°。重算後再走 24 m，軌跡的 191 個起始點與行向相同，定位訂閱維持 1 個。結束後訂閱與計時工作歸零，切回 Core Location。 [偏航重算畫面](ios-evidence/stage4/missed-turn.png) |
| 暫停／繼續 | 實際點按面板暫停、切換倍率後繼續，也按 Home 再回到 App。另在整合測試停住 1.25 個真實秒，行駛里程與模擬秒數沒有增加，來源沒有 timer 或待送初始 fix，訂閱保留供恢復。 [暫停](ios-evidence/stage4/paused.png) · [繼續](ios-evidence/stage4/resumed.png) |
| 停車／抖動／中斷 | 停車時 HUD 顯示 0，虛擬里程凍結。開啟抖動時擷取兩筆不同座標，速度皆為 0，回報精度 14 m。中斷期間車仍前進至少 16 m，WKWebView 收到 0 筆位置，恢復後重新收到 fix 並恢復 29 km/h。 [訊號中斷](ios-evidence/stage4/signal-outage.png) |
| 自然抵達與語音 | 1x、3x、8x 切換後沿起始路徑前進 1,032 m、累積 132 個模擬秒，由共用核心顯示抵達，未注入終點座標。抵達後訂閱及來源 timer 均歸零，本次導航收到 11 次原生語音開始回呼。 [抵達畫面](ios-evidence/stage4/arrival.png) |
| 倍速 | 同一行駛測試量得約 1.000、0.334、0.125 個真實秒一筆。三組各筆間距皆為 1 模擬秒／8 m，速度 28.8 km/h。 |

- `node ios/tools/build-web.mjs all` 完成兩種 iOS 資產建置。306 項共用測試及 35 組楠梓參考通過，24 組路由預計算前後一致。`npm run build` 和 `node tools/sync-web-assets.mjs` 更新 Android 的正式資產。官方道路、待轉區與參考路線資料維持原樣。
- `node ios/tools/test-simulator.mjs debug` 通過 11 項 XCTest、2 項 XCUITest。`release` 通過 2 項 XCUITest，包含 Core Location 前景導航和 Home 復原。`denied` 通過 1 項實際撤銷授權測試。完整 Xcode log 與 `.xcresult` 位於 `ios/.build/test-results/` 的 `debug-2026-11-20T15-46-15-803Z`、`release-2026-11-20T15-48-45-960Z`、`denied-2026-11-20T15-49-36-592Z`。另以 `stage4-resume.xcresult` 重跑面板操作，在新 fix 清除暫停提示後保存繼續畫面。
- iPhone arm64 Debug 和 Release 的未簽章建置成功。掃描兩個 iPhone App 及 Simulator Release 的 native executable、Debug dylib 及 Web 資產，確認皆使用 `ios-release`，腳本 SHA-256 正確，未含虛擬來源、命令、面板、時計及倍率標記。Simulator Debug 的相同掃描確實找到工具。另把開發旗標傳給 Release 的資產校驗，確認建置校驗會拒絕組態不一致。
- Gradle Wrapper 8.14.3、JDK 21、Android SDK 36 執行 `assembleDebug testDebugUnitTest --offline --rerun-tasks` 成功，APK 內的資產政策及實際 JS 均排除 iOS 開發功能，1 項 Android 單元測試通過。Android 裝置操作待實機驗證。

首輪建置修正了 Swift 非同步測試輔助函式的逃逸 closure。首輪操作時這個 Simulator 的語音偏好原本關閉，測試已改為開啟並於結束時還原，重跑收到原生導航語音回呼。實體 iPhone 的 GPS、喇叭或藍牙輸出、簽章和道路驗收留到實機階段。背景及鎖屏持續導航目前仍屬前景範圍之外，這一輪的 Home 復原測試只證明回前景可接續。

---

## 第五階段：主要操作流程（2026-11-21）

- 本地與常用地點選取共用同一份內建地標，選定後關閉鍵盤並顯示目的地。規劃預設取得目前位置，也可以對任一站搜尋或明確選取地圖點。地圖替換會清除原站的來源與地址，再依現有路網吸附。
- 上移與下移只作用於停靠點。每次更換、排序或切換汽機車時都使用現有車種與通行規則重算。既有楠梓人工參考的兩端點、方向、車種匹配門檻保留，多停靠點與未命中組合走一般規劃。
- 偏航後把待經站點與新路線的里程對應一起更新，另以當前路線的最大進度辨識已經過的停靠點。HUD 顯示下一站，靠近終點的抵達判定也會先檢查中途站是否已完成。
- WKWebView 由 UIKit 安全區及 `keyboardLayoutGuide` 定位。iOS 搜尋欄維持 16px，清單與規劃內容可捲動。「開始導航」固定在預覽面板下方，主要點按控制至少 44pt。仍沿用現有 React、MapLibre、路網和導航核心。
- iOS 使用固定版 GooglePlacesSwift 10.15.0 的 Places UI Kit，iOS bundle 不載入 Google 的 JavaScript bootstrap。使用者按下 Google 搜尋才呼叫原生 `PlaceSearchView`。原生使用 Info.plist 中的 iOS 專用金鑰與 Bundle ID；WKWebView 只接收是否設定的布林值，以及本次選取的 ID、座標與取消／錯誤。API Key 設定檔忽略不追蹤。 [iOS 設定步驟](../ios/README.md#google-places可選) · [Google 原生 Places UI Kit](https://developers.google.com/maps/documentation/places/ios-sdk/places-ui-kit-get-started) · [Google 自訂來源及 Referer 指引](https://developers.google.com/maps/api-security-best-practices#host-your-browser-based-apps-on-a-server)

測試使用 iPhone 17 Pro Simulator（iOS 26.3.1）與 Xcode 26.2。首次操作發現鍵盤開啟時，後段搜尋結果要在清單內捲動，替換站點時其他站列也會擠壓輸入區。編輯模式改為只顯示當前站，使用目前位置與地圖選點操作放在輸入欄下方，避免搜尋焦點改變時按鈕移位。另調整測試使用實際出現在客戶端索引的地標，維持既有大眾運輸過濾。

| 實際操作 | 本輪結果 |
| --- | --- |
| 本地地標與常用地點 | 在 WKWebView 從常用地點編輯選入國立高雄大學，再從常用捷徑選取該地點，確認目的地摘要並啟動路線。測試結束還原本機偏好。 [常用地點](ios-evidence/stage5/saved-place.png) |
| 鍵盤、安全區與手選起點 | XCUITest 開啟軟體鍵盤，捲動「高雄大學」搜尋結果並點選鍵盤上方的「國立高雄大學」。選取後確認鍵盤關閉。規劃先用目前位置，再按「在地圖上選起點」點實際地圖並確認起點值改變。實測「開始導航」與「結束」高度至少 44pt，底部結束按鈕留在 WKWebView 安全範圍內，實際點按離開導航。 [鍵盤搜尋](ios-evidence/stage5/keyboard-search.png) · [地圖起點與預覽](ios-evidence/stage5/map-start-preview.png) |
| 預覽、排序、車種及重啟 | 先取得目前位置，再搜尋替換起點與終點，新增高雄大學郵局及國立高雄大學游泳池，操作上移並確認順序。重新計算機車與汽車路線，收合及打開轉向步驟。開始後看到下一站與 ETA，點結束後清除 GPS 訂閱，再規劃並開始一段新導航。 [排序預覽](ios-evidence/stage5/reordered-waypoints.png) |
| 路口待轉、測速及導航資訊 | 機車由援中國民小學往綜合籃球場，預覽出現待轉步驟，導航在路口 `2601136103` 顯示待轉牌、車道指引與 ETA。汽車由中和里里辦公室往中和兒童公園，在德中路與大學二十九路口路線上出現測速警示與剩餘距離，顯示速限 60 km/h。 [待轉](ios-evidence/stage5/two-stage.png) · [測速](ios-evidence/stage5/speed-camera.png) |
| 途經站後連續偏航 | 依序將高雄大學產學育成中心、高雄大學郵局設為停靠點。經過第一站後操作保持直行，核心連續兩次重算都保留郵局為下一站，定位仍只有一個訂閱。未新增、移除或改寫道路及通行條件。 [偏航後的下一站](ios-evidence/stage5/waypoint-reroute.png) |
| Google 未設定 | Simulator 顯示缺金鑰狀態，沒有 Maps JavaScript bootstrap。即使直接抵達原生橋接，缺金鑰也回覆明確錯誤並保持本地搜尋可選取。查詢結果回傳、請求取消以及內容欄位由共用橋接測試檢查。線上結果與受限制金鑰的正向驗證需提供有效金鑰。 [缺金鑰畫面](ios-evidence/stage5/google-key-missing.png) |
| 抵達 | 重跑既有整合導航，車輛沿真實路線資料行進至國立高雄大學，由共用核心判定抵達，完成按鈕回到瀏覽，定位與導航計時器清空。 [抵達](ios-evidence/stage5/arrival.png) |

### 建置與回歸

- `node ios/tools/build-web.mjs all` 通過 311 項共用測試，涵蓋 35 組楠梓人工參考路線。24 組預計算前後的路由一致，其中 22 組有解。兩種 iOS 前端建置及包內資產稽核通過，官方道路、待轉區及參考資料的原始檔無差異。
- `node ios/tools/test-simulator.mjs debug` 通過 15 項 XCTest 和 3 項 XCUITest。`release` 通過 2 項 XCUITest，涵蓋系統定位、離線地圖觸控及回前景。`denied` 通過 1 項定位權限拒絕測試。各組的原始日誌及 `results.xcresult` 保存在 `ios/.build/test-results/` 下的 `debug-2026-11-20T16-24-33-878Z`、`release-2026-11-20T16-28-04-514Z`、`denied-2026-11-20T16-28-59-572Z`，時間戳使用 UTC。
- `LaneDevRelease` 的 `generic/platform=iOS` 未簽章 arm64 建置通過，`MinimumOSVersion` 為 16.4。成品含 `ios-release` 前端與原生 Google SDK，資產稽核確認排除 Simulator 虛擬導航入口。
- Android 前端用 `npm run build` 與 `node tools/sync-web-assets.mjs` 重新打包。Gradle `assembleDebug testDebugUnitTest --offline --rerun-tasks` 通過並產出 `app/build/outputs/apk/debug/app-debug.apk`，既有 1 項 JUnit 通過。APK 保留 Android 的 Google JavaScript 載入路徑。未使用 Android 裝置操作。

使用者指定第六階段先完成原生語音、設定與 App 生命週期。轉入實體 iPhone 時，依第四階段清單刪除 Simulator 虛擬工具，並將相關測試改為系統定位或實機案例。iOS 16.4 目前是部署編譯目標，實體 iPhone、簽章、真正鎖屏與 Google 成功授權的驗證各自待補。

<a id="stage6"></a>

## 第六階段：原生語音、設定與 App 生命週期（2026-11-21）

- iOS 以 `AVSpeechSynthesizer` 使用已安裝的 zh-TW 聲音，找不到時使用已安裝的其他中文聲音。轉向、待轉、車道、測速及抵達的文案和優先順序沿用共用核心。iOS 逐則交給合成器，待播最多兩則，指示從發出起超過五秒即捨棄。迫近轉向及抵達沿用原有高優先旗標，插播時中斷現有語音並清除排隊項目。
- 導航靜音立即停止自動播報，設定內可手動試聽或停止。音訊中斷會丟棄現有與待播指示，新的指示在中斷結束或 App 回到前景後重新取得音訊工作階段。App 也在重規劃換線及定位中斷時清除舊語音。 [Apple 音訊中斷文件](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)
- iOS 語音下載及全機定位服務各顯示對應設定路徑，LaneDev 定位權限按鈕使用公開的 App 設定入口。導引視距、語音開關及常用地點沿用自訂來源的本機偏好。 [設定操作](../ios/README.md#語音定位與前景導航)
- 防熄屏由原生在前景導航控制。Scene inactive 時停止定位及語音並恢復自動休眠，返回前景的同一導航等待新位置。WKWebView 重載、失敗、程序終止或 Scene 斷開會撤銷原文件的定位、語音、反查地址與搜尋回呼，重新載入後可再規劃。

### Simulator 證據與限制

| 驗證 | 實際結果 |
| --- | --- |
| 中文試聽與語音回呼 | 使用 iPhone 17 Pro Simulator（iOS 26.3.1、Xcode 26.2）。在語音導航關閉時手動試聽收到 AVSpeechSynthesizer 的 `didStart`、`didFinish` 回呼。第二次試聽使用停止按鈕，另一次在試聽中關閉語音開關，兩次均清除當前及待播項目。系統回報 zh-TW 可用、輸出 Speaker、音量 60%。 [試聽畫面](ios-evidence/stage6/speech-preview.png) |
| 插播、過期與音訊中斷 | 實際合成器確認迫近轉向覆蓋正在播的指令及待播測速提示。利用測試時鐘推進六秒，確認排隊提示無開始回呼。注入 iOS 音訊中斷通知，驗證清空待播，收到結束通知後下一則可播；另測沒有結束通知而回前景時仍能播放新提示。空聲音清單也以測試注入，確認提示下載、沒有啟動播放。 |
| iOS 設定入口 | XCUITest 實際點按語音說明、全機定位服務說明及 App 定位權限。兩個說明各顯示 iOS 設定路徑。App 定位權限按鈕開啟 iOS 的「設定」App，可返回 LaneDev。 |
| 偏好持久化 | 以 XCUITest 實際切換語音、改導航視距、編輯住家地址。終止並重新啟動 App 後，三項設定在畫面上皆保留。測後還原偏好。 [重開後的設定](ios-evidence/stage6/relaunched-settings.png) |
| Home、定位中斷與重載 | XCUITest 按 Home，確認 App 進入背景，回前景仍可接續導航。系統位置注入配合 hosted XCTest 確認離開前景無新定位且防熄屏解除，返回由新定位恢復一個訂閱。模擬訊號中斷會清除待播，WebView 實際重載會清空定位訂閱、語音與防熄屏，可以重新導航。 |
| 人工聽音 | 未執行。回呼與 Speaker 路由是系統紀錄，尚未確認喇叭實際可聽、語音清晰度、實體靜音開關或藍牙的表現。來電等真實音訊中斷未測，通知注入只驗證 App 如何處理。 |
| 背景與鎖屏 | 已以 Home 驗證背景暫停及返回。Simulator 的鎖定選單無法由本機自動化操作，macOS 拒絕輔助取用（`-1719`），本輪未實測鎖屏。未配置背景定位或背景音訊，背景與鎖屏持續導航目前未支援。 |

### 建置與回歸

- `node ios/tools/build-web.mjs all` 通過 312 項共用測試，涵蓋 35 組楠梓參考路線。24 組預計算前後的路由一致，其中 22 組有解。兩種 iOS 資產通過校驗，官方道路、待轉區及參考路線檔案無差異。
- `node ios/tools/test-simulator.mjs debug` 通過 17 項 XCTest 與 5 項 XCUITest。`release` 通過 4 項 XCUITest，包含系統定位、離線地圖、設定與回前景。`denied` 通過 1 項定位拒絕測試。各組的 `xcodebuild.log` 和 `results.xcresult` 位於 `ios/.build/test-results/` 的 `debug-2026-11-20T17-14-28-217Z`、`release-2026-11-20T17-19-03-308Z`、`denied-2026-11-20T17-20-45-924Z`，時間戳使用 UTC。
- `npm run build` 與 `node tools/sync-web-assets.mjs` 已更新 Android 前端。以 JDK 21、Android SDK 36 及 Gradle 8.14.3 跑 `bash gradlew assembleDebug testDebugUnitTest --offline --rerun-tasks`，產出 Debug APK，既有 1 項 Android 單元測試通過。本輪未在 Android 裝置操作。
- `LaneDevRelease` 通過未簽章的 `generic/platform=iOS` arm64 建置。最低部署版本為 iOS 16.4，Release App 及其前端包的虛擬導航入口排除稽核通過。

首輪中斷測試發現回前景沿用舊合成器時，新指示可能收不到完成回呼。丟棄播報時同步釋放合成器，重跑通過。另一次 XCUITest 卡在等待 Simulator 動畫，重啟 Simulator 後通過完整回歸。

下一階段依使用者指定先完成 Simulator 完整回歸。進入實體 iPhone 前須按第四階段清單完整刪除虛擬導航。保留一般前景語音、手動試聽與系統定位測試，再以簽章裝置驗證真實音訊中斷、人工聽音、鎖屏與前景恢復。iOS 16.4 執行環境、簽章及實體裝置仍待安排。

<a id="stage7"></a>

## 第七階段：Simulator 完整驗收與回歸（2026-11-21）

工作區與 `feat/ios-navigation` 維持原位。使用 iPhone 17 Pro Simulator、iOS 26.3.1（23D8133）、Xcode 26.2（17C52），Mac 為 Apple M4 Pro／24 GB，macOS 15.7.9（24G830），Node.js 26.0.0／npm 11.12.1。App 直接讀取打包資產。

### 可重跑指令

在 LaneDev 根目錄執行。先啟動測試用 iPhone Simulator，或設定 `LANE_SIMULATOR_UDID` 指向已啟動的裝置。各組會依序使用同一個 Simulator。

```bash
node ios/tools/build-web.mjs all
node ios/tools/test-simulator.mjs system
node ios/tools/test-simulator.mjs debug
node ios/tools/test-simulator.mjs release
node ios/tools/test-simulator.mjs denied
(cd web-source && npm run build)
node tools/sync-web-assets.mjs
bash gradlew assembleDebug testDebugUnitTest --offline --rerun-tasks
```

`system` 以 `simctl location` 注入固定軌跡，並用 `simctl privacy` 在導航中撤銷及授予權限。座標由 Core Location 進入原生橋接與共用核心。系統低精度與定位失敗由 XCTest 注入 delegate 輸入，精度恢復再由系統軌跡驗證。腳本測後清除系統軌跡並恢復測試 App 的定位授權。Debug 的虛擬案例由 App 內的 Simulator 定位來源供應；Release UI 驗證正式包的系統定位、觸控與啟動。

Android 回歸使用 Gradle 8.14.3、JDK 21 與 Android SDK 36。首次安裝前端套件、Gradle 或 Android SDK 時須準備對應快取，再執行上方的離線 Gradle 指令。

### 案例結果

| 案例 | 虛擬定位 | Core Location |
| --- | --- | --- |
| 直行、轉彎、待轉、抵達、結束 | 虛擬車輛沿路網正常前進與轉向，機車顯示待轉，核心判定抵達，結束清除訂閱與計時器。 [導航](ios-evidence/stage7/virtual-navigation.png) · [抵達](ios-evidence/stage7/virtual-arrival.png) | 固定軌跡走援中國民小學至綜合籃球場，顯示待轉牌及後續右轉，再自然抵達。完成後結束亮屏控制，定位和播報清空。 [待轉](ios-evidence/stage7/system-two-stage.png) · [抵達](ios-evidence/stage7/system-arrival.png) |
| 應轉未轉、偏航與接回 | 讓來源自己保持直行，重算後原始軌跡仍維持方向。另以同一來源回放獨立返程，確認接回後仍是同一筆導航訂閱。 [偏航](ios-evidence/stage7/virtual-reroute.png) · [接回](ios-evidence/stage7/virtual-rejoined.png) | 固定軌跡錯過左轉後觸發成功重算；另一段軌跡接回並真正靠近棒球場，HUD 才切換至高雄大學郵局。 [重算](ios-evidence/stage7/system-reroute.png) · [接回](ios-evidence/stage7/system-rejoined.png) |
| 多停靠點 | 第一次通過產學育成中心後，連續重算兩次仍保留郵局。 | 規劃棒球場、郵局兩站，核對重規劃前後下一站及實際 GPS 座標。 |
| 汽車／機車與禁行 | 操作兩車種重算。共用圖回歸另檢查國道 1 號 OSM way `25724914`，汽車路線使用該路段，機車走平行道路。 | 相同起終點的汽車步驟無待轉，機車步驟及 HUD 均有待轉。 |
| 停車、抖動、中斷、低精度、恢復 | 停車為 0、固定 6 m 抖動、中斷及恢復均由虛擬來源實際送出；150 m 測試值驗證凍結進度。 [虛擬低精度](ios-evidence/stage7/virtual-low-accuracy.png) | `simctl set` 提供停車和位置抖動；XCTest 透過 Core Location delegate 注入 150 m 精度及錯誤，後續從 OS 軌跡恢復。 [低精度](ios-evidence/stage7/system-low-accuracy.png) · [中斷](ios-evidence/stage7/system-interruption.png) |
| 定位拒絕、撤銷、重新授權 | 依賴系統權限的流程在 Core Location 驗證。 | 實際撤銷後顯示未授權並停定位，重新授權後同一個 watch 恢復。初次拒絕另跑 `denied`。 [撤銷畫面](ios-evidence/stage7/permission-revoked.png) |
| 路網外、不可達及搜尋失敗 | 規劃與本地搜尋由共用前端驗證。 | 系統起點在路網外時保留目的地並顯示改用地圖選點。另驗證路網外終點、輸入查無地點，以及原路網上有起終點卻不可達的案例。 [起點](ios-evidence/stage7/start-outside-network.png) · [終點](ios-evidence/stage7/destination-outside-network.png) · [不可達](ios-evidence/stage7/unreachable-route.png) · [搜尋](ios-evidence/stage7/search-empty.png) |
| 鍵盤、安全區、手動拖圖與重新置中 | XCUITest 操作鍵盤結果、手選起點、44 pt 開始／結束控制與拖圖後回置中。 [鍵盤](ios-evidence/stage7/keyboard.png) · [拖圖](ios-evidence/stage7/virtual-drag-recenter.png) | 正式包以系統定位實際拖圖，點「回到目前位置」恢復跟隨。鍵盤與安全區由同一套 WKWebView 介面覆蓋。 [正式包](ios-evidence/stage7/release-core-location.png) · [重新置中](ios-evidence/stage7/core-location-drag-recenter.png) |
| 語音開關、插播及結束 | 實際虛擬導航啟動中文提示。原生 XCTest 覆蓋試聽、靜音、高優先插播、過期與清除。 | 系統定位驅動第一則待轉語音，收到原生播放開始回呼。完成導航後確認語音已停止。插播、靜音與中斷恢復沿用相同原生語音服務。 |
| App 背景與返回 | XCUITest 按 Home 並回前景，重新接續並可結束。 | Core Location 整合 XCTest 驗證回前景等待新位置，Release UI 實際按 Home 後返回。 |

### 本輪修正

- 路網外的目前位置補上手動選起點的指示，原路網距離和通行限制沿用既有門檻。
- 重算後遇到路線重疊時，路線里程曾提早跳過尚未到達的停靠點。新增可信定位、實際接近及匹配里程的確認，完成一站才允許確認下一站。合併路線使用該停靠點在實際合併幾何上的里程。修正後返程的 GPS 確實進入第一站附近，再顯示下一站。
- iOS 導航跟隨有時會在 MapLibre 發出拖曳事件前打斷手勢。從首次觸碰就暫停鏡頭更新，後續能操作拖圖與「回到目前位置」。

共用測試 313 項通過。24 組預計算路由一致，其中 22 組有解。35 組楠梓人工參考路線的路徑與車道帶通過。官方道路、待轉區與參考路線檔案維持原位元組，產物中只有路網 manifest 的建置輸入雜湊更新，導航和繪圖來源的 SHA-256 均保持一致。Android APK 與 1 項既有單元測試通過，iPhone 未簽章 Release arm64 建置通過。

Simulator 共 32 項通過，包含 `system` 4 項、`debug` 17 項 XCTest 加 5 項 XCUITest、`release` 5 項 XCUITest 及 `denied` 1 項。各組 `results.xcresult` 及 `xcodebuild.log` 位於 `ios/.build/test-results/`，目錄為 `system-2026-11-20T17-57-53-760Z`、`debug-2026-11-20T17-50-28-868Z`、`release-2026-11-20T17-55-04-075Z`、`denied-2026-11-20T17-57-05-336Z`。系統截圖取自同組案例前次通過的 `system-2026-11-20T17-45-07-428Z`。目錄時間使用 UTC。

### Simulator 量測

| 項目 | 結果 |
| --- | --- |
| Release 啟動 | 終止 App 後重開 3 次，至「目前位置」可操作分別為 4,156、4,141、4,108 ms，中位數 4.14 秒。包含 XCUITest 啟動與無障礙查詢時間，OS 快取保留。 |
| Core Location 正常導航 | 每次 49 筆 OS 定位，兩輪送達間隔中位數 804–805 ms。每次有 48 筆可觀察的 HUD 文字變更，更新中位數 1 ms。 |
| Core Location 偏航與接回 | 每次 97 筆 OS 定位，兩輪送達間隔中位數 804–805 ms。每次有 46 筆 HUD 文字變更，更新中位數 1 ms。成功搜尋新路線兩輪分別耗時 43、49 ms。 |
| App 虛擬來源偏航 | 8x 場景的 20 筆定位，送達間隔中位數 125 ms。16 筆有 HUD 文字變更，更新中位數 1 ms。成功搜尋新路線耗時 8 ms。 |

HUD 用 WebView 的 `performance.now()` 量定位事件到可觀察的文字更新，每筆定位取一秒內最後一次相關更新。重算時間來自共用核心對同步各段搜尋的紀錄，包含該次路線搜尋，偏航等待、畫線及 GPU 顯示另有時間。量測使用上述 Simulator 注入頻率，留作後續裝置測量的對照。

### 剩餘問題

- 尚待驗證實體 iPhone、簽章、iOS 16.4 執行、實際 GPS／羅盤與真實中斷、音質及藍牙輸出。Simulator 的真實鎖屏操作仍未驗證，背景與鎖屏目前沒有持續導航。
- Google 金鑰仍未配置，驗證範圍為本地搜尋與缺金鑰提示。實機效能、耗電及長時間道路表現留待實體裝置測試。

### 實機驗收清單

- [ ] 進入實體 iPhone 階段前依第四階段清單完整移除 App 虛擬來源及相關測試入口，重跑 iOS、共用、Android 建置，掃描成品。
- [ ] 設定 Apple Development Team 與簽章，實機安裝並測最低支援 iOS 16.4。關閉 Mac 開發伺服器，核對本機包啟動、路網校驗、搜尋與重新開啟。
- [ ] 實地走正常轉向、待轉、測速、應轉未轉、偏航接回與停靠點順序，核對現場汽機車與車道限制。
- [ ] 測使用期間定位、拒絕、重新授權、精確位置開關、系統定位關閉與 GPS 中斷，核對裝置行進方向、羅盤與重新置中。
- [ ] 人工聽中文播報及插播，在 iPhone 喇叭、藍牙、靜音開關與來電情境分別記錄聽音與回呼。測 Home、鎖屏、返回前景與防熄屏。
- [ ] 使用有效且受限制的 Google iOS 金鑰驗證線上搜尋。以真實裝置記錄啟動、HUD、重算延遲、耗電與長時間導航。

<a id="stage8"></a>

## 第八階段：實體 iPhone 與虛擬功能移除（2026-11-21）

### 移除與成品核對

已刪除 App 內的替代定位來源、面板、軌跡、倍速、狀態與橋接。iOS 只有 `CLLocationManager` 的位置更新，經 `LaneGeolocation` 進入共用導航核心。時間、速度、動畫、抵達及 ETA 使用原有 GPS 或系統時間。iOS Vite 成品剔除瀏覽器開發模組，Debug 和 Release 的 Xcode 啟動設定也關閉定位模擬。

| 移除項目 | 結果 |
| --- | --- |
| 位置來源與面板 | 刪除 `SimulatorLocationSource.swift`、`SimulatorNavigationPanel.swift` 及 Xcode 專案引用。 |
| 橋接與導航狀態 | 移除來源切換、控制指令、`window.LaneSimulator`、虛擬計時、倍速和語音佇列接點。 |
| 網頁入口與建置 | iOS 已移除 `?sim` 使用路徑。刪除專用 Vite 模式、旗標、Xcode 驗證腳本和舊資產目錄。 |
| 驗證 | 獨立 App 已通過舊入口與測試資源稽核。Simulator 系統位置測試及 XCTest 保留於 App 之外。 |

前端改用單一 `ios` production build，Xcode 全組態打包 `ios/.web/public`。重建前刪除前期兩種資產輸出及本工作區的舊 App 產品。Xcode build phase 與 App 啟動同時要求 v2 資產政策。XCTest 實際確認 v1 包被拒絕，載入帶舊查詢參數的頁面及發送舊橋接請求也無法建立導航或定位訂閱。

獨立成品可執行 `node ios/tools/audit-app.mjs <LaneDev.app>`。稽核比較包內每個前端檔案與新產物的 SHA-256，掃描前端、Bridge.js、Swift 主程式的舊入口，並檢查測試插件與軌跡未出貨。Hosted XCTest 的 `build-for-testing` 會注入測試插件，出貨稽核採用獨立 `build`。

### 建置與 Simulator 回歸

- `node ios/tools/build-web.mjs` 通過 313 項共用測試，24 組預計算路由結果一致（22 組有解），35 組楠梓人工參考路線驗證通過。官方資料及參考路線皆唯讀。
- Android 正式包資產已重建，`bash gradlew assembleDebug testDebugUnitTest --offline --rerun-tasks` 通過，含 1 項既有單元測試。
- Simulator 共 31 項通過。`debug` 為 14 項 XCTest 加 5 項 XCUITest，`system` 為 5 項、`release` 為 6 項、`denied` 為 1 項。系統定位案例包括待轉、抵達、語音、偏航及停靠點、低精度、中斷、撤銷及恢復授權、規劃失敗及測速。這些操作由 Simulator OS 或 XCTest 提供位置資料。 [Simulator 抵達](ios-evidence/stage8/simulator-core-location-arrival.png) · [Simulator 測速提醒](ios-evidence/stage8/simulator-core-location-speed-camera.png)
- 原始 Simulator 日誌及測試結果在 `ios/.build/test-results/` 的 `debug-2026-11-21T07-44-01-407Z`、`system-2026-11-21T07-48-34-303Z`、`release-2026-11-21T07-51-11-359Z`、`denied-2026-11-21T07-53-43-720Z`，目錄時間使用 UTC。Release Simulator 的三次重開至可操作測值為 4,290、4,131、4,135 ms。
- 獨立 Debug／Release Simulator 與未簽章 iPhone Release arm64 建置已完成。各成品稽核均核對 45 個前端檔案。

### 實體 iPhone 12 與開發簽章

| 項目 | 實際結果 |
| --- | --- |
| iPhone 12（iOS 18.3、22D63） | USB 辨識、信任及 Xcode 配對完成。`devicectl` 確認 `pairingState: paired`、`developerModeStatus: enabled`、`ddiServicesAvailable: true`、`tunnelState: connected`。 |
| Bundle Identifier、佈建與定位設定 | 預設 `tw.lanepilot.lanedev.ios`。專案為自動簽章，可透過機器本機的 `Signing.local.xcconfig` 指定開發 Team。保留使用期間定位用途及精確定位提示，無 Always 定位權限、背景定位或音訊模式。 [實機安裝步驟](../ios/README.md#實體-iphone-安裝) |
| 簽章、安裝與啟動 | Apple Account 登入後使用有效的 Apple Development 憑證與本機 Team 設定。iPhone 12 Debug 自動佈建、簽章建置、macOS 簽章校驗、45 個前端檔案稽核及 USB 安裝均通過。首次啟動遇到裝置信任檢查，16:11 重試已由 `devicectl` 確認啟動成功。 [真機連線、建置與安裝輸出摘要](ios-evidence/stage8/iphone12-readiness.txt) |
| 搜尋、規劃與常用地點 | 真機 XCTest 通過本地搜尋、手動起點、加入兩個停靠點後排序、轉向步驟及汽機車預覽。真機 XCUITest 通過鍵盤開啟時點按住家、學校、公司捷徑，三個地點均帶入路線終點。 [iPhone 12 離線路線畫面](ios-evidence/stage8/iphone12-offline-route-preview.png) |
| 實際定位、語音與效能 | iPhone 12 的 Core Location 經 WKWebView 橋接回傳位置，單次請求 24 ms，水平精度 13.1 m；可能使用啟動後取得的系統位置。WebView 重新載入到地圖來源就緒 4,487 ms（Debug、單次）。中文試聽收到一次開始及完成回呼，停止後清空佇列，系統回報擴音輸出。人工聽音、實際行進方向、導航更新和偏航重算耗時仍待測。 |
| iPhone 生命週期 | 真機尚未操作低精度、權限變更、Home、鎖屏、音訊中斷及防熄屏。前景退回會暫停定位與語音是目前的實作及 Simulator 結果。背景及鎖屏持續導航未支援。 |

使用者回報的捷徑問題在 iPhone 12 重現。搜尋欄在點按時先失焦，React 會移除捷徑，按鈕未收到 click。讓搜尋欄保有焦點直到捷徑完成選取後，同一真機測試通過，已重新簽章、稽核、安裝並啟動修正版。iPhone 17 Pro Simulator 也通過同一觸控測試，結果在 `ios/.build/stage8-saved-shortcuts-simulator.xcresult`。修正版再次通過 313 項共用測試、24 組路線基準及 Android Debug APK 與單元測試。原始真機結果在 `ios/.build-device/stage8-iphone12-{followup,saved-before,saved-after}.xcresult`。 [真機輸出摘要](ios-evidence/stage8/iphone12-readiness.txt)

Google Places 首次真機查詢在 iPhone 12 遇到身分驗證失敗，同一 App 內的 Places API (New) 診斷也回報呼叫者沒有權限。使用者調整 Cloud 設定後，沿用本機金鑰及 Bundle ID `tw.lanepilot.lanedev.ios` 重測。Places UI Kit 回傳「國立高雄大學 楠梓」的結果，點選後 LaneDev 顯示 Google Maps 來源，並將該地點帶入路線終點。XCUITest 在 iPhone 12（iOS 18.3）通過。 [Google Places 設定](../ios/README.md#google-places可選) · [真機輸出摘要](ios-evidence/stage8/iphone12-readiness.txt)

依第七階段的實機清單驗證實際走行、偏航恢復與抵達。iPhone 12 的 iOS 18.3 也無法驗收最低支援版本 iOS 16.4。內建地標和常用地點可離線使用。

<a id="stage9"></a>

## 第九階段：正式版本整理與交付（2026-11-21）

交付在原工作區及 `feat/ios-navigation` 完成。環境為 macOS 15.7.9 arm64、Xcode 26.2（17C52）、iOS SDK 26.2、Node 26.0.0、npm 11.12.1、Temurin JDK 21.0.13.1、Android Platform 36／Build Tools 35.0.0。

### 重建順序與產物

1. 取得包含本階段變更的原始碼，依 [根 README](../README.md) 安裝環境。執行 `node ios/tools/build-web.mjs` 安裝 lockfile 依賴、跑共用測試、生成路網、打包並同步 iOS 資源。Xcode 開啟 [LaneDev.xcodeproj](../ios/LaneDev.xcodeproj)，依 `Package.resolved` 解析 GooglePlacesSwift。
2. 在 [iOS README](../ios/README.md) 選擇 iPhone 17 Pro Simulator 或 iPhone 12 實機指令。兩者都使用 `LaneDevRelease` 和 Release 組態，驗收個別使用 `simctl` 或 `devicectl` 安裝啟動。
3. 共用來源更新時，在 `web-source/` 執行 `npm run build`，再執行 `node tools/sync-web-assets.mjs` 和 `bash gradlew assembleDebug testDebugUnitTest`。Android 也保留原有 PowerShell 入口。

| 本機成品 | 路徑與用途 |
| --- | --- |
| iPhone 17 Pro Simulator | `ios/.build/stage9-standalone/Build/Products/Release-iphonesimulator/LaneDev.app`。Simulator 操作與回歸使用。 |
| iPhone 12 | `ios/.build-device/stage9-standalone/Build/Products/Release-iphoneos/LaneDev.app`。開發簽章，用於已佈建裝置的實機操作。 |
| Android | `app/build/outputs/apk/debug/app-debug.apk`。Android 建置回歸與本機安裝。 |

兩個獨立 iOS 成品皆核對 45 個包內前端檔案及資源版本。已稽核前端、Swift 執行檔、橋接、測試資源和兩份 scheme，確認虛擬導航、倍速、舊入口及測試軌跡均已排除。共用 HTML 頁面標題已從 NavSim 更新為 LaneDev。 [第九階段驗證證據](ios-evidence/stage9/verification.txt)

### 功能驗收表

| 功能 | 完成項目 | 驗證證據 | 已知限制與待辦 |
| --- | --- | --- | --- |
| 打包與重建 | iOS Release 共用 scheme、鎖定的 JS／Swift 依賴、預計算路網、校驗及同步工具。 | 重跑來源流程與兩種 iOS Release 建置。實機成品通過簽章及資產校驗。 | 開發簽章供已佈建裝置使用。公開發佈需另外 Archive、發佈簽章及 App Store Connect。 |
| 本機啟動、地圖、搜尋、常用地點、規劃 | App 內建地圖、地標、字型、路網與設定。 | Mac 未運行開發伺服器時，Simulator Release 完成啟動、搜尋與規劃，iPhone 12 Release 完成啟動、拖曳、縮放、旋轉及住家／學校／公司捷徑帶入終點。第八階段 iPhone 12 已驗證完整離線手動規劃。 | 路網覆蓋以內建資料範圍為準。地址反查取決於系統服務。 |
| 路由與 Android 回歸 | 共用路由、汽機車限制、車道、待轉與楠梓路線規則。 | 313 項共用測試、24 組路線基準（22 組有解）、35 組楠梓人工參考路線、Android Debug APK 和 1 項 JUnit 測試通過。官方資料差異檢查通過。 | Android 實機本階段未操作。 |
| 前景定位與導航 | Core Location 唯一來源，沿用車道、測速、偏航、停靠點及抵達判斷。 | Simulator 以 OS 位置驗證前景導航、應轉未轉後重算、保留停靠點與抵達。第八階段 iPhone 12 實際位置通過原生橋接。 | 實際道路移動、羅盤、低精度、偏航回程及抵達仍待道路驗收。 |
| 中文語音與生命週期 | 原生中文語音、停止與設定持久化。離開前景暫停位置、語音及防熄屏，返回等待新定位。 | Simulator 的導航按 Home 後返回通過；第八階段 iPhone 12 通過中文語音回呼。本階段 iPhone 12 先退到主畫面再終止重開，保留了新語音設定。 | 語音設定剛切換便由 XCTest 終止程序時，兩次讀回舊值。完整偏好測試在實機編輯住家時遇到 XCTest 未取得鍵盤焦點，待人工確認。實機聽音、導航時的背景恢復、音訊中斷、鎖屏及防熄屏仍待驗證。背景及鎖屏持續導航目前未支援。 |
| Google Places | 原生 Places UI Kit 選配，回傳當次規劃所需的地點。 | 第八階段 iPhone 12 線上查詢成功，結果帶入路線終點。 | 需有效 iOS 金鑰、啟用相應 API、連網。 |
| 憑證與版本相容 | 本機設定、簽章資料及成品由 Git 排除。 | 檢查交付候選內容與目前分支 69 筆提交的程式及設定歷史，未發現金鑰或私人簽章資料。 | iOS 16.4 是部署目標，實機操作證據使用 iOS 18.3。 |

Simulator 此階段共 16 項通過（Release 7、system 5、map 4）。XCTest 從啟動到「目前位置」啟用的三次量測，iPhone 17 Pro Simulator 為 4,119、4,108、4,098 ms，iPhone 12 為 6,501、6,593、6,696 ms。兩個環境測試期間均未啟動 Mac 開發伺服器。iPhone 定位或反查服務的飛航模式行為仍待測。

測試後恢復 iPhone 12 原有的語音與視距設定，並以 `devicectl` 安裝、啟動已稽核的獨立 Release 成品。下次實機驗收先確認強制結束前的設定寫入與常用地點編輯焦點，再到路網涵蓋的道路測試方向、偏航、停靠點及抵達，並單獨記錄人工聽音、背景返回和鎖屏。 [第七階段實機驗收清單](#stage7)

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
