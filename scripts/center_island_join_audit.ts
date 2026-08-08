// 中央島貫通接點稽核（node scripts/run_offline.mjs scripts/center_island_join_audit.ts）
//
// 驗證 core/centerIslandJoins.ts 的現地指定接點三件事：
//   1. 島面連續 —— 沿主路中心線跨過接點取樣，每一點都落在某個中央島多邊形內
//      （對照組：把貫通標記拿掉重算一次，同一批取樣點必須出現破洞，
//        否則這個量測沒有鑑別力）
//   2. 主路直行不受影響、且在接點不得迴轉
//   3. 側街只能進入相鄰的那一個行向，另一向必須繞行
//
// 參數：--db=<path>
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { CENTER_ISLAND_JOINS } from '../src/core/centerIslandJoins'
import { RoadGraph } from '../src/core/graph'
import { buildTurnBays } from '../src/core/turnbays'
import { buildCenterIslands, type MedianIsland } from '../src/core/medians'
import { bearing, COS_LAT, cumulative, haversine, offsetMeters, pointAlong } from '../src/core/geo'

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

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

function buildViews(joins = CENTER_ISLAND_JOINS) {
  const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads, foldJournal(journal))
  return buildRoadMergeViews(roads.filter((r) => !r.properties.deleted), journal, joins)
}

