// 高德導航風格：淺色底、深藍灰路面、白色車道線、藍色路線帶。
// 車道級圖層 (minzoom 15) 全部用真實公尺寬，縮放時比例不變。
import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl'
import { widthMeters, pxPerMeter } from './geo'
import { GROUND_RULES } from './roadtext'

export const C = {
  bg: '#e9edf2',
  building: '#dce3ec',
  buildingLine: '#c8d2df',
  casing: '#39445e',
  surface: '#4d5a74',
  motoBox: '#61708f', // 機車停等格框內：比路面淺一階（不透明，蓋掉車道線且清楚可辨）
  laneLine: 'rgba(255,255,255,0.85)',
  centerLine: '#f5c542',
  routeCasing: '#1d4ed8',
  route: '#3b82f6',
  label: '#3d4a5c',
  labelHalo: '#ffffff',
}

/** icon 尺寸表達式：讓圖片呈現為實際 meters 高（imgPx = 圖片像素高） */
function iconMeters(meters: number | ExpressionSpecification, imgPx: number): ExpressionSpecification {
  const s = (z: number): number | ExpressionSpecification => typeof meters === 'number'
    ? (meters * pxPerMeter(z)) / imgPx
    : ['*', meters, pxPerMeter(z) / imgPx]
  return ['interpolate', ['exponential', 2], ['zoom'], 10, s(10), 24, s(24)]
}

const LANE_ZOOM = 15 // 之下畫簡化路網、之上畫車道級

