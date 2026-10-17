# 楠梓區 OSM 建築高度配對資料

建立時間：2026-07-24T13:53:14.961Z

## 內容
- **nanzih_buildings_height.geojson**：MapLibre / GIS 可直接載入的建築多邊形與視覺高度。
- **nanzih_buildings_height.csv**：逐棟高度屬性清單，不包含 geometry。

## 高度規則
1. `osm_height`：OSM `height=*`，以公尺數字解析（高可信度）。
2. `osm_levels_derived`：`building:levels × 3.2m`，另加 `roof:levels × 2m`（中可信度）。
3. `building_type_default`：沒有 OSM 高度和樓層時，以建築類型的**視覺預設高度**補值（低可信度，非測量結果）。

| 建築類型 | 視覺預設高度 |
|---|---:|
| residential / apartments / house | 10m |
| commercial / office / retail | 12m |
| industrial / warehouse | 9m |
| school / university / hospital / public | 15m |
| temple / church | 14m |
| garage / shed | 3.5m |
| unclassified | 9m |

## 資料品質
總建物：1154

| 高度來源 | 棟數 |
|---|---:|
| osm_levels_derived | 197 |
| building_type_default | 956 |
| osm_height | 1 |

常見 OSM `building=*` 值：

| 類型 | 棟數 |
|---|---:|
| yes | 378 |
| apartments | 333 |
| residential | 193 |
| industrial | 47 |
| house | 35 |
| university | 33 |
| school | 25 |
| terrace | 20 |
| college | 15 |
| office | 8 |
| public | 7 |
| commercial | 7 |
| construction | 7 |
| retail | 6 |
| train_station | 5 |
| temple | 5 |
| dormitory | 5 |
| kindergarten | 5 |
| storage_tank | 4 |
| ruins | 4 |
| hospital | 3 |
| transportation | 2 |
| warehouse | 2 |
| greenhouse | 1 |
| grandstand | 1 |

## 授權與標示
來源為 OpenStreetMap contributors，資料使用需遵守 [ODbL 1.0](https://www.openstreetmap.org/copyright)。使用於地圖時應顯示 **© OpenStreetMap contributors**。

## MapLibre
對 GeoJSON 的 `height_m` 使用 `fill-extrusion-height`，即可產生 3D 建築。要區分品質，可按 `height_source` 設定不同色彩或透明度。
