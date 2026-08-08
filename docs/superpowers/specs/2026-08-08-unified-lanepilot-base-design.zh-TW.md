# LanePilot 新 Base 與 HUD／路網統一資料設計

## 狀態

- 日期：2026-08-08
- 狀態：設計已由使用者逐段確認，待書面規格審閱
- 相關設計：`2026-08-04-lane-aware-navigation-design.zh-TW.md`

## 背景與問題

目前 LanePilot 標註的資料權威被拆成多條管線：

- `road_database.json.segments` 保存道路幾何，但 5,481 筆 segment 中只有約 22 筆直接帶有車道 base 欄位。
- `road_database.json.annotations` 為空陣列。
- 731 筆 LanePilot 車道資料被物化成 `editor.journal` 中的 `author=lanepilot` 紀錄，供道路繪製使用。
- `lane-guidance.json` 另外保存 1,007 筆 HUD／導航車道紀錄。
- 待轉區與機車規則又由另一條 annotations 轉換流程處理。

因此道路繪製、導航 graph、導航線與 HUD 可能對同一路段取得不同的車道數或轉向。本設計建立真正的 LanePilot base，並讓所有消費端使用同一份解析後資料。

目前來源 `annotations.jsonl` 有 1,485 筆紀錄：927 筆 `intersection_approach`、552 筆 `segment_direction`，另有 6 筆 legacy／未指定 scope 紀錄；其中 1,008 筆含 lane profile。

## 目標

1. 讓 `road_database.json.annotations` 成為 LanePilot 路段、路口、車道、機車與待轉規則的正式 base。
2. 移除 731 筆舊 `author=lanepilot` journal，避免同一標註同時存在 base 與覆蓋層。
3. 完整保留人工 journal、道路合併、新道路、待轉區、刪除及其他人工繪圖設定。
4. 建立唯一的有效車道模型，供道路繪製、導航 graph、導航線與 HUD 共用。
5. 無法映射或驗證失敗時拒絕覆寫正式資料庫，不得默默略過。
6. 新 base 完成後重建人工 journal 差異報告。

## 非目標

- 不使用 GPS 推測駕駛目前所在的實際車道。
- 不自動刪除與新 base 相同的人工欄位；報告只提供人工回查。
- 不改變人工資料最高優先權。
- 不把 LanePilot base 再包裝成另一種 journal。

## 正式資料模型

`road_database.json` 保持單一正式靜態資料庫：

```text
road_database.json
├─ segments       道路幾何、OSM 與靜態路段資料
├─ annotations    LanePilot 路段、路口、車道、機車與待轉 base
└─ editor
   ├─ journal     人工及結構性覆蓋
   ├─ waiting_zones
   └─ deleted_waiting_zone_ids
```

`annotations` 保存可追溯的 LanePilot 正規化紀錄，不將路口 approach 資料錯誤攤平成整條 way。每筆紀錄保留 segment identity、scope、方向、路口 node、lane profile、機車規則、待轉規則及來源 metadata。

道路合併仍是 `editor.journal` 中的 `road_merge` 紀錄。`anna`、`rex`、`unknown`、`road-merge-recovery-v2` 與其他非 LanePilot 紀錄全部保留。

## 欄位級解析優先序

由高到低：

1. 人工 block journal：`way/W@b/N`
2. 人工 way journal：`way/W`
3. LanePilot `intersection_approach`
4. LanePilot `segment_direction`
5. segment／OSM 原始欄位
6. 系統推測

這是欄位級 overlay。人工只修改 `turn_lanes` 時，車道數仍可沿用 LanePilot base；未出現在人工紀錄中的 base 欄位不會被清空。

## 有效車道模型

新增單一解析邊界，為每個「道路區塊 × 行車方向 × 接近路口」產生有效模型：

```text
EffectiveLaneModel
├─ laneCount
├─ laneMovements
├─ motorcycleAccess
├─ twoStageLeftTurn
├─ waitingZone
├─ fieldSources
└─ inferredFields
```

`fieldSources` 記錄每個欄位來自人工 block、人工 way、LanePilot approach、LanePilot segment、OSM 或推測。`inferredFields` 供 HUD 判斷是否顯示警告。

道路切分及 couplet/way/node remap 完成後才建立模型，使 approach node 能對應實際區塊。人工道路欄位套用後，再 replay 新道路、刪除與道路合併，建立最終 routing roads 與 rendering roads。

## 共用消費端

- 道路繪製以 `EffectiveLaneModel` 決定車道數與路面箭頭。
- `RoadGraph` edge 持有或引用同一模型，不能重新從另一份檔案解析。
- 導航車道選擇只允許符合下一個 maneuver 的車道。
- HUD 直接顯示目前導航 edge 使用的有效模型。
- `lane-guidance.json` 不再是執行期權威；可暫時保留為相容或稽核用衍生檔，但正式程式不得在 base 載入失敗時偷偷回退使用它。

## 導航與機車行為