const emptyFC = { type: 'FeatureCollection', features: [] } as const

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      'taiwan-ocean': {
        type: 'geojson',
        data: '/data/environment/taiwan_ocean.geojson',
        attribution: 'Made with Natural Earth',
      },
      'nanzih-green-areas': {
        type: 'geojson',
        data: '/data/environment/nanzih_green_areas.geojson',
        attribution: '© OpenStreetMap contributors',
      },
      'nanzih-water-areas': {
        type: 'geojson',
        data: '/data/environment/nanzih_water_areas.geojson',
        attribution: '© OpenStreetMap contributors',
      },
      'nanzih-waterways': {
        type: 'geojson',
        data: '/data/environment/nanzih_waterways.geojson',
        attribution: '© OpenStreetMap contributors',
      },
      roads: { type: 'geojson', data: emptyFC as never },
      roadSurfaces: { type: 'geojson', data: emptyFC as never },
      dividers: { type: 'geojson', data: emptyFC as never },
      roadPreview: { type: 'geojson', data: emptyFC as never },
      turnbays: { type: 'geojson', data: emptyFC as never },
      roadtext: { type: 'geojson', data: emptyFC as never },
      medians: { type: 'geojson', data: emptyFC as never },
      buildings: { type: 'geojson', data: emptyFC as never },
      occludedBuildings: { type: 'geojson', data: emptyFC as never },
      route: { type: 'geojson', data: emptyFC as never },
      endpoints: { type: 'geojson', data: emptyFC as never },
      zones: { type: 'geojson', data: emptyFC as never },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
      {
        id: 'taiwan-ocean-fill',
        type: 'fill',
        source: 'taiwan-ocean',
        filter: ['==', ['get', 'water_type'], 'ocean'],
        paint: { 'fill-color': '#BFD9EA', 'fill-opacity': 0.76 },
      },
      {
        id: 'taiwan-coastline',
        type: 'line',
        source: 'taiwan-ocean',
        filter: ['==', ['get', 'feature_category'], 'coastline'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#9FBFD2',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 14, 1.4],
        },
      },
      {
        id: 'green-areas-fill',
        type: 'fill',
        source: 'nanzih-green-areas',
        paint: {
          'fill-color': [
            'match', ['get', 'green_type'],
            'park', '#CFE7C7',
            'garden', '#CFE7C7',
            'forest_or_wood', '#B8D8AE',
            'grass_or_meadow', '#DCEBCF',
            'natural_green', '#C8DFC0',
            'agricultural', '#E7EBCB',
            '#DCEBCF',
          ],
          'fill-opacity': [
            'match', ['get', 'green_priority'],
            'high', 0.78,
            'medium', 0.68,
            'low', 0.58,
            0.65,
          ],
        },
      },
      {
        id: 'water-areas-fill',
        type: 'fill',
        source: 'nanzih-water-areas',
        paint: {
          'fill-color': '#BFD9EA',
          'fill-opacity': 0.76,
        },
      },
      {
        id: 'waterways-line',
        type: 'line',
        source: 'nanzih-waterways',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#BFD9EA',
          'line-opacity': 0.82,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            11, [
              'match', ['get', 'waterway_type'],
              'river', 1.4,
              ['stream', 'canal'], 0.9,
              0.5,
            ],
            18, [
              'match', ['get', 'waterway_type'],
              'river', 5,
              ['stream', 'canal'], 3,
              1.5,
            ],
          ],
        },
      },
      {
        id: 'waterways-label',
        type: 'symbol',
        source: 'nanzih-waterways',
        minzoom: 14.5,
        filter: ['all', ['has', 'name'], ['!=', ['get', 'name'], '']],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 260,
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 13,
          'text-rotation-alignment': 'map',
          'text-pitch-alignment': 'map',
          'text-keep-upright': true,
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.6,
        },
      },

      // ── 簡化路網（低 zoom）──
      {
        id: 'roads-simple', type: 'line', source: 'roads', maxzoom: LANE_ZOOM,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.surface,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'highway'],
              ['motorway', 'trunk'], 2.2, ['primary', 'secondary'], 1.6, 0.7],
            15, ['match', ['get', 'highway'],
              ['motorway', 'trunk'], 7, ['primary', 'secondary'], 5.5, 3.5],
          ],
        },
      },

      // ── 車道級路面 ──
      // 高架路段（elevated）不畫地面路體——3D 橋面（elevated3d）全長取代，
      // 平面「影子」會造成雙重路體（2026-07-18 使用者回饋移除）
      {
        id: 'road-casing', type: 'fill', source: 'roadSurfaces', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'surfaceKind'], 'casing'],
        paint: { 'fill-color': C.casing },
      },
      // ── 偏心左轉道（Enhancement Layer）──
      // casing 墊在 road-surface 之前：bay 與路面的接縫由 surface 蓋掉，只露出外緣描邊
      {
        id: 'bay-casing', type: 'fill', source: 'turnbays', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'kind'], 'casing'],
        paint: { 'fill-color': C.casing },
      },
      {
        id: 'road-surface', type: 'fill', source: 'roadSurfaces', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'surfaceKind'], 'surface'],
        paint: { 'fill-color': C.surface },
      },
      {
        id: 'bay-fill', type: 'fill', source: 'turnbays', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'kind'], 'fill'],
        paint: { 'fill-color': C.surface },
      },
      {
        // bay 邊線與中央槽化線（台灣標線色）：分隔對向 = 黃、分隔同向 = 白；
        // stop = 路口停止線（白粗橫線，寬 0.45m 仿實際 30~60cm）
        id: 'bay-edge', type: 'fill', source: 'turnbays', minzoom: 15.5,
        filter: ['all', ['==', ['get', 'kind'], 'line'], ['==', ['get', 'groundMarking'], true]],
        paint: {
          'fill-color': ['match', ['get', 'color'], 'yellow', C.centerLine, C.laneLine],
        },
      },
      {
        id: 'unused-lane-gore', type: 'fill', source: 'turnbays', minzoom: 15.5,
        filter: ['in', ['get', 'featureType'],
          ['literal', ['unused_lane_gore_outline', 'unused_lane_gore_hatch']]],
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], C.centerLine],
          'fill-opacity': 1,
        },
      },
      // ── 分隔島（Case B：成對單行間的實體分隔帶，自動推導）──
      {
        id: 'median-fill', type: 'fill', source: 'medians', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'kind'], 'island'],
        paint: { 'fill-color': '#87977f' }, // 綠帶（比路面淺、帶綠灰）
      },
      {
        // 島緣標線：分隔對向 = 黃（標線顏色規則）
        id: 'median-edge', type: 'line', source: 'medians', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'island'],
        paint: { 'line-color': C.centerLine, 'line-width': widthMeters(0.25) },
      },
      {
        // 儲車段地面箭頭（左轉/迴轉），朝向 = 行進方向
        id: 'bay-arrow', type: 'symbol', source: 'turnbays', minzoom: 16,
        filter: ['==', ['get', 'kind'], 'arrow'],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': iconMeters(4.5, 96),
          'icon-rotate': ['get', 'brg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
        paint: { 'icon-opacity': 0.9 },
      },

      // ── 車道線（載入時用 turf lineOffset 生成）──
      {
        id: 'lane-divider', type: 'fill', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'lane'],
        paint: {
          'fill-color': C.laneLine,
        },
      },
      {
        id: 'center-divider', type: 'fill', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'center'],
        paint: { 'fill-color': C.centerLine },
      },
      {
        id: 'center-divider-double', type: 'fill', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'center-double'],
        paint: { 'fill-color': C.centerLine },
      },
      {
        // 機車道分隔：白實線
        id: 'moto-divider', type: 'fill', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'moto'],
        paint: { 'fill-color': C.laneLine },
      },
      // 編輯模式即時預覽：只重算目前選取的道路區塊。
      {
        id: 'road-preview-casing', type: 'fill', source: 'roadPreview', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'surfaceKind'], 'casing'],
        paint: { 'fill-color': C.casing },
      },
      {
        id: 'road-preview-surface', type: 'fill', source: 'roadPreview', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'surfaceKind'], 'surface'],
        paint: { 'fill-color': C.surface },
      },
      {
        id: 'road-preview-lane', type: 'fill', source: 'roadPreview', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'lane'],
        paint: { 'fill-color': C.laneLine },
      },
      {
        id: 'road-preview-center', type: 'fill', source: 'roadPreview', minzoom: 15.5,
        filter: ['in', ['get', 'kind'], ['literal', ['center', 'center-double']]],
        paint: { 'fill-color': C.centerLine },
      },
      {
        id: 'road-preview-moto', type: 'fill', source: 'roadPreview', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'moto'],
        paint: { 'fill-color': C.laneLine },
      },

      // ── 機車停等格（排在車道線之後：不透明 fill 蓋掉框內車道線＝「線在格前截止」，
      // 填色比路面淺一階讓框本體清楚可辨；白框加粗 0.22m）──
      {
        id: 'motobox-fill', type: 'fill', source: 'turnbays', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'motobox'],
        paint: { 'fill-color': C.motoBox },
      },
      {
        id: 'motobox-edge', type: 'line', source: 'turnbays', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'motobox'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': C.laneLine, 'line-width': widthMeters(0.22) },
      },
      {
        id: 'motobox-icon', type: 'symbol', source: 'turnbays', minzoom: 16,
        filter: ['in', ['get', 'kind'], ['literal', ['motobox-icon', 'moto-lane-entry-icon']]],
        layout: {
          'icon-image': ['get', 'icon'],
          // SVG 高度皆為 809px；每枚圖示依停等格分配寬度自動縮放。
          'icon-size': iconMeters(['get', 'iconHeightM'], 809),
          'icon-rotate': ['get', 'brg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 0.95 },
      },

      {
        // 路面印字（禁行機車等）：roadtext.ts 生成點位，朝向 = 行進方向。
        // 尺寸與 makeIcons 的 roadTextImage 約定：4 字 × 80px/字 ↔ 10m 長
        id: 'road-text', type: 'symbol', source: 'roadtext', minzoom: 16,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans CJK TC Regular'],
          'text-size': widthMeters(1.15),
          'text-writing-mode': ['vertical'],
          'text-letter-spacing': 0.12,
          'text-rotate': ['get', 'brg'],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': ['get', 'color'], 'text-opacity': 0.92 },
      },

      // ── 單行道方向箭頭 ──
      {
        id: 'oneway-arrow', type: 'symbol', source: 'roads', minzoom: 16,
        filter: ['all', ['==', ['get', 'oneway'], 'yes'], ['!=', ['get', 'elevated'], true],
          ['!=', ['get', 'roadMarkingMode'], 'none'],
          ['!=', ['get', 'hideIntersectionInfo'], true]],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 140,
          'icon-image': 'arrow-right',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.35, 20, 0.8],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
        paint: { 'icon-opacity': 0.75 },
      },

      // ── 3D 建築 ──
      // 必須排在道路「之後」：MapLibre 按圖層順序合成，建築放前面會被路面蓋過去，
      // 看起來像沉到地底。放這裡建築能正確遮擋後方道路；路線帶/車標仍壓在最上層。
      {
        id: 'buildings', type: 'fill-extrusion', source: 'buildings', minzoom: 14,
        paint: {
          'fill-extrusion-color': [
            'match', ['get', 'building'],
            'station_support', [
              'match', ['get', 'station_parent_building'],
              'train_station', '#ddd3c5',
              C.building,
            ],
            'station_extension', [
              'match', ['get', 'station_parent_building'],
              'train_station', '#ddd3c5',
              C.building,
            ],
            ['industrial', 'warehouse', 'storage_tank'], '#c9c4bb',
            ['school', 'university', 'college', 'kindergarten', 'hospital', 'public'], '#d6dfcf',
            ['commercial', 'office', 'retail', 'train_station'], '#ddd3c5',
            ['temple', 'church'], '#ddcfbf',
            C.building,
          ],
          'fill-extrusion-height': ['coalesce', ['get', 'height_m'], 9],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height_m'], 0],
          'fill-extrusion-opacity': 1,
        },
      },
      {
        id: 'occluded-buildings', type: 'fill-extrusion', source: 'occludedBuildings', minzoom: 14,
        paint: {
          'fill-extrusion-color': '#cbd5e1',
          'fill-extrusion-height': ['coalesce', ['get', 'height_m'], 9],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height_m'], 0],
          'fill-extrusion-opacity': 0.22,
        },
      },

      // ── 導航路線帶 ──
      // 路線帶透明度 70%（不透明度 0.3）：能看到藍線指引，也透得出地面標線/車道虛線
      {
        id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.routeCasing, 'line-width': 11, 'line-opacity': 0.3 },
      },
      {
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.route, 'line-width': 8, 'line-opacity': 0.3 },
      },
      {
        id: 'route-chevron', type: 'symbol', source: 'route',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 70,
          'icon-image': 'chevron-right',
          'icon-size': 0.55,
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
      },

      // ── 待轉區（Enhancement Layer，可編輯）──
      {
        id: 'zone-fill', type: 'fill', source: 'zones',
        filter: ['==', ['get', 'kind'], 'fill'],
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['get', 'highlighted'], false], 'rgba(250,204,21,0.68)',
            ['boolean', ['get', 'selected'], false], 'rgba(59,130,246,0.35)',
            'rgba(255,255,255,0.28)',
          ],
        },
      },
      {
        id: 'zone-outline-casing', type: 'fill', source: 'zones',
        filter: ['all',
          ['==', ['get', 'kind'], 'outline-casing'],
          ['==', ['get', 'groundMarking'], true],
        ],
        paint: { 'fill-color': 'rgba(30,41,59,0.85)' },
      },
      {
        id: 'zone-outline', type: 'fill', source: 'zones',
        filter: ['all',
          ['==', ['get', 'kind'], 'outline'],
          ['==', ['get', 'groundMarking'], true],
        ],
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['get', 'highlighted'], false], '#fde047',
            ['boolean', ['get', 'selected'], false], '#3b82f6',
            '#ffffff',
          ],
        },
      },
      {
        id: 'zone-label', type: 'symbol', source: 'zones', minzoom: 15.5,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'icon-image': 'zone-text',
          'icon-size': iconMeters(3.6, 160),
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
        },
      },

      // ── 起終點 ──
      {
        id: 'endpoint-circle', type: 'circle', source: 'endpoints',
        paint: {
          'circle-radius': 8,
          'circle-color': ['match', ['get', 'kind'], 'start', '#22c55e', 'via', '#1565c0', '#ef4444'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      },

      // ── 路名 ──
      {
        id: 'road-label', type: 'symbol', source: 'roads', minzoom: 14.5,
        filter: ['all', ['has', 'name'], ['!=', ['get', 'roadMarkingMode'], 'none'],
          ['!=', ['get', 'hideIntersectionInfo'], true]],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 13,
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.6,
        },
      },

      // 車輛（放置的模型與導航自車）由 three.js 自訂圖層渲染（models3d.ts），
      // 於 App 載入時 map.addLayer 掛在所有樣式圖層之上。
    ],
  }
}

