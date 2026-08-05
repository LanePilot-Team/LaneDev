// 路面印字避讓稽核（node scripts/run_offline.mjs scripts/road_text_audit.ts）
//
// 走與 app 完全相同的繪製管線，驗證：
//   1. 沒有任何一筆路面印字與地面箭頭／機車道入口圖示／停止線重疊
//      （對照組：不餵 obstacles 重算一次，必須量得到重疊，否則量測無鑑別力）
//   2. 機車道的印字落在靠近路口箭頭那一端
//   3. 路段夠長時機車道印字前後各一組
//
// 參數：--db=<path> --way=<id>
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
  buildTurnBays, buildRightLanes, buildStopLines, buildLaneArrows,
  buildMotoBoxes, buildMotoLaneEntryIcons,
} from '../src/core/turnbays'
import { buildRoadTexts, roadTextObstacles, roadTextLengthM } from '../src/core/roadtext'
import { haversine, angleDelta, COS_LAT } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
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
const motoEntryIcons = buildMotoLaneEntryIcons(graph, journal)
const obstacles = roadTextObstacles({
  arrows,
  motoEntryIcons: motoEntryIcons.features,
  stopLines,
  motoBoxes: motoBoxes.boxes,
})
console.log(`障礙：箭頭 ${arrows.length}、機車道入口圖示 ${motoEntryIcons.features.length}`
  + `、停止線 ${stopLines.length}、停等格 ${motoBoxes.boxes.length}`)

const texts = buildRoadTexts(graph, bays, rightLanes, obstacles).features
const bare = buildRoadTexts(graph, bays, rightLanes).features
console.log(`路面印字：避讓後 ${texts.length} 筆、未避讓 ${bare.length} 筆\n`)

/** 直排文字在地面上的佔位矩形（沿路軸 len × 橫向 1.6m），以 4 角表示。 */
function textCorners(feature: (typeof texts)[number]): [number, number][] {
  const label = String(feature.properties?.label ?? '')
  const brg = Number(feature.properties?.brg ?? 0)
  const half = roadTextLengthM(label) / 2
  const halfWidth = 0.8
  const c = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates
  const rad = brg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad) // 沿路軸單位向量
  const bx = Math.cos(rad), by = -Math.sin(rad) // 橫向
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([u, v]) => [
    c[0] + (ax * half * u + bx * halfWidth * v) / KX,
    c[1] + (ay * half * u + by * halfWidth * v) / KY,
  ] as [number, number])
}

const toM = (p: [number, number]) => [p[0] * KX, p[1] * KY] as [number, number]

/** 兩個凸多邊形是否相交（分離軸定理）。 */
function overlaps(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = toM(poly[i]), q = toM(poly[(i + 1) % poly.length])
      const nx = -(q[1] - p[1]), ny = q[0] - p[0]
      const proj = (poly2: [number, number][]) => {
        let lo = Infinity, hi = -Infinity
        for (const pt of poly2) {
          const m = toM(pt)
          const v = m[0] * nx + m[1] * ny
          lo = Math.min(lo, v); hi = Math.max(hi, v)
        }
        return [lo, hi] as const
      }
      const [alo, ahi] = proj(a)
      const [blo, bhi] = proj(b)
      if (ahi < blo || bhi < alo) return false
    }
  }
  return true
}

/** 箭頭圖示佔位（4.5m × 2.2m），以中心與方位角展開。 */
const arrowCorners = (arrow: (typeof arrows)[number]): [number, number][] => {
  const rad = arrow.brg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad)
  const bx = Math.cos(rad), by = -Math.sin(rad)
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([u, v]) => [
    arrow.pos[0] + (ax * 2.25 * u + bx * 1.1 * v) / KX,
    arrow.pos[1] + (ay * 2.25 * u + by * 1.1 * v) / KY,
  ] as [number, number])
}

const iconCorners = (feature: (typeof motoEntryIcons.features)[number]): [number, number][] => {
  const brg = Number(feature.properties?.brg ?? 0)
  const h = (Number(feature.properties?.iconHeightM) || 3.2) / 2
  const rad = brg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad)
  const bx = Math.cos(rad), by = -Math.sin(rad)
  const c = feature.geometry.coordinates as [number, number]
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([u, v]) => [
    c[0] + (ax * h * u + bx * 0.6 * v) / KX,
    c[1] + (ay * h * u + by * 0.6 * v) / KY,
  ] as [number, number])
}

