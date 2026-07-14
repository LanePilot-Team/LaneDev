# NavSim v0.2 — 楠梓區車道級導航模擬前端

台灣機車友善車道級導航系統畢業專題的模擬前端（純前端、無後端）：
React 19 + TypeScript + Vite + MapLibre GL + Turf + three.js。

> 本資料夾為獨立可執行單元；完整計畫書/系統演進脈絡在此 repo 之外的畢專主目錄，
> 不影響本專案的安裝與執行。

## 快速開始

```powershell
cd nav_simulator\v0.2
npm install
npm run dev        # http://localhost:5180（host 已開，手機走 Tailscale IP）
```

**關閉 dev server**：在跑 `npm run dev` 的終端機按 **Ctrl+C**（出現 `Terminate batch job (Y/N)?` 按 `Y`）。
找不到那個終端機時（視窗關了但 server 還活著、或 5180 被占用）：

```powershell
netstat -ano | findstr :5180      # 查出佔用 5180 的 PID（最後一欄）
taskkill /PID <PID> /F            # 結束它
```

## 底圖（Base Layer）：預設 LanePilot shard，怎麼更新、怎麼關

啟動時預設載入 **LanePilot 行政區 shard**（含 node_refs，可導航）：

```
public/data/lanepilot/area_4212599.segments.jsonl   楠梓區
public/data/lanepilot/area_4212683.segments.jsonl   橋頭區（楠梓車站周邊路網在 OSM 行政區劃屬橋頭）
```

- **更新底圖**：組員交付新 shard 時直接覆蓋同名檔案，重新整理即生效。
- **關閉（退回舊的 Overpass 快照）**：把 `public/data/lanepilot/` 整個資料夾改名或移走
  （例如改成 `lanepilot.off`），重新整理就會自動退回 `public/data/nanzi_roads.geojson`，
  Console 會印「LanePilot shard 底圖載入失敗，退回 Overpass 快照」。改回原名即恢復。
- **臨時換圖（不動檔案）**：工具列「匯入地圖」可多選其他區的 `segments.jsonl`（自動合併去重）
  或 `annotations.jsonl`（套用車道標註＋待轉區）；匯入只在當前分頁有效，重新整理回到預設。
- 標註（journal／待轉區）存 localStorage，與底圖無關、重新整理不會消失；
  要清空：F12 → Console 輸入 `localStorage.clear()` 後重新整理。

舊的 Overpass 快照仍可重抓（備援底圖與 3D 建築來源）：

```powershell
python scripts/fetch_nanzi.py   # Overpass → 楠梓區路網 + demo 區建築
```

## 目前功能

