// 路段捏合驗證（node scripts/run_offline.mjs scripts/merge_audit.ts）
//
// 驗證「兩個路口到路口區塊是否真的變成同一段」。走與 app 完全相同的管線
// （靜態資料庫 → parseImported → roadsFromGeoJSON → prepareBaseRoads → journal），
// 所以結論等同編輯模式看到的東西：
//   - 編輯器以 (osm_id, blockNode) 定位點選到的區塊（useEditor.handleEditClick），
//     「只找得到一段」＝ from～to 之間只存在一個區塊
//   - RoadGraph 用同一份 nodes 陣列建邊，接點不再是路口 ＝ 導航拓樸也合而為一
//
// 判準用「兩端的真實 OSM 節點」而不是區塊鍵：捏合會把中間接點換成新的合成負 id，
// 只比對舊鍵會把「切點只是換了個 id」誤判成合併成功。
//
// 參數：
//   --db=<path>   預設 public/data/road_database.json
//   --way=<id>    受檢道路 way id（預設 23976945 加昌路）
//   --from=<node> 合併後路段的起點節點（預設 2417585497）
//   --to=<node>   合併後路段的終點節點（預設 1401138223）
//   --simulate=api      不動檔案，記憶體內套用 vite /api/.../merge 的
//                       ignore_internal_junction 行為後再驗證（改動前預演）
//   --simulate=detach   api 的行為 ＋ 解除其他 way 對接點的共用。
//                       couplet 合併會依座標把側街節點重新嫁接到保留線最近的
//                       頂點上，因此只改保留線自己的節點 id 會被原樣接回去。
//   --simulate=release  只解除其他 way 對接點的共用，完全不動受檢道路自己的
//                       節點（達成同樣結果的最小改動，也最容易還原）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import { RoadGraph } from '../src/core/graph'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const WAY = Number(arg('way', '23976945'))
const FROM = Number(arg('from', '2417585497'))
const TO = Number(arg('to', '1401138223'))
const SIMULATE = arg('simulate', '')

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

interface Segment {
  object_identity?: {
    nav_segment_key?: string
    split_index?: number
    source_osm?: { osm_id?: number }
  }
  node_refs?: number[]
}
interface Database { segments: Segment[]; editor?: { journal?: EnhancementRecord[] } }

const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const ends = (r: RoadFeature): [number, number] => {
  const ns = r.properties.nodes
  return [ns[0], ns[ns.length - 1]]
}

