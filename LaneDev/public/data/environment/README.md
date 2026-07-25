# 楠梓區環境圖層

本資料由 `scripts/collect-nanzih-environment-data.mjs` 一次性從 OpenStreetMap
抽取，供應用程式以靜態 GeoJSON 載入；應用程式執行期間不會連線 Overpass。

檔案：

- `nanzih_green_areas.geojson`：公園、花園、森林、草地、自然綠地及農地面。
- `nanzih_water_areas.geojson`：河面、湖泊、水庫、池塘、滯洪池及濕地面。
- `nanzih_waterways.geojson`：河流、溪流、運河、排水道及溝渠線。
- `source-metadata.json`：抽取時間、查詢、來源、授權及分類數量。

幾何保留 WGS84（EPSG:4326）的 Polygon、MultiPolygon、LineString 或
MultiLineString，並保留 OSM ID、元素類型、名稱及完整原始 tags。

資料來源：© OpenStreetMap contributors，ODbL 1.0。