| 功能 | 說明 |
| --- | --- |
| 路網底圖 | 預設 LanePilot 楠梓＋橋頭區 shard（含 node_refs，可導航）；備援 Overpass 快照見上一節 |
| 2.5D 車道級渲染 | 路面實際公尺寬（lanes×3.2m）、白色車道虛線、黃色分向線、單行道箭頭、路名、3D 建築（demo 區）；zoom<15 自動退化為簡化路網 |
| 路線規劃 | 前端建圖 + A*（時間成本，依道路等級限速），點兩下地圖或按「Demo 路線」（高雄大學→楠梓車站 6.4 km） |
| 高德式導航 | 藍色頂部看板（轉向箭頭+距離+路名）、車道列（有 turn:lanes 用真值，沒有推薦轉向側車道）、航向朝上 3D 鏡頭、路線帶+箭頭、車標、速度圓標、剩餘距離/抵達時間、1x/3x/8x 倍速 |
| 待轉區編輯 | 只能放在路口 40 m 內（綁 intersection id）、自動對齊道路方向、拖曳移動、Q/E 旋轉、Del 刪除、localStorage 持久化 |
| 車道編輯 | 編輯模式（預設工具）點選道路：**每方向**汽車車道數 ±（以東西南北標示方向）、每方向機車道開關、順向每車道轉向循環切換；儲存寫入 journal 並立即重繪路寬/車道線 |
| 車道斷面模型 | 雙向道 = 分向黃線 + 各方向車道（白虛線）+ 最外側機車道（白實線，2.2m）；已附示範標註（大學南路中段每向 2 車道+機車道、大學西路 1+1+機車道，首次啟動自動載入 seed） |
| 車輛模型（真 3D） | three.js 自訂圖層程式組模：轎車（車身/車窗艙/車頂/四輪/頭尾燈，車色依 id 從 5 色盤配）、機車（車架/前叉/雙輪/騎士+安全帽）。編輯模式「車輛」工具點道路放置，吸附車道中心沿路向；點選 → 側面板刪除/清空；導航自車也是 3D 模型（依車種）。用途：驗證車道標註 + 未來 NPC 模擬基礎 |
| 路線停靠點 | 規劃路線 = 右側面板（mvp 還原）：起點/停靠點/終點逐一點地圖設定、可重設單點、＋新增停靠點、分段失敗會指出哪段；面板 ✕ 關閉 |
| 精確吸附 | 起終點/車輛投影到「線段上的精確點」（誤差 <1 m，原本吸頂點會偏幾十公尺） |
| 車道內行駛 | 導航模擬車依車種跑在自己的車道：汽車走內側車道、機車走機車道（無機車道則最外側車道），換路段橫向平滑過渡；自車 = 3D 模型 |
| 路口前變道 | 轉彎前 45 m 自動切到轉向車道（右轉→最右、左轉→最左、兩段式→維持右側）；路線帶同步畫出變道軌跡 |
| 任意點起終 | 路線起終點吸附到「路段上最近的點」（部分邊接入 A*），不再跳到路口 |
| 紀錄體系 | append-only journal + fold（設計見計畫書 B-3）；「匯出」下載 `nanzi_enhancements.json`（journal 歷程 + 最新值 + 待轉區） |
| 轉向提醒分級 | 照 mvp：250 m 藍色「前往左側車道・準備左轉」→ 60 m 橘紅「左轉・進入某路」→ 25 m 內「現在」；距離取整（<100 取 10、以上取 50）；機車免待轉左轉標「(免待轉)」；靠左/靠右/迴轉全套文案 |
| 兩段式左轉提醒 | 機車模式下，左轉路口若有待轉區 → 看板變**黃底黑字**「靠右進入待轉區（兩段式左轉）」（遠端為「準備兩段式左轉・稍後靠右待轉」）、車道列亮最右側 |
| 偏航重規劃 | 導航中按「偏航」：車橫移 60 m 模擬走錯路，從新位置自動重算路線續航（mvp reroute demo） |
| 導航自由縮放 | 導航鏡頭只鎖航向與位置，縮放交還使用者；滾輪/觸控手勢後 250 ms 內鏡頭跟隨讓路，平滑縮放不被 30Hz jumpTo 打斷 |
| 匯入地圖/標註 | 工具列「匯入地圖」：LanePilot `segments.jsonl`（可多選跨區合併去重、換 Base Layer）與 `annotations.jsonl`（legacy/v2 皆可：lane_profiles→journal 車道覆寫、兩段式規則→自動生成待轉區，對不上的計數略過） |
| 停靠點拖曳排序 | 規劃面板每列 ⋮⋮ 把手可上下拖動；角色跟著新順序走（拖到最上=新起點），放開自動重算路線 |
| 轉向合併 | 錯位路口/巷弄接駁 22 m 內的成對轉向合併成淨轉向（抵銷者移除），修掉「該右轉卡在左轉」 |
| 連動指示 | 下一動作在 60 m 內時看板加「隨後左轉/右轉/迴轉」預告，連續轉向不再措手不及 |
| 路段資訊卡 | 瀏覽模式點路段看 Base Layer 屬性（名稱/等級/車道/單雙向/限速/OSM id） |
| **真 GPS 導航** | 「開始導航」旁的 GPS 按鈕：`watchPosition` 取得真實定位，`turf.nearestPointOnLine` 即時算沿線進度與離線距離；需 HTTPS 或 localhost（按鈕在非安全環境自動停用並提示原因），支援 Wake Lock（螢幕不自動熄滅） |
| 偏航自動重規劃（GPS） | 連續 3 次定位偏離路線 >60 m（10 秒冷卻避免反覆重算）→ 自動從目前位置重新規劃並接續導航 |
| 路口決策（不照指引走） | 接近路口 30 m 內，畫面列出該路口其他可行方向；選了就先沿真實道路幾何開一段（150 m 內），超過 40 m 或撞死路才觸發 reroute——比直接瞬移更接近真實跑錯路的情境 |
| 換車道 | 導航中 ◀/▶ 按鈕一次切一條車道，夾在目前路段實際車道數內，不會開出路面 |