// ── 程式繪製 icon（避開 CJK glyph 伺服器依賴：中文全用 canvas 畫成圖）──

/** 路面標線字（直書）：圖頂端由 roadtext.ts 對準行進方向；實際道路標字需讓
 * 駕駛由近到遠讀，因此圖片由頂到底反向排列（底端第一字、頂端最後一字）。
 * 字體瘦長（scale 1.5 倍高）仿標線比例。 */
function roadTextImage(text: string, color = '#ffffff') {
  const chars = [...text].reverse()
  const W = 56, CELL = 80
  return canvasImage(W, CELL * chars.length, (g) => {
    g.font = 'bold 44px "Microsoft JhengHei", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = color
    chars.forEach((ch, i) => {
      g.save()
      g.translate(W / 2, i * CELL + CELL / 2)
      g.scale(1, 1.5)
      g.fillText(ch, 0, 0)
      g.restore()
    })
  })
}

function canvasImage(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')!
  draw(g)
  return g.getImageData(0, 0, w, h)
}

/** 路面箭頭保留原高度與筆畫，只略縮橫向，避免貼住相鄰車道線。 */
function roadArrowImage(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  return canvasImage(w, h, (g) => {
    g.translate(w / 2, 0)
    g.scale(0.92, 1)
    g.translate(-w / 2, 0)
    draw(g)
  })
}

