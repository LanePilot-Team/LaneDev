// 路口探針：查「這兩條路到底有沒有接起來」「這個路口哪些轉向被什麼擋住」。
// audit 告訴你哪裡有問題，這支告訴你為什麼。
//
//   --a=加昌路 --b=區東路   兩條路的區塊、共用節點、幾何最近距離
//   --like=昌               列出所有含該字串的路名
//   --node=123,456          哪些區塊含這些節點（加 --withdeleted 連已刪的一起看）
//   --trans=289126281       路口所有「進入 → 離開」組合，逐一說明通/不通的理由
//   --at=120.31,22.72 --r=120   座標半徑內的所有區塊
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { newRoadsFromFolded } from '../src/core/newroads'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
} from '../src/core/laneBase'
import { haversine, bearing } from '../src/core/geo'
import { RoadGraph, carAllowed, motoAllowed, oneSideEntryTransitionAllowed } from '../src/core/graph'
import { guidanceForRoadDirection } from '../src/core/laneBase'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, fallback = '') =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('segments 解析失敗')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const roads0 = prepared.roads

// Canonical Lane Base（與 mapCore 相同）
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
const laneIndex = buildLaneBaseIndex(remapped.records)
applyLaneBaseToRoads(roads0, laneIndex)

const journal = db.editor?.journal ?? []
const folded = foldJournal(journal)
const roadsAll = [...roads0, ...newRoadsFromFolded(folded, prepared.nodeRemap)]
applyToRoads(roadsAll, folded)
const active = roadsAll.filter((r) => !r.properties.deleted)
const view = buildRoadMergeViews(active, journal)
const roads = process.argv.includes('--withdeleted') ? roadsAll : view.routingRoads
console.log(`路網：${roads.length} 區塊`)

const norm = (s?: string) => (s ?? '').replace(/\s+/g, '')
const nameA = arg('a')
const nameB = arg('b')

const describe = (r: RoadFeature) => {
  const p = r.properties
  return `way/${p.osm_id}@b/${p.blockNode} ${p.name ?? '(無名)'} ${p.highway}`
    + ` oneway=${p.oneway} f=${p.lanesForward} b=${p.lanesBackward}`
    + ` motorcar=${p.motorcar ?? '-'} motorcycle=${p.motorcycle ?? '-'}`
}

// --like=昌：列出所有含該字串的路名
const like = arg('like')
if (like) {
  const names = new Map<string, number>()
  for (const r of roads) {
    const n = norm(r.properties.name)
    if (n.includes(like)) names.set(n, (names.get(n) ?? 0) + 1)
  }
  console.log(`\n== 路名含「${like}」 ==`)
  for (const [n, c] of [...names].sort()) console.log(`  ${n} (${c})`)
}

// --node=123,456：列出經過這些節點的所有區塊
const nodeArg = arg('node')
if (nodeArg) {
  for (const idText of nodeArg.split(',')) {
    const id = Number(idText)
    console.log(`\n== node=${id} ==`)
    const at = roads.filter((r) => r.properties.nodes.includes(id))
    if (!at.length) console.log('  ❌ 沒有任何路網區塊含此節點')
    for (const r of at) {
      const i = r.properties.nodes.indexOf(id)
      console.log(`  [${i}/${r.properties.nodes.length - 1}] ${describe(r)}`)
      console.log(`     nodes=${r.properties.nodes.join('>')}`)
    }
  }
}

if (nameA) {
  const A = roads.filter((r) => norm(r.properties.name) === nameA)
  console.log(`\n== ${nameA}：${A.length} 區塊 ==`)
  for (const r of A) {
    const cs = r.geometry.coordinates as [number, number][]
    console.log(`  ${describe(r)}`)
    console.log(`     nodes=${r.properties.nodes.join('>')}`)
    console.log(`     ${cs[0].map((n) => n.toFixed(6))} → ${cs[cs.length - 1].map((n) => n.toFixed(6))}`)
  }
  if (nameB) {
    const B = roads.filter((r) => norm(r.properties.name) === nameB)
    console.log(`\n== ${nameB}：${B.length} 區塊 ==`)
    for (const r of B) {
      const cs = r.geometry.coordinates as [number, number][]
      console.log(`  ${describe(r)}`)
      console.log(`     nodes=${r.properties.nodes.join('>')}`)
      console.log(`     ${cs[0].map((n) => n.toFixed(6))} → ${cs[cs.length - 1].map((n) => n.toFixed(6))}`)
    }
    // 共用節點
    const nb = new Map<number, RoadFeature[]>()
    for (const r of B) for (const n of r.properties.nodes) {
      if (!nb.has(n)) nb.set(n, [])
      nb.get(n)!.push(r)
    }
    console.log(`\n== 共用節點 ==`)
    let found = 0
    for (const r of A) for (const n of r.properties.nodes) {
      if (nb.has(n)) { found++; console.log(`  node=${n} ${describe(r)} ↔ ${nb.get(n)!.map(describe).join(' / ')}`) }
    }
    if (!found) console.log('  ❌ 沒有任何共用節點——圖上兩條路完全不連通')
    // 幾何最近距離
    let best: { d: number; a: RoadFeature; b: RoadFeature; pa: [number, number]; pb: [number, number] } | null = null
    for (const ra of A) for (const rb of B) {
      for (const pa of ra.geometry.coordinates as [number, number][]) {
        for (const pb of rb.geometry.coordinates as [number, number][]) {
          const d = haversine(pa, pb)
          if (!best || d < best.d) best = { d, a: ra, b: rb, pa, pb }
        }
      }
    }
    if (best) {
      console.log(`\n幾何最近頂點距離 ${best.d.toFixed(2)}m`)
      console.log(`  A ${describe(best.a)} @ ${best.pa}`)
      console.log(`  B ${describe(best.b)} @ ${best.pb}`)
    }
  }
}

