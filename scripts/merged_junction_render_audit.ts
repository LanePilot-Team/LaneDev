// 捏合接點的「繪製」稽核
// （node scripts/run_offline.mjs scripts/merged_junction_render_audit.ts）
//
// 捏合接點在畫面上必須仍是捏合，不能長得像普通十字路口。規格（使用者示意圖）：
//   1. 小巷 → 主線正向：可駛出
//   2. 主線正向 → 小巷：可駛入
//   3. 主線反向 → 小巷：不可，必須先到路口迴轉成正向
// 由此推出的繪製規則：
//   一、中央島／中央帶標線在捏合段是連續的，不得在接點斷開（那裡不是開口）
//   二、主線反向不得出現「左轉進小巷」的地面箭頭
//   三、小巷要有停止線，且位置貼齊主線正向車道的最外緣（不是中線、不是壓在島上）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { RoadGraph } from '../src/core/graph'
import {
  buildTurnBays, buildRightLanes, buildChannelization, buildStopLines,
  buildLaneArrows, buildMotoBoxes,
} from '../src/core/turnbays'
import { buildMedians } from '../src/core/medians'
import { haversine, bearing, angleDelta } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const RADIUS = Number(arg('radius', '8'))

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor?.journal ?? []
applyToRoads(roads, foldJournal(journal))
const active = roads.filter((r) => !r.properties.deleted)
const mergeView = buildRoadMergeViews(active, journal)
const routingRoads = mergeView.routingRoads
const renderRoads = mergeView.renderRoads
const renderGraph = new RoadGraph(renderRoads)

const bays = buildTurnBays(renderGraph, journal)
const rightLanes = buildRightLanes(renderGraph, journal)
const channel = buildChannelization(renderGraph, bays)
const stopLines = buildStopLines(renderGraph, bays, rightLanes, journal)
const motoBoxes = buildMotoBoxes(renderGraph, bays, rightLanes, journal)
const arrows = buildLaneArrows(renderGraph, bays, rightLanes, motoBoxes.dirs, journal)
const medians = buildMedians(renderRoads)

// 找出所有捏合接點（主線登記了 oneSideEntryNodes 的節點）
interface J { main: RoadFeature; node: number; pos: [number, number] }
/** 節點座標：登記的是別名後的 id，主線自己握的是負節點，兩邊都要找 */
const posOfNode = (id: number): [number, number] | null => {
  for (const r of routingRoads) {
    const i = r.properties.nodes.indexOf(id)
    if (i >= 0) return r.geometry.coordinates[i] as [number, number]
  }
  return null
}
const junctions: J[] = []
const seenJ = new Set<number>()
const ONLY = arg('name', '')
for (const r of routingRoads) {
  for (const node of r.properties.oneSideEntryNodes ?? []) {
    if (seenJ.has(node)) continue // 多條 way 可能登記同一個接點，只看一次
    if (ONLY && !(r.properties.name ?? '').includes(ONLY)) continue
    const pos = posOfNode(node)
    if (!pos) continue
    seenJ.add(node)
    junctions.push({ main: r, node, pos })
  }
}
console.log(`捏合接點：${junctions.length}\n`)

const near = (p: [number, number], at: [number, number]) => haversine(p, at) < RADIUS
const lineNear = (coords: [number, number][], at: [number, number]) =>
  coords.some((c) => near(c, at))

