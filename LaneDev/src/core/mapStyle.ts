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
  laneLine: 'rgba(255,255,255,0.85)',
  centerLine: '#f5c542',
  routeCasing: '#1d4ed8',
  route: '#3b82f6',
  label: '#3d4a5c',
  labelHalo: '#ffffff',
}

/** 路面總寬（公尺）：由 roads.ts computeDerived 算好放在 width_m */
const wExpr: ExpressionSpecification = ['coalesce', ['to-number', ['get', 'width_m']], 6.4]
const surfaceWidthM: ExpressionSpecification = ['+', wExpr, 0.8]
const casingWidthM: ExpressionSpecification = ['+', wExpr, 2.4]

/** icon 尺寸表達式：讓圖片呈現為實際 meters 高（imgPx = 圖片像素高） */
function iconMeters(meters: number, imgPx: number): ExpressionSpecification {
  const s = (z: number) => (meters * pxPerMeter(z)) / imgPx
  return ['interpolate', ['exponential', 2], ['zoom'], 10, s(10), 24, s(24)]
}

const LANE_ZOOM = 15 // 之下畫簡化路網、之上畫車道級

const emptyFC = { type: 'FeatureCollection', features: [] } as const

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      roads: { type: 'geojson', data: emptyFC as never },
      dividers: { type: 'geojson', data: emptyFC as never },
      turnbays: { type: 'geojson', data: emptyFC as never },
      roadtext: { type: 'geojson', data: emptyFC as never },
      medians: { type: 'geojson', data: emptyFC as never },
      buildings: { type: 'geojson', data: emptyFC as never },
      route: { type: 'geojson', data: emptyFC as never },
      endpoints: { type: 'geojson', data: emptyFC as never },
      zones: { type: 'geojson', data: emptyFC as never },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

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
      {
        id: 'road-casing', type: 'line', source: 'roads', minzoom: LANE_ZOOM,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.casing, 'line-width': widthMeters(casingWidthM) },
      },
      // ── 偏心左轉道（Enhancement Layer）──
      // casing 墊在 road-surface 之前：bay 與路面的接縫由 surface 蓋掉，只露出外緣描邊
      {
        id: 'bay-casing', type: 'fill', source: 'turnbays', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'kind'], 'casing'],
        paint: { 'fill-color': C.casing },
      },
      {
        id: 'road-surface', type: 'line', source: 'roads', minzoom: LANE_ZOOM,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.surface, 'line-width': widthMeters(surfaceWidthM) },
      },
      {
        id: 'bay-fill', type: 'fill', source: 'turnbays', minzoom: LANE_ZOOM,
        filter: ['==', ['get', 'kind'], 'fill'],
        paint: { 'fill-color': C.surface },
      },
      {
        // bay 邊線與中央槽化線（台灣標線色）：分隔對向 = 黃、分隔同向 = 白
        id: 'bay-edge', type: 'line', source: 'turnbays', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'color'], 'yellow', C.centerLine, C.laneLine],
          'line-width': widthMeters(['match', ['get', 'color'], 'yellow', 0.25, 0.15] as ExpressionSpecification),
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
        id: 'lane-divider', type: 'line', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'lane'],
        paint: {
          'line-color': C.laneLine,
          'line-width': widthMeters(0.15),
          'line-dasharray': [27, 40], // ≈ 台灣 4m 線段 / 6m 間隔（單位=線寬倍數）
        },
      },
      {
        id: 'center-divider', type: 'line', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'center'],
        paint: { 'line-color': C.centerLine, 'line-width': widthMeters(0.3) },
      },
      {
        // 機車道分隔：白實線
        id: 'moto-divider', type: 'line', source: 'dividers', minzoom: 15.5,
        filter: ['==', ['get', 'kind'], 'moto'],
        paint: { 'line-color': C.laneLine, 'line-width': widthMeters(0.15) },
      },

      {
        // 路面印字（禁行機車等）：roadtext.ts 生成點位，朝向 = 行進方向。
        // 尺寸與 makeIcons 的 roadTextImage 約定：4 字 × 80px/字 ↔ 10m 長
        id: 'road-text', type: 'symbol', source: 'roadtext', minzoom: 16,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': iconMeters(10, 320),
          'icon-rotate': ['get', 'brg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
        paint: { 'icon-opacity': 0.9 },
      },

      // ── 單行道方向箭頭 ──
      {
        id: 'oneway-arrow', type: 'symbol', source: 'roads', minzoom: 16,
        filter: ['==', ['get', 'oneway'], 'yes'],
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
          'fill-extrusion-color': C.building,
          'fill-extrusion-height': ['get', 'height'],
          // 不透明：半透明 extrusion 要排序（慢），且與路面穿插處特別明顯
          'fill-extrusion-opacity': 1,
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
        paint: {
          'fill-color': [
            'case', ['boolean', ['get', 'selected'], false],
            'rgba(59,130,246,0.35)', 'rgba(255,255,255,0.28)',
          ],
        },
      },
      {
        // 深色描邊墊底，讓白框在路面外的淺色地面上也看得見
        id: 'zone-outline-casing', type: 'line', source: 'zones',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': 'rgba(30,41,59,0.85)', 'line-width': widthMeters(0.34) },
      },
      {
        id: 'zone-outline', type: 'line', source: 'zones',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': [
            'case', ['boolean', ['get', 'selected'], false], '#3b82f6', '#ffffff',
          ],
          'line-width': widthMeters(0.18),
        },
      },
      {
        id: 'zone-label', type: 'symbol', source: 'zones', minzoom: 15.5,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'icon-image': 'zone-text',
          'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 16, 0.18, 20, 1.4],
          // 文字永遠正立（框體本身已表達朝向）
          'icon-rotation-alignment': 'viewport',
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
        filter: ['has', 'name'],
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

/** 路面標線字（直書）：第一字在圖頂端，地圖閱讀由上往下（keep-upright 由
 * roadtext.ts 的 iconBrg 保證不倒立）。字體瘦長（scale 1.5 倍高）仿標線比例。
 * 注意：這是「地圖可讀性優先」，與實際路面「第一字靠近駕駛」的漆法相反。 */
function roadTextImage(text: string) {
  const chars = [...text]
  const W = 56, CELL = 80
  return canvasImage(W, CELL * chars.length, (g) => {
    g.font = 'bold 44px "Microsoft JhengHei", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#ffffff'
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
    'bay-arrow-left': canvasImage(48, 96, (g) => {
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
    'bay-arrow-uturn': canvasImage(48, 96, (g) => {
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
    'lane-arrow-through': canvasImage(48, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 8
      g.beginPath(); g.moveTo(24, 92); g.lineTo(24, 30); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(24, 4); g.lineTo(10, 34); g.lineTo(38, 34)
      g.closePath(); g.fill()
    }),
    'lane-arrow-right': canvasImage(48, 96, (g) => {
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
    'lane-arrow-through-right': canvasImage(56, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 7
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(20, 92); g.lineTo(20, 26); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(20, 2); g.lineTo(8, 28); g.lineTo(32, 28)
      g.closePath(); g.fill()
      g.beginPath(); g.moveTo(20, 66); g.quadraticCurveTo(38, 62, 40, 50); g.stroke()
      g.beginPath(); g.moveTo(32, 36); g.lineTo(52, 44); g.lineTo(38, 60)
      g.closePath(); g.fill()
    }),
    'lane-arrow-left-through': canvasImage(56, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 7
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(36, 92); g.lineTo(36, 26); g.stroke()
      g.fillStyle = '#ffffff'
      g.beginPath(); g.moveTo(36, 2); g.lineTo(24, 28); g.lineTo(48, 28)
      g.closePath(); g.fill()
      g.beginPath(); g.moveTo(36, 66); g.quadraticCurveTo(18, 62, 16, 50); g.stroke()
      g.beginPath(); g.moveTo(24, 36); g.lineTo(4, 44); g.lineTo(18, 60)
      g.closePath(); g.fill()
    }),
    'lane-arrow-left-right': canvasImage(64, 96, (g) => {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 7
      g.lineJoin = 'round'
      g.beginPath(); g.moveTo(32, 92); g.lineTo(32, 50); g.stroke()
      g.fillStyle = '#ffffff'
      // 右彎
      g.beginPath(); g.moveTo(32, 66); g.quadraticCurveTo(50, 62, 52, 50); g.stroke()
      g.beginPath(); g.moveTo(44, 36); g.lineTo(64, 44); g.lineTo(50, 60)
      g.closePath(); g.fill()
      // 左彎（鏡像）
      g.beginPath(); g.moveTo(32, 66); g.quadraticCurveTo(14, 62, 12, 50); g.stroke()
      g.beginPath(); g.moveTo(20, 36); g.lineTo(0, 44); g.lineTo(14, 60)
      g.closePath(); g.fill()
    }),
    // 地面規則印字（roadtext.ts GROUND_RULES 決定點位與順序）
    ...Object.fromEntries(GROUND_RULES.map((r) => [`rule-${r.code}`, roadTextImage(r.label)])),
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
