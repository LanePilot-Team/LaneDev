// 離線 harness（npx tsx scripts/import_audit.ts）：
// 用與 app 相同的 core/pipeline.prepareBaseRoads 建底圖，重現 importFlow 的
// LanePilot 標註匯入，列出「略過」的標註（movement_key = 檔名）與對應路名。
// 用途：couplet 合併/匯入邏輯改動後的回歸驗證＋給組員的標註檢誤清單。
// 註：這裡載入楠梓＋橋頭兩份 shard（app 預設暫時只載楠梓）。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, mergeMaps, type AnnotationRecord } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph, type TurnOption } from '../src/core/graph'
import { angleDelta, bearing as geoBearing, haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data/lanepilot')
const ANN_DIR = join(HERE, '../../../LanePilot/annotations')

// ── 底圖管線（同 mapCore / importFlow）──
const shards = ['area_4212599.segments.jsonl', 'area_4212683.segments.jsonl']
  .map((f) => parseImported(readFileSync(join(DATA, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: any }[]
const fc = mergeMaps(shards).fc
const { roads, nodeRemap, wayRemap } = prepareBaseRoads(roadsFromGeoJSON(fc))
const graph = new RoadGraph(roads)
const interPos = new Map(graph.intersections().map((i) => [i.id, i.pos]))
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

const byId = new Map<number, RoadFeature[]>()
for (const r of roads) {
  const id = r.properties.osm_id
  if (!byId.has(id)) byId.set(id, [])
  byId.get(id)!.push(r)
}
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

type Dir = 'forward' | 'backward'
const flipDir = (d: Dir): Dir => (d === 'forward' ? 'backward' : 'forward')

function approachBearingAt(
  blocks: RoadFeature[], nodeId: number, dir: Dir, normalized = false,
): number | null {
  for (const road of blocks) {
    const nodes = road.properties.nodes
    const i = nodes.indexOf(nodeId)
    if (i < 0) continue
    const eff = !normalized && road.properties.reversed ? flipDir(dir) : dir
    const cs = road.geometry.coordinates as [number, number][]
    if (eff === 'forward') {
      if (i > 0) return geoBearing(cs[i - 1], cs[i])
    } else if (i < cs.length - 1) {
      return geoBearing(cs[i + 1], cs[i])
    }
  }
  return null
}

// ── 標註匯入（同 importFlow.importAnnotations 的略過判定）──
const files = readdirSync(ANN_DIR).filter((f) => f.endsWith('.json'))
console.log(`標註檔：${files.length}`)
const zones: { intersectionId: number; fromBearing: number }[] = []
let zonesAdded = 0
let laneApplied = 0
let laneRemapped = 0
const skips: string[] = []
const laneSkips: string[] = []

for (const file of files) {
  let recs: AnnotationRecord[]
  try {
    const parsed = parseImported(readFileSync(join(ANN_DIR, file), 'utf8'))
    if (parsed.kind !== 'annotations') continue
    recs = parsed.records
  } catch (e) { skips.push(`${file}: 解析失敗 ${e}`); continue }
  for (const rec of recs) {
    const segId = Number(rec.segmentKey.split('/')[1])
    if (rec.laneProfiles.length) {
      if (byId.has(segId)) laneApplied++
      else if (wayRemap.has(segId)) { laneRemapped++ }
      else laneSkips.push(`${file}: 車道覆寫略過（${rec.segmentKey} ${wayName.get(segId) ?? '?'} 不在底圖）`)
    }
    for (const rule of rec.movementRules) {
      if (rule.movement !== 'left') continue
      const want = rule.motorcycle_turn_rule === 'two_stage_required'
        || rule.motorcycle_turn_rule === 'two_stage_optional'
        || rule.waiting_zone_exists === 'yes'
      if (!want) continue
      const rawNode = Number((rule.applies_to_intersection_key ?? '').split('/')[1])
      const segName = wayName.get(segId) ?? '?'
      if (!rawNode) { skips.push(`${file}: 缺路口鍵（${rec.segmentKey} ${segName}）`); continue }
      let nodeId = nodeRemap.get(rawNode) ?? rawNode
      const appId = Number((rule.approach_segment_key ?? rec.segmentKey).split('/')[1])
      let blocks = byId.get(appId)
      let dir: Dir = rule.approach_direction === 'backward' ? 'backward' : 'forward'
      let normalized = false
      if (!blocks) {
        const dropped = wayRemap.get(appId)
        if (dropped) {
          blocks = dropped.keepIds.flatMap((id) => byId.get(id) ?? [])
          dir = dropped.dropReversed ? dir : flipDir(dir)
          normalized = true
        }
      }
      const evaluate = (nid: number): { opt: TurnOption; err: number; appBrg: number | null } | null => {
        const options = graph.leftTurnOptions(nid) ?? []
        if (!options.length) return null
        const appBrg = blocks?.length ? approachBearingAt(blocks, nid, dir, normalized) : null
        if (appBrg === null) return options.length === 1 ? { opt: options[0], err: 0, appBrg } : null
        let best = Infinity
        let opt = options[0]
        for (const o of options) {
          const d = Math.abs(angleDelta(o.fromBearing, appBrg))
          if (d < best) { best = d; opt = o }
        }
        return { opt, err: best, appBrg }
      }
      let m = evaluate(nodeId)
      if ((!m || m.err > 60) && blocks?.length) {
        const p0 = interPos.get(nodeId)
        if (p0) {
          const seen = new Set<number>([nodeId])
          for (const b of blocks) {
            for (const n of b.properties.nodes) {
              if (seen.has(n)) continue
              seen.add(n)
              const p = interPos.get(n)
              if (!p || haversine(p0, p) > 40) continue
              const mm = evaluate(n)
              if (mm && mm.err <= 60) { m = mm; nodeId = n; break }
            }
            if (m && m.err <= 60) break
          }
        }
      }
      const inter = namesAtNode(nodeId).join(' × ')
      if (!m) {
        skips.push(`${file}: 路口無左轉配對（${rec.segmentKey} ${segName}｜node/${nodeId} @ ${inter || '不在底圖'}）`)
        continue
      }
      if (m.err > 60) {
        skips.push(`${file}: 進入方向對不上（${rec.segmentKey} ${segName}｜node/${nodeId} @ ${inter}｜標註方向=${rule.approach_direction ?? 'forward'} 方位角 ${m.appBrg?.toFixed(0) ?? '?'}°，最佳選項差 ${m.err.toFixed(0)}°）`)
        continue
      }
      const opt = m.opt
      if (zones.some((z) => z.intersectionId === nodeId && Math.abs(angleDelta(z.fromBearing, opt.fromBearing)) < 30)) continue
      zones.push({ intersectionId: nodeId, fromBearing: opt.fromBearing })
      zonesAdded++
    }
  }
}
console.log(`\n待轉區 +${zonesAdded}，略過 ${skips.length}：`)
for (const s of skips) console.log('  ' + s)
console.log(`\n車道覆寫：直接命中 ${laneApplied}、經 wayRemap 轉掛 ${laneRemapped}、略過 ${laneSkips.length}：`)
for (const s of laneSkips) console.log('  ' + s)
