import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, type EnhancementRecord } from '../src/core/enhancements'
import {
  buildLaneGuidanceIndex,
  remapLaneGuidanceRecords,
  type LaneDirection,
  type LaneGuidanceRecord,
} from '../src/core/laneGuidance'

const root = process.cwd()
const outputDir = join(root, 'docs', 'audits')
const manualAuthors = new Set(['anna', 'rex', 'unknown'])
const laneFields = new Set([
  'lanes_forward', 'lanes_backward', 'turn_lanes', 'turn_lanes_backward',
])

const db = JSON.parse(readFileSync(join(root, 'public/data/road_database.json'), 'utf8'))
const journal = db.editor.journal as EnhancementRecord[]
const manual = journal.filter((record) => manualAuthors.has(record.author))
const parsed = parseImported(db.segments.map((record: unknown) => JSON.stringify(record)).join('\n'))
if (parsed.kind !== 'map') throw new Error('road_database.segments 無法解析成地圖')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const roads = prepared.roads.filter((road) => !road.properties.deleted)
const guidanceRaw = JSON.parse(readFileSync(
  join(root, 'public/data/lanepilot/lane-guidance.json'), 'utf8',
)) as LaneGuidanceRecord[]
const guidance = remapLaneGuidanceRecords(guidanceRaw, {
  existingWayIds: new Set(roads.map((road) => road.properties.osm_id)),
  nodeRemap: prepared.nodeRemap,
  wayRemap: prepared.wayRemap,
})
const guidanceIndex = buildLaneGuidanceIndex(guidance)
const folded = foldJournal(manual)

type Provenance = Pick<EnhancementRecord, 'author' | 'seq' | 'ts'> & { target: string }
const provenance = new Map<string, Map<string, Provenance>>()
for (const record of manual) {
  const key = record.target.key
  if (record.op === 'delete') {
    provenance.delete(key)
    continue
  }
  const current = provenance.get(key) ?? new Map<string, Provenance>()
  for (const field of Object.keys(record.fields ?? {})) {
    current.set(field, {
      author: record.author,
      seq: record.seq,
      ts: record.ts,
      target: key,
    })
  }
  provenance.set(key, current)
}

const normalizeRaw = (movements: string[] | undefined) =>
  movements?.map((movement) => String(movement ?? '').trim()).join('|') ?? ''
const movementSemantics = (value: unknown) => String(value ?? '')
  .split('|')
  .map((lane) => lane.split(/[;+]/).map((item) => item.trim()).filter(Boolean).sort().join('+'))
  .join('|')
const display = (value: unknown) => value === undefined || value === '' ? '—' : String(value)
const directionLabel = (direction: LaneDirection) => direction === 'forward' ? '正向' : '反向'
const csv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
const markdownCell = (value: unknown) => display(value).replaceAll('|', '\\|')

type AuditRow = {
  category: string
  categoryLabel: string
  roadName: string
  wayId: number
  blockNode: number
  direction: LaneDirection
  approachNode?: number
  longitude: number
  latitude: number
  googleMaps: string
  openStreetMap: string
  baseScope?: string
  baseLaneCount?: number
  baseTurnLanes?: string
  manualLaneCount?: number
  manualTurnLanes?: string
  laneSource?: Provenance
  turnSource?: Provenance
  note: string
}

const labels: Record<string, string> = {
  exact_same: '完全一致',
  partial_same: '已填欄位一致（另一欄未人工設定）',
  arrow_style_only: '允許方向相同，但箭頭表示法不同',
  turn_lanes_differ: '轉向內容不同',
  lane_count_differs: '車道數不同',
  lane_and_turn_differ: '車道數與轉向皆不同',
  no_base: 'LanePilot base 無對應資料',
}

