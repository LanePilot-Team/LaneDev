// 離線 harness（npx tsx scripts/import_audit.ts [annotations.jsonl]）：
// 用與 app 相同的 core/pipeline.prepareBaseRoads 建底圖，重現 LanePilot 標註匯入
//（待轉區部分直接呼叫 app 同一份 core/zoneimport.zonesFromAnnotations——
// 審計工具不能另寫一套邏輯），列出「略過」的標註與對應路名。
// 用途：couplet 合併/匯入邏輯改動後的回歸驗證＋給組員的標註檢誤清單。
// 引數可指定合併版 annotations.jsonl（lane-annotator-online exports/）；
// 沒給就退回舊佇列目錄（一筆一檔）。SHARDS=nanzi 只載楠梓（重現 app 預設）。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, mergeMaps, type AnnotationRecord } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph } from '../src/core/graph'
import { buildRawWays, zonesFromAnnotations } from '../src/core/zoneimport'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data/lanepilot')
const ANN_DIR = join(HERE, '../../../LanePilot/annotations')

// ── 底圖管線（同 mapCore / importFlow）──
const shardFiles = process.env.SHARDS === 'nanzi'
  ? ['area_4212599.segments.jsonl']
  : ['area_4212599.segments.jsonl', 'area_4212683.segments.jsonl']
const shards = shardFiles
  .map((f) => parseImported(readFileSync(join(DATA, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: any }[]
const fc = mergeMaps(shards).fc
const roadsRaw = roadsFromGeoJSON(fc)
const rawWays = buildRawWays(roadsRaw) // 前處理會變動幾何，先留原始快照（同 mapCore）
const { roads, nodeRemap, wayRemap } = prepareBaseRoads(roadsRaw)
const graph = new RoadGraph(roads)
console.log(`底圖：${roads.length} 區塊, nodeRemap ${nodeRemap.size}, wayRemap ${wayRemap.size}`)

// couplet 合併結果總覽（目標路名的區塊數與單/雙向分佈）
const mergedNames = new Set<string>()
for (const r of roads) if (r.properties.coupletMerged) mergedNames.add(r.properties.name ?? '?')
console.log(`已合併路名（${mergedNames.size}）: ${[...mergedNames].sort().join('、')}`)
for (const nm of ['後昌路', '外環西路', '後昌新路', '藍昌路', '加昌路', '左楠路', '楠海路', '德民路', '中央路']) {
  const rs = roads.filter((r) => r.properties.name === nm)
  const two = rs.filter((r) => r.properties.oneway === 'no').length
  console.log(`  ${nm}: ${rs.length} 區塊（雙向 ${two}／單行 ${rs.length - two}）`)
}
// 落單保護回歸：獨立支段不能被合併吃掉、要維持單行
for (const [id, nm] of [[25724902, '加昌路南支'], [230216186, '加昌路支'], [24465741, '藍昌路南段']] as const) {
  const rs = roads.filter((r) => r.properties.osm_id === id)
  const ow = rs.length ? rs.every((r) => r.properties.oneway === 'yes') : false
  console.log(`  way/${id} ${nm}: ${rs.length ? `存在 ${rs.length} 區塊, 全單行=${ow}` : '❌ 消失'}`)
}

const byId = new Set(roads.map((r) => r.properties.osm_id))
const namesAtNode = (nodeId: number): string[] => {
  const s = new Set<string>()
  for (const r of roads) if (r.properties.nodes.includes(nodeId)) s.add(r.properties.name ?? '(無名)')
  return [...s]
}
const wayName = new Map<number, string>()
for (const f of fc.features) {
  const p = f.properties as Record<string, unknown>
  wayName.set(Number(p.osm_id), String(p.name ?? '(無名)'))
}

// ── 標註來源：合併版 jsonl（引數）或舊佇列目錄（一筆一檔）──
const argFile = process.argv[2]
const sources: { name: string; text: string }[] = argFile
  ? [{ name: argFile, text: readFileSync(argFile, 'utf8') }]
  : readdirSync(ANN_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, text: readFileSync(join(ANN_DIR, f), 'utf8') }))
const records: AnnotationRecord[] = []
for (const { name, text } of sources) {
  try {
    const parsed = parseImported(text)
    if (parsed.kind === 'annotations') records.push(...parsed.records)
  } catch (e) { console.log(`  ${name}: 解析失敗 ${e}`) }
}
console.log(`標註來源：${argFile ?? ANN_DIR}（${records.length} 筆）`)

// ── 車道覆寫命中率（importFlow 第 1 段的略過判定）──
let laneApplied = 0
let laneRemapped = 0
const laneSkips: string[] = []
for (const rec of records) {
  if (!rec.laneProfiles.length) continue
  const segId = Number(rec.segmentKey.split('/')[1])
  if (byId.has(segId)) laneApplied++
  else if (wayRemap.has(segId)) laneRemapped++
  else laneSkips.push(`${rec.segmentKey}: 車道覆寫略過（${wayName.get(segId) ?? '?'} 不在底圖）`)
}

// ── 待轉區（app 同一份核心）──
const { zones, skips } = zonesFromAnnotations({
  records, graph, roads, nodeRemap, wayRemap, rawWays,
})
const label = { node: '缺路口鍵', noLeft: '路口無左轉配對', dir: '進入方向對不上' }
console.log(`\n待轉區 +${zones.length}，略過 ${skips.length}：`)
for (const s of skips) {
  const segName = wayName.get(Number(s.segmentKey.split('/')[1])) ?? '?'
  const inter = s.nodeId ? namesAtNode(s.nodeId).join(' × ') : ''
  console.log(`  ${s.key}: ${label[s.reason]}（${segName}`
    + `${s.nodeId ? `｜node/${s.nodeId} @ ${inter || '不在底圖'}` : ''}`
    + `${s.detail ? `｜${s.detail}` : ''}）`)
}
console.log(`\n車道覆寫：直接命中 ${laneApplied}、經 wayRemap 轉掛 ${laneRemapped}、略過 ${laneSkips.length}：`)
for (const s of laneSkips) console.log('  ' + s)
