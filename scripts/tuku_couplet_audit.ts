import { readFileSync } from 'node:fs'
import { parseImported } from '../src/core/importmap'
import { prepareBaseRoads } from '../src/core/pipeline'
import { roadsFromGeoJSON } from '../src/core/roads'

const db = JSON.parse(readFileSync('public/data/road_database.json', 'utf8'))
const parsed = parseImported(db.segments.map((row: unknown) => JSON.stringify(row)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road database did not parse as a map')
const { roads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` | ${detail}` : ''}`)
  if (!ok) failures++
}

const main = roads.filter((road) => road.properties.name === '土庫一路'
  && road.properties.highway === 'tertiary')
const side = roads.filter((road) => road.properties.name === '土庫一路'
  && road.properties.highway === 'unclassified')
check('central mainline is fully merged two-way', main.length > 0 && main.every((road) =>
  road.properties.osm_id === 126247891
  && road.properties.oneway === 'no'
  && road.properties.coupletMerged === true
  && road.properties.lanesForward === 3
  && road.properties.lanesBackward === 3), `blocks=${main.length}`)
const sourceIds = new Set(main.flatMap((road) =>
  road.properties.sourceSegments?.map((source) => source.osmId) ?? []))
check('all three central source ways are represented',
  [126247863, 126247891, 1464614123].every((id) => sourceIds.has(id)))
check('outer Tuku carriageways remain separate one-way roads', side.length > 0
  && side.every((road) => road.properties.oneway === 'yes' && !road.properties.coupletMerged),
`blocks=${side.length}`)

const resolveNode = (node: number) => {
  const seen = new Set<number>()
  while (nodeRemap.has(node) && !seen.has(node)) {
    seen.add(node)
    node = nodeRemap.get(node)!
  }
  return node
}
const mainNodes = new Set(main.flatMap((road) => road.properties.nodes))
for (const [label, node, names] of [
  ['Qinan Road', 1451069359, ['旗楠路']],
  ['Qingfeng 1st Road', 12954233419, ['清豐一路']],
  ['Qingfeng 2nd Road', 1400036850, ['清豐二路']],
  ['Demin Bridge', 1400036044, ['德民新橋']],
  ['Tuku 2nd Road', 1400036044, ['土庫二路']],
] as const) {
  const mapped = resolveNode(node)
  check(`side connection ${label}`, mainNodes.has(mapped) && roads.some((road) =>
    names.includes(road.properties.name as never) && road.properties.nodes.includes(mapped)))
}

const adjacency = new Map<number, Set<number>>()
const add = (from: number, to: number) => {
  const next = adjacency.get(from) ?? new Set<number>()
  next.add(to)
  adjacency.set(from, next)
}
for (const road of roads) {
  const nodes = road.properties.nodes
  if (nodes.length < 2) continue
  add(nodes[0], nodes[nodes.length - 1])
  if (road.properties.oneway === 'no') add(nodes[nodes.length - 1], nodes[0])
}
const reachable = (from: number, to: number) => {
  const queue = [resolveNode(from)]
  const target = resolveNode(to)
  const seen = new Set(queue)
  while (queue.length) {
    const node = queue.shift()!
    if (node === target) return true
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return false
}
check('central navigation east-to-west', reachable(1451069359, 1400036044))
check('central navigation west-to-east', reachable(1400036044, 1451069359))

if (failures) process.exitCode = 1
