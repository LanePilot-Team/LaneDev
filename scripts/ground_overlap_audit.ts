// 地面標線互相切割稽核（node scripts/run_offline.mjs scripts/ground_overlap_audit.ts）
//
// 走與 app 相同的繪製管線，檢查「停止線切過地面箭頭」與「路名壓到箭頭」。
// 停止線是橫向實線、箭頭是圖示，兩者相交在實地是不存在的畫法；偏心左轉道
// （bay）把停止線的內界往對向拉，最容易切到自己的左轉箭頭。
//
// 參數：--db=<path> --verbose
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'
import {
  buildTurnBays, buildRightLanes, buildStopLines, buildLaneArrows, buildMotoBoxes,
  type PaintLine, type GroundArrow,
} from '../src/core/turnbays'
import {
  buildRoadLabelLines, buildRoadTexts, roadTextObstacles,
} from '../src/core/roadtext'
import { roadsForRendering } from '../src/core/roads'
import { haversine, COS_LAT } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const VERBOSE = process.argv.includes('--verbose')
const KX = 111320 * COS_LAT, KY = 110540

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor?.journal ?? []
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads.filter((r) => !r.properties.deleted), journal)
const graph = new RoadGraph(view.renderRoads)
const bays = buildTurnBays(graph, journal)
const rightLanes = buildRightLanes(graph, journal)
const stopLines = buildStopLines(graph, bays, rightLanes, journal)
const motoBoxes = buildMotoBoxes(graph, bays, rightLanes, journal)
const arrows = buildLaneArrows(graph, bays, rightLanes, motoBoxes.dirs, journal, stopLines)
// 對照組：不餵停止線（＝舊行為），同一批量測必須抓得到切割
const bareArrows = buildLaneArrows(graph, bays, rightLanes, motoBoxes.dirs, journal)
console.log(`停止線 ${stopLines.length} 條、地面箭頭 ${arrows.length} 個`
  + `（未避讓 ${bareArrows.length} 個）、偏心道 ${bays.length} 組`)

const toM = (p: [number, number]): [number, number] => [p[0] * KX, p[1] * KY]

/** 箭頭圖示佔位（4.5m × 2.2m）四角。 */
function arrowCorners(a: GroundArrow): [number, number][] {
  const rad = a.brg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad)
  const bx = Math.cos(rad), by = -Math.sin(rad)
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([u, v]) => [
    a.pos[0] + (ax * 2.25 * u + bx * 1.1 * v) / KX,
    a.pos[1] + (ay * 2.25 * u + by * 1.1 * v) / KY,
  ] as [number, number])
}

/** 線段是否穿過凸多邊形（含端點落在內部）。 */
function segmentHitsPolygon(a: [number, number], b: [number, number], poly: [number, number][]) {
  const am = toM(a), bm = toM(b)
  const pm = poly.map(toM)
  const inside = (p: [number, number]) => {
    let win = 0
    for (let i = 0, j = pm.length - 1; i < pm.length; j = i++) {
      if ((pm[i][1] > p[1]) !== (pm[j][1] > p[1])
        && p[0] < ((pm[j][0] - pm[i][0]) * (p[1] - pm[i][1])) / (pm[j][1] - pm[i][1] + 1e-12) + pm[i][0]) {
        win = win ? 0 : 1
      }
    }
    return win === 1
  }
  if (inside(am) || inside(bm)) return true
  const cross = (o: number[], p: number[], q: number[]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  for (let i = 0; i < pm.length; i++) {
    const c = pm[i], d = pm[(i + 1) % pm.length]
    const d1 = cross(am, bm, c), d2 = cross(am, bm, d)
    const d3 = cross(c, d, am), d4 = cross(c, d, bm)
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true
  }
  return false
}

interface Cut {
  stop: PaintLine
  arrow: GroundArrow
  sameDir: boolean
  hasBay: boolean
}
const bayDirs = new Set(bays.map((b) => `${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}`))
function findCuts(lines: PaintLine[], list: GroundArrow[]): Cut[] {
  const out: Cut[] = []
  for (const line of lines) {
    if (line.coords.length < 2) continue
    const mid = line.coords[0]
    for (const a of list) {
      if (haversine(a.pos, mid) > 30) continue
      let hit = false
      for (let i = 0; i < line.coords.length - 1 && !hit; i++) {
        hit = segmentHitsPolygon(line.coords[i], line.coords[i + 1], arrowCorners(a))
      }
      if (!hit) continue
      out.push({
        stop: line, arrow: a,
        sameDir: line.ownerKey === a.ownerKey,
        hasBay: bayDirs.has(String(line.ownerKey)),
      })
    }
  }
  return out
}

const cuts = findCuts(stopLines, arrows)
const sameDir = cuts.filter((c) => c.sameDir)
const crossDir = cuts.filter((c) => !c.sameDir)
console.log(`\n停止線切到箭頭：${cuts.length} 處`
  + `（同一進口 ${sameDir.length}、其他進口 ${crossDir.length}）`)
const withBay = sameDir.filter((c) => c.hasBay)
console.log(`  同一進口中有偏心左轉道的：${withBay.length}`)
const byDir = new Map<string, number>()
for (const c of sameDir) byDir.set(String(c.stop.ownerKey), (byDir.get(String(c.stop.ownerKey)) ?? 0) + 1)
for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, VERBOSE ? 200 : 15)) {
  const c = sameDir.find((x) => x.stop.ownerKey === dir)!
  console.log(`   ${dir} × ${n}${c.hasBay ? '（有偏心道）' : ''}`
    + ` @ ${c.arrow.pos.map((v) => v.toFixed(6)).join(',')}`)
}

