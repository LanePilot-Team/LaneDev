# TDX 大眾運輸資料接入計畫書

擬定日期：2026-08-11　範圍：楠梓區＋左營區
狀態：**範圍已核定（§9），Phase 0 已完成（§10），Phase 1 進行中**

---

## 0. 一句話

把 TDX 的公車、公共自行車、捷運／輕軌資料接進來，**但不是為了做一個公車 App**——
是為了讓這個車道級導航知道「哪一條車道旁邊有公車站」「終點附近哪裡可以還 YouBike」，
做別的導航 App 因為沒有車道級底圖而做不到的事。

---

## 1. 先講三個會決定整個架構的限制

### 1.1 Client Secret 不能進前端（**硬性**）

TDX 走 OAuth2 client_credentials：拿 `client_id` + `client_secret` 換 access token
（端點 `https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token`，
token 有效期 86400 秒）。

這個專案是純靜態 SPA，`npm run build` 後整包丟 GitHub Pages。
**Vite 會把 `import.meta.env.VITE_*` 直接內嵌進 JS bundle**，
所以只要 secret 帶了 `VITE_` 前綴，它就會出現在 <https://…github.io/LaneDev/assets/index-xxx.js> 裡，
任何人都能撿走去用你的額度。這條沒有折衷方案。

**做法**：credential 只給 Node 讀，永遠不帶 `VITE_` 前綴。

```
.env.local          # 已被 .gitignore 擋掉（現有規則 .env.* 就涵蓋）
  TDX_CLIENT_ID=...
  TDX_CLIENT_SECRET=...
.env.example        # 進版控，只寫欄位名稱不寫值
```

讀得到它的只有兩個地方：build script（Node）與 Vite dev middleware（Node）。

### 1.2 靜態資料可以進版控，即時資料不行

| | 靜態（站點、路線、站序、線型、班表） | 即時（YouBike 車位、公車到站） |
|---|---|---|
| 取得時機 | build script，人工執行 | 每次查詢，runtime |
| 存放 | `public/data/*.json` 進版控 | 不能存 |
| 線上版（Pages） | ✅ 正常 | ❌ 沒有後端可以藏 secret |
| 本機 dev | ✅ | ✅ 走 Vite middleware proxy |
| 離線 audit 可驗 | ✅ | ❌ |

這跟測速照相是同一個判斷（資料指引第 4 節：不要讓 App 直接打政府端點）。
**結論：靜態的照抄測速照相那套管線；即時的做成可插拔 provider，線上版明講「即時資訊僅本機可用」。**

要讓線上版也有即時資料，唯一乾淨解是加一個 Cloudflare Worker / Vercel Function 當 proxy
（約 30 行、免費額度綽綽有餘）。**這是你要決定的事，不是我該自作主張加的基礎設施。**

### 1.3 TDX 的線型不是車道級

TDX 的 `Bus_Shape` / `Rail_Shape` 是**營運路線示意中心線**，用途是「這班車走哪條路」。
它跟本專案 `road_database.json` 的車道級幾何不是同一個精度層級。

**所以：TDX 線型只能當疊加圖層，絕對不可以拿來當底圖或推導車道。**
站牌座標同理——實測其他縣市資料常有站牌落在路中央或建築物裡的情況，必須 snap + 稽核。

---

## 2. 要抓什麼（範圍：楠梓＋左營）

| 運具 | 端點 | 篩法 | 預估量 |
|---|---|---|---|
| 公共自行車站 | `/v2/Bike/Station/City/Kaohsiung` | bbox 篩兩區 | 數十站 |
| 自行車道線型 | `/v2/Cycling/Shape/Kaohsiung` | bbox 裁切 | 中等 |
| 公車站牌 | `/v2/Bus/Stop/City/Kaohsiung` | bbox 篩兩區 | 數百站 |
| 公車路線 | `/v2/Bus/StopOfRoute/City/Kaohsiung` | **只留「有站牌落在兩區」的路線** | 待測 |
| 公車路線線型 | `/v2/Bus/Shape/City/Kaohsiung` | 同上，且裁切到 bbox | 待測 |
| 捷運站 | `/v2/Rail/Metro/Station/KRTC` | bbox 篩（紅線經左營、楠梓） | 個位數 |
| 輕軌站 | `/v2/Rail/Metro/Station/KLRT` | bbox 篩（環狀輕軌經左營） | 十餘站 |
| 捷運／輕軌線型 | `/v2/Rail/Metro/Shape/{KRTC,KLRT}` | bbox 裁切 | 小 |
| 臺鐵／高鐵站 | `/v2/Rail/TRA/Station`、`/v2/Rail/THSR/Station` | bbox 篩 → 新左營、左營 | 2–3 站 |

