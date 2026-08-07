import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { prepareBaseRoads } from '../src/core/pipeline'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database did not parse as a map')
const { roads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))

const key = (road: RoadFeature) => `way/${road.properties.osm_id}@b/${road.properties.blockNode}`
const keys = new Set(roads.map(key))
let failures = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

for (const removed of [
  'way/25706466@b/1400036190',
  'way/25706466@b/8198448992',
  'way/25706466@b/1400036869',
  'way/25706466@b/1400036531',
  'way/25706466@b/265591751',
  'way/24436713@b/280277447',
]) check(`removed ${removed}`, !keys.has(removed))

for (const retained of [
  'way/271982114@b/1400036862',
  'way/271982114@b/8198448994',
  'way/25706464@b/1451069359',
  // These three are short but necessary approach connectors.
  'way/126247891@b/1451069359',
  'way/126247891@b/1400036531',
  'way/271982128@b/1400036190',
  // The two blocks the user asked us to identify, not delete.
  'way/25706466@b/280277330',
  'way/25706466@b/8806916643',
]) check(`retained ${retained}`, keys.has(retained))

const tail = roads.find((road) => key(road) === 'way/25706466@b/8806916643')
const tailNode = tail?.properties.nodes.indexOf(8806916619) ?? -1
const tailCoord = tailNode >= 0
  ? tail!.geometry.coordinates[tailNode] as [number, number]
  : null
check('Qinan-to-Tuku tail keeps its original straight middle vertex', !!tailCoord
  && Math.abs(tailCoord[0] - 120.3327612) < 1e-8
  && Math.abs(tailCoord[1] - 22.7355082) < 1e-8)
check('Qinan-to-Tuku tail still joins Tuku Road at node 265591751', !!tail
  && tail.properties.nodes.at(-1) === 265591751
  && roads.some((road) => road.properties.name === '土庫一路'
    && road.properties.nodes.includes(265591751)))
if (tail) {
  const cs = tail.geometry.coordinates as [number, number][]
  const smooth = cs.slice(1, -1).every((point, index) => {
    const a = cs[index], b = point, c = cs[index + 2]
    const kx = 102600, ky = 110540
    const ux = (b[0] - a[0]) * kx, uy = (b[1] - a[1]) * ky
    const vx = (c[0] - b[0]) * kx, vy = (c[1] - b[1]) * ky
    return (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)) > Math.cos(Math.PI / 4)
  })
  check('Qinan-to-Tuku tail has no turn sharper than 45 degrees', smooth)
}

const adjacency = new Map<number, Set<number>>()
const addEdge = (from: number, to: number) => {
  const next = adjacency.get(from) ?? new Set<number>()
  next.add(to)
  adjacency.set(from, next)
}
for (const road of roads) {
  const ns = road.properties.nodes
  if (ns.length < 2) continue
  addEdge(ns[0], ns[ns.length - 1])
  if (road.properties.oneway === 'no') addEdge(ns[ns.length - 1], ns[0])
}
const reachable = (from: number, to: number) => {
  const queue = [from]
  const seen = new Set(queue)
  while (queue.length) {
    const node = queue.shift()!
    if (node === to) return true
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return false
}
const resolveNode = (node: number) => {
  const seen = new Set<number>()
  while (nodeRemap.has(node) && !seen.has(node)) {
    seen.add(node)
    node = nodeRemap.get(node)!
  }
  return node
}

for (const [label, from, to] of [
  ['Qinan north to south', 280277330, 1932046238],
  ['Qinan south to north', 1932046238, 280277330],
  ['Tuku primary inbound', 1400036078, 1400036165],
  ['Tuku secondary inbound', 12954233421, 1400036862],
  ['Tuku primary outbound', 1451069359, 1400036044],
  ['Tuku secondary outbound', 280277330, 12954233418],
] as const) check(`route ${label}`, reachable(resolveNode(from), resolveNode(to)))

if (failures) process.exitCode = 1
