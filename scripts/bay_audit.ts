// 偏心左轉道稽核（node scripts/run_offline.mjs scripts/bay_audit.ts --key=way/W@b/N）
//
// 「面板開了偏心道，儲存後卻沒東西」要一路追四關才知道卡在哪：
//   1. scope   ── buildTurnBays 只處理 couplet 合併且中央帶為槽化（或島+開口模式）的區塊
//   2. anchor  ── graph.bayAnchors 有沒有生出這個行向的錨點
//   3. wantBay ── journal 覆寫／左轉配對／中央帶寬 ≥3m
//   4. 長度    ── 兩端停止線之間放不放得下儲車段（MIN_DEFORM 14m）
// 這支把四關逐一印出來，並模擬「人工 present:1」看是否救得回來。
//
//   --key=way/W@b/N   受檢區塊（逐關診斷）
//   --all-blocks      連同該 way 的其他區塊一起列出（找鄰段對照用）
//   --merge=way/W@b/N 預演「把這個鄰段捏合進受檢區塊」後偏心道是否放得下（不寫檔）
//   --short-list      全圖列出短開口（儲車 <14m，只有人工開啟生得出來）
//   --orphan-list     全圖列出對不到錨點的 turn_bay 覆寫
//   --seam-scan       全圖列出「面板會把設定寫到捏合接縫」的區塊
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import {
  foldJournal, applyToRoads, applyRoadMerges, journalForMergedRoads,
  type EnhancementRecord,
} from '../src/core/enhancements'
import { RoadGraph } from '../src/core/graph'
import { buildTurnBays, stopLineEdges } from '../src/core/turnbays'
import { cumulative, haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const KEY = arg('key', '')
const ALL_BLOCKS = process.argv.includes('--all-blocks')
/** 全圖列出「短開口」（儲車段 < MIN_DEFORM 14m，只有人工開啟才生得出來） */
const SHORT_LIST = process.argv.includes('--short-list')
const ORPHAN_LIST = process.argv.includes('--orphan-list')
const SEAM_SCAN = process.argv.includes('--seam-scan')
if (!KEY && !SHORT_LIST && !ORPHAN_LIST && !SEAM_SCAN) {
  console.error('請給 --key=way/W@b/N、--short-list、--orphan-list 或 --seam-scan')
  process.exit(2)
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const journal: EnhancementRecord[] = db.editor.journal
// 與 mapCore 同序：applyToRoads → applyRoadMerges → RoadGraph → buildTurnBays
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)
const graph = new RoadGraph(roads)
const bays = buildTurnBays(graph, journalForMergedRoads(journal))

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const lengthOf = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}

// turnbays 的 foldBayOverrides 不對外開放，這裡照同樣規則折一份（後寫的贏、delete 移除）
const overrides = new Map<string, Record<string, string | number>>()
for (const rec of journalForMergedRoads(journal)) {
  if (rec.target.type !== 'turn_bay') continue
  if (rec.op === 'delete') overrides.delete(rec.target.key)
  else overrides.set(rec.target.key, { ...overrides.get(rec.target.key), ...rec.fields })
}

/** 全圖列出「寫在沒有錨點的節點上」的 turn_bay 紀錄（捏合接縫最常見） */
if (ORPHAN_LIST) {
  const anchorKeys = new Set(graph.bayAnchors(() => true)
    .map((a) => `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`))
  const orphans = [...overrides.entries()].filter(([k]) => !anchorKeys.has(k))
  const live = orphans.filter(([, f]) => Number(f.present) === 1)
  console.log(`turn_bay 覆寫 ${overrides.size} 筆，其中對不到錨點的 ${orphans.length} 筆`
    + `（present:1 的 ${live.length} 筆＝按了但永遠不會出現）：`)
  for (const [k, f] of live) console.log(`   ${k}｜${JSON.stringify(f)}`)
  if (!KEY) process.exit(0)
}

