// 停止線稽核（node scripts/run_offline.mjs scripts/stop_line_audit.ts）
//
// 走與 app 相同的繪製管線，驗證：
//   1. FORCED_STOP_LINES 的每個現地指定進口都真的畫出停止線，且落在該區塊最前端
//   2. 停止線橫跨該行向的完整車道塊（不是半條）
//   3. 例外只作用在指定進口——全圖停止線總數不因此暴增（對照組：清空清單重算）
//
// 參數：--db=<path>
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
  buildTurnBays, buildRightLanes, buildStopLines, FORCED_STOP_LINES,
} from '../src/core/turnbays'
import { laneSpanM } from '../src/core/roads'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))

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
const lines = buildStopLines(graph, bays, rightLanes, journal)
console.log(`停止線共 ${lines.length} 條`)

// 對照組：清空現地指定清單重算（同一支 build，只是例外沒了）
const saved = FORCED_STOP_LINES.splice(0, FORCED_STOP_LINES.length)
const bare = buildStopLines(new RoadGraph(view.renderRoads), bays, rightLanes, journal)
FORCED_STOP_LINES.push(...saved)
console.log(`對照組（無現地指定）：${bare.length} 條\n`)

check('現地指定只多出清單裡那幾條',
  lines.length - bare.length === FORCED_STOP_LINES.length,
  `${bare.length} → ${lines.length}（清單 ${FORCED_STOP_LINES.length} 筆）`)

const nodePos = new Map<number, [number, number]>()
for (const r of view.renderRoads) {
  r.properties.nodes.forEach((n, i) => {
    if (!nodePos.has(n)) nodePos.set(n, r.geometry.coordinates[i] as [number, number])
  })
}

for (const spec of FORCED_STOP_LINES) {
  const dirKey = `${spec.osmId}@${spec.toNode}${spec.back ? '~b' : ''}`
  const label = `way/${spec.osmId}@b/${spec.blockNode} → node ${spec.toNode}`
  const mine = lines.filter((l) => l.ownerKey === dirKey)
  check(`${label} 有停止線`, mine.length === 1, `${mine.length} 條（${dirKey}）`)
  if (mine.length !== 1) continue
  const line = mine[0]
  const pos = nodePos.get(spec.toNode)!
  const dist = Math.min(...line.coords.map((c) => haversine(c, pos)))
  check(`${label} 停止線落在區塊最前端（距節點 ≤15m）`, dist <= 15, `${dist.toFixed(1)}m`)
  const road = view.renderRoads.find((r) =>
    r.properties.osm_id === spec.osmId && r.properties.blockNode === spec.blockNode)!
  const span = laneSpanM(road.properties, spec.back)
  // 有偏心左轉道/右轉附加道時，停止線要一併橫跨過去
  const bay = bays.find((b) =>
    `${b.wayId}@${b.nodeId}${b.back ? '~b' : ''}` === dirKey)
  const rl = rightLanes.find((r) =>
    `${r.wayId}@${r.nodeId}${r.back ? '~b' : ''}` === dirKey)
  const expected = span + (bay?.widthM ?? 0) + (rl?.widthM ?? 0) - 0.3
  const len = haversine(line.coords[0], line.coords[line.coords.length - 1])
  check(`${label} 停止線橫跨完整車道塊`,
    Math.abs(len - expected) < 1.2,
    `線長 ${len.toFixed(1)}m vs 應有 ${expected.toFixed(1)}m`
    + `（車道塊 ${span.toFixed(1)}m${bay ? ` ＋偏心道 ${bay.widthM.toFixed(1)}m` : ''}`
    + `${rl ? ` ＋右轉道 ${rl.widthM.toFixed(1)}m` : ''}）`)
  check(`${label} 對照組確實沒有（量測有鑑別力）`,
    !bare.some((l) => l.ownerKey === dirKey))
}

console.log(fails === 0 ? '\n✅ 全數通過' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
