// 機車停等格落點稽核：每個實際畫出的格子，其幾何中心離「它自己的路口節點」多遠。
//   --at=lng,lat --radius=公尺   只看某座標附近
//   --far=公尺                   全圖列出離自己路口超過此距離的格子（預設 40）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildRoadMergeViews } from '../src/core/roadMerge'
import { buildTurnBays, buildRightLanes, buildMotoBoxes } from '../src/core/turnbays'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const AT = arg('at', '')
const RADIUS = Number(arg('radius', '150'))
const FAR = Number(arg('far', '40'))

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const journal = db.editor.journal
applyToRoads(roads, foldJournal(journal))
const view = buildRoadMergeViews(roads, journal)
const graph = new RoadGraph(view.renderRoads)
const bays = buildTurnBays(graph, journal)
const rl = buildRightLanes(graph, journal)
const { boxes } = buildMotoBoxes(graph, bays, rl, journal)

// 節點座標表（用繪圖用道路，與 graph 同一份）
const nodePos = new Map<number, [number, number]>()
const waysAt = new Map<number, Set<number>>()
const nameOf = new Map<number, string>()
for (const r of view.renderRoads as RoadFeature[]) {
  const cs = r.geometry.coordinates as [number, number][]
  const ns = r.properties.nodes ?? []
  nameOf.set(r.properties.osm_id, r.properties.name ?? '(無名)')
  ns.forEach((n: number, i: number) => {
    if (cs[i]) nodePos.set(n, cs[i])
    if (!waysAt.has(n)) waysAt.set(n, new Set())
    waysAt.get(n)!.add(r.properties.osm_id)
  })
}

const drawn = boxes.filter((b) => b.ring)
console.log(`停等格候選 ${boxes.length} 個，實際畫出 ${drawn.length} 個\n`)

type Row = { key: string; dir: string; c: [number, number]; node: number; dist: number; icons: number }
const rows: Row[] = []
for (const b of drawn) {
  const ring = b.ring!
  const c: [number, number] = [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ]
  const node = Number(b.dir.split('@')[1].replace('~b', ''))
  const np = nodePos.get(node)
  rows.push({ key: b.key, dir: b.dir, c, node, dist: np ? haversine(c, np) : -1, icons: b.icons?.length ?? 0 })
}

if (process.argv.includes('--json')) {
  for (const r of rows.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(JSON.stringify({ k: r.key, c: [ +r.c[0].toFixed(7), +r.c[1].toFixed(7) ], d: +r.dist.toFixed(2) }))
  }
  process.exit(0)
}

if (AT) {
  const [lng, lat] = AT.split(',').map(Number)
  const near = rows.filter((r) => haversine(r.c, [lng, lat]) <= RADIUS)
    .sort((a, b) => haversine(a.c, [lng, lat]) - haversine(b.c, [lng, lat]))
  console.log(`=== (${lng},${lat}) ${RADIUS}m 內畫出的停等格 ${near.length} 個 ===`)
  for (const r of near) {
    const w = Number(r.dir.split('@')[0])
    console.log(`  ${r.key}`)
    console.log(`    way/${w} ${nameOf.get(w) ?? '?'} → 路口節點 ${r.node}`)
    const ws = [...(waysAt.get(r.node) ?? [])]
    const isJunction = ws.length > 1
    console.log(`    格子中心 ${r.c.map((x) => x.toFixed(7)).join(',')}  離節點 ${r.dist.toFixed(1)} m  圖示 ${r.icons} 枚`)
    console.log(`    ${isJunction ? '✅ 路口' : '❌ 非路口(只有一條 way 經過)'} 節點 ${r.node} 上的 way: ${ws.map((x) => `${x}(${nameOf.get(x) ?? '?'})`).join(', ')}`)
  }
}

const far = rows.filter((r) => r.dist > FAR).sort((a, b) => b.dist - a.dist)
console.log(`\n=== 離自己路口 > ${FAR} m 的停等格：${far.length} 個 ===`)
for (const r of far.slice(0, 25)) {
  const w = Number(r.dir.split('@')[0])
  console.log(`  ${r.dist.toFixed(1).padStart(7)} m  ${r.key}  way/${w} ${nameOf.get(w) ?? '?'}  中心 ${r.c.map((x) => x.toFixed(6)).join(',')}`)
}
const noNode = rows.filter((r) => r.dist < 0)
if (noNode.length) {
  console.log(`\n⚠ 找不到自己路口節點座標的格子: ${noNode.length} 個`)
  for (const r of noNode.slice(0, 10)) console.log('   ', r.key)
}