/** 全圖列出「面板會把設定寫到捏合接縫」的區塊（修正前的舊紀錄都在這裡失效） */
if (SEAM_SCAN) {
  const byRoad = new Map<RoadFeature, { fwd: number[]; bwd: number[] }>()
  for (const e of stopLineEdges(graph, () => true)) {
    const slot = byRoad.get(e.road) ?? { fwd: [], bwd: [] }
    ;(e.back ? slot.bwd : slot.fwd).push(e.toNode)
    byRoad.set(e.road, slot)
  }
  const hits: string[] = []
  for (const [r, slot] of byRoad) {
    if (r.properties.deleted) continue
    const ends = new Set([r.properties.nodes[0], r.properties.nodes[r.properties.nodes.length - 1]])
    const bad: string[] = []
    if (slot.fwd.length && !ends.has(slot.fwd[0])) bad.push(`順向→node/${slot.fwd[0]}`)
    if (slot.bwd.length && !ends.has(slot.bwd[0])) bad.push(`逆向→node/${slot.bwd[0]}`)
    if (bad.length) {
      hits.push(`   ${key(r)}｜${r.properties.name ?? '未命名'}`
        + `｜${lengthOf(r).toFixed(0)}m｜${bad.join('、')}`)
    }
  }
  console.log(`面板舊邏輯（取第一條同向邊）會寫到區塊內部節點的區塊：${hits.length} 個`)
  for (const h of hits) console.log(h)
  if (!KEY) process.exit(0)
}

if (SHORT_LIST) {
  const short = bays.filter((b) => b.bayLenM < 14)
  console.log(`全圖偏心道 ${bays.length} 條，其中短開口（儲車 <14m）${short.length} 條：`)
  for (const b of short) {
    console.log(`   ${b.key}｜儲車 ${b.bayLenM.toFixed(1)}m｜漸變 ${b.taperLenM.toFixed(1)}m`
      + `｜寬 ${b.widthM}m｜${b.turns}｜source=${b.source}`)
  }
  if (!KEY) process.exit(0)
}

const road = roads.find((r) => key(r) === KEY)
if (!road) { console.error(`找不到區塊 ${KEY}`); process.exit(1) }
const p = road.properties

if (ALL_BLOCKS) {
  console.log(`── way/${p.osm_id} 的所有區塊 ──`)
  for (const r of roads.filter((x) => x.properties.osm_id === p.osm_id)) {
    const q = r.properties
    console.log(`  ${key(r) === KEY ? '▶' : ' '} ${key(r)}｜${lengthOf(r).toFixed(0)}m`
      + `｜couplet=${!!q.coupletMerged}｜centerM=${q.centerM ?? 0}｜centerKind=${q.centerKind}`
      + `｜oneway=${q.oneway}${q.deleted ? '｜[已刪除]' : ''}`)
  }
  console.log('')
}

console.log(`受檢 ${KEY}｜${p.name ?? '未命名'}｜${lengthOf(road).toFixed(1)}m`)
console.log(`  highway=${p.highway}｜oneway=${p.oneway}｜車道 ${p.lanesForward}+${p.lanesBackward}`)
console.log(`  coupletMerged=${!!p.coupletMerged}｜centerM=${p.centerM ?? 0}`
  + `｜centerKind=${p.centerKind}｜islandBayMode=${!!p.islandBayMode}`)
console.log(`  兩端 node：${p.nodes[0]} … ${p.nodes[p.nodes.length - 1]}`
  + `${p.deleted ? '｜[已刪除]' : ''}`)

// ── 1. scope ──
const inScope = (!!p.coupletMerged && p.centerKind === 'hatch')
  || (p.centerKind === 'island' && !!p.islandBayMode)
console.log(`\n1. scope：${inScope ? '✅ 在生成範圍內' : '❌ 不在生成範圍內'}`)
if (!inScope) {
  console.log('   buildTurnBays 只處理「couplet 合併 + 中央帶為槽化」或「實體島 + 路口開口模式」的區塊。')
  console.log('   面板的中央帶欄位對 centerM>0 就會開放，但沒有 coupletMerged 的話'
    + '偏心道永遠不會生成——journal 寫得進去，畫面不會有東西。')
}

// ── 2. anchors ──
const anchors = graph.bayAnchors(() => true)
  .filter((a) => a.wayId === p.osm_id && p.nodes.includes(a.nodeId))
