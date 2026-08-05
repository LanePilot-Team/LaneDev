# 舊道路捏合升級與回退回查報告

- 來源：`未指定`
- 產生時間：`2026-08-05T08:39:54.197Z`
- 總數：50
- 已升級：2
- 已回退：0
- 原本已是 V2：48

「已升級」代表舊捏合已轉成可追溯的 schema v2；「已回退」代表無法安全還原關係，因此只停用舊捏合，讓道路回到未捏合狀態。

## 處置結果與判定說明

### 處置結果

- **已升級**：判定為 `replayable` 或 `recoverable_via_provenance`。保留舊紀錄，追加停用紀錄，再建立含完整來源快照的 schema v2 捏合。
- **已回退**：判定為 `needs_manual_review`、`invalid` 或 `legacy_destructive`。只停用不安全的舊捏合，讓道路恢復成未捏合狀態，交由人工確認。
- **原本已是 V2**：紀錄本來就有完整來源快照，不需要再次升級。

### 判定

- **`replayable`（可依序重播）**：能精確找到原本主段、次段與共同接點，並按舊 journal 順序重建相同捏合。
- **`recoverable_via_provenance`（可由來源追溯）**：畫面上的原路段可能已被 couplet 合併或吸收，但仍可由 `sourceSegments` 中的 OSM way、節點與幾何唯一找回。
- **`needs_manual_review`（需要人工確認）**：找得到相關道路，但候選路段、側路方向或允許進出方向無法唯一判定；系統不猜測，因此回退。
- **`invalid`（幾何或關係不成立）**：兩段目前不符合捏合條件，例如端點相距過遠、沒有共同接點或排列不連續。
- **`legacy_destructive`（舊版破壞性資料）**：舊版曾直接移除次段，而且現有來源資料不足以安全找回；本報告此類為 0 筆。

### 回查欄位

- **主段／次段**：當初作為承載段與吸收段的 block key；主段與次段不代表地圖上的左右順序或實際行駛方向。
- **來源 seq**：舊 journal 的紀錄序號，可用來追查原始操作。
- **人工回查位置**：預期接合節點的 Google Maps 與 OSM node 連結。
- **說明**：該筆判定的具體原因，例如「來源候選不唯一」或「端點相距 21.7 公尺」。

## 已升級（2）