bbox 直接沿用測速照相那份：`120.2–120.42E, 22.62–22.82N`，
但這次改成**用現有路網的實際 bounding box 動態算**，避免手寫常數跟底圖脫節。

> 公車路線數量是唯一的未知數。高雄市區公車全市數百條，
> 「經過兩區」的到底剩幾條要打了才知道——這是 Phase 0 要先量的。
> 如果 shape 資料超過 ~3 MB，就只留站牌與站序，線型改成只在需要時載入。

---

## 3. 怎麼應用（你問的重點）

按「跟這個專案的本體有多相關」排序，不是按好做的程度排。

### A. 公車停靠影響車道 —— 這才是接 TDX 的真正理由 ⭐

公車站牌 snap 到路段後，可以算出「站牌在這條路的哪一側、對應哪一個車道」。
接著：

- **地圖（瀏覽模式）**：該路段最右車道畫上公車彎/停靠標記。
- **導航中**：接近有公車站的路段時提示「右側車道有公車停靠站」，
  和現有的車道指引合併——直行時建議避開最右車道。
- 機車 profile 尤其有意義：機車被規定靠右行駛，公車進站正好衝突。

**別的導航 App 做不到這件事，因為它們沒有車道級底圖。**
這是把 TDX 接進來最有辨識度的產出，也最適合寫進畢專。

### B. 大眾運輸疊加圖層（瀏覽模式）⭐

公車站牌、YouBike 站、捷運／輕軌站與路線線型，做成可切換的圖層群組。
風險最低、驗證最直接，也是 A 與 C 的資料基礎。做法照測速照相的圓標圖層。

### C. 終點轉乘提示

導航終點在捷運站／高鐵站附近時，抵達前提示最近的 YouBike 站與距離。
（即時車位是加分，沒有即時資料時就只顯示站點與車柱數。）

### D. YouBike 即時可借／可還

`/v2/Bike/Availability/Kaohsiung`，10 秒左右更新一次。
**受 1.2 限制：dev 可用、線上版不可用**，除非加 Worker。

### E. 公車即時到站 —— 建議不做

對一個**開車／騎車**導航來說價值很低，但資料量與更新頻率成本最高。
真要做也排在最後。

---

## 4. 實作架構（照現有慣例，不發明新東西）

```
scripts/tdx_client.mjs         TDX 認證與請求（token 快取到 node_modules/.cache，避免每次重抓）
scripts/build_transit.mjs      抓取 → bbox 篩選 → 正規化 → public/data/transit.json
scripts/transit_audit.ts       離線稽核（見 §5）
public/data/transit.json       版本化資料檔（含 source/授權/fetchedAt，同 speed_cameras.json）
src/core/transit.ts            純函式：型別、bbox 篩選、站牌 snap 到路段與側別、圖層 GeoJSON
src/core/transit.test.mjs      單元測試
src/core/mapStyle.ts           +transit source 與圖層（站點圓標、路線線型）
src/app/mapCore.ts             載入 transit.json（失敗只少圖層，不擋導航）
vite.config.ts                 +tdxProxy() dev middleware（沿用 staticRoadDatabaseWriter 的 isLocalWrite 防護）
src/nav/…                      A 與 C 的導航提示（Phase 3 才動）
```

npm scripts（命名沿用現有風格）：

```
transit:data        node scripts/build_transit.mjs
audit:transit       node scripts/run_offline.mjs scripts/transit_audit.ts
test:transit        node --test src/core/transit.test.mjs   （併入 test:all）
```

**即時資料的 provider 介面**：`src/core/transitLive.ts` 匯出
`fetchBikeAvailability()`，實作在 dev 打 `/api/tdx/bike-availability`（Vite middleware 代打），
在 production 直接回 `null`。UI 拿到 `null` 就顯示「即時資訊僅本機可用」，不做假資料。

---

## 5. 怎麼驗證（沒有這段就不該開工）

MapLibre 在 Browser pane 沒顯示時不 composite，截圖驗不了——這專案一路都是靠離線 harness。
`audit:transit` 要能回答這四個問題：

1. **站點有沒有落在路網上**：每個公車站牌／YouBike 站到最近路段的垂距。
   超過 25 m 的列出來人工核對（座標偏差是這類資料最常見的問題）。
2. **站牌在路的哪一側**：用路段走向的法向量判左右，回報「右側／左側／判不出來」。
   §3-A 整個功能建立在這個判斷上，判不出來的比例太高就代表 A 不可行。