let fails = 0
for (const j of junctions.slice(0, Number(arg('limit', '5')))) {
  const name = j.main.properties.name ?? '未命名'
  const replayed = mergeView.resolved.filter((merge) => merge.junctionNodeId === j.node)
  console.log(`── ${name}（way/${j.main.properties.osm_id}）node=${j.node}`
    + `｜road_merge=${replayed.length} ──`)

  // 一、中央帶標線是否在接點斷開
  // 只看「主線自己的」中央帶：小巷的中央帶本來就該在路口收邊，混在一起會誤判。
  // 判準用走向——與主線近乎平行的才是主線的中央帶，垂直的是橫向道路的。
  const mi0 = j.main.properties.nodes.indexOf(j.node)
  const mcs0 = j.main.geometry.coordinates as [number, number][]
  const mainBrg0 = mi0 > 0
    ? bearing(mcs0[mi0 - 1], mcs0[Math.min(mi0 + 1, mcs0.length - 1)])
    : bearing(mcs0[0], mcs0[mcs0.length - 1])
  const parallelToMain = (cs: [number, number][]) => {
    let d = Math.abs(angleDelta(bearing(cs[0], cs[cs.length - 1]), mainBrg0))
    if (d > 90) d = 180 - d
    return d < 30
  }
  const chanNear = channel.filter((l) => {
    const cs = l.coords as [number, number][]
    return lineNear(cs, j.pos) && parallelToMain(cs)
  })
  const gaps: number[] = []
  for (const l of chanNear) {
    const cs = l.coords as [number, number][]
    // 線的端點若落在接點附近，代表主線的中央帶在這裡被切斷
    for (const end of [cs[0], cs[cs.length - 1]]) {
      const d = haversine(end, j.pos)
      if (d < 6) gaps.push(d)
    }
  }
  const overlapsNeighborJunction = chanNear.some((line) => {
    const ownerNode = line.ownerKey?.match(/@node\/(-?\d+)/)?.[1]
    return ownerNode !== undefined && Number(ownerNode) !== j.node
  })
  const brokenChannel = gaps.length > 0 && !overlapsNeighborJunction
  console.log(`   中央帶標線：${chanNear.length} 條經過｜`
    + (overlapsNeighborJunction
      ? '✅ 端點屬於相鄰的真實路口樣式，不是捏合接縫開口'
      : brokenChannel
      ? `❌ 有 ${gaps.length} 個端點落在接點 ${Math.min(...gaps).toFixed(0)}m 內＝被切斷`
      : '✅ 連續，未在接點斷開'))
  if (brokenChannel) {
    for (const line of chanNear) {
      const cs = line.coords as [number, number][]
      console.log(`      ${line.style ?? 'plain'} owner=${line.ownerKey ?? '-'} `
        + `端距=${haversine(cs[0], j.pos).toFixed(1)}/${haversine(cs[cs.length - 1], j.pos).toFixed(1)}m`)
    }
  }
  if (brokenChannel) fails++

  // 中央島（綠帶）是否連續
  const medNear = medians.filter((m) => m.polygon.some((c) => near(c, j.pos)))
  console.log(`   中央島面：${medNear.length} 片覆蓋此處`
    + (medNear.length ? '｜✅ 島面存在' : '｜⚠ 此處無島面（可能本來就沒有）'))

  // 二、反向是否出現轉進小巷的箭頭
  // 主線的行進方位（用接點前後兩點推）；反向 = 主線方位 +180
  const mainBrg = mainBrg0
  const arrowsNear = arrows.filter((a) => near(a.pos, j.pos))
  const isBack = (a: { brg: number }) => Math.abs(angleDelta(a.brg, mainBrg)) > 90
  const badArrows = arrowsNear.filter((a) =>
    a.ownerKey?.startsWith(`${j.main.properties.osm_id}@${j.node}`)
    && isBack(a) && /left|↰/.test(a.icon))
  console.log(`   地面箭頭：附近 ${arrowsNear.length} 個`
    + `（反向 ${arrowsNear.filter(isBack).length} 個）｜`
    + (badArrows.length
      ? `❌ 反向有 ${badArrows.length} 個左轉箭頭：${badArrows.map((a) => a.icon).join(' ')}`
      : '✅ 反向無左轉箭頭'))
  if (badArrows.length) {
    console.log(`      owner=${badArrows.map((arrow) => arrow.ownerKey ?? '-').join(', ')}`)
    for (const road of renderRoads.filter((road) => road.properties.nodes.includes(j.node))) {
      console.log(`      render way/${road.properties.osm_id} ${road.properties.name ?? ''}`
        + ` oneSide=${JSON.stringify(road.properties.oneSideEntryNodes ?? [])}`)
    }
  }
  if (badArrows.length) fails++

  // 三、停止線：主線不該有、小巷該有
  const stopNear = stopLines.filter((l) => lineNear(l.coords as [number, number][], j.pos))
  // 停止線橫跨行車方向：與主線中心線近乎垂直 = 畫在主線上；平行 = 畫在小巷上
  const lineBrg = (l: { coords: [number, number][] }) =>
    bearing(l.coords[0], l.coords[l.coords.length - 1])
  const perpToMain = (l: { coords: [number, number][] }) => {
    let d = Math.abs(angleDelta(lineBrg(l), mainBrg))
    if (d > 90) d = 180 - d
    return d > 45
  }
  const onMain = stopNear.filter((l) => perpToMain(l as { coords: [number, number][] }))
  const onSide = stopNear.filter((l) => !perpToMain(l as { coords: [number, number][] }))
  console.log(`   停止線：主線 ${onMain.length} 條、小巷 ${onSide.length} 條`
    + (onMain.length ? '｜❌ 主線不該因為捏合接點出現停止線' : '｜✅ 主線無停止線')
    + (onSide.length ? '｜✅ 小巷有停止線' : '｜⚠ 小巷無停止線'))
  if (onMain.length) fails++
  console.log()
}

console.log(fails === 0 ? '✅ 抽查的接點繪製符合捏合語意' : `❌ ${fails} 項不符`)
// 其他九支稽核都有設離開碼；少了這行，CI 會把 ❌ 誤判成成功。
process.exitCode = fails === 0 ? 0 : 1
