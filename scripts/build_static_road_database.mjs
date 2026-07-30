import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const data = resolve(root, 'public/data')
const lanePilot = resolve(data, 'lanepilot')
const allRegions = [
  { area_id: 'area/4212599', name: '楠梓區', file: 'area_4212599.segments.jsonl' },
  { area_id: 'area/4212533', name: '左營區', file: 'area_4212533.segments.jsonl' },
]
const nanzihOnly = process.argv.includes('--nanzih-only')
const regions = nanzihOnly ? allRegions.slice(0, 1) : allRegions

function parseJsonl(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

const loaded = (await Promise.all(
  regions.map(({ file }) => readFile(resolve(lanePilot, file), 'utf8').then(parseJsonl)),
)).flat()

// 跨區界的 way 會被兩份行政區 shard 各收錄一次（LanePilot 依行政區匯出，extract
// 涵蓋到就收）。這裡過去是純串接、整條鏈上沒有任何唯一性檢查，於是同一條路進來
// 兩份，切塊後放大成數百組重複區塊鍵，各自套用覆寫、各自畫中央帶 → 整段雙重黃線。
// 身分 = nav_segment_key + split_index；保留先出現的（regions 順序 = 楠梓優先）。
const segmentIdentity = (s) =>
  `${s.object_identity?.nav_segment_key ?? s.osm_id}#${s.object_identity?.split_index ?? 0}`
const seenSegments = new Set()
const duplicateSegments = []
const segments = []
for (const s of loaded) {
  const id = segmentIdentity(s)
  if (seenSegments.has(id)) { duplicateSegments.push(id); continue }
  seenSegments.add(id)
  segments.push(s)
}
if (duplicateSegments.length) {
  // 一定要出聲。靜默吃掉重複正是這個問題藏這麼久的原因。
  console.warn(`[dedupe] 跨 shard 重複分段 ${duplicateSegments.length} 個已移除`
    + `（${loaded.length} → ${segments.length}）`)
  console.warn(`[dedupe] 例：${duplicateSegments.slice(0, 5).join(', ')}`)
}

// Some published district shards contain geometry but omit node_refs. LaneDev
// needs one node id per coordinate for drawing, intersections and routing.
// Reuse real OSM node ids wherever another shard supplies them; otherwise assign
// stable negative synthetic ids shared by every identical coordinate.
const coordinateKey = (point) => `${Number(point[0]).toFixed(7)},${Number(point[1]).toFixed(7)}`
const nodeByCoordinate = new Map()
for (const segment of segments) {
  const coordinates = segment.geometry?.coordinates ?? []
  const nodes = segment.node_refs
  if (!Array.isArray(nodes) || nodes.length !== coordinates.length) continue
  coordinates.forEach((point, index) => nodeByCoordinate.set(coordinateKey(point), nodes[index]))
}
let nextSyntheticNode = -1
for (const segment of segments) {
  const coordinates = segment.geometry?.coordinates ?? []
  if (Array.isArray(segment.node_refs) && segment.node_refs.length === coordinates.length) continue
  segment.node_refs = coordinates.map((point) => {
    const key = coordinateKey(point)
    const existing = nodeByCoordinate.get(key)
    if (existing !== undefined) return existing
    const synthetic = nextSyntheticNode--
    nodeByCoordinate.set(key, synthetic)
    return synthetic
  })
}

// annotations.jsonl 已在匯入階段具體化為 editor.journal 與 waiting_zones。
// 執行時不再需要重複攜帶近 9 MB 的原始標註；唯一生效來源仍是同一份
// road_database.json 內的 segments + editor。
const annotations = []

let existingEditor = null
try {
  existingEditor = JSON.parse(
    await readFile(resolve(data, 'road_database.json'), 'utf8'),
  ).editor
} catch {
  // First build has no canonical database yet.
}

if (existingEditor && nanzihOnly) {
  const allowedWays = new Set(segments.map((segment) =>
    Number(segment.object_identity?.source_osm?.osm_id
      ?? String(segment.object_identity?.nav_segment_key ?? '').match(/^way\/(-?\d+)/)?.[1]
      ?? segment.osm_id)).filter(Number.isFinite))
  const allowedNodes = new Set(segments.flatMap((segment) =>
    Array.isArray(segment.node_refs) ? segment.node_refs.map(Number) : []))
  existingEditor = {
    ...existingEditor,
    journal: existingEditor.journal.filter((record) => {
      const wayIds = [...String(record.target?.key ?? '').matchAll(/way\/(-?\d+)/g)]
        .map((match) => Number(match[1]))
      return wayIds.length === 0 || wayIds.every((wayId) => allowedWays.has(wayId))
    }),
    waiting_zones: existingEditor.waiting_zones.filter((zone) =>
      allowedNodes.has(Number(zone.intersectionId))),
  }
}

let journal = []
try {
  journal = JSON.parse(await readFile(resolve(data, 'seed_journal.json'), 'utf8'))
} catch {
  // A missing seed is valid; browser edits will populate the canonical editor.
}

const output = {
  format: 'lanedev-static-road-database-v1',
  updated_at: new Date().toISOString(),
  regions: regions.map(({ area_id, name }) => ({ area_id, name })),
  segments,
  annotations,
  editor: existingEditor ?? {
    updated_at: '',
    journal,
    waiting_zones: [],
    deleted_waiting_zone_ids: [],
  },
}

// --out=<路徑> 讓評估用的重建產到暫存檔，不覆蓋唯一資料庫
const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  ?? resolve(data, 'road_database.json')
await writeFile(outPath, `${JSON.stringify(output)}\n`, 'utf8')

console.log(JSON.stringify({
  output: outPath,
  segments: segments.length,
  duplicatesRemoved: duplicateSegments.length,
  annotations: annotations.length,
  journal: journal.length,
}, null, 2))
