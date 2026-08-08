// 失效設定稽核（node scripts/run_offline.mjs scripts/dead_settings_audit.ts）
//
// 「面板按了、journal 也存了，地圖上卻沒東西」的全圖盤點。偏心道／機車停等格／
// 右轉附加車道三者共用同一組行向鍵 `way/W@node/N[~b]`，鍵是車道面板從
// stopLineEdges 的「第一條同向邊」推出來的——捏合過的區塊在路網圖上仍被舊接點
// 切成多條邊，第一條的終點常常是**接縫**（區塊內部節點），設定就寫進了黑洞。
//
// 判準不是猜測，是直接比對「journal 說要有」與「建置端實際產出」：
//   turn_bay   present≠0        vs buildTurnBays 的 key
//   right_lane present≠0        vs buildRightLanes 的 key
//   moto_box   lanes>0          vs buildMotoBoxes 的 key（coveredLanes>0）
//
//   --type=turn_bay|right_lane|moto_box  只看某一類
import { readFileSync } from 'node:fs'
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
import { buildTurnBays, buildRightLanes, buildMotoBoxes } from '../src/core/turnbays'
import { haversine } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const ONLY = arg('type', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const journal: EnhancementRecord[] = db.editor.journal
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(journal))
applyRoadMerges(roads, journal)
const graph = new RoadGraph(roads)
const merged = journalForMergedRoads(journal)
const bays = buildTurnBays(graph, merged)
const rightLanes = buildRightLanes(graph, merged)
const motoBoxes = buildMotoBoxes(graph, bays, rightLanes, merged)

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const lengthOf = (r: RoadFeature) => {
  const cs = r.geometry.coordinates as [number, number][]
  return cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
}

/** 後寫的贏、delete 移除——與各 builder 的 fold* 同規則 */
function fold(type: string) {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of merged) {
    if (rec.target.type !== type) continue
    if (rec.op === 'delete') out.delete(rec.target.key)
    else out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
  }
  return out
}

const live = roads.filter((r) => !r.properties.deleted)
/** node → 以它為端點的區塊／以它為內部節點的區塊（同一條 way 內） */
const endsOf = new Map<string, RoadFeature[]>()
const insideOf = new Map<string, RoadFeature[]>()
for (const r of live) {
  const ns = r.properties.nodes
  const push = (m: Map<string, RoadFeature[]>, k: string) => {
    const list = m.get(k) ?? []
    list.push(r)
    m.set(k, list)
  }
  push(endsOf, `${r.properties.osm_id}@${ns[0]}`)
  push(endsOf, `${r.properties.osm_id}@${ns[ns.length - 1]}`)
  for (const n of ns.slice(1, -1)) push(insideOf, `${r.properties.osm_id}@${n}`)
}

const parseKey = (k: string) => {
  const m = k.match(/^way\/(\d+)@node\/(-?\d+)(~b)?(~[rm])?$/)
  return m ? { wayId: Number(m[1]), nodeId: Number(m[2]), back: !!m[3] } : null
}

/** 這個鍵指到的節點在該 way 上是什麼身分：端點／區塊內部（接縫）／不存在 */
function classify(k: string) {
  const p = parseKey(k)
  if (!p) return { why: '鍵格式不明', blocks: [] as RoadFeature[] }
  const id = `${p.wayId}@${p.nodeId}`
  const ends = endsOf.get(id) ?? []
  const inside = insideOf.get(id) ?? []
  if (ends.length) return { why: '端點（鍵沒問題，卡在別的條件）', blocks: ends }
  if (inside.length) return { why: '★ 區塊內部節點（捏合接縫）——設定寫進黑洞', blocks: inside }
  return { why: '節點已不在活躍路網（區塊被刪或重建）', blocks: [] }
}

// 錨點層級的原因：鍵沒問題時，卡的多半是「錨點被捏合規則排除」或「長度不足」
const anchorMap = new Map(graph.bayAnchors(() => true)
  .map((a) => [`way/${a.wayId}@node/${a.nodeId}${a.back ? '~b' : ''}`, a]))
function anchorReason(k: string) {
  const base = k.replace(/~[rm]$/, '')
  const a = anchorMap.get(base)
  if (!a) return '      這個行向在路網圖上沒有偏心道錨點（端點不是路口，或行向不存在）'
  const cs = a.coords
  const total = cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)
  const end = total - a.setbackM
  const suppressed = a.road.properties.oneSideEntryNodes?.includes(a.nodeId)
    && graph.hasDistinctRoadAt(a.nodeId, a.road)
  const q = a.road.properties
  // 中央帶偏心道要有中央空間：makeBay 對「雙向且 centerM=0」直接回 null
  const noCenter = q.oneway === 'no' && !(q.centerM > 0)
  return `      錨點所在區塊 ${key(a.road)}｜centerM=${q.centerM ?? 0}`
    + `｜centerKind=${q.centerKind}｜islandBay=${!!q.islandBayMode}\n`
    + `      進入邊 ${total.toFixed(1)}m − 收邊 ${a.setbackM.toFixed(1)}m = 可用 ${end.toFixed(1)}m`
    + `｜hasLeftPair=${a.hasLeftPair}`
    + (noCenter ? '\n      ★ 中央帶寬 0——雙向道沒有偏心空間，左轉只能靠內側車道箭頭' : '')
    + (suppressed ? '\n      ★ 錨點在捏合接點上，依「主路視覺連續」規則不生成偏心道' : '')
    + (!suppressed && end < 11 ? '\n      ★ 可用長度低於短開口下限 11m' : '')
}

const groups: { type: string; on: [string, Record<string, string | number>][]; built: Set<string> }[] = [
  {
    type: 'turn_bay',
    on: [...fold('turn_bay')].filter(([, f]) => Number(f.present) !== 0),
    built: new Set(bays.map((b) => b.key)),
  },
  {
    type: 'right_lane',
    on: [...fold('right_lane')].filter(([, f]) => Number(f.present) !== 0),
    built: new Set(rightLanes.map((r) => r.key)),
  },
  {
    type: 'moto_box',
    on: [...fold('moto_box')].filter(([, f]) => Number(f.lanes) > 0),
    built: new Set(motoBoxes.boxes.filter((b) => b.coveredLanes > 0).map((b) => b.key)),
  },
]

let deadTotal = 0
for (const g of groups) {
  if (ONLY && g.type !== ONLY) continue
  const dead = g.on.filter(([k]) => !g.built.has(k))
  deadTotal += dead.length
  console.log(`\n── ${g.type}：開啟中 ${g.on.length} 筆，實際產出 ${g.built.size} 個`
    + `，失效 ${dead.length} 筆 ──`)
  for (const [k, f] of dead) {
    const c = classify(k)
    console.log(`   ${k}｜${JSON.stringify(f)}`)
    console.log(`      ${c.why}`)
    if (g.type !== 'moto_box') console.log(anchorReason(k))
    for (const b of c.blocks) {
      const q = b.properties
      const inScope = (!!q.coupletMerged && q.centerKind === 'hatch')
        || (q.centerKind === 'island' && !!q.islandBayMode)
      console.log(`      區塊 ${key(b)}｜${q.name ?? '未命名'}｜${lengthOf(b).toFixed(0)}m`
        + `｜couplet=${!!q.coupletMerged}｜centerM=${q.centerM ?? 0}`
        + `｜centerKind=${q.centerKind}｜islandBay=${!!q.islandBayMode}`
        + `｜${inScope ? 'scope ✅' : 'scope ❌ 偏心道不生成'}`)
    }
  }
}
console.log(`\n合計失效設定：${deadTotal} 筆`)
