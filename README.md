# LaneDev — 楠梓區車道級地圖編輯器 + 導航模擬

**線上版：https://lanepilot-team.github.io/LaneDev/**

台灣機車友善車道級導航系統畢業專題的地圖編輯器與導航模擬前端（純前端、無後端）：
React 19 + TypeScript + Vite + MapLibre GL + Turf + three.js。
含編輯模式全功能（車道/待轉區/偏心道/車輛標註）。

## 快速開始

```powershell
npm install
npm run dev            # http://localhost:5190（host 已開，可從區網/Tailscale 連）
npm run build          # tsc -b && vite build（build 即型別檢查；無另設 lint/test）
npm run preview        # http://localhost:4173/LaneDev/（驗證 Pages 子路徑）
```

推 `main` 會由 `.github/workflows/deploy.yml` 自動 build 並部署到 GitHub Pages。

> **base path**：Pages 是 project site，build 時 base = `/LaneDev/`（見 `vite.config.ts`）。
> 所有 runtime 才組出來的 `public/` 資源路徑一律包 `asset()`（`src/core/asset.ts`），
> 不要寫死 `/data/...`，否則線上會 404。repo 改名時 base 要一起改。

離線回歸（改演算法後跑）：

```powershell
npx tsx scripts/route_audit.ts    # 隨機 500 對路由：汽/機車禁行 0 違規
npx tsx scripts/ground_audit.ts   # 停止線/分隔線收邊/右轉道/路寬微調 16 項
npx tsx scripts/import_audit.ts   # LanePilot 標註吃入命中率
```

## 手動更新地標資料（OSM＋TDX）

1. 複製 `.env.example` 為 `.env.local`，填入 TDX Client Id 與 Client Secret。
   `.env.local` 已由 `.gitignore` 排除，不會打包或部署。
2. 執行：

```powershell
npm run places:update                 # OSM＋TDX
npm run places:update -- --osm-only  # 只更新 OSM
npm run places:update -- --tdx-only  # 只更新 TDX
```

更新結果會寫入 `public/data/places/places.json`。OSM 抓取楠梓區與左營區的具名
POI；TDX 抓取高雄市觀光、車站、公車站與公有停車場資料，再裁切至目前路網範圍。
腳本先完整驗證新資料才替換舊檔，任一主要來源失敗時會保留上一版。

**關閉 dev server**：終端機 Ctrl+C；找不到終端機時：

```powershell
netstat -ano | findstr :5190      # 查出佔用 5190 的 PID（最後一欄）
taskkill /PID <PID> /F            # 結束它（npm 的 node 子程序常在視窗關掉後存活）
```

## 底圖（Base Layer）：預設 LanePilot shard

啟動時預設載入 **LanePilot 行政區 shard**（含 node_refs，可導航）：

```
public/data/lanepilot/area_4212599.segments.jsonl   楠梓區（預設載入）
public/data/lanepilot/area_4212683.segments.jsonl   橋頭區（暫不預載——楠梓車站周邊
                                                    在 OSM 行政區劃屬橋頭，要跑車站
                                                    Demo 需加回 DEFAULT_SHARD_URLS 或手動匯入）
public/data/lanepilot/annotations.jsonl             組員標註（啟動自動轉待轉區 zone-lp-*）
```

- **更新底圖/標註**：組員交付新檔直接覆蓋同名檔案，重新整理即生效。
- **除錯開關**（URL query）：`?base=osm` 退回 Overpass 快照底圖、`?journal=off`
  不套任何標註（看純 OSM）、`?lpzones=off` 關閉待轉區自動吃入、`?screenshot`
  開 MSAA/preserveDrawingBuffer（截圖用，內顯平時很貴別開）。
- **臨時換圖**：工具列「匯入地圖」多選 `segments.jsonl`（跨區合併去重）或
  `annotations.jsonl`；只在當前分頁有效。
- 標註（journal/待轉區）存 localStorage，與底圖檔案無關；清空：F12 →
  `localStorage.clear()` 後重新整理。
- 備援 Overpass 快照重抓：`python scripts/fetch_nanzi.py`。