截圖見 `screenshots/`。

## 架構對應（計畫書 B-3/B-4）

```
public/data/lanepilot/  預設 Base Layer（LanePilot shard，含 node_refs）
public/data/*.geojson   備援 Base Layer（scripts/fetch_nanzi.py 產出）
src/importmap.ts        shard/標註解析 + 多區合併（啟動預載與「匯入地圖」共用）
src/roads.ts            屬性正規化 + 車道線生成（turf lineOffset）
src/graph.ts            路網圖（OSM node 拓撲切邊）+ A* + 轉向指引
src/mapStyle.ts         高德式樣式 + 公尺級寬度表達式 + canvas icon
src/drive.ts            模擬行駛（等速插值 + 方位角平滑 + 換車道）
src/gpsNav.ts           真 GPS 導航（watchPosition + 沿線投影），輸出與 drive.ts 同一種 DriveState
src/useDrive.ts         導航狀態機（模擬/GPS 共用）：HUD、鏡頭跟隨、reroute、路口決策
src/zones.ts            待轉區 = Enhancement Layer 第一個可編輯物件
src/App.tsx             模式機（瀏覽/編輯/規劃/導航）+ 畫面組裝
```

設計原則（呼應「SimCity 式 alter」）：**所有 Enhancement 物件都是「放置→拖曳→旋轉→屬性→匯出」同一套互動模型**，待轉區是第一個實作，之後的停止線、號誌、車道箭頭沿用。

## 已知限制 / 待修改

正式清單維護在計畫書 **B-11**（車道編輯、待轉區方向性+導航提醒、路牌/轉向限制、建築穿模）。此外：

- 已有：汽車/機車切換（機車禁行國道+`motorcycle=no`）、待轉區限路口 40 m 內放置（記 intersection id）。
- 效能三元兇已修：MSAA、preserveDrawingBuffer（現在只在 `?screenshot` 開）、導航 HUD 60fps setState（降至 ~6fps）。
- 待轉區匯出格式尚未轉成 LanePilot `annotations.jsonl` schema（欄位對應見計畫書 B-3）。
- 車道列在無 `turn:lanes` 的路口是推薦值（轉向側最外車道），需人工標註補真值。
- 路口處車道虛線直接相交，未做路口面清空。
- 建築只抓 demo 區 bbox；無 lanes tag 路段用等級預設值（primary 4 / secondary 3 / 其他 2）。
- headless 瀏覽器截圖偶發白屏（GPU 合成問題），實機瀏覽器正常。
- 真 GPS 導航需要 HTTPS 或 localhost（瀏覽器 Geolocation API 限制）；區網用 IP 開啟時該功能會停用，
  要在手機測試 GPS 導航請用 `tailscale serve --bg --https=443 http://localhost:5180` 轉成 HTTPS。
- journal 的標註作者目前寫死 `rex`（`src/enhancements.ts` 的 `AUTHOR`），單人開發階段夠用；
  多人協作時需要改成可設定值。

## 資料授權

地圖資料 © OpenStreetMap contributors（[ODbL](https://opendatacommons.org/licenses/odbl/)）。
預設底圖來自 LanePilot 專案對 OSM PBF 快照的行政區切片（`public/data/lanepilot/`）；
備援底圖為 Overpass API 即時查詢快照，時間見 `public/data/meta.json`。
