# LaneNav — 台灣車道級（機車友善）導航

純前端的車道級導航展示（高雄市楠梓區路網）。React 19 + TypeScript + Vite + MapLibre GL + three.js，無後端。

核心差異化是**機車路權**：

- 兩段式左轉：路口待轉區顯示與導航黃色待轉提醒
- 機車禁行路段（`motorcycle=no`）避讓
- 機車道（最外側白實線）與車道級指引
- 汽車/機車雙車種路線規劃，一鍵切換即重算

## 功能

| 模式 | 說明 |
|---|---|
| 瀏覽 | 高德式 2.5D 地圖（公尺級路寬、車道虛線、待轉區、分隔島），點路段看屬性 |
| 規劃路線 | 起點/停靠點/終點（可拖曳排序）、🚗/🛵 車種切換、轉彎步驟清單（含兩段式左轉提醒） |
| 模擬行駛 | 沿路線等速行駛：導航看板、車道級指引、變速/換車道、路口「不照指引走」自動重規劃 |
| GPS 導航 | 真實定位導航（需 HTTPS），偏離自動重規劃 |
| 匯入地圖 | LanePilot `segments.jsonl`（換底圖）/ `annotations.jsonl`（套標註），唯讀套用 |

## 開發

```bash
npm install
npm run dev      # http://localhost:5181
npm run build    # tsc 型別檢查 + 打包到 dist/
```

## 程式結構

```
src/
  core/     路網資料/正規化/路網圖 A*/地圖樣式/待轉區/偏心道/3D 車模 …
  app/      地圖初始化與共用狀態（mapCore）、匯入流程（importFlow）
  plan/     路線規劃：usePlanner / PlanPanel / ManeuverList
  nav/      導航：模擬駕駛 drive / GPS gpsNav / useDrive / DriveHUD
  browse/   瀏覽：路段資訊卡
  App.tsx   模式機 + 點擊分派 + 畫面組裝（LaneNav 專屬）
public/data/  楠梓區路網 shard、建築物、示範標註（seed journal）
```

> ⚠️ `src/core` `src/app` `src/plan` `src/nav` `src/browse` `src/App.css` 與 `public/data`
> 由開發版 repo（LaneDev）的 `npm run sync-lanenav` 鏡像產生。
> 要改共用功能請到 LaneDev 修改後重新同步，不要直接改這些目錄。

## 資料來源

- 路網/建築：OpenStreetMap（© OpenStreetMap contributors，ODbL）
- 楠梓區 shard：LanePilot 資料管線（OSM 萃取，含 node_refs 拓撲）
- 待轉區等人工標註：Enhancement Layer journal（append-only，與底圖解耦）
