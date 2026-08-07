// 高架橋面俯視出圖（node scripts/run_offline.mjs scripts/deck_svg.ts --at=lat,lng --out=x.svg）
//
// area_svg 畫的是地面圖層；橋面是 elevated3d 建的 3D mesh，地面出圖看不到它。
// Browser pane 沒顯示時 MapLibre 不 composite，橋面在瀏覽器裡也是零回饋——
// 這支把 setModel 產生的 mesh 三角形投影回經緯度俯視畫出來，用來確認
// 「匝道匯流處橋面到底長什麼樣」這種只有看圖才說得準的事。
//
//   --at=lat,lng   出圖中心（必要，或用 --key=way/W@b/N）
//   --radius=      半徑公尺（預設 150）
//   --scale=       每公尺幾 px（預設 4）
//   --ground=off   不畫地面路面（只看橋面）
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import maplibregl from 'maplibre-gl'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, buildRoadSurfaces, roadsForRendering, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildElevation } from '../src/core/elevation'
import { ElevatedLayer } from '../src/core/elevated3d'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { COS_LAT, haversine, NANZI_CENTER } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const OUT = arg('out', '')
const AT = arg('at', '')
const KEY = arg('key', '')
const RADIUS = Number(arg('radius', '150'))
const SCALE = Number(arg('scale', '4'))
const GROUND = arg('ground', 'on') !== 'off'
if (!OUT || (!AT && !KEY)) {
  console.error('請給 --out=<檔案.svg> 與 --at=lat,lng 或 --key=way/W@b/N')
  process.exit(2)
}

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const journal: EnhancementRecord[] = db.editor?.journal ?? []
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((r) => !r.properties.deleted)
const view = buildRoadMergeViews(active, journal)
const model = buildElevation(view.renderRoads)
const layer = new ElevatedLayer()
layer.setModel(model)

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
let center: [number, number]
if (AT) {
  const [lat, lng] = AT.split(',').map(Number)
  center = [lng, lat]
} else {
  const road = view.renderRoads.find((r) => blockKey(r) === KEY)
  if (!road) { console.error(`找不到區塊 ${KEY}`); process.exit(1) }
  const cs = road.geometry.coordinates as [number, number][]
  center = cs[Math.floor(cs.length / 2)]
}

// 場景座標（東,上,-北 公尺，錨在 NANZI_CENTER 的 Mercator）→ 經緯度
const originMerc = maplibregl.MercatorCoordinate.fromLngLat(
  { lng: NANZI_CENTER[0], lat: NANZI_CENTER[1] }, 0)
const mercScale = originMerc.meterInMercatorCoordinateUnits()
const toLngLat = (x: number, z: number): [number, number] => {
  const mc = new maplibregl.MercatorCoordinate(
    originMerc.x + x * mercScale, originMerc.y + z * mercScale, 0)
  const ll = mc.toLngLat()
  return [ll.lng, ll.lat]
}

const KX = 111320 * COS_LAT
const KY = 110540
const xy = ([lng, lat]: number[]): [number, number] =>
  [(lng - center[0]) * KX * SCALE, -(lat - center[1]) * KY * SCALE]
const R = RADIUS * SCALE
const inside = (pt: number[]) => haversine(pt as [number, number], center) < RADIUS * 1.6
const path = (ring: number[][]) =>
  ring.map((p, i) => `${i ? 'L' : 'M'}${xy(p).map((v) => v.toFixed(1)).join(' ')}`).join('')

const parts: string[] = []

// 1. 地面路面（對照用底圖）
if (GROUND) {
  const surfaces = buildRoadSurfaces(roadsForRendering(view.renderRoads))
  for (const f of surfaces.features) {
    if (f.properties.surfaceKind !== 'surface') continue
    const g = f.geometry
    const rings = g.type === 'MultiPolygon'
      ? (g.coordinates as number[][][][]).flat() : g.coordinates as number[][][]
    if (!rings[0]?.some(inside)) continue
    parts.push(`<path d="${rings.map((r) => path(r) + 'Z').join('')}" fill="#39445e"`
      + ' stroke="none" fill-rule="evenodd"/>')
  }
}

// 2. 橋面三角形（group.children 依 setModel 的 add 順序：deck/side/rail/pier/white/yellow）
const COLORS = ['rgba(125,152,196,.55)', 'rgba(57,68,94,.35)', 'rgba(182,191,204,.9)',
  'rgba(139,149,168,.5)', 'rgba(233,237,242,.95)', 'rgba(245,197,66,.95)']
const group = (layer as unknown as { group: THREE.Group }).group
let tris = 0
group.children.forEach((child, ci) => {
  const geo = (child as THREE.Mesh).geometry as THREE.BufferGeometry
  const pos = geo?.getAttribute('position')
  if (!pos) return
  const fill = COLORS[ci] ?? 'rgba(255,0,255,.5)'
  const d: string[] = []
  for (let i = 0; i < pos.count; i += 3) {
    const ring: number[][] = []
    let near = false
    for (let k = 0; k < 3; k++) {
      const ll = toLngLat(pos.getX(i + k), pos.getZ(i + k))
      ring.push(ll)
      if (inside(ll)) near = true
    }
    if (!near) continue
    d.push(path(ring) + 'Z')
    tris++
  }
  if (d.length) parts.push(`<path d="${d.join('')}" fill="${fill}" stroke="none"/>`)
})

// 3. 高架區塊中心線與端點（診斷標註）
for (const { road } of model.entries()) {
  const cs = road.geometry.coordinates as [number, number][]
  if (!cs.some(inside)) continue
  parts.push(`<path d="${path(cs)}" fill="none" stroke="#f472b6" stroke-width="1"`
    + ' stroke-dasharray="6 4"/>')
  for (const [i, node] of [[0, road.properties.nodes[0]],
    [cs.length - 1, road.properties.nodes[road.properties.nodes.length - 1]]] as const) {
    if (!inside(cs[i])) continue
    const [x, y] = xy(cs[i])
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#f472b6"/>`
      + `<text x="${(x + 5).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="9"`
      + ` fill="#fbcfe8">${blockKey(road)}${i ? '末' : '起'} n${node}</text>`)
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-R} ${-R} ${2 * R} ${2 * R}"`
  + ` width="${2 * R}" height="${2 * R}">`
  + `<rect x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" fill="#111827"/>`
  + parts.join('\n') + '</svg>'
writeFileSync(OUT, svg)
console.log(`寫出 ${OUT}（中心 ${center[1].toFixed(6)},${center[0].toFixed(6)}`
  + `　半徑 ${RADIUS}m　橋面三角形 ${tris} 個）`)
