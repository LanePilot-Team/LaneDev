// 偏心道／槽化線的離線出圖（node scripts/run_offline.mjs scripts/bay_svg.ts --key=… --out=x.svg）
//
// Browser pane 沒顯示時 MapLibre 不 composite，改標線幾何在瀏覽器裡零回饋。
// 這支直接把 buildTurnBays / buildChannelization 的線段投影成 SVG，用來確認
// 「兩向偏心道有沒有接成 S 型」這種只有看圖才說得準的事。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, buildRoadSurfaces, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import {
  foldJournal, applyToRoads, applyRoadMerges, journalForMergedRoads,
  type EnhancementRecord,
} from '../src/core/enhancements'
import { RoadGraph } from '../src/core/graph'
import { buildTurnBays, buildChannelization } from '../src/core/turnbays'
import { COS_LAT } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const KEY = arg('key', '')
const OUT = arg('out', '')
const PAD = Number(arg('pad', '25')) // 視窗往外擴幾公尺
if (!KEY || !OUT) { console.error('請給 --key=way/W@b/N 與 --out=<檔案.svg>'); process.exit(2) }

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const journal: EnhancementRecord[] = db.editor.journal
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)
const graph = new RoadGraph(roads)
const merged = journalForMergedRoads(journal)
const bays = buildTurnBays(graph, merged)
const lines = buildChannelization(graph, bays)

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const road = roads.find((r) => key(r) === KEY)
if (!road) { console.error(`找不到區塊 ${KEY}`); process.exit(1) }

// 公尺平面投影（以區塊中心為原點；y 向上為北，SVG 要翻）
const cs = road.geometry.coordinates as [number, number][]
const c0: [number, number] = cs[Math.floor(cs.length / 2)]
const KX = 111320 * COS_LAT
const KY = 110540
const xy = ([lng, lat]: [number, number]): [number, number] =>
  [(lng - c0[0]) * KX, (lat - c0[1]) * KY]

const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
const grow = (pts: [number, number][]) => {
  for (const [x, y] of pts) {
    bbox.minX = Math.min(bbox.minX, x); bbox.maxX = Math.max(bbox.maxX, x)
    bbox.minY = Math.min(bbox.minY, y); bbox.maxY = Math.max(bbox.maxY, y)
  }
}
grow(cs.map(xy))

// 路面（區塊本身與鄰近路段，給個底）
const near = roads.filter((r) => !r.properties.deleted
  && (r.geometry.coordinates as [number, number][]).some((c) => {
    const [x, y] = xy(c)
    return Math.abs(x) < 90 && Math.abs(y) < 90
  }))
const surfaces = buildRoadSurfaces(near)

const parts: string[] = []
const path = (pts: [number, number][], close = false) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(' ')
  + (close ? ' Z' : '')

for (const f of surfaces.features) {
  if (f.properties?.surfaceKind !== 'surface') continue
  const rings = f.geometry.type === 'Polygon'
    ? [f.geometry.coordinates]
    : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []
  for (const poly of rings) {
    for (const ring of poly as [number, number][][]) {
      parts.push(`<path d="${path(ring.map(xy), true)}" fill="#4d5a74" />`)
    }
  }
}

// 槽化／偏心道的黃線（S 型就在這裡）與白線
const inView = (pts: [number, number][]) => pts.some(([x, y]) =>
  x > bbox.minX - PAD && x < bbox.maxX + PAD && y > bbox.minY - PAD && y < bbox.maxY + PAD)
let yellow = 0
let white = 0
for (const l of lines) {
  const pts = l.coords.map(xy)
  if (!inView(pts)) continue
  const isYellow = l.color === 'yellow'
  if (isYellow) yellow++; else white++
  parts.push(`<path d="${path(pts)}" fill="none" stroke="${isYellow ? '#f5c542' : '#ffffff'}"`
    + ` stroke-width="0.35" stroke-linecap="round" />`)
}
// 偏心道自己的白線 + 儲車段起訖標記
const mine = bays.filter((b) => b.wayId === road.properties.osm_id
  && road.properties.nodes.includes(b.nodeId))
for (const b of mine) {
  for (const l of b.lines) {
    const pts = l.coords.map(xy)
    parts.push(`<path d="${path(pts)}" fill="none" stroke="${l.color === 'yellow' ? '#f5c542' : '#fff'}"`
      + ' stroke-width="0.3" />')
  }
  for (const a of b.arrows) {
    const [x, y] = xy(a.pos)
    parts.push(`<circle cx="${x.toFixed(2)}" cy="${(-y).toFixed(2)}" r="0.8" fill="#22d3ee" />`)
  }
}

// 路名標記：受檢區塊沿線每個節點上接的其他路（分辨方位用）
const labelled = new Set<string>()
for (const nodeId of road.properties.nodes) {
  const idx = road.properties.nodes.indexOf(nodeId)
  const at = cs[idx]
  if (!at) continue
  for (const r of roads) {
    if (r === road || r.properties.deleted) continue
    if (!r.properties.nodes.includes(nodeId)) continue
    const name = r.properties.name
    if (!name || labelled.has(name)) continue
    labelled.add(name)
    const [x, y] = xy(at)
    parts.push(`<circle cx="${x.toFixed(2)}" cy="${(-y).toFixed(2)}" r="0.6" fill="#b3261e" />`)
    parts.push(`<text x="${(x + 1.2).toFixed(2)}" y="${(-y).toFixed(2)}" font-size="3"`
      + ` fill="#b3261e" font-family="sans-serif">${name}</text>`)
  }
}
parts.push(`<text x="${(bbox.minX - PAD + 2).toFixed(2)}"`
  + ` y="${(-bbox.maxY - PAD + 6).toFixed(2)}" font-size="4" fill="#3d4a5c"`
  + ` font-family="sans-serif">↑ 北　${KEY}</text>`)

const w = bbox.maxX - bbox.minX + PAD * 2
const h = bbox.maxY - bbox.minY + PAD * 2
const vb = `${(bbox.minX - PAD).toFixed(2)} ${(-bbox.maxY - PAD).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"`
  + ` width="${Math.round(w * 8)}" height="${Math.round(h * 8)}">`
  + `<rect x="${(bbox.minX - PAD).toFixed(2)}" y="${(-bbox.maxY - PAD).toFixed(2)}"`
  + ` width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#e9edf2" />`
  + parts.join('') + '</svg>'
writeFileSync(OUT, svg, 'utf8')
console.log(`${KEY}：偏心道 ${mine.length} 條、黃線 ${yellow} 段、白線 ${white} 段 → ${OUT}`)
for (const b of mine) {
  console.log(`   ${b.key}｜${b.back ? '逆向' : '順向'}｜儲車 ${b.bayLenM.toFixed(1)}m`
    + `｜漸變 ${b.taperLenM.toFixed(1)}m`)
}