const rows: AuditRow[] = []
const seen = new Set<string>()
for (const road of roads) {
  const directions: LaneDirection[] = road.properties.oneway === 'yes'
    ? ['forward'] : ['forward', 'backward']
  for (const direction of directions) {
    const identity = `${road.properties.osm_id}@${road.properties.blockNode}/${direction}`
    if (seen.has(identity)) continue
    seen.add(identity)

    const wayKey = `way/${road.properties.osm_id}`
    const blockKey = `${wayKey}@b/${road.properties.blockNode}`
    const wayFields = folded.get(wayKey) ?? {}
    const blockFields = folded.get(blockKey) ?? {}
    const effective = { ...wayFields, ...blockFields }
    const laneField = direction === 'forward' ? 'lanes_forward' : 'lanes_backward'
    const turnField = direction === 'forward' ? 'turn_lanes' : 'turn_lanes_backward'
    const hasLane = effective[laneField] !== undefined
    const hasTurn = effective[turnField] !== undefined
    if (!hasLane && !hasTurn) continue

    const approachNode = direction === 'forward'
      ? road.properties.nodes.at(-1) : road.properties.nodes[0]
    const approach = approachNode === undefined ? undefined
      : guidanceIndex.approachByKey.get(
        `${road.properties.osm_id}@${approachNode}/${direction}`,
      )
    const segment = guidanceIndex.segmentByKey.get(`${road.properties.osm_id}/${direction}`)
    const base = approach ?? segment
    const manualLaneCount = hasLane ? Number(effective[laneField]) : undefined
    const manualTurnLanes = hasTurn ? String(effective[turnField]) : undefined
    const baseTurnLanes = base ? normalizeRaw(base.laneMovements) : undefined
    const laneSame = !hasLane || manualLaneCount === base?.laneCount
    const turnRawSame = !hasTurn || manualTurnLanes === baseTurnLanes
    const turnSemanticSame = !hasTurn ||
      movementSemantics(manualTurnLanes) === movementSemantics(baseTurnLanes)

    let category = 'no_base'
    if (base) {
      if (laneSame && turnRawSame) category = hasLane && hasTurn ? 'exact_same' : 'partial_same'
      else if (laneSame && turnSemanticSame) category = 'arrow_style_only'
      else if (!laneSame && !turnSemanticSame) category = 'lane_and_turn_differ'
      else if (!laneSame) category = 'lane_count_differs'
      else category = 'turn_lanes_differ'
    }

    const coordinates = road.geometry.coordinates
    const point = direction === 'forward' ? coordinates.at(-1) : coordinates[0]
    const longitude = Number(point?.[0] ?? 0)
    const latitude = Number(point?.[1] ?? 0)
    const laneSourceKey = blockFields[laneField] !== undefined ? blockKey : wayKey
    const turnSourceKey = blockFields[turnField] !== undefined ? blockKey : wayKey
    const laneSource = hasLane ? provenance.get(laneSourceKey)?.get(laneField) : undefined
    const turnSource = hasTurn ? provenance.get(turnSourceKey)?.get(turnField) : undefined
    const note = category === 'exact_same'
      ? '移除此人工覆蓋後，僅就車道數與轉向而言，顯示結果仍相同。'
      : category === 'partial_same'
        ? '只有部分比較欄位由人工明確設定；另一欄仍需確認來源。'
        : category === 'arrow_style_only'
          ? '`+` 與 `;` 的允許方向相同，但目前繪圖語意不同，需看現地箭頭樣式。'
          : category === 'no_base'
            ? 'LanePilot 沒有可套用到此路段方向的 approach 或 segment 紀錄。'
            : '人工值會覆蓋 LanePilot；請依現地與標註資料判定應保留哪一方。'

    rows.push({
      category,
      categoryLabel: labels[category],
      roadName: road.properties.name || '未命名道路',
      wayId: road.properties.osm_id,
      blockNode: road.properties.blockNode,
      direction,
      approachNode,
      longitude,
      latitude,
      googleMaps: `https://www.google.com/maps/@${latitude},${longitude},20z`,
      openStreetMap: `https://www.openstreetmap.org/way/${road.properties.osm_id}`,
      baseScope: base?.scope,
      baseLaneCount: base?.laneCount,
      baseTurnLanes,
      manualLaneCount,
      manualTurnLanes,
      laneSource,
      turnSource,
      note,
    })
  }
}

const order = Object.keys(labels)
rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) ||
  a.roadName.localeCompare(b.roadName, 'zh-Hant') || a.wayId - b.wayId ||
  a.blockNode - b.blockNode || a.direction.localeCompare(b.direction))
const counts = Object.fromEntries(order.map((key) => [key, rows.filter((row) => row.category === key).length]))

const liveTargets = new Map<string, EnhancementRecord>()
for (const record of manual) {
  const key = `${record.target.type}:${record.target.key}`
  if (record.op === 'delete') liveTargets.delete(key)
  else liveTargets.set(key, record)
}
const liveRoadTargetsWithLaneFields = [...liveTargets.values()].filter((record) =>
  record.target.type === 'road' && Object.keys(record.fields ?? {}).some((field) => laneFields.has(field))).length

mkdirSync(outputDir, { recursive: true })
const csvColumns = [
  '分類', '道路名稱', 'way_id', 'block_node', '方向', 'approach_node', '緯度', '經度',
  'Google Maps', 'OpenStreetMap', 'LanePilot範圍', 'LanePilot車道數', 'LanePilot轉向',
  '人工車道數', '人工轉向', '車道來源作者', '車道來源seq', '車道來源target',
  '轉向來源作者', '轉向來源seq', '轉向來源target', '說明',
]
const csvLines = [csvColumns.map(csv).join(',')]
for (const row of rows) {
  csvLines.push([
    row.categoryLabel, row.roadName, row.wayId, row.blockNode, directionLabel(row.direction),
    row.approachNode, row.latitude, row.longitude, row.googleMaps, row.openStreetMap,
    row.baseScope, row.baseLaneCount, row.baseTurnLanes, row.manualLaneCount,
    row.manualTurnLanes, row.laneSource?.author, row.laneSource?.seq, row.laneSource?.target,
    row.turnSource?.author, row.turnSource?.seq, row.turnSource?.target, row.note,
  ].map(csv).join(','))
}
const csvPath = join(outputDir, 'manual-lane-journal-review.csv')
writeFileSync(csvPath, `\uFEFF${csvLines.join('\r\n')}\r\n`, 'utf8')