3. **公車路線線型對不對得上底圖**：抽樣比對 TDX shape 與最近路段的偏差，
   量化「示意線型」到底差多少，作為「不可當底圖」的證據。
4. **資料規模**：各類筆數與 JSON 檔案大小，避免默默塞一個 10 MB 的檔進版控。

另外照測速照相的前例，做一份靜態 HTML 預覽看圖層與提示卡視覺。

---

## 6. 分期

| Phase | 內容 | 產出 | 可否獨立驗收 |
|---|---|---|---|
| **0. 探路（0.5 天）** | 用你的 key 打通認證，實測各端點回傳、量「經過兩區的公車路線」到底幾條、量站牌座標品質 | 一份實測數字報告 | ✅ 直接決定後面規模 |
| **1. 靜態資料管線** | `tdx_client` + `build_transit` + `transit.json` + `audit:transit` + 單元測試 | 資料進版控、稽核通過 | ✅ |
| **2. 疊加圖層（§3-B）** | mapStyle 圖層、mapCore 載入、瀏覽模式切換、TDX 顯名與標章 | 地圖上看得到 | ✅ |
| **3. 公車停靠影響車道（§3-A）** | 站牌側別判定 → 車道標記 → 導航提示 | 這期的主菜，做完結案 | ✅ |

~~Phase 4（即時＋轉乘）~~ 已依 §9 決議移除。

Phase 0 結束我會先回報數字，不會直接往下衝。

---

## 7. 已知風險

| 風險 | 影響 | 對策 |
|---|---|---|
| Client Secret 外洩 | 額度被盜用 | §1.1，永不帶 `VITE_` 前綴；`.env.local` 已在 gitignore |
| 公車資料量過大 | 版控與載入變慢 | Phase 0 先量；必要時線型改按需載入 |
| 站牌座標偏差 | §3-A 判錯車道側別 → **給出錯誤的行車建議** | audit 第 1、2 項把關；判不出來就不提示，不猜 |
| TDX 線型被誤用 | 底圖精度崩壞 | §1.3 明文禁止；audit 第 3 項量化差距佐證 |
| 即時資料線上不可用 | 功能不完整 | 明講限制，不做假資料；要補就加 Worker |
| API 頻率限制 | build 中途失敗 | 目前每來源 IP 每秒 50 次；build script 加節流與重試 |

---

## 8. 授權與顯名

TDX 採**政府資料開放授權條款第 1 版**，但比警政署那份多一個要求：

> 應用服務中須揭露「資料介接**交通部 TDX 平臺**」並加入**平臺標章**。

做法：
- 地圖 source `attribution` 加上 TDX 顯名（與現有 OSM、警政署並列）。
- 平臺標章圖檔放 `public/assets/`，在「關於／資料來源」處顯示。
- README「資料授權」段補一節，含 `transit.json` 的 `fetchedAt`。

---

## 9. 已核定範圍（2026-08-11）

- **做**：§3-B 疊加圖層 → §3-A 公車停靠影響車道。
- **不做**：§3-C 轉乘提示、§3-D YouBike 即時車位、§3-E 公車即時到站。
- **全案不含任何即時資料**，所以：
  - `src/core/transitLive.ts` 與 Vite dev proxy middleware **取消**，不寫。
  - `scripts/tdx_client.mjs` 只在 build script 與探路腳本用，runtime 完全不碰 TDX。
  - Cloudflare Worker 不需要。
- §4 的檔案清單與 §6 的分期照此縮減：**Phase 4 整個移除**，做完 Phase 3 就結案。

> 之後想補即時資料，架構上不會卡住——靜態資料檔已經帶了站點 UID，
> 加一支 provider 就能對上，但那要先解決 §1.2 的部署問題。

---

## 10. Phase 0 探路結果（2026-08-11 實測）

執行：`npm run tdx:probe`（原始回應快取在 `scripts/.tdx-probe/`，不進版控）

### 10.1 端點路徑（已確認，不必再猜）

| 資料 | 正確路徑 |
|---|---|
| 公共自行車站 | `/Bike/Station/City/Kaohsiung` |
| 自行車道線型 | `/Cycling/Shape/City/Kaohsiung` ← **不是** `/Cycling/Shape/Kaohsiung`（404） |
| 公車站牌 | `/Bus/Stop/City/Kaohsiung` |
| 公車路線／站序／線型 | `/Bus/{Route,StopOfRoute,Shape}/City/Kaohsiung` |
| 捷運／輕軌 | `/Rail/Metro/{Station,Shape}/{KRTC,KLRT}` |
| 臺鐵／高鐵 | `/Rail/TRA/Station`、`/Rail/THSR/Station` |

base URL：`https://tdx.transportdata.tw/api/basic/v2`