console.log(`\n2. anchor：這個區塊兩端共 ${anchors.length} 個錨點`)
console.log('   （錨點鍵是 way+node，同一條 way 的相鄰區塊共用端點時會落在別的區塊上）')
for (const a of anchors) {
  const anchorKey = `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`
  const cum = cumulative(a.coords)
  const total = cum[cum.length - 1]
  const end = total - a.setbackM
  const o = overrides.get(anchorKey)
  const forcedHere = !!o && Number(o.present) === 1
  const need = 14 + (forcedHere ? 4 : 8)
  console.log(`   ${a.back ? '逆向' : '順向'} → ${anchorKey}`)
  console.log(`      所在區塊 ${key(a.road)}｜進入邊 ${total.toFixed(1)}m`
    + ` − 收邊 ${a.setbackM.toFixed(1)}m = 可用 ${end.toFixed(1)}m`)
  console.log(`      hasLeftPair=${a.hasLeftPair}`
    + `｜journal=${o ? JSON.stringify(o) : '無'}`
    + `｜門檻 ${need}m → ${end >= need ? '✅ 過' : '❌ 太短，makeBay 直接回 null'}`)
}
if (anchors.length === 0) {
  console.log('   兩端都沒有錨點：這個行向在路網圖上沒有可左轉的路口'
    + '（端點是死路、或接點被捏合改名）。')
}

// 面板會寫到哪個鍵：LaneEditPanel 用 stopLineEdges 的首個順/逆向邊決定 nodeLast/nodeFirst。
// 捏合過的區塊在路網圖上會被舊接點切成多條邊，「首個」不一定是真正的區塊端點。
const panelEdges = stopLineEdges(graph, (candidate) => candidate === road)
const panelForward = panelEdges.find((e) => !e.back)
const panelBackward = panelEdges.find((e) => e.back)
const ends = new Set([p.nodes[0], p.nodes[p.nodes.length - 1]])
const nodeLast = panelForward?.toNode ?? p.nodes[p.nodes.length - 1] ?? 0
const nodeFirst = panelBackward?.toNode ?? p.nodes[0] ?? 0
console.log(`\n面板寫入鍵（車道面板的「偏心道轉向」）：`)
console.log(`   這個區塊在圖上有 ${panelEdges.length} 條邊`
  + `（順向 ${panelEdges.filter((e) => !e.back).length}／逆向 ${panelEdges.filter((e) => e.back).length}）`)
for (const e of panelEdges) {
  console.log(`      ${e.back ? '逆向' : '順向'} ${e.fromNode} → ${e.toNode}`
    + `${ends.has(e.toNode) ? '（區塊端點）' : '（★ 區塊內部節點——捏合接縫）'}`)
}
console.log(`   順向 → way/${p.osm_id}@node/${nodeLast}`
  + `${ends.has(nodeLast) ? ' ✅' : ' ❌ 不是區塊端點，這筆紀錄永遠對不到錨點'}`)
console.log(`   逆向 → way/${p.osm_id}@node/${nodeFirst}~b`
  + `${ends.has(nodeFirst) ? ' ✅' : ' ❌ 不是區塊端點，這筆紀錄永遠對不到錨點'}`)

// buildTurnBays 的配對迴圈：以順向邊為單位，fa/ba 都要時 paired=true，
// 兩向要共用同一條邊的長度——短開口在 paired 下只能各用一半。
const anchorAt = (k: string) => graph.bayAnchors(() => true)
  .find((a) => `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}` === k)
const wantBayOf = (k: string) => {
  const a = anchorAt(k)
  if (!a) return false
  // 捏合接點：主路必須視覺連續，該節點只保留導航的單側入口語意，不生成偏心道
  if (a.road.properties.oneSideEntryNodes?.includes(a.nodeId)
    && graph.hasDistinctRoadAt(a.nodeId, a.road)) return false
  const o = overrides.get(k)
  if (o) return Number(o.present) !== 0
  return a.hasLeftPair && (p.oneway !== 'no' || (p.centerM ?? 0) >= 3)
}
console.log('\n配對迴圈（buildTurnBays 以順向邊為單位）：')
for (const e of graph.scopeEdges(() => true).filter((x) => x.road === road && !x.back)) {
  const faKey = `way/${p.osm_id}@node/${e.toNode}`
  const baKey = `way/${p.osm_id}@node/${e.fromNode}~b`
  const fa = wantBayOf(faKey)
  const ba = wantBayOf(baKey)
  const n = (fa ? 1 : 0) + (ba ? 1 : 0)
  console.log(`   邊 ${e.fromNode} → ${e.toNode}`)
  console.log(`      fa ${faKey}｜want=${fa}${anchorAt(faKey) ? '' : '（無錨點）'}`)
  console.log(`      ba ${baKey}｜want=${ba}${anchorAt(baKey) ? '' : '（無錨點）'}`)
  console.log(`      n=${n}${n === 2 ? '｜paired=true（兩向共用長度，各只能用一半）' : ''}`)
}