interface Blocker {
  corners: [number, number][]; kind: string; center: [number, number]; wayId: string
}
const wayOf = (key?: string) => (key ?? '').match(/(\d+)/)?.[1] ?? ''
const blockers: Blocker[] = [
  ...arrows.map((a) => ({
    corners: arrowCorners(a), kind: '箭頭', center: a.pos, wayId: wayOf(a.ownerKey),
  })),
  ...motoEntryIcons.features.map((f) => ({
    corners: iconCorners(f), kind: '機車道入口圖示',
    center: f.geometry.coordinates as [number, number],
    wayId: wayOf(String(f.properties?.key ?? '')),
  })),
  ...stopLines.filter((l) => l.coords.length >= 2).map((l) => ({
    corners: l.coords as [number, number][], kind: '停止線',
    center: l.coords[Math.floor(l.coords.length / 2)] as [number, number],
    wayId: wayOf(l.ownerKey),
  })),
]

interface Hit {
  label: string; kind: string; pos: [number, number]; sameWay: boolean; blockerWay: string
}
function countOverlaps(list: typeof texts): Hit[] {
  const hits: Hit[] = []
  for (const t of list) {
    const pos = (t.geometry as unknown as { coordinates: [number, number] }).coordinates
    const corners = textCorners(t)
    const textWay = wayOf(String(t.properties?.srcKey ?? ''))
    for (const b of blockers) {
      if (haversine(pos, b.center) > 25) continue
      if (!overlaps(corners, b.corners)) continue
      hits.push({
        label: `${t.properties?.label}[${t.properties?.srcKey}]`,
        kind: b.kind, pos,
        sameWay: !b.wayId || b.wayId === textWay,
        blockerWay: b.wayId,
      })
      break
    }
  }
  return hits
}

const hits = countOverlaps(texts)
const bareHits = countOverlaps(bare)
const sameWayHits = hits.filter((h) => h.sameWay)
const crossWayHits = hits.filter((h) => !h.sameWay)
check('沒有任何路面印字壓到自己這條路的箭頭／圖示／停止線',
  sameWayHits.length === 0, `重疊 ${sameWayHits.length}/${texts.length} 筆`)
check('對照組確實有重疊（量測有鑑別力）',
  bareHits.length > 0, `未避讓時重疊 ${bareHits.length}/${bare.length} 筆`)
for (const h of hits.slice(0, 8)) {
  console.log(`   ${h.sameWay ? '❗' : '⚠'} ${h.label} 壓到${h.kind}`
    + `${h.sameWay ? '' : `（來自 way/${h.blockerWay}，疊圖重複 way）`}`
    + ` @ ${h.pos.map((v) => v.toFixed(6)).join(',')}`)
}
console.log(`   跨 way 重疊（兩條疊在一起的 way 各畫各的，屬既有重複資料問題）：${crossWayHits.length} 筆`)
const bareKinds = new Map<string, number>()
for (const h of bareHits) bareKinds.set(h.kind, (bareKinds.get(h.kind) ?? 0) + 1)
console.log(`   未避讓時的重疊種類：${[...bareKinds].map(([k, v]) => `${k}×${v}`).join('、')}`)

// ── 機車道印字靠近箭頭 ──
const motoTexts = texts.filter((t) => t.properties?.laneType === 'moto')
console.log(`\n機車道印字 ${motoTexts.length} 筆`)
const nearestArrowM = (t: (typeof texts)[number]) => {
  const pos = (t.geometry as unknown as { coordinates: [number, number] }).coordinates
  let best = Infinity
  for (const a of arrows) best = Math.min(best, haversine(pos, a.pos))
  return best
}
const bareMoto = bare.filter((t) => t.properties?.laneType === 'moto')
const posOf = (t: (typeof texts)[number]) =>
  (t.geometry as unknown as { coordinates: [number, number] }).coordinates