## 目前功能

### 渲染（高德式 2.5D）

| 功能 | 說明 |
| --- | --- |
| 車道級路面 | 實際公尺寬（lanes×3.2m＋機車道 2.2m＋中央帶＋路寬微調）、白車道虛線、黃分向線、單行箭頭、路名、3D 建築；zoom<15 退化為簡化路網 |
| couplet 成對單行合併 | OSM 拆成兩條單行的道路自動合併為單一雙向路體（泛用同名掃描 ~54 路＋五道防呆）；主慢分離道路（外環西路/德民路）只併主線、慢車道吸收為機車道＋可調快慢分隔島 |
| 偏心左轉道＋中央槽化 | couplet 合併路段自動生成（journal 可覆寫）：儲車段、漸變開口、黃邊線、槽化斜紋、左轉/迴轉地面箭頭 |
| 停止線＋右轉附加車道 | 路口停止線（斜交路口平行交會道路）、右轉道（journal 人工開啟）、分隔線路口收邊全部裁到停止線延長線——路口面全清 |
| 分隔島 | 中央實體島（Case A 編輯）、成對單行間自動推導（Case B）、高雄大學路四線並排顯式配對（Case C）、快慢分隔島（主慢分離） |
| 路面印字 | 禁行機車等地面規則字（journal 設定；`motorcycle=no` 自動 fallback） |
| **高架 3D（方案 B）** | 中山高本線＋楠梓交流道匝道＋高楠公路陸橋＋楠陽高架橋：three.js 織帶橋面（含護欄/橋墩/橋面標線）、匝道 100m smoothstep 連續爬升、高架段地面路體隱藏；跨河橋（仁武橋等）不抬。`core/elevation.ts` 高度剖面與渲染/車輛共用 |
| 3D 車輛 | three.js 程式組模轎車/機車＋騎士；編輯模式可放置 NPC 車輛（吸附車道中心）；導航自車依車種顯示，**上高架 z 跟著橋面抬** |

### 路線規劃與導航

| 功能 | 說明 |
| --- | --- |
| 路線規劃 | 前端建圖＋A*（時間成本）；起/迄/停靠點（拖曳排序）、汽/機車雙 profile 切換即重算、轉彎步驟清單；Demo 路線 = 高雄大學→楠梓車站 6.4 km（車站端需橋頭 shard） |
| 機車路權 | 機車禁行國道/快速道路與 `motorcycle=no`；兩段式左轉（待轉區路口黃底看板＋車道列亮最右）；汽車禁行機車專用道（`motorcar=no`＋0 汽車車道） |
| 車道級指引 | 路線帶偏移到實際行駛車道（藍帶+箭頭）；路口前 45m 變道（右轉→最右、左轉→最左/偏心道、兩段式→靠右）；變道 ramp 對齊偏心道開口不壓槽化線；**高架段路線帶改 3D 絲帶貼橋面** |
| 導航 HUD | 藍色看板三級距離文案（250/60/25m）、連動指示「隨後…」、即時路名/車道列（turn:lanes 真值）、速度圓標、倍速 1x/3x/8x、航向朝上、自由縮放（手勢讓路 250ms） |
| 模擬行駛 | 車貼路線帶等速行駛、◀/▶ 換車道（夾在實際車道內）、路口決策「不照指引走」→ 沿真實幾何走一段後自動 reroute |
| 真 GPS 導航 | `watchPosition`＋沿線投影；偏離 60m×3 次自動重規劃（10s 冷卻）；需 HTTPS（線上版 Pages 本身即 HTTPS；本機測試可用 `tailscale serve --bg --https=443 http://localhost:5190`）；Wake Lock 防熄屏 |

### 編輯與資料（Enhancement Layer，本專案核心設計）