- 右轉導航線必須位於允許右轉的最外側合適車道，不能回到僅直行的中央車道。
- 導航線換道時機與 HUD 高亮同步。
- 一般機車轉彎後優先進入合法外側車道。
- 兩段式左轉使用最外側允許直行車道；若最外側僅能右轉，不得引導機車進入該車道待轉。
- 系統不宣稱知道駕駛實際位於哪條車道；偏離導航道路時依既有行為重新算路。
- 只有實際使用 OSM／幾何推測欄位時，HUD 顯示小字「系統推測資料，請依現場標線行駛」。

## 新 Base 建置流程

1. 讀取 LanePilot segment shards 與最新版 `annotations.jsonl`。
2. 去重並驗證 segment identity、`node_refs`、`nav_segment_key + split_index`。
3. 正規化 annotation，建立 segment、approach、機車及待轉索引。
4. 將既有 editor 資料分成：LanePilot 舊物化紀錄、人工／結構性紀錄。
5. 移除全部 `author=lanepilot` 紀錄，只把人工／結構性紀錄放入候選資料庫。
6. 產生 `road_database.candidate.json` 與機器可讀稽核報告。
7. 執行資料、replay、導航、繪圖、測試與 production build 驗證。
8. 所有必要檢查通過後，先備份舊資料庫，再以明確 `--write-canonical` 操作取代正式資料庫。

建置預設只寫候選檔，不能直接寫 canonical。

## 映射與失敗規則

每筆 annotation 必須有下列結果之一：

- 成功映射並被消費。
- 本身不含該類資料，例如只有 movement rule、沒有 lane profile；仍需記錄其已由其他解析器處理。
- 明確錯誤並列入人工回查。

以下情況禁止正式寫入：

- 標註 way 或 approach node 無法在 remap 後路網找到。
- 同一 canonical key 有內容不同的重複標註。
- 車道數與 movement array 不相容且無明確修復規則。
- 舊 segment 無原因消失或 identity 衝突。
- 人工 journal 內容或順序意外改變。
- 道路合併、新道路、待轉區或人工刪除無法 replay。

不適用於某欄位的有效紀錄不是錯誤；未被任何解析器說明的紀錄才是錯誤。

## 人工資料保護

正式取代前記錄並比對：

- 非 LanePilot journal 的完整內容雜湊。
- 紀錄總數、作者分布、target type 分布與 seq 順序。
- `waiting_zones` 與 `deleted_waiting_zone_ids`。
- 道路合併、新道路及 dependent `turn_bay`、`right_lane`、`moto_box` 紀錄。

新 base 不會自動刪除與 base 相同的人工欄位，因為舊編輯器可能把未實際修改的欄位一併保存。清理只能在新版比較報告完成後，以欄位級方式另行決策。

## 測試與驗證

### 轉換測試

- segment 與 approach scope 正確映射。
- way/node remap 及方向翻轉正確。
- 機車、兩段式左轉與待轉規則不遺失。
- 無法映射與衝突時命令回傳非零 exit code。

### Overlay 測試

- 人工 block 高於人工 way。
- 人工高於 LanePilot approach/segment。
- approach 高於 segment，segment 高於 OSM／推測。
- 部分人工欄位不會清空未修改的 base 欄位。
- 道路合併及新道路 replay 後仍解析正確模型。

### 一致性測試

- 路面車道數等於 HUD 車道數。
- 路面箭頭等於 HUD 箭頭。
- 導航線只使用允許下一 maneuver 的車道。
- 右轉線不回中央直行車道。
- 待轉機車不進右轉專用道。
- 只有推測欄位觸發 HUD 推測提示。

### 專案驗證

- `npm.cmd run test:all`
- 新 base candidate audit
- 人工 journal hash/replay audit
- 導航與繪圖一致性 audit
- `npm.cmd run build`
- `git diff --check`

## 新版人工回查報告

正式新 base 建立後，重新產生並覆蓋目前的 Markdown 與 CSV 報告。分類包括：

- 完全一致。
- 已填欄位一致。
- 允許方向相同但箭頭表示不同。
- 轉向不同。
- 車道數不同。
- 車道數與轉向皆不同。
- 新 base 無對應資料。
- 標註存在但無法映射；正式發布前此數量必須為 0。

報告保留道路名稱、way/block、方向、座標、Google Maps、OSM、base 值、人工值、來源 author/seq/target 與回查說明。舊的 488 筆完全一致只是舊管線結果，不得當作新 base 的最終數字。

## 驗收條件

1. `road_database.annotations` 不再為空，且所有 1,485 筆來源標註都有可稽核處理結果。
2. `author=lanepilot` journal 數量為 0。
3. 非 LanePilot 人工與結構性資料完整保留並可 replay。
4. HUD、道路繪製、導航 graph 與導航線共用同一有效車道模型。
5. 不允許方向不會出現在導航線上。
6. 機車外側車道與兩段式左轉規則符合本規格。
7. 無法映射數量為 0，所有測試、audit 與 build 通過後才可取代 canonical。
8. 新版人工差異報告成功產生。