// 主組必須在上游組的「下游」（＝靠近路口箭頭那一端）
const upstream = motoTexts.filter((t) => String(t.properties?.roadKey).endsWith(':upstream'))
let pairs = 0, downstreamOk = 0
for (const up of upstream) {
  const main = motoTexts.find((t) =>
    t.properties?.srcKey === up.properties?.srcKey &&
    t.properties?.lane === up.properties?.lane &&
    t.properties?.label === up.properties?.label &&
    !String(t.properties?.roadKey).endsWith(':upstream'))
  if (!main) continue
  pairs++
  const a = posOf(up), b = posOf(main)
  const rad = Number(main.properties?.brg) * Math.PI / 180
  const along = (b[0] - a[0]) * KX * Math.sin(rad) + (b[1] - a[1]) * KY * Math.cos(rad)
  if (along > 0) downstreamOk++
}
check('機車道主印字位於上游組的下游（＝靠近路口箭頭那一端）',
  pairs > 0 && downstreamOk === pairs, `${downstreamOk}/${pairs} 組`)

// 主組緊鄰同向的路口箭頭
const aheadArrowM = (t: (typeof texts)[number]) => {
  const pos = posOf(t)
  const rad = Number(t.properties?.brg) * Math.PI / 180
  let best = Infinity
  for (const a of arrows) {
    const d = haversine(pos, a.pos)
    if (d > 60) continue
    if (Math.abs(angleDelta(Number(t.properties?.brg), a.brg)) > 30) continue
    const along = (a.pos[0] - pos[0]) * KX * Math.sin(rad) + (a.pos[1] - pos[1]) * KY * Math.cos(rad)
    if (along <= 0) continue
    best = Math.min(best, d)
  }
  return best
}
// 前方本來就沒有箭頭的路段（機車專用道等）不列入——那裡沒有可以貼近的對象
const mains = motoTexts
  .filter((t) => !String(t.properties?.roadKey).endsWith(':upstream'))
  .filter((t) => Number.isFinite(aheadArrowM(t)))
const adjacent = mains.filter((t) => aheadArrowM(t) <= 25)
const upstreamAhead = upstream.filter((t) => Number.isFinite(aheadArrowM(t)))
check('機車道主印字緊鄰前方同向箭頭（25m 內）',
  mains.length > 0 && adjacent.length === mains.length,
  `${adjacent.length}/${mains.length} 筆`
  + `；上游組 ${upstreamAhead.filter((t) => aheadArrowM(t) <= 25).length}/${upstreamAhead.length} 筆在 25m 內（本來就該遠離）`)

check('路段夠長的機車道前後各一組', upstream.length > 0,
  `補上游組 ${upstream.length} 筆`)

// 逐 way 抽點
const WAY = arg('way', '')
if (WAY) {
  console.log(`\n── way/${WAY} 的印字 ──`)
  for (const t of texts) {
    const key = String(t.properties?.roadKey)
    const pos = (t.geometry as unknown as { coordinates: [number, number] }).coordinates
    if (!key.includes(WAY)) continue
    console.log(`  ${t.properties?.label} lane=${t.properties?.lane}`
      + ` ${t.properties?.laneType} key=${key}`
      + ` 距最近箭頭 ${nearestArrowM(t).toFixed(1)}m @ ${pos.map((v) => v.toFixed(6)).join(',')}`)
  }
}



// 診斷輸出
console.log('\n── 機車道印字逐筆 ──')
for (const t of motoTexts) {
  const pos = (t.geometry as unknown as { coordinates: [number, number] }).coordinates
  console.log(`  ${t.properties?.label} key=${t.properties?.roadKey}`
    + ` 距箭頭 ${nearestArrowM(t).toFixed(1)}m span=${Number(t.properties?.spanM).toFixed(0)}m`)
}
console.log('\n── 未避讓的機車道印字逐筆 ──')
for (const t of bareMoto) {
  console.log(`  ${t.properties?.label} key=${t.properties?.roadKey}`
    + ` 距箭頭 ${nearestArrowM(t).toFixed(1)}m span=${Number(t.properties?.spanM).toFixed(0)}m`)
}
console.log('\n── 殘餘重疊細節 ──')
for (const h of hits) {
  const near = blockers.filter((b) => haversine(h.pos, b.center) < 12)
  console.log(`  ${h.label} @ ${h.pos} 附近障礙 ${near.map((b) => `${b.kind}(${haversine(h.pos, b.center).toFixed(1)}m)`).join('、')}`)
}

console.log(fails === 0 ? '\n✅ 全數通過' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