// --trans=<node>：列舉該路口所有「進入邊 → 離開邊」組合，逐一說明為什麼通/不通。
// 直接對 RoadGraph 的內部索引取值（除錯工具，不動 core）。
const transArg = arg('trans')
if (transArg) {
  const graph = new RoadGraph(roads) as unknown as {
    adj: Map<number, InternalEdge[]>
    adjIn: Map<number, InternalEdge[]>
    roadMergeBarrierNodes: Set<number>
    laneTransitionPlan: (
      incoming: InternalEdge, outgoing: InternalEdge, nodeId: number,
      profile: string, policy: object, entryLaneIndex?: number,
    ) => { decision: { allowed: boolean; reason: string; incompatibleLaneIndices: number[] } }
  }
  interface InternalEdge {
    from: number; to: number; coords: [number, number][]
    road: RoadFeature; back: boolean
  }
  const profile = arg('profile', 'car') as 'car' | 'moto'
  for (const idText of transArg.split(',')) {
    const nodeId = Number(idText)
    const incoming = graph.adjIn.get(nodeId) ?? []
    const outgoing = graph.adj.get(nodeId) ?? []
    const barrier = graph.roadMergeBarrierNodes.has(nodeId)
    console.log(`\n== 路口 node=${nodeId}（${profile}）｜捏合/中央島屏障=${barrier ? '是' : '否'}`
      + `｜入邊 ${incoming.length}、出邊 ${outgoing.length} ==`)
    const label = (e: InternalEdge) => {
      const p = e.road.properties
      return `${p.name ?? '(無名)'} way/${p.osm_id}@b/${p.blockNode}${e.back ? '(逆)' : ''}`
    }
    for (const inE of incoming) {
      const c = inE.coords
      const inB = bearing(c[c.length - 2], c[c.length - 1])
      const g = guidanceForRoadDirection(inE.road, inE.back)
      console.log(`  ← ${label(inE)} 進入方位 ${inB.toFixed(0)}°`
        + `｜可行駛=${(profile === 'moto' ? motoAllowed : carAllowed)(inE.road, inE.back)}`)
      console.log(`      車道指引（${g.source}）${g.laneCount} 道：`
        + `${(g.laneMovements ?? []).map((m, i) => `${i}:${m || '(空)'}`).join(' ｜ ')}`)
      for (const outE of outgoing) {
        const outB = bearing(outE.coords[0], outE.coords[1])
        let delta = outB - inB
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        const dir = Math.abs(delta) < 25 ? '直行'
          : Math.abs(delta) > 155 ? '迴轉' : delta > 0 ? '右轉' : '左轉'
        const drivable = (profile === 'moto' ? motoAllowed : carAllowed)(outE.road, outE.back)
        const topo = oneSideEntryTransitionAllowed(
          inE.road, inE.back, outE.road, outE.back, nodeId)
        let lane = 'n/a'
        try {
          const plan = graph.laneTransitionPlan(inE, outE, nodeId, profile, {}, undefined)
          lane = plan?.decision.allowed
            ? `ok(${plan.decision.reason})`
            : `❌${plan?.decision.reason ?? 'null'}`
        } catch (error) { lane = `例外 ${(error as Error).message}` }
        const ok = drivable && topo && lane.startsWith('ok')
        console.log(`      ${ok ? '✅' : '❌'} → ${label(outE)} ${dir}(${delta.toFixed(0)}°)`
          + `｜可行駛=${drivable}｜捏合規則=${topo}｜車道決策=${lane}`)
      }
    }
  }
}

// 座標半徑列舉
const at = arg('at')
if (at) {
  const [lng, lat] = at.split(',').map(Number)
  const R = Number(arg('r', '80'))
  console.log(`\n== ${lng},${lat} 半徑 ${R}m ==`)
  for (const r of roads) {
    const cs = r.geometry.coordinates as [number, number][]
    const hit = cs.some((c) => haversine(c, [lng, lat]) < R)
    if (!hit) continue
    console.log(`  ${describe(r)}`)
    console.log(`     nodes=${r.properties.nodes.join('>')}`)
    console.log(`     ${cs[0].map((n) => n.toFixed(6))} → ${cs[cs.length - 1].map((n) => n.toFixed(6))} 長 ${haversine(cs[0], cs[cs.length - 1]).toFixed(0)}m 方位 ${bearing(cs[0], cs[cs.length - 1]).toFixed(0)}°`)
  }
}