export function makeIcons(): Record<string, ImageData> {
  return {
    // 導航自車：白圈藍箭頭（線放置的箭頭指右 = 線方向）
    'car-arrow': canvasImage(72, 72, (g) => {
      g.shadowColor = 'rgba(0,0,0,0.35)'
      g.shadowBlur = 6
      g.fillStyle = '#ffffff'
      g.beginPath(); g.arc(36, 36, 26, 0, Math.PI * 2); g.fill()
      g.shadowBlur = 0
      g.fillStyle = '#2563eb'
      g.beginPath()
      g.moveTo(36, 14); g.lineTo(52, 52); g.lineTo(36, 43); g.lineTo(20, 52)
      g.closePath(); g.fill()
    }),
    'arrow-right': canvasImage(32, 32, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 5
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(6, 16); g.lineTo(24, 16); g.stroke()
      g.beginPath(); g.moveTo(17, 8); g.lineTo(25, 16); g.lineTo(17, 24); g.stroke()
    }),
    'chevron-right': canvasImage(28, 28, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 6
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(9, 5); g.lineTo(20, 14); g.lineTo(9, 23); g.stroke()
    }),
    // 俯視汽車模型（車頭朝上，4.6m 長比例）
    'model-car': canvasImage(40, 72, (g) => {
      const rr = (x: number, y: number, w: number, h: number, r: number) => {
        g.beginPath()
        g.moveTo(x + r, y)
        g.arcTo(x + w, y, x + w, y + h, r)
        g.arcTo(x + w, y + h, x, y + h, r)
        g.arcTo(x, y + h, x, y, r)
        g.arcTo(x, y, x + w, y, r)
        g.closePath()
      }
      g.shadowColor = 'rgba(0,0,0,0.35)'
      g.shadowBlur = 4
      g.fillStyle = '#2f66e5'
      rr(6, 3, 28, 66, 10); g.fill()
      g.shadowBlur = 0
      g.fillStyle = 'rgba(15,30,80,0.55)' // 前擋風
      rr(10, 16, 20, 10, 4); g.fill()
      g.fillStyle = '#5b8bf5' // 車頂
      rr(10, 28, 20, 24, 4); g.fill()
      g.fillStyle = 'rgba(15,30,80,0.45)' // 後擋風
      rr(10, 54, 20, 8, 4); g.fill()
    }),
    // 俯視機車模型（2.2m 長比例）
    'model-moto': canvasImage(20, 48, (g) => {
      g.shadowColor = 'rgba(0,0,0,0.35)'
      g.shadowBlur = 3
      g.strokeStyle = '#263143'
      g.lineWidth = 6
      g.lineCap = 'round'
      g.beginPath(); g.moveTo(10, 6); g.lineTo(10, 42); g.stroke() // 車身
      g.shadowBlur = 0
      g.strokeStyle = '#111'
      g.lineWidth = 4
      g.beginPath(); g.moveTo(10, 4); g.lineTo(10, 10); g.stroke() // 前輪
      g.beginPath(); g.moveTo(10, 38); g.lineTo(10, 44); g.stroke() // 後輪
      g.fillStyle = '#22c55e' // 騎士安全帽
      g.beginPath(); g.arc(10, 26, 6, 0, Math.PI * 2); g.fill()
      g.strokeStyle = '#fff'
      g.lineWidth = 1.5
      g.beginPath(); g.arc(10, 26, 6, 0, Math.PI * 2); g.stroke()
    }),
    // 偏心左轉道地面箭頭（畫成朝上 = 行進方向，圖層用 icon-rotate 對齊路向）
    'bay-arrow-left': roadArrowImage(48, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(30, 92); g.lineTo(30, 40); g.quadraticCurveTo(30, 26, 18, 26)
      g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath()
      g.moveTo(20, 12); g.lineTo(2, 26); g.lineTo(20, 40)
      g.closePath(); g.fill()
    }),
    'bay-arrow-uturn': roadArrowImage(48, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(34, 92); g.lineTo(34, 40)
      g.quadraticCurveTo(34, 18, 22, 18)
      g.quadraticCurveTo(10, 18, 10, 36); g.lineTo(10, 44)
      g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath()
      g.moveTo(1, 44); g.lineTo(19, 44); g.lineTo(10, 64)
      g.closePath(); g.fill()
    }),
    // 路口地面車道箭頭（朝上 = 行進方向，icon-rotate 對齊路向）
    'lane-arrow-through': roadArrowImage(48, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.beginPath(); g.moveTo(24, 92); g.lineTo(24, 30); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(24, 4); g.lineTo(10, 34); g.lineTo(38, 34)
      g.closePath(); g.fill()
    }),
    'lane-arrow-right': roadArrowImage(48, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(18, 92); g.lineTo(18, 40); g.quadraticCurveTo(18, 26, 30, 26)
      g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath()
      g.moveTo(28, 12); g.lineTo(46, 26); g.lineTo(28, 40)
      g.closePath(); g.fill()
    }),
    // 合體式直行＋右轉：直行主幹保持完整，右轉支線由主幹分岔後水平指向右側。
    // 造型參照台灣路面箭頭，刻意拉開兩個箭頭頭部，縮小後仍可辨識兩種動作。
    'lane-arrow-through-right': roadArrowImage(68, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      // 完整直行箭頭
      g.beginPath(); g.moveTo(30, 92); g.lineTo(30, 30); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(30, 3); g.lineTo(15, 34); g.lineTo(45, 34)
      g.closePath(); g.fill()
      // 從主幹分出的右轉箭頭：先彎、再保留一小段水平箭桿
      g.beginPath(); g.moveTo(30, 70); g.quadraticCurveTo(30, 50, 52, 50); g.lineTo(57, 50); g.stroke()
      g.beginPath(); g.moveTo(67, 50); g.lineTo(49, 35); g.lineTo(49, 65)
      g.closePath(); g.fill()
    }),
    // 並排式直行+右轉（兩支完整箭頭各自獨立，非合體分岔）
    'lane-arrow-through-right-dual': roadArrowImage(72, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 7
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      // 左：完整直行箭頭
      g.beginPath(); g.moveTo(18, 92); g.lineTo(18, 30); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(18, 6); g.lineTo(6, 34); g.lineTo(30, 34)
      g.closePath(); g.fill()
      // 右：完整右轉箭頭（同 lane-arrow-right 造型，平移到右半）
      g.beginPath()
      g.moveTo(46, 92); g.lineTo(46, 44); g.quadraticCurveTo(46, 30, 56, 30)
      g.stroke()
      g.beginPath()
      g.moveTo(54, 18); g.lineTo(70, 30); g.lineTo(54, 42)
      g.closePath(); g.fill()
    }),
    // 合體式左轉＋直行：與上式鏡像，兩個箭頭頭部清楚分離。
    'lane-arrow-left-through': roadArrowImage(68, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(38, 92); g.lineTo(38, 30); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(38, 3); g.lineTo(23, 34); g.lineTo(53, 34)
      g.closePath(); g.fill()
      g.beginPath(); g.moveTo(38, 70); g.quadraticCurveTo(38, 50, 16, 50); g.lineTo(11, 50); g.stroke()
      g.beginPath(); g.moveTo(1, 50); g.lineTo(19, 35); g.lineTo(19, 65)
      g.closePath(); g.fill()
    }),
    // 合體式左轉＋右轉：共用單一主幹，在同一高度平順分岔，
    // 左右箭頭頭部與前右／左前樣式採相同比例，縮小後仍清楚可辨。
    'lane-arrow-left-right': roadArrowImage(72, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.lineCap = 'butt'
      g.lineJoin = 'round'
      // 共用主幹
      g.beginPath(); g.moveTo(36, 92); g.lineTo(36, 67); g.stroke()
      // 左右兩側由同一分岔點對稱彎出，並各保留短水平箭桿
      g.beginPath()
      g.moveTo(36, 69); g.quadraticCurveTo(36, 49, 16, 49); g.lineTo(12, 49)
      g.stroke()
      g.beginPath()
      g.moveTo(36, 69); g.quadraticCurveTo(36, 49, 56, 49); g.lineTo(60, 49)
      g.stroke()
      g.fillStyle = '#ffffff'
      // 左箭頭
      g.beginPath(); g.moveTo(0, 49); g.lineTo(20, 34); g.lineTo(20, 64)
      g.closePath(); g.fill()
      // 右箭頭
      g.beginPath(); g.moveTo(72, 49); g.lineTo(52, 34); g.lineTo(52, 64)
      g.closePath(); g.fill()
    }),
    // 地面規則印字（roadtext.ts GROUND_RULES 決定點位與順序）
    ...Object.fromEntries(GROUND_RULES.map((r) => [
      `rule-${r.code}`,
      roadTextImage(r.label, r.code === 'no_moto' ? '#facc15' : '#ffffff'),
    ])),
    // 「待轉區」文字用 canvas 畫，不依賴字型伺服器
    'zone-text': canvasImage(160, 48, (g) => {
      g.font = 'bold 30px "Microsoft JhengHei", sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.lineWidth = 5
      g.strokeStyle = 'rgba(30,41,59,0.9)'
      g.strokeText('待轉區', 80, 25)
      g.fillStyle = '#ffffff'
      g.fillText('待轉區', 80, 25)
    }),
  }
}