| 道路 | 主段 | 次段 | 來源 seq | 判定 | 說明 | 人工回查位置 |
| --- | --- | --- | ---: | --- | --- | --- |
| 後昌路 | `way/281341659@b/2206349219` | `way/281341659@b/1407167209` | 3334 | replayable | 可依序重播 | [Google Maps](https://www.google.com/maps/@22.713172632375873,120.29406287499663,20z) / [OSM node 2206349219](https://www.openstreetmap.org/node/2206349219) |
| 藍昌路 | `way/254325307@b/1080697450` | `way/254325307@b/1080697512` | 3339 | replayable | 可依序重播 | [Google Maps](https://www.google.com/maps/@22.72962731334906,120.29206514043723,20z) / [OSM node 1080697450](https://www.openstreetmap.org/node/1080697450) |

## 已回退（0）

| 道路 | 主段 | 次段 | 來源 seq | 判定 | 說明 | 人工回查位置 |
| --- | --- | --- | ---: | --- | --- | --- |

## 原本已是 V2（48）

| 道路 | 主段 | 次段 | 來源 seq | 判定 | 說明 | 人工回查位置 |
| --- | --- | --- | ---: | --- | --- | --- |
| 藍昌路 | `way/254325307@b/12658227994` | `way/254325307@b/256245347` | 3343 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.73179771761087,120.29235600984691,20z) / [OSM node 12658227994](https://www.openstreetmap.org/node/12658227994) |
| 德中路 | `way/312871463@b/1080697254` | `way/312871463@b/1080696851` | 3345 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7265288,120.2747883,20z) / [OSM node 1080696851](https://www.openstreetmap.org/node/1080696851) |
| 德中路 | `way/312871463@b/2206324454` | `way/312871463@b/8420604124` | 3347 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7245962,120.2760852,20z) / [OSM node 8420604124](https://www.openstreetmap.org/node/8420604124) |
| 德中路 | `way/267715934@b/2206324442` | `way/267715934@b/4585345353` | 3349 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7227034,120.2776658,20z) / [OSM node 4585345353](https://www.openstreetmap.org/node/4585345353) |
| 德中路 | `way/267715934@b/9853009726` | `way/267715934@b/2206324436` | 3351 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7221724,120.2785028,20z) / [OSM node 9853009726](https://www.openstreetmap.org/node/9853009726) |
| 右昌街 | `way/267715913@b/1398635709` | `way/267715913@b/1398635978` | 3353 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.719057258826922,120.28371918808679,20z) / [OSM node 1398635978](https://www.openstreetmap.org/node/1398635978) |
| 右昌街 | `way/267715913@b/256455983` | `way/267715913@b/2956870896` | 3355 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.718490348170008,120.28465426522413,20z) / [OSM node 2956870896](https://www.openstreetmap.org/node/2956870896) |
| 右昌街 | `way/267715913@b/1398635709` | `way/267715913@b/256455983` | 3357 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.71875788073867,120.28421299006834,20z) / [OSM node 1398635709](https://www.openstreetmap.org/node/1398635709) |
| 右昌街 | `way/339750724@b/1398634826` | `way/339750724@b/1398636099` | 3359 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7179879,120.2853798,20z) / [OSM node 1398636099](https://www.openstreetmap.org/node/1398636099) |
| 右昌街 | `way/339750724@b/265968432` | `way/339750724@b/1398634826` | 3361 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.717910054160345,120.28561584147815,20z) / [OSM node 1398634826](https://www.openstreetmap.org/node/1398634826) |
| 右昌街 | `way/23683314@b/1398635694` | `way/23683314@b/1398634474` | 3365 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7170969,120.2868877,20z) / [OSM node 1398634474](https://www.openstreetmap.org/node/1398634474) |
| 右昌街 | `way/23683314@b/1398635837` | `way/23683314@b/1398635694` | 3367 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7169992,120.2872028,20z) / [OSM node 1398635694](https://www.openstreetmap.org/node/1398635694) |
| 右昌街 | `way/23683314@b/265968424` | `way/23683314@b/1398635837` | 3369 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7169064,120.2871693,20z) / [OSM node 1398635837](https://www.openstreetmap.org/node/1398635837) |
| 軍校路 | `way/267715892@b/2401176462` | `way/267715892@b/2401176460` | 3371 | recoverable_via_provenance | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7086649,120.2929731,20z) / [OSM node 2401176460](https://www.openstreetmap.org/node/2401176460) |
| 軍校路 | `way/267715892@b/2401176466` | `way/267715892@b/2401176462` | 3373 | recoverable_via_provenance | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7085939,120.292968,20z) / [OSM node 2401176462](https://www.openstreetmap.org/node/2401176462) |
| 軍校路 | `way/267715892@b/1372607199` | `way/267715892@b/2401176466` | 3375 | recoverable_via_provenance | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7085321,120.292958,20z) / [OSM node 2401176466](https://www.openstreetmap.org/node/2401176466) |
| 德中路 | `way/312871463@b/1080697514` | `way/312871463@b/1080697102` | 3380 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.729462568698665,120.27251821941903,20z) / [OSM node 1080697102](https://www.openstreetmap.org/node/1080697102) |
| 德中路 | `way/312871463@b/1080697514` | `way/312871463@b/1080697358` | 3382 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.72996920131409,120.27214033735282,20z) / [OSM node 1080697358](https://www.openstreetmap.org/node/1080697358) |
| 德中路 | `way/312871463@b/256455721` | `way/312871463@b/4668515918` | 3384 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7279852800404,120.27362207751308,20z) / [OSM node 4668515918](https://www.openstreetmap.org/node/4668515918) |
| 軍校路 | `way/383026294@b/262083286` | `way/383026294@b/258786223` | 3386 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.705610801046483,120.2928091952179,20z) / [OSM node 262083286](https://www.openstreetmap.org/node/262083286) |
| 軍校路 | `way/383026294@b/2938751972` | `way/383026294@b/2938751971` | 3388 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7048345,120.2925069,20z) / [OSM node 2938751971](https://www.openstreetmap.org/node/2938751971) |
| 軍校路 | `way/383026294@b/4315349243` | `way/383026294@b/2938751972` | 3390 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.70447,120.2925083,20z) / [OSM node 2938751972](https://www.openstreetmap.org/node/2938751972) |
| 加昌路 | `way/280015655@b/2206349237` | `way/280015655@b/2206349235` | 3392 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7143433,120.2955899,20z) / [OSM node 2206349235](https://www.openstreetmap.org/node/2206349235) |
| 加昌路 | `way/280015655@b/2206349237` | `way/280015655@b/1400036052` | 3394 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7144334,120.2958517,20z) / [OSM node 2206349237](https://www.openstreetmap.org/node/2206349237) |
| 加昌路 | `way/280015655@b/1400036405` | `way/280015655@b/1400036046` | 3396 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7146483,120.2964683,20z) / [OSM node 1400036405](https://www.openstreetmap.org/node/1400036405) |
| 加昌路 | `way/280015655@b/2206232294` | `way/280015655@b/1400036098` | 3398 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.71509552149069,120.29744851157412,20z) / [OSM node 1400036098](https://www.openstreetmap.org/node/1400036098) |
| 加昌路 | `way/280015655@b/1400036405` | `way/280015655@b/2206232291` | 3400 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.71485803908675,120.2968139031436,20z) / [OSM node 1400036046](https://www.openstreetmap.org/node/1400036046) |
| 加昌路 | `way/293422503@b/1400036749` | `way/293422503@b/304709043` | 3402 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.71565,120.2987823,20z) / [OSM node 1400036749](https://www.openstreetmap.org/node/1400036749) |
| 加昌路 | `way/268219230@b/1400036464` | `way/268219230@b/10894062953` | 3404 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7161202,120.3000992,20z) / [OSM node 10894062953](https://www.openstreetmap.org/node/10894062953) |
| 加昌路 | `way/23976945@b/2417585497` | `way/23976945@b/2417585494` | 3406 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7219622,120.3151321,20z) / [OSM node 2417585494](https://www.openstreetmap.org/node/2417585494) |
| 加昌路 | `way/280277096@b/1219300551` | `way/280277096@b/2377566099` | 3408 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.718138362550732,120.3056390180698,20z) / [OSM node 1219300551](https://www.openstreetmap.org/node/1219300551) |
| 加昌路 | `way/280277096@b/256730893` | `way/280277096@b/265599589` | 3410 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7192692,120.3089414,20z) / [OSM node 265599589](https://www.openstreetmap.org/node/265599589) |
| 加昌路 | `way/23976945@b/256245267` | `way/23976945@b/1401138499` | 3412 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7204191,120.3114176,20z) / [OSM node 1401138499](https://www.openstreetmap.org/node/1401138499) |
| 加昌路 | `way/230216178@b/2624297542` | `way/268219227@b/1196964687` | 3414 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7236125,120.3188825,20z) / [OSM node 1196964687](https://www.openstreetmap.org/node/1196964687) |
| 德民路 | `way/254325305@b/256455746` | `way/254325305@b/2379749920` | 3416 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.721702968209716,120.29198869496852,20z) / [OSM node 2379749920](https://www.openstreetmap.org/node/2379749920) |
| 藍昌路 | `way/297138323@b/13305979122` | `way/1450825430@b/258784609` | 3418 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.726484728978562,120.29162786095868,20z) / [OSM node 13305979122](https://www.openstreetmap.org/node/13305979122) |
| 德民路 | `way/254325305@b/1400036368` | `way/254325305@b/256455769` | 3420 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7219859,120.2945163,20z) / [OSM node 256455769](https://www.openstreetmap.org/node/256455769) |
| 德民路 | `way/254325305@b/1398635729` | `way/254325305@b/1400036368` | 3422 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.721928049968362,120.29388401674038,20z) / [OSM node 1400036368](https://www.openstreetmap.org/node/1400036368) |
| 德民路 | `way/254325305@b/1401138287` | `way/1420142022@b/13049704155` | 3424 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7223994,120.2956702,20z) / [OSM node 13049704155](https://www.openstreetmap.org/node/13049704155) |
| 德民路 | `way/254325305@b/1401138287` | `way/254325305@b/1400036861` | 3426 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7225036,120.2952755,20z) / [OSM node 1401138287](https://www.openstreetmap.org/node/1401138287) |
| 德民路 | `way/254325305@b/1401138287` | `way/254325305@b/3164180313` | 3428 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.722377476563278,120.29524264277696,20z) / [OSM node 1400036861](https://www.openstreetmap.org/node/1400036861) |
| 德民路 | `way/126247850@b/7477787914` | `way/126247850@b/12599118960` | 3430 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7305373,120.3157708,20z) / [OSM node 12599118960](https://www.openstreetmap.org/node/12599118960) |
| 德民路 | `way/126247850@b/258785765` | `way/126247850@b/2913992342` | 3432 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.731035321007433,120.31647834640353,20z) / [OSM node 2913992342](https://www.openstreetmap.org/node/2913992342) |
| 後昌路 | `way/281341661@b/4586442323` | `way/281341661@b/1372607153` | 3436 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.71607064849144,120.28831404351948,20z) / [OSM node 4586442323](https://www.openstreetmap.org/node/4586442323) |
| 學專路 | `way/24204253@b/2398129507` | `way/24204253@b/1219300659` | 3640 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7147264,120.3154594,20z) / [OSM node 2398129507](https://www.openstreetmap.org/node/2398129507) |
| 學專路 | `way/24204253@b/1219300429` | `way/24204253@b/1219300564` | 3645 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.7141354,120.314444,20z) / [OSM node 1219300564](https://www.openstreetmap.org/node/1219300564) |
| 外環西路 | `way/268219234@b/2206324424` | `way/1454602407@b/2206324417` | 3849 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.713147048463146,120.30234969214254,20z) / [OSM node 2206324417](https://www.openstreetmap.org/node/2206324417) |
| 左楠路 | `way/297205391@b/3010545851` | `way/297205391@b/2919858675` | 3886 | replayable | 已是 schema v2，不重複遷移 | [Google Maps](https://www.google.com/maps/@22.710699458849,120.30230769324382,20z) / [OSM node 2919858675](https://www.openstreetmap.org/node/2919858675) |
