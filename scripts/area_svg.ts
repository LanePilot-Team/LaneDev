// 區域出圖（node scripts/run_offline.mjs scripts/area_svg.ts --at=lat,lng --out=x.svg）
//
// Browser pane 沒顯示時 MapLibre 不 composite，改樣式在瀏覽器裡零回饋（見 bay_svg.ts）。
// bay_svg 只畫偏心道與槽化線；這支跑的是 mapCore.refreshBays 的完整組合——路面、
// 車道分隔線、停止線、箭頭、機車停等格、分隔島、路面印字——用來確認
// 「這段路的樣式是不是真的不見了」這種只有看圖才說得準的事。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import {
  roadsFromGeoJSON, buildRoadSurfaces, buildDividers, roadsForRendering,
  type RoadFeature,
} from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'
import {
  buildTurnBays, buildRightLanes, buildChannelization, buildStopLines,
  buildLaneArrows, buildMotoBoxes, buildSpecifiedWhiteMotoHatch,
  buildLeftTurnWaitingAreas, buildMotoLaneEntryIcons, buildUnusedLaneGores, baysToGeoJSON,
} from '../src/core/turnbays'
import {
  buildMedians, buildTwinIslands, buildMotoSepIslands, buildCenterIslands, mediansToGeoJSON,
} from '../src/core/medians'
import { buildRoadTexts, roadTextObstacles } from '../src/core/roadtext'
import { COS_LAT, haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const OUT = arg('out', '')
const KEY = arg('key', '')
const AT = arg('at', '')
const RADIUS = Number(arg('radius', '120'))
const SCALE = Number(arg('scale', '4')) // 每公尺幾個 px
const DROP_MERGE = arg('drop', '')
if (!OUT || (!KEY && !AT)) {
  console.error('請給 --out=<檔案.svg> 與 --key=way/W@b/N 或 --at=lat,lng')
  process.exit(2)
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
let journal: EnhancementRecord[] = db.editor?.journal ?? []
if (DROP_MERGE) journal = journal.filter((r) => r.target.key !== DROP_MERGE)

const { roads: baseRoads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const folded = foldJournal(journal)
// 與 mapCore 同一步：使用者自訂新增的道路要物化進來，否則出圖看不到它們
const roads = [...baseRoads, ...newRoadsFromFolded(folded, nodeRemap)]
applyToRoads(roads, folded)
const active = roads.filter((r) => !r.properties.deleted)
const view = buildRoadMergeViews(active, journal)
const renderGraph = new RoadGraph(view.renderRoads)
const bays = buildTurnBays(renderGraph, journal)
const rightLanes = buildRightLanes(renderGraph, journal)
const channel = [
  ...buildChannelization(renderGraph, bays),
  ...buildSpecifiedWhiteMotoHatch(renderGraph),
]
const stopLines = buildStopLines(renderGraph, bays, rightLanes, journal)
const leftWait = buildLeftTurnWaitingAreas(renderGraph, bays)
const motoBoxes = buildMotoBoxes(renderGraph, bays, rightLanes, journal)
const arrows = buildLaneArrows(
  renderGraph, bays, rightLanes, motoBoxes.dirs, journal, stopLines)
const motoEntryIcons = buildMotoLaneEntryIcons(renderGraph, journal)
const bayFeatures = baysToGeoJSON(
  bays, [...channel, ...stopLines, ...leftWait], arrows, rightLanes, motoBoxes.boxes)
bayFeatures.features.push(
  ...motoEntryIcons.features, ...buildUnusedLaneGores(renderGraph, bays).features)
const rendered = roadsForRendering(view.renderRoads)
const surfaces = buildRoadSurfaces(rendered)
const dividers = buildDividers(rendered)
const islands = mediansToGeoJSON([
  ...buildMedians(rendered), ...buildTwinIslands(rendered, journal),
  ...buildMotoSepIslands(renderGraph), ...buildCenterIslands(renderGraph, bays),
])
const obstacles = roadTextObstacles({
  arrows, motoEntryIcons: motoEntryIcons.features, stopLines, motoBoxes: motoBoxes.boxes })
const texts = buildRoadTexts(renderGraph, bays, rightLanes, obstacles)

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
let center: [number, number]
if (AT) {
  const [lat, lng] = AT.split(',').map(Number)
  center = [lng, lat]
} else {
  const road = view.renderRoads.find((r) => blockKey(r) === KEY)
    ?? view.routingRoads.find((r) => blockKey(r) === KEY)
  if (!road) { console.error(`找不到區塊 ${KEY}`); process.exit(1) }
  const cs = road.geometry.coordinates as [number, number][]
  center = cs[Math.floor(cs.length / 2)]
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
const poly = (coords: number[][][], fill: string, stroke = 'none', width = 0) => {
  if (!coords[0]?.some(inside)) return
  parts.push(`<path d="${coords.map((r) => path(r) + 'Z').join('')}" fill="${fill}"`
    + ` stroke="${stroke}" stroke-width="${width}" fill-rule="evenodd"/>`)
}
const line = (cs: number[][], stroke: string, width: number, dash = '') => {
  if (!cs.some(inside)) return
  parts.push(`<path d="${path(cs)}" fill="none" stroke="${stroke}"`
    + ` stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}`
    + ' stroke-linecap="round"/>')
}
const dot = (pt: number[], color: string, label = '', size = 3) => {
  if (!inside(pt)) return
  const [x, y] = xy(pt)
  parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" fill="${color}"/>`)
  if (label) {
    parts.push(`<text x="${(x + 5).toFixed(1)}" y="${(y + 3).toFixed(1)}"`
      + ` font-size="9" fill="${color}">${label.replace(/[<&]/g, '')}</text>`)
  }
}

const geom = (f: { geometry: { type: string; coordinates: unknown } }) =>
  f.geometry as { type: string; coordinates: number[][][] | number[][] | number[] }

// 1. 路面（casing 深、surface 淺）
for (const kind of ['casing', 'surface'] as const) {
  for (const f of surfaces.features) {
    if (f.properties.kind !== kind) continue
    const g = geom(f)
    const rings = g.type === 'MultiPolygon'
      ? (g.coordinates as unknown as number[][][][]).flat() : g.coordinates as number[][][]
    poly(rings, kind === 'casing' ? '#3f4550' : '#6b7280')
  }
}
// 2. 分隔島
for (const f of islands.features) poly(geom(f).coordinates as number[][][], '#4d7c4d')
// 3. 車道分隔線
for (const f of dividers.features) {
  const kind = String((f.properties as { kind?: string })?.kind ?? '')
  const yellow = kind.startsWith('center')
  line(geom(f).coordinates as number[][], yellow ? '#facc15' : '#e5e7eb',
    yellow ? 2 : 1.6, kind === 'lane' ? '10 8' : '')
}
// 4. 停止線／槽化／機車格／箭頭
for (const f of bayFeatures.features) {
  const p = (f.properties ?? {}) as { kind?: string; color?: string; icon?: string }
  const g = geom(f)
  if (g.type === 'Polygon') {
    poly(g.coordinates as number[][][],
      p.kind === 'motobox' ? 'none' : 'rgba(250,204,21,.25)',
      p.kind === 'motobox' ? '#ffffff' : '#facc15', 1.5)
  } else if (g.type === 'LineString') {
    const c = p.color === 'stop' ? '#ffffff' : p.color === 'yellow' ? '#facc15' : '#e5e7eb'
    line(g.coordinates as number[][], c, p.color === 'stop' ? 5 : 1.8)
  } else if (g.type === 'Point') {
    dot(g.coordinates as number[], '#38bdf8', p.icon ?? '', 2)
  }
}
// 5. 路面印字
for (const f of texts.features) {
  const p = (f.properties ?? {}) as { text?: string }
  dot(geom(f).coordinates as number[], '#facc15', p.text ?? '', 1.5)
}
// 6. 區塊端點標註（診斷用）
for (const r of view.renderRoads) {
  const cs = r.geometry.coordinates as [number, number][]
  if (!cs.some(inside)) continue
  dot(cs[0], '#f472b6', blockKey(r) + (r.properties.roadMarkingMode !== 'all'
    ? ` [mark=${r.properties.roadMarkingMode}]` : ''), 2.5)
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-R} ${-R} ${2 * R} ${2 * R}"`
  + ` width="${2 * R}" height="${2 * R}">`
  + `<rect x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" fill="#111827"/>`
  + parts.join('\n') + '</svg>'
writeFileSync(OUT, svg)
console.log(`寫出 ${OUT}（中心 ${center[1].toFixed(6)},${center[0].toFixed(6)}`
  + `　半徑 ${RADIUS}m　${parts.length} 個圖元）`)