// 端點路口組成：區塊為什麼這麼短，看鄰接的是什麼路就知道
const seamNodes = [...new Set(panelEdges.map((e) => e.toNode))].filter((n) => !ends.has(n))
for (const nodeId of [p.nodes[0], p.nodes[p.nodes.length - 1], ...seamNodes]) {
  const others = roads.filter((r) => !r.properties.deleted && r !== road
    && r.properties.nodes.includes(nodeId))
  console.log(`\n   node/${nodeId} 接了 ${others.length} 條：`)
  for (const r of others) {
    console.log(`      ${key(r)}｜${r.properties.name ?? '未命名'}`
      + `｜${lengthOf(r).toFixed(0)}m｜${r.properties.highway}`)
  }
}

// ── 3+4. 長度 ──
const edges = graph.scopeEdges(() => true).filter((e) => e.road === road && !e.back)
for (const e of edges) {
  const cum = cumulative(e.coords)
  const total = cum[cum.length - 1]
  const usable = total - e.startSetbackM - e.endSetbackM
  console.log(`\n3. 可用長度：中心線 ${total.toFixed(1)}m`
    + ` − 兩端收邊 ${e.startSetbackM.toFixed(1)}/${e.endSetbackM.toFixed(1)}m`
    + ` = ${usable.toFixed(1)}m`)
  for (const n of [1, 2]) {
    // buildTurnBays 的自適應鏈：先縮槽化、再縮漸變、最後整段不留槽化
    let taper = 15
    let hatch = n === 2 ? 20 : 16
    let bayLen = (usable - n * taper - hatch) / n
    if (bayLen < 30) { hatch = 8; bayLen = (usable - n * taper - hatch) / n }
    if (bayLen < 30) { taper = 10; bayLen = (usable - n * taper - hatch) / n }
    if (bayLen < 30) { hatch = 0; bayLen = (usable - n * taper) / n }
    const ok = bayLen >= 14
    console.log(`   ${n} 向偏心道：儲車段 ${bayLen.toFixed(1)}m`
      + `（漸變 ${taper}m、槽化 ${hatch}m）→ ${ok ? '✅ 放得下' : '❌ 低於 MIN_DEFORM 14m'}`)
  }
}
if (edges.length === 0) console.log('\n3. 可用長度：這個區塊沒有順向邊（單行或已被捏合為次段）')

// ── 實際產出 ──
const mine = bays.filter((b) => b.wayId === p.osm_id
  && (b.nodeId === p.nodes[0] || b.nodeId === p.nodes[p.nodes.length - 1]))
console.log(`\n4. 實際產出：${mine.length} 條偏心道`)
for (const b of mine) {
  console.log(`   ${b.key}｜kind=${b.kind}｜儲車 ${b.bayLenM.toFixed(1)}m`
    + `｜漸變 ${b.taperLenM.toFixed(1)}m｜寬 ${b.widthM}m｜轉向 ${b.turns}`
    + `｜paired=${b.paired}｜d0=${b.d0M.toFixed(1)}m｜儲車起點 ${b.bayStartM.toFixed(1)}m｜終點 ${b.endM.toFixed(1)}m`)
}

// ── 模擬人工 present:1（面板按下去等於寫這筆）：兩向都開會拿到什麼 ──
{
  const forced: EnhancementRecord[] = [...journal]
  for (const a of anchors) {
    forced.push({
      seq: forced.length + 1, ts: new Date().toISOString(), author: 'bay_audit',
      op: 'set',
      target: { type: 'turn_bay', key: `way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}` },
      fields: { present: 1, turns: 'left' },
    } as EnhancementRecord)
  }
  const after = buildTurnBays(graph, journalForMergedRoads(forced))
    .filter((b) => b.wayId === p.osm_id
      && (b.nodeId === p.nodes[0] || b.nodeId === p.nodes[p.nodes.length - 1]))
  console.log(`\n5. 模擬面板開啟（present:1）：${after.length} 條`
    + `${after.length ? '——面板應該有效，若畫面沒有請檢查儲存/重載' : '——面板按了也不會有東西'}`)
  for (const b of after) {
    console.log(`   ${b.key}｜儲車 ${b.bayLenM.toFixed(1)}m｜漸變 ${b.taperLenM.toFixed(1)}m`)
  }
}