### 10.2 兩個文件沒寫、會安靜出錯的限制

1. **實際限流比文件嚴格得多**。文件寫「每來源 IP 每秒 50 次」，實測用金鑰約
   8 req/s 就開始回 `429 API rate limit exceeded`。已把 client 壓到約 **1 req/s**，
   並支援 `Retry-After`。
2. **單次請求最多回 1500 筆**，`$top=20000` 也一樣只給 1500，**而且不報錯**。
   全市公車站牌有 19208 筆——沒有 `$skip` 翻頁的話會安靜地只拿到前 1500 筆，
   結果看起來完全正常。已加 `tdxGetAll()` 翻頁，並在翻到上限時明確回報不完整。

### 10.3 資料規模

「範圍內」的定義最後改成**離本專案路網 25 m 以內**，不是 bbox 矩形——
bbox 會掃進三民、鼓山等鄰區（4257 筆公車站牌裡有 1256 筆根本不在我們的路網上）。
用路網距離同時也是「這筆資料對我們有沒有用」的定義。

| 資料 | 全市 | 路網 25m 內 |
|---|---|---|
| 公車站牌 | 19208 | **3002** |
| YouBike 站 | 1500（已確認是真實總數，非上限） | **288** |
| 捷運站 KRTC | 39 | **11** |
| 輕軌站 KLRT | 38 | **7** |
| 臺鐵站 | 245 | **4** |
| 高鐵站 | 12 | **1** |

公車路線：全市 617 個方向 → **經過本區的有 233 個方向 / 122 條路線**。

原始 payload 太大（StopOfRoute 2589 KB + Shape 796 KB + Stops 1618 KB ≈ 5 MB），
**Phase 1 必須正規化而不是原樣落地**：站牌詳細資料只存一份，路線只存站序 UID 列表，
公車路線線型另存成獨立檔案按需載入。

### 10.4 Phase 3 可行性（本次探路最重要的數字）

TDX 公車站牌有 **`Bearing` 欄位，覆蓋率 100%**（八方位 N/NE/E/…）——這是站牌服務的行車方向，
與幾何是**兩個獨立訊號**，可以互相驗證。實測拿它跟最近路段走向比對：

| | 筆數 | 佔比 |
|---|---|---|
| Bearing 與道路走向一致（可判定行車方向） | 2893 | **96.4%** |
| 其中垂距 ≥2 m（左右側別也明確） | 2677 | **89.2%** |
| Bearing 與道路走向差 >45°（判不出來） | 109 | 3.6% |

**結論：§3-A（公車停靠影響車道）成立**，九成的站牌可以明確定位到「哪個行車方向的哪一側」。
判不出來的 3.6% 依既有原則處理——**不猜，就不提示**。

### 10.5 對計畫的修正

- 「範圍內」的定義由 bbox 改為路網 25 m 距離（§2 的篩法照此更新）。
- Phase 1 必須做正規化與檔案拆分（§10.3）。
- **推導值不進資料檔**：站牌的 snap 結果、車道側別都在 runtime 算，
  資料檔只存來源欄位。理由同 `lanedev-panel-derive-not-snapshot` 的教訓——
  路網前處理（couplet 合併等）會變，快照下來的推導值會跟底圖脫節。

---

## 11. Phase 1／2 完成紀錄（2026-08-11）

### 11.1 產出

| 檔案 | 說明 |
|---|---|
| `scripts/tdx_client.mjs` | 認證、token 快取、節流（1 req/s）、`$skip` 翻頁、`Retry-After` |
| `scripts/build_transit.mjs` | `npm run transit:data` |
| `public/data/transit.json` | 487 KB（站點、路線站序、軌道線型） |
| `public/data/transit_bus_shapes.json` | 237 KB（公車線型，疊加圖層預設不載入） |
| `src/core/transit.ts` | 型別、八方位、snap、站牌行向／側別推導、圖層 GeoJSON |
| `src/core/transit.test.mjs` | `npm run test:transit`（12 項，已併入 test:all） |
| `scripts/transit_audit.ts` | `npm run audit:transit` |

收錄結果：公車站牌 3002／YouBike 303／軌道車站 15（捷運 9、輕軌 2、臺鐵 3、高鐵 1）／
公車路線方向 197。原始 payload 約 5 MB，正規化後 724 KB。

### 11.2 收錄門檻改成分兩種（實測後修正）

原本一律 25 m，結果**把捷運左營站（離最近道路 61 m）與高鐵左營站（74 m）整個刷掉**——
軌道車站的參考點在站體中央，不在路邊。改成：