// 跨進口：多半是「停止線越過中央線、伸進對向車道」——偏心左轉道把內界拉到對向
const crossByDir = new Map<string, { n: number; hasBay: boolean; sample: Cut }>()
for (const c of crossDir) {
  const k = `${c.stop.ownerKey} ✂ ${c.arrow.ownerKey}`
  const e = crossByDir.get(k) ?? { n: 0, hasBay: c.hasBay, sample: c }
  e.n++
  crossByDir.set(k, e)
}
console.log(`
跨進口切割明細（${crossByDir.size} 組）：`)
for (const [k, v] of [...crossByDir].sort((a, b) => b[1].n - a[1].n).slice(0, VERBOSE ? 200 : 20)) {
  console.log(`   ${k} × ${v.n}${v.hasBay ? '（停止線那側有偏心道）' : ''}`
    + ` @ ${v.sample.arrow.pos.map((x) => x.toFixed(6)).join(',')}`)
}
const crossWithBay = crossDir.filter((c) => c.hasBay).length
console.log(`   其中停止線那一側有偏心左轉道：${crossWithBay}/${crossDir.length}`)

// ── 路名 ──
const renderRoads = roadsForRendering(view.renderRoads)
const motoEntryIcons = { features: [] as never[] }
const markingObstacles = roadTextObstacles({
  arrows, stopLines, motoBoxes: motoBoxes.boxes,
})
const roadTexts = buildRoadTexts(graph, bays, rightLanes, markingObstacles).features
const labelObstacles = [
  ...markingObstacles,
  ...roadTexts.map((f) => ({
    points: [(f.geometry as unknown as { coordinates: [number, number] }).coordinates],
    alongHalfM: 5, crossHalfM: 1,
  })),
]
const labelLines = buildRoadLabelLines(renderRoads, labelObstacles).features
const bareLabelLines = buildRoadLabelLines(renderRoads).features
const namedRoads = renderRoads.filter((r) => r.properties.name?.trim()).length
console.log(`
路名可用中心線區段：${labelLines.length} 段`
  + `（未避讓 ${bareLabelLines.length} 段／有名稱的區塊 ${namedRoads} 個）`)

/** 路名線是否貼近箭頭（沿線取樣點與箭頭中心距離）。 */
function labelNearArrows(lines: typeof labelLines, limitM: number) {
  let hits = 0
  for (const f of lines) {
    const pts = (f.geometry as unknown as { coordinates: [number, number][] }).coordinates
    for (const a of arrows) {
      if (pts.some((c) => haversine(c, a.pos) < limitM)) { hits++; break }
    }
  }
  return hits
}
const labelHits = labelNearArrows(labelLines, 4)
const bareLabelHits = labelNearArrows(bareLabelLines, 4)
check('路名可排字的區段都離箭頭 4m 以上', labelHits === 0,
  `${labelHits}/${labelLines.length} 段太近`)
check('對照組確實有太近的（量測有鑑別力）', bareLabelHits > 0,
  `未避讓時 ${bareLabelHits}/${bareLabelLines.length} 段`)
check('大部分有名稱的區塊仍排得下路名',
  labelLines.length >= namedRoads * 0.6,
  `${labelLines.length}/${namedRoads}`)
void motoEntryIcons

check('停止線沒有切到自己這個進口的箭頭', sameDir.length === 0, `${sameDir.length} 處`)
check('停止線沒有切到其他進口的箭頭', crossDir.length === 0, `${crossDir.length} 處`)
const bareCuts = findCuts(stopLines, bareArrows)
check('對照組確實有切割（量測有鑑別力）', bareCuts.length > 0,
  `未避讓時 ${bareCuts.length} 處`)
check('避讓沒有讓箭頭消失', arrows.length === bareArrows.length,
  `${bareArrows.length} → ${arrows.length}`)
// 退讓幅度
let moved = 0, maxMove = 0
for (let i = 0; i < Math.min(arrows.length, bareArrows.length); i++) {
  const d = haversine(arrows[i].pos, bareArrows[i].pos)
  if (d > 0.05) { moved++; maxMove = Math.max(maxMove, d) }
}
console.log(`   位置有調整的箭頭 ${moved} 個，最大位移 ${maxMove.toFixed(1)}m`)

console.log(fails === 0 ? '\n✅ 全數通過' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