const markdown: string[] = [
  '# 人工車道 Journal 與 LanePilot Base 回查清單',
  '',
  `資料庫版本時間：${db.updated_at ?? '未提供'}`,
  '',
  '## 比較口徑',
  '',
  '- 人工來源：`anna`、`rex`、`unknown`。`claude` 只有 2 筆新道路幾何紀錄，沒有車道欄位，未納入。',
  '- 人工 journal 先依 target 依序 fold；同一 target 的後寫欄位覆蓋先寫欄位，區塊鍵 `way/W@b/N` 再覆蓋整條 way 鍵 `way/W`。',
  '- LanePilot base 使用執行期 HUD 的優先序：路口 approach 紀錄優先，沒有時才使用 segment-direction 紀錄。',
  '- `through+right` 與 `through;right` 不算完全一致：允許方向雖相同，但 LaneDev 目前以不同箭頭樣式繪製。',
  '- 本報告只比較車道數與車道轉向，不表示其他人工欄位（待轉區、標線、機車道等）可以刪除。',
  '',
  '## 數量漏斗',
  '',
  `- 人工 journal 原始紀錄：${manual.length} 筆（anna ${manual.filter((r) => r.author === 'anna').length}、rex ${manual.filter((r) => r.author === 'rex').length}、unknown ${manual.filter((r) => r.author === 'unknown').length}）`,
  `- fold 後仍存在的人工 targets：${liveTargets.size} 個`,
  `- 其中含車道數或轉向欄位的 road targets：${liveRoadTargetsWithLaneFields} 個`,
  `- 展開到目前路網的有效「路段區塊 × 行車方向」：${rows.length} 筆`,
  '',
  '## 分類總覽',
  '',
  '| 分類 | 筆數 | 人工回查重點 |',
  '|---|---:|---|',
  ...order.map((key) => `| ${labels[key]} | ${counts[key]} | ${key === 'exact_same' ? '車道欄位可視為冗餘候選，但不可直接刪除整筆人工 journal。' : key === 'arrow_style_only' ? '看現地究竟是組合箭頭或分開箭頭。' : key === 'no_base' ? '檢查標註是否缺漏或無法映射。' : '比較現地、LanePilot 標註與人工修改原因。'} |`),
  '',
  '## 詳細清單',
  '',
  '完整欄位與可排序內容請使用同目錄的 `manual-lane-journal-review.csv`。以下按分類列出所有位置。',
]

for (const key of order) {
  const categoryRows = rows.filter((row) => row.category === key)
  markdown.push('', `### ${labels[key]}（${categoryRows.length} 筆）`, '')
  if (categoryRows.length === 0) {
    markdown.push('無。')
    continue
  }
  markdown.push('| 道路／位置 | 方向 | LanePilot | 人工結果 | 人工來源 |')
  markdown.push('|---|---|---|---|---|')
  for (const row of categoryRows) {
    const source = row.turnSource ?? row.laneSource
    markdown.push(`| ${markdownCell(row.roadName)}<br>way/${row.wayId} @b/${row.blockNode}<br>[Google Maps](${row.googleMaps}) · [OSM](${row.openStreetMap}) | ${directionLabel(row.direction)} | ${markdownCell(row.baseLaneCount)} 道；${markdownCell(row.baseTurnLanes)}<br>${markdownCell(row.baseScope)} | ${markdownCell(row.manualLaneCount)} 道；${markdownCell(row.manualTurnLanes)} | ${source ? `${source.author} #${source.seq}` : '—'} |`)
  }
}

markdown.push(
  '',
  '## 使用提醒',
  '',
  '「完全一致」只代表比較的兩個車道欄位一致。因為人工編輯器過去可能把未修改欄位一併寫入，同一筆 target 內仍可能有待轉區、停止線、機車道與繪圖設定；若要清理冗餘資料，應做欄位級移除，不能直接刪除整筆 target。',
)
const markdownPath = join(outputDir, 'manual-lane-journal-review.md')
writeFileSync(markdownPath, `${markdown.join('\n')}\n`, 'utf8')

console.log(JSON.stringify({
  journal: {
    total: journal.length,
    manualRaw: manual.length,
    liveTargets: liveTargets.size,
    liveRoadTargetsWithLaneFields,
  },
  effectiveRoadDirections: rows.length,
  categories: counts,
  outputs: { markdownPath, csvPath },
}, null, 2))