// ── 預演捏合：把鄰段併進來後進入邊會變長，短區塊常常就過門檻了 ──
const MERGE = arg('merge', '')
if (MERGE) {
  const other = roads.find((r) => key(r) === MERGE)
  if (!other) { console.error(`\n找不到要捏合的鄰段 ${MERGE}`); process.exit(1) }
  const merged: EnhancementRecord[] = [...journal, {
    seq: journal.length + 1, ts: new Date().toISOString(), author: 'bay_audit',
    op: 'set',
    target: { type: 'road_merge', key: `merge/${KEY}+${MERGE}` },
    fields: {
      primary: KEY, secondary: MERGE,
      secondary_nodes: JSON.stringify(other.properties.nodes),
    },
  } as EnhancementRecord]
  const { roads: roads2 } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads2, foldJournal(merged))
  const applied = applyRoadMerges(roads2, merged)
  const graph2 = new RoadGraph(roads2)
  const bays2 = buildTurnBays(graph2, journalForMergedRoads(merged))
    .filter((b) => b.wayId === p.osm_id)
  const kept = roads2.find((r) => key(r) === KEY)
  console.log(`\n── 預演捏合 ${KEY} + ${MERGE}（applyRoadMerges 生效 ${applied} 筆）──`)
  console.log(`   保留段長度：${kept ? lengthOf(kept).toFixed(1) : '?'}m`)
  console.log(`   way/${p.osm_id} 上的偏心道：${bays2.length} 條`)
  for (const b of bays2) {
    console.log(`   ${b.key}｜儲車 ${b.bayLenM.toFixed(1)}m｜漸變 ${b.taperLenM.toFixed(1)}m`
      + `｜寬 ${b.widthM}m｜${b.turns}`)
  }
}

// ── 寫入偏心道覆寫（等同面板按下該方向）：不給 --out 只預演 ──
const SET_BAY = arg('set-bay', '')
if (SET_BAY) {
  const turns = arg('turns', 'left')
  const OUT = arg('out', '')
  const record = {
    seq: journal.length + 1, ts: new Date().toISOString(), author: arg('author', 'anna'),
    op: 'set' as const,
    target: { type: 'turn_bay', key: SET_BAY },
    fields: { present: 1, turns },
  }
  const next = [...journal, record as EnhancementRecord]
  const { roads: roads3 } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads3, foldJournal(next))
  applyRoadMerges(roads3, next)
  const graph3 = new RoadGraph(roads3)
  const after = buildTurnBays(graph3, journalForMergedRoads(next))
    .filter((b) => b.wayId === p.osm_id && p.nodes.includes(b.nodeId))
  console.log(`\n── 寫入 ${SET_BAY}｜present:1 turns:${turns} ──`)
  console.log(`   套用後這個區塊的偏心道：${after.length} 條`)
  for (const b of after) {
    console.log(`   ${b.key}｜${b.back ? '逆向' : '順向'}｜儲車 ${b.bayLenM.toFixed(1)}m`
      + `｜漸變 ${b.taperLenM.toFixed(1)}m｜paired=${b.paired}`
      + `｜漸變起點 d0=${b.d0M.toFixed(1)}m｜儲車起點 ${b.bayStartM.toFixed(1)}m`
      + `｜終點 ${b.endM.toFixed(1)}m`)
  }
  if (!OUT) {
    console.log('   （預演，未寫檔。加 --out=<路徑> 才會寫入）')
  } else {
    db.editor.journal = next.map((r: { seq: number }, i: number) => ({ ...r, seq: i + 1 }))
    db.editor.updated_at = new Date().toISOString()
    db.updated_at = db.editor.updated_at
    writeFileSync(OUT, `${JSON.stringify(db)}\n`, 'utf8')
    console.log(`   已寫入 ${OUT}`)
  }
}

// 目前 journal 上跟這個區塊有關的 turn_bay 紀錄
const related = journal.filter((r) => r.target?.type === 'turn_bay'
  && String(r.target.key).startsWith(`way/${p.osm_id}@node/`))
console.log(`\njournal 上的 turn_bay 紀錄（way/${p.osm_id}）：${related.length} 筆`)
for (const r of related.slice(-8)) {
  console.log(`   ${r.target.key}｜${JSON.stringify(r.fields)}`)
}