/** 點是否落在多邊形內（ray casting，公尺平面）。 */
function inPolygon(p: [number, number], ring: [number, number][]): boolean {
  let inside = false
  const x = p[0] * KX, y = p[1] * KY
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * KX, yi = ring[i][1] * KY
    const xj = ring[j][0] * KX, yj = ring[j][1] * KY
    if ((yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside
  }
  return inside
}

const coveredBy = (p: [number, number], islands: MedianIsland[]) =>
  islands.some((m) => inPolygon(p, m.polygon))

const islandsFor = (renderRoads: RoadFeature[]) => {
  const graph = new RoadGraph(renderRoads)
  return buildCenterIslands(graph, buildTurnBays(graph, journal))
}

/** 接點兩側各 stretchM 公尺的主路中心線取樣點（沿兩臂各自的幾何走）。 */
function centrelineSamples(
  renderRoads: RoadFeature[], nodeId: number, stretchM: number, stepM: number,
): [number, number][] {
  const out: [number, number][] = []
  for (const road of renderRoads) {
    const nodes = road.properties.nodes
    const coords = road.geometry.coordinates as [number, number][]
    if (nodes.length !== coords.length || coords.length < 2) continue
    const index = nodes.indexOf(nodeId)
    if (index !== 0 && index !== nodes.length - 1) continue
    if ((road.properties.centerM || 0) <= 0 || road.properties.centerKind !== 'island') continue
    const line = index === 0 ? coords : [...coords].reverse()
    const cum = cumulative(line)
    const total = cum[cum.length - 1]
    for (let d = 0; d <= Math.min(stretchM, total); d += stepM) {
      out.push(pointAlong(line, cum, d).pos)
    }
  }
  return out
}

for (const spec of CENTER_ISLAND_JOINS) {
  console.log(`\n══ ${spec.label}（node ${spec.nodeId}）══`)
  const view = buildViews()
  const arms = view.renderRoads.filter((r) =>
    (r.properties.centerIslandJoinNodes ?? []).includes(spec.nodeId))
  check('繪圖視圖解析出兩段主路', arms.length === 2, arms.map(blockKey).join(' ↔ '))
  const routingArms = view.routingRoads.filter((r) =>
    (r.properties.centerIslandJoinNodes ?? []).includes(spec.nodeId))
  check('導航視圖解析出兩段主路', routingArms.length === 2, routingArms.map(blockKey).join(' ↔ '))

  // ── 1. 島面連續 ──
  const islands = islandsFor(view.renderRoads)
  const samples = centrelineSamples(view.renderRoads, spec.nodeId, 12, 0.5)
  const holes = samples.filter((p) => !coveredBy(p, islands))
  check('接點前後 12m 的中心線都被中央島覆蓋',
    samples.length > 20 && holes.length === 0,
    `取樣 ${samples.length} 點、破洞 ${holes.length}`)

  // 對照組：不套用貫通接點重算一次，同一批點必須出現破洞
  const bare = buildViews([])
  const bareHoles = samples.filter((p) => !coveredBy(p, islandsFor(bare.renderRoads)))
  check('對照組確實有破洞（量測有鑑別力）',
    bareHoles.length > 0, `未貫通時破洞 ${bareHoles.length}/${samples.length} 點`)

  // ── 2/3. 導航 ──
  // 取樣點沿「繪圖視圖」的長區塊量測（導航視圖可能被切成幾公尺的短樁，
  // 從短樁端點起算會落在路口節點上，量到的是路口本身而不是主路直行）。
  const nodePos = (() => {
    const road = arms[0]
    return road.geometry.coordinates[road.properties.nodes.indexOf(spec.nodeId)] as [number, number]
  })()
  const along = (road: RoadFeature, awayFromNodeM: number): [number, number] => {
    const nodes = road.properties.nodes
    const coords = road.geometry.coordinates as [number, number][]
    const line = nodes.indexOf(spec.nodeId) === 0 ? coords : [...coords].reverse()
    const cum = cumulative(line)
    return pointAlong(line, cum, Math.min(awayFromNodeM, cum[cum.length - 1])).pos
  }
  /** 雙向道的中心線在兩個行向上都吸得到；橫移半個車道才能指定行向。 */
  const LATERAL_M = 3.2
  const rightOf = (p: [number, number], brg: number): [number, number] => {
    const rad = (brg + 90) * Math.PI / 180
    return offsetMeters(p, Math.sin(rad) * LATERAL_M, Math.cos(rad) * LATERAL_M)
  }
  /** 朝接點行駛的車道上的一點 */
  const approach = (road: RoadFeature, distM: number) => {
    const p = along(road, distM)
    return rightOf(p, bearing(p, nodePos))
  }
  /** 離開接點行駛的車道上的一點 */
  const departure = (road: RoadFeature, distM: number) => {
    const p = along(road, distM)
    return rightOf(p, bearing(nodePos, p))
  }

  const [renderArmA, renderArmB] = arms
  const graph = new RoadGraph(view.routingRoads)
  const bareGraph = new RoadGraph(bare.routingRoads)
  const straight = haversine(along(renderArmA, 40), along(renderArmB, 40))
  const throughAB = graph.route(approach(renderArmA, 40), departure(renderArmB, 40), 'car')
  const throughBA = graph.route(approach(renderArmB, 40), departure(renderArmA, 40), 'car')
  check('主路 A→B 直行不受影響', !!throughAB,
    throughAB ? `${throughAB.lengthM.toFixed(0)}m（直線 ${straight.toFixed(0)}m）` : '無路徑')
  check('主路 B→A 直行不受影響', !!throughBA,
    throughBA ? `${throughBA.lengthM.toFixed(0)}m（直線 ${straight.toFixed(0)}m）` : '無路徑')
  check('直行沒有被迫繞路（≤1.5 倍直線距離）',
    !!throughAB && !!throughBA
    && throughAB.lengthM < straight * 1.5 && throughBA.lengthM < straight * 1.5,
    `${throughAB?.lengthM.toFixed(0)}m／${throughBA?.lengthM.toFixed(0)}m vs ${straight.toFixed(0)}m`)

  // 迴轉：進入接點後折回同一臂的對向車道，必須繞出接點以外
  const uTurnAB = graph.route(approach(renderArmB, 40), departure(renderArmB, 40), 'car')
  const bareUTurn = bareGraph.route(approach(renderArmB, 40), departure(renderArmB, 40), 'car')
  check('主路不得在接點迴轉',
    !!uTurnAB && !!bareUTurn && uTurnAB.lengthM > bareUTurn.lengthM * 1.5,
    `貫通後 ${uTurnAB?.lengthM.toFixed(0)}m vs 未貫通 ${bareUTurn?.lengthM.toFixed(0)}m`)

  // 側街：只能進入相鄰行向；另一向要到得了，但必須繞出接點再折返
  const sides = view.renderRoads.filter((r) => {
    if (r === renderArmA || r === renderArmB) return false
    const nodes = r.properties.nodes
    return nodes[0] === spec.nodeId || nodes[nodes.length - 1] === spec.nodeId
  })
  console.log(`   側街 ${sides.length} 條：${sides.map(blockKey).join('、')}`)
  for (const side of sides) {
    const from = approach(side, 30)
    const toA = graph.route(from, departure(renderArmA, 40), 'car')
    const toB = graph.route(from, departure(renderArmB, 40), 'car')
    check(`${blockKey(side)} 兩個行向都仍可抵達`, !!toA && !!toB,
      `→A ${toA ? `${toA.lengthM.toFixed(0)}m` : '無'}／→B ${toB ? `${toB.lengthM.toFixed(0)}m` : '無'}`)
    if (!toA || !toB) continue
    // 相鄰的那一向直接右轉；另一向被中央島擋住，只能繞遠路
    const bareA = bareGraph.route(from, departure(renderArmA, 40), 'car')
    const bareB = bareGraph.route(from, departure(renderArmB, 40), 'car')
    const blockedA = !!bareA && toA.lengthM > bareA.lengthM * 1.5
    const blockedB = !!bareB && toB.lengthM > bareB.lengthM * 1.5
    check(`${blockKey(side)} 只有一個行向能在接點轉出（另一向被島擋住）`,
      blockedA !== blockedB,
      `→A ${toA.lengthM.toFixed(0)}m（未貫通 ${bareA?.lengthM.toFixed(0)}m）`
      + `／→B ${toB.lengthM.toFixed(0)}m（未貫通 ${bareB?.lengthM.toFixed(0)}m）`)
  }
}

console.log(fails === 0 ? '\n✅ 全數通過' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