| 功能 | 說明 |
| --- | --- |
| 紀錄體系 | append-only journal + fold（`{seq,ts,author,op,target,fields}`），localStorage 持久化，首次載入 seed；編輯粒度 = 路口到路口區塊（鍵 `way/W@b/N`）；「匯出」下載 `navsim-enhancement-v0.5` |
| 車道編輯 | 每向車道數/機車道/轉向真值/中央帶（寬度+槽化⇄島）/快慢分隔帶/路寬微調/地面規則印字 |
| 待轉區 | 路口 40m 內放置、拖曳/旋轉、停止線對齊自動定位；**LanePilot 標註啟動自動吃入**（`annotations.jsonl` → 360 個 zone-lp-*，手動放置優先） |
| 偏心道/右轉道編輯 | BayPanel 逐行向開啟/調長/關閉 |
| 匯入 | `segments.jsonl`（換底圖）與 `annotations.jsonl`（legacy/v2/一筆一檔皆可；couplet 合併後的 node/way 重映射自動遷移） |

截圖見 `screenshots/`。

## 架構對應

```
public/data/lanepilot/*.segments.jsonl  預設 Base Layer（LanePilot shard，含 node_refs）
src/core/importmap.ts    shard/標註解析＋多區合併（啟動預載與「匯入地圖」共用）
src/core/pipeline.ts     底圖前處理：人工修正 → couplet 合併 → 依路口切塊 → 高架標記
src/core/roads.ts        屬性正規化＋車道線幾何（turf lineOffset）
src/core/graph.ts        路網圖（OSM node 拓撲切邊）＋A*＋轉向/車道級指引
src/core/mapStyle.ts     高德式 2.5D 樣式：公尺級寬度表達式、canvas icon
src/core/elevation.ts    高架判定＋高度剖面（渲染與車輛共用）
src/core/elevated3d.ts   three.js 橋面圖層（織帶橋面/護欄/橋墩/路線絲帶）
src/core/models3d.ts     three.js 車輛模型（轎車/機車，含導航自車 z 抬升）
src/core/zones|turnbays|medians|roadtext|couplet|enhancements.ts  Enhancement 各件
src/app/mapCore.ts       地圖初始化＋共用 refs＋重繪函式
src/core/asset.ts        public 資源路徑解析（Pages base 前綴，見上）
src/plan/                usePlanner（停靠點/路線/車種/兩段式）＋PlanPanel＋ManeuverList
src/nav/                 drive（模擬）/gpsNav（GPS）/useDrive（編排）/DriveHUD（看板文案）
src/browse/              RoadInfoCard（路段資訊卡）
src/edit/                編輯模式：useEditor＋EditPanels（車道/待轉區/偏心道/車輛）
src/App.tsx              模式機＋點擊分派＋畫面組裝（薄 wiring）
```

設計原則：**所有 Enhancement 物件都是「放置→拖曳→旋轉→屬性→匯出」同一套互動
模型**，且與 Base Layer 解耦（journal 可 rebase/合併，換底圖或後端格式不變）。

## 已知限制 / 待修改

正式清單維護在畢專主 repo 的 `SDD.md` §10 與計畫書 B-11/B-12 backlog。摘要：

- 路牌/轉向限制（禁左轉/禁迴轉）未實作；Undo/Redo 未做（journal 天然支援）。
- 高架：detour 暫時路線的絲帶不上橋；隧道/地下道視覺下沉未做；高架清單手動維護（楠梓範圍）。
- 無 `turn:lanes` 真值的車道列是推薦值；無 `lanes` tag 用等級預設（primary 4／secondary 3／其他 2）。
- 橋頭 shard 預設不載——Demo 路線東端（楠梓車站）會缺路。
- LanePilot 車道標註（author=lanepilot）預設過濾不套用（實驗期決策）；待轉區則自動吃入。
- journal 署名預設空白，於「匯出」時填寫（存 localStorage 沿用）；尚無帳號體系，署名不可驗證。
- headless 截圖偶發白屏（GPU 合成問題），實機正常；效能基準以 production build 為準。

## 資料授權

地圖資料 © OpenStreetMap contributors（[ODbL](https://opendatacommons.org/licenses/odbl/)）。
預設底圖來自 LanePilot 專案對 OSM PBF 快照的行政區切片（`public/data/lanepilot/`）；
備援底圖為 Overpass API 即時查詢快照，時間見 `public/data/meta.json`。