- 公車站牌 25 m：它的用途就是貼到某一段路的某一側，snap 不上就沒用。
- 其他站點 100 m：仍排得掉鄰區的臺鐵內惟（236 m）與捷運青埔（308 m）。

### 11.3 稽核結果

```
公車站牌 3002 筆
  snap 成功    2993（99.7%）  垂距 中位 8.5m／p90 15.6m
  可判行車方向  2827（94.5%）
  側別 右 2481／左 187／判不出來 325 → 可用於車道提示 2668（89.1%）
  左側佔比 7.0%（靠右行駛下合理，多為港灣式站台／分隔島設站）
```

**TDX 線型與底圖的偏差（量化「示意中心線」）**：

| | 中位 | p90 | 最大 |
|---|---|---|---|
| 公車路線線型 | 2.3 m | 13.4 m | 121.0 m |
| 軌道線型 | 5.9 m | 42.1 m | 124.9 m |

車道寬 3.2 m——p90 已經差到四個車道以上。這組數字就是 §1.3「不可當底圖」的證據。

### 11.4 一個設計取捨要記著

build script 用 **原始 segment** 篩範圍，audit 與 App 用 **前處理後的路網**。
兩者會有小落差（couplet 合併讓中心線橫向位移，9 筆站牌因此掉出 25 m）。
這是刻意的：build 的篩選要穩定、不隨前處理版本跳動。
audit 用 1% 當警戒線——少量正常，大量才代表前處理有回歸。

### 11.5 Phase 2 疊加圖層

工具列「🚌 大眾運輸」開關（預設關）。圖層密度分級避免標籤淹沒畫面：
軌道站 zoom 11＋、YouBike 13＋、公車站牌 14＋、站名 16＋。
**導航中自動關閉**（3000 個站牌在每幀旋轉的地圖上重排太貴，同 oneway-arrow／road-label），
結束導航後回復使用者原本的開關狀態。

`npm run audit:style` 0 錯誤；資料經 Vite 實際供得出來（已驗）。
MapLibre 在 Browser pane 未顯示時不 composite，圖層外觀仍待實機確認。

### 11.6 下一步

Phase 3：把 89.1% 可定位的站牌接到車道模型 → 地圖標記 → 導航提示。

---

## 12. 金鑰外洩檢查（2026-08-11）

上傳 GitHub 前的實測，六項全過：

| # | 檢查 | 結果 |
|---|---|---|
| 1 | git 追蹤的 248 個檔案 | 不含憑證 |
| 2 | `git add .` 會收進去的 43 個未追蹤檔案 | 不含憑證 |
| 3 | `.env*` 是否曾 commit | 從未進入歷史 |
| 4 | `.env.local`／token 快取／`.tdx-cache`／`dist` 的忽略規則 | 全部確認被忽略 |
| 5 | `.github/workflows/deploy.yml` | 只跑 `npm ci` + `npm run build`，**不需要金鑰** |
| 6 | **實際 build 後掃描部署產物**（30 檔 44.6 MB） | 不含憑證，連認證端點字樣都沒有 |

結構上安全的原因不是「有記得加 gitignore」，而是 **runtime 完全不碰 TDX**：
金鑰只有 `scripts/tdx_client.mjs`（Node）讀得到，App 讀的是已 commit 的 `transit.json`。
CI 因此從頭到尾不需要金鑰。

### 12.1 途中發現的一個真實風險（已修）

模擬「隊友 clone 後的環境」時，隊友那份**竟然成功抓到資料**——
原因是 access token 原本快取在 `node_modules/.cache/tdx-token.json`。
`.gitignore` 擋得住 git，但**擋不住「把整個專案資料夾壓縮傳給組員」**，
而那正是學生專案最常見的傳檔方式。傳出去的是一把 24 小時內有效的鑰匙。

**已改成放系統暫存目錄**（`os.tmpdir()/lanedev-tdx-token.json`），壓縮專案永遠帶不到它。
代價只是暫存被清掉時要重新認證一次（一天一次請求）。

### 12.2 隊友的實際體驗（已實測）

只拿得到「會上傳的檔案」、沒有 `.env.local`、沒有 token 快取的環境下：

- `npm run dev` / `npm run build` / `npm run test:all` / `npm run audit:transit`　**全部正常**
  （資料檔已進版控，稽核實測仍是「站牌 3002 筆、snap 99.7%、✅ 全部通過」）
- `npm run transit:data`　**明確報錯並退出**，訊息告訴他去 TDX 會員中心申請自己的金鑰、
  建立 `.env.local`、不要加 `VITE_` 前綴。

也就是說：**用功能不需要金鑰，只有「重新抓一份最新資料」需要**。
