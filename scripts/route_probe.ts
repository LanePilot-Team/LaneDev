// 單一路線探針：跑一次 A* 並列出經過哪些路、轉了幾次彎。
// 「導航為什麼走這條」的第一手證據，也用來做修改前後的 A/B 對照。
//
//   --from=lng,lat --to=lng,lat   起訖點
//   --profile=car|moto            車種（預設 car）
//   --db=<路徑>                   換一份資料庫（拿 .lanedev-backups 的做前後比對）
//   --restore=way/W@b/N,...       另外再跑一次「把這些區塊還原」的結果做對照
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
} from '../src/core/laneBase'
import { RoadGraph, type Profile } from '../src/core/graph'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const has = (name: string) => process.argv.includes(`--${name}`)

const db = JSON.parse(readFileSync(
  arg('db', join(HERE, '../public/data/road_database.json')), 'utf8'))

function build(extra: EnhancementRecord[]) {
  const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
  const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  const roads0 = prepared.roads
  const extraction = extractLaneBase(Array.isArray(db.annotations) ? db.annotations : [])
  const remapped = remapLaneBase(extraction.records, {
    existingWayIds: new Set(roads0.map((r) => r.properties.osm_id)),
    nodeRemap: prepared.nodeRemap,
    wayRemap: prepared.wayRemap,
    wayApproachNodes: roads0.reduce((index, road) => {
      const nodes = index.get(road.properties.osm_id) ?? {
        forward: new Set<number>(), backward: new Set<number>(),
      }
      nodes.forward.add(road.properties.nodes.at(-1)!)
      if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
      index.set(road.properties.osm_id, nodes)
      return index
    }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
  })
  applyLaneBaseToRoads(roads0, buildLaneBaseIndex(remapped.records))
  const journal: EnhancementRecord[] = [...(db.editor?.journal ?? []), ...extra]
  const folded = foldJournal(journal)
  const roadsAll = [...roads0, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
  applyToRoads(roadsAll, folded)
  const view = buildRoadMergeViews(roadsAll.filter((r) => !r.properties.deleted), journal)
  return { roads: view.routingRoads, graph: new RoadGraph(view.routingRoads) }
}

const restoreKeys = arg('restore').split(',').filter(Boolean)
const extra: EnhancementRecord[] = restoreKeys.map((k, i) => ({
  seq: 900000 + i, ts: new Date(Date.now() + i).toISOString(), author: 'probe', op: 'set',
  target: { type: 'road', key: k }, fields: { deleted: 0 },
}))

const parse = (s: string) => s.split(',').map(Number) as [number, number]
const from = parse(arg('from'))
const to = parse(arg('to'))
const profile = (arg('profile', 'car') as Profile)

for (const [label, ex] of [['現況', [] as EnhancementRecord[]], ...(extra.length ? [['還原後', extra] as const] : [])] as [string, EnhancementRecord[]][]) {
  const { graph } = build(ex)
  const route = graph.route(from, to, profile)
  console.log(`\n===== ${label} =====`)
  if (!route) { console.log('❌ 無法成線'); continue }
  console.log(`長度 ${route.lengthM.toFixed(0)}m｜時間 ${route.timeS.toFixed(0)}s｜直線 ${haversine(from, to).toFixed(0)}m`)
  const names: string[] = []
  for (const sp of route.spans) {
    if (!sp.road) continue
    const p = sp.road.properties
    const label = `${p.name ?? '(無名)'} way/${p.osm_id}`
    if (names[names.length - 1] !== label) names.push(label)
  }
  console.log(`經過：${names.join(' → ')}`)
  console.log(`轉向：${route.maneuvers.map((m) => `${m.kind}@${m.distM.toFixed(0)}m`).join('、')}`)
}

if (has('gapinfo')) {
  const { roads } = build([])
  const near = roads.filter((r) => (r.geometry.coordinates as [number, number][])
    .some((c) => haversine(c, from) < 200))
  console.log(`\n起點 200m 內 ${near.length} 區塊`)
  for (const r of near) {
    const p = r.properties as RoadFeature['properties']
    console.log(`  way/${p.osm_id}@b/${p.blockNode} ${p.name ?? '(無名)'} nodes=${p.nodes.join('>')}`)
  }
}