/** 跑一次 app 底圖管線，回傳活躍區塊與 couplet 造成的節點重映射 */
function prepare(db: Database) {
  const parsed = parseImported(db.segments.map((r) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
  const { roads, nodeRemap } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  const journal = db.editor?.journal ?? []
  applyToRoads(roads, foldJournal(journal))
  return { roads, active: roads.filter((r) => !r.properties.deleted), nodeRemap, journal }
}

/** from → to 之間最少要經過哪幾個區塊（依端點相接做 BFS，與節點 id 是否被
 * 改名無關）。回傳 null 代表兩端在該 way 上根本不連通。 */
function chainBetween(blocks: RoadFeature[], from: number, to: number): RoadFeature[] | null {
  const queue: { node: number; path: RoadFeature[] }[] = [{ node: from, path: [] }]
  const seen = new Set<number>([from])
  while (queue.length) {
    const { node, path } = queue.shift()!
    if (node === to) return path
    for (const b of blocks) {
      if (path.includes(b)) continue
      const [a, z] = ends(b)
      if (a !== node && z !== node) continue
      const next = a === node ? z : a
      if (seen.has(next)) continue
      seen.add(next)
      queue.push({ node: next, path: [...path, b] })
    }
  }
  return null
}

const db: Database = JSON.parse(readFileSync(DB_PATH, 'utf8'))
console.log(`資料庫：${DB_PATH}`)
console.log(`受檢路段：way/${WAY} 由節點 ${FROM} 到 ${TO}` +
  (SIMULATE ? `｜模擬模式 ${SIMULATE}` : ''))

// ---- 模擬：記憶體內重現 vite 捏合 API 的靜態資料改寫 ------------------------
if (SIMULATE) {
  // 先跑一次管線，找出這段中間目前有哪些「切點」——那才是要忽略的接點
  const before = prepare(db)
  const chain = chainBetween(
    before.active.filter((r) => r.properties.osm_id === WAY), FROM, TO)
  if (!chain) throw new Error('模擬前就找不到 from→to 的區塊鏈')
  const joins: number[] = []
  for (let i = 1; i < chain.length; i++) {
    const [a, z] = ends(chain[i])
    const prev = ends(chain[i - 1])
    joins.push(prev.includes(a) ? a : z)
  }
  console.log(`模擬：目前 ${chain.length} 段，接點 ${joins.join('、') || '無'}`)

  const carrier = db.segments.find((s) =>
    Number(s.object_identity?.source_osm?.osm_id) === WAY
    && (s.node_refs ?? []).includes(FROM))
  if (!carrier) throw new Error('找不到承載這段的原始靜態分段')
  const used = new Set<number>()
  for (const s of db.segments) for (const n of s.node_refs ?? []) used.add(Number(n))
  const nextFree = (seed: number) => {
    let v = seed
    while (used.has(v)) v--
    used.add(v)
    return v
  }
  for (const joinNode of joins) {
    const joinIndex = (carrier.node_refs ?? []).findIndex((n) => Number(n) === joinNode)
    if (joinIndex <= 0 || joinIndex >= carrier.node_refs!.length - 1) {
      throw new Error(`接點 ${joinNode} 不是承載分段的內部節點，此處無法用忽略內部路口處理`)
    }
    const synthetic = nextFree(
      -900_000_000_000 - Math.abs(WAY) * 10_000 - Math.abs(joinNode % 10_000))
    if (SIMULATE !== 'release') {
      carrier.node_refs![joinIndex] = synthetic
      console.log(`模擬：承載分段第 ${joinIndex} 個節點 ${joinNode} → ${synthetic}`)
    }
    if (SIMULATE === 'api') continue
    // 其他 way 引用的是「重映射前」的原始節點 id，要回頭查 nodeRemap
    const sources = new Set<number>([joinNode])
    for (const [src, dst] of before.nodeRemap) if (dst === joinNode) sources.add(src)
    // release：只碰「別條路」的引用——受檢道路自己的來源分段（couplet 併掉的
    // 對向車行道等）不動，改動面積最小
    const ownKeys = new Set(chain.flatMap((r) =>
      r.properties.sourceSegments.map((src) => src.navSegmentKey)))
    for (const s of db.segments) {
      if (s === carrier) continue
      if (SIMULATE === 'release'
        && ownKeys.has(String(s.object_identity?.nav_segment_key ?? ''))) continue
      const refs = s.node_refs ?? []
      for (let i = 0; i < refs.length; i++) {
        if (!sources.has(Number(refs[i]))) continue
        const detached = nextFree(synthetic - 1)
        console.log(`模擬：解除 ${s.object_identity?.nav_segment_key}`
          + ` 對接點的共用（${refs[i]} → ${detached}）`)
        refs[i] = detached
      }
    }
  }
}

// ---- 驗證 -------------------------------------------------------------------
const { roads: allBlocks, active, journal } = prepare(db)
const sameWay = active.filter((r) => r.properties.osm_id === WAY)
console.log(`\nway/${WAY} 的活躍區塊：${sameWay.length}`)
for (const r of sameWay) console.log(`  ${blockKey(r)} nodes=${JSON.stringify(r.properties.nodes)}`)

const chain = chainBetween(sameWay, FROM, TO)
console.log(`\n${FROM} → ${TO} 需要經過的區塊：` +
  (chain ? `${chain.length}（${chain.map(blockKey).join('、')}）` : '不連通'))

check('編輯地圖只找得到一個路段', chain !== null && chain.length === 1,
  chain ? `${chain.length} 段` : '兩端不連通')
const whole = chain?.length === 1 ? chain[0] : undefined
check('該路段兩端正好是 from／to', Boolean(whole) && ends(whole!).includes(FROM)
  && ends(whole!).includes(TO),
  whole ? `nodes=${JSON.stringify(whole.properties.nodes)}` : '無單一區塊')

// 中間節點若還是別的區塊的端點，那裡就還是路口切點
const mids = new Set(whole ? whole.properties.nodes.slice(1, -1) : [])
const stillEndpoint = active.filter((r) => r !== whole && ends(r).some((n) => mids.has(n)))
check('中間接點不再是任何區塊的端點', Boolean(whole) && stillEndpoint.length === 0,
  stillEndpoint.length ? stillEndpoint.map((r) => `${blockKey(r)}（${r.properties.name ?? '未命名'}）`).join('、') : '無')

// 導航拓樸：接點若還是路口，A* 仍會在那裡切邊
const graph = new RoadGraph(active)
const interIds = new Set(graph.intersections().map((i) => i.id))
const midInter = [...mids].filter((n) => interIds.has(n))
check('導航路網不再把中間接點視為路口', Boolean(whole) && midInter.length === 0,
  midInter.length ? `仍是路口：${midInter.join('、')}` : '無')

// journal 殘留：指向已不存在區塊的覆寫會靜默失效。捏合會改掉接點 id，接點兩側
// （含被切斷的側街）的區塊鍵跟著變，舊鍵就變孤兒——尤其 deleted=1 變孤兒代表
// 使用者刪掉的路段會重新出現在地圖上，一定要抓出來。
// 用「所有區塊」而非「活躍區塊」比對：套用成功的 deleted=1 會把區塊移出活躍集合，
// 拿活躍集合比會把正常生效的刪除也算成孤兒
const liveKeys = new Set(allBlocks.map(blockKey))
const orphans = [...foldJournal(journal)].filter(([k]) =>
  /^way\/-?\d+@b\/-?\d+$/.test(k) && !liveKeys.has(k))
if (orphans.length) {
  console.log(`\n全圖孤兒區塊鍵：${orphans.length}`)
  for (const [k, v] of orphans) console.log(`  ${k} ${JSON.stringify(v).slice(0, 120)}`)
}
const orphanDeletes = orphans.filter(([, v]) => Number(v.deleted) > 0)
check('沒有失效的刪除覆寫（被刪的路段不會復活）', orphanDeletes.length === 0,
  orphanDeletes.length ? orphanDeletes.map(([k]) => k).join('、') : '無')

console.log(fails === 0 ? '\n✅ 全數通過：兩段已是同一路段' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
