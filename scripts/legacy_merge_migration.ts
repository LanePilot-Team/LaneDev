// 舊靜態捏合 → journal 捏合 的可行性模擬／遷移
// （node scripts/run_offline.mjs scripts/legacy_merge_migration.ts [--apply=<out.json>]）
//
// 舊做法把接點 node id 換成大負數，造成兩個後果，兩個都是使用者實際在痛的：
//   1. 側街被完全切斷（連 T 字路口都不是，正向也進不去）
//   2. 兩側區塊鍵跟著改名 → 既有覆寫變孤兒，靜默失效
// 把 node id 還原、改用 journal 的 road_merge 紀錄達成同樣的接合，兩個問題一起消失，
// 而且接點會依 applyRoadMerges 自動登記 oneSideEntryNodes（單向進入的 T 字路口）。
//
// ⚠ 已知未解問題：實測套用後，加昌路 way/23976945 那組原本正常的捏合會裂成兩段。
//   只有加昌路自己引用該負節點、segments 前後相同，裂開發生在管線內，推測是還原
//   其他節點後 collapseKnownIntersections（fixups.ts:55）對該負節點改變了判定。
//   未根因排除前不要 --apply 到正式檔。
//
// 不給 --apply 時只模擬，回報每個接點能不能用 checkRoadMerge 重現。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import {
  foldJournal, applyToRoads, applyRoadMerges, checkRoadMerge, type EnhancementRecord,
} from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const APPLY = arg('apply', '')

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))

// ── 1. 從 segments 找出所有舊捏合改名，並還原成原始節點 id ────────────────────
// 原始 id 無法從負數反推，改用座標：同座標若別條路還握著正節點，那就是原本共用的。
const coordKey = (c: number[]) => `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)}`
const positiveAt = new Map<string, Set<number>>()
for (const s of db.segments) {
  const refs: number[] = s.node_refs ?? []
  const cs: number[][] = s.geometry?.coordinates ?? []
  refs.forEach((n, i) => {
    if (Number(n) <= 0 || !cs[i]) return
    const k = coordKey(cs[i])
    if (!positiveAt.has(k)) positiveAt.set(k, new Set())
    positiveAt.get(k)!.add(Number(n))
  })
}

interface Rename { seg: any; index: number; negative: number; restored: number; name: string }
const renames: Rename[] = []
const unresolved: { name: string; negative: number }[] = []
for (const s of db.segments) {
  const refs: number[] = s.node_refs ?? []
  const cs: number[][] = s.geometry?.coordinates ?? []
  refs.forEach((n, i) => {
    if (Number(n) > -1_000_000) return // 建置補的 -1、-2 不是捏合痕跡
    const matches = [...(positiveAt.get(coordKey(cs[i] ?? [])) ?? [])]
    const name = String(s.lane_nav_tags?.road_name ?? '未命名')
    if (matches.length === 1) {
      renames.push({ seg: s, index: i, negative: Number(n), restored: matches[0], name })
    } else {
      unresolved.push({ name, negative: Number(n) })
    }
  })
}
console.log(`舊捏合改名：${renames.length} 個可由同座標正節點還原`
  + `／${unresolved.length} 個無法還原（同座標沒有唯一正節點）`)
for (const u of unresolved) console.log(`   ✖ ${u.name} node=${u.negative}`)

// ── 2. 還原 node id，重跑管線，看接點兩側能不能用 checkRoadMerge 接回去 ───────
const restoredDb = JSON.parse(JSON.stringify(db))
db.segments.forEach((s: any, si: number) => {
  for (const r of renames) {
    if (r.seg !== s) continue
    restoredDb.segments[si].node_refs[r.index] = r.restored
  }
})

const build = (source: any, journal: EnhancementRecord[]) => {
  const parsed = parseImported(source.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
  const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads, foldJournal(journal))
  applyRoadMerges(roads, journal)
  return roads.filter((r) => !r.properties.deleted)
}
const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

const journal: EnhancementRecord[] = db.editor?.journal ?? []
// 當初改名時 journal 鍵也被一起搬到負節點上（restore_merges 的 remap）。只還原
// node_refs 而不還原鍵，覆寫就套不上去，兩側車道配置會假性不同、害 checkRoadMerge
// 拒絕重現這個接點。兩者必須一起還原。
const keyRemap = new Map(renames.map((r) => [r.negative, r.restored]))
const restoredJournal: EnhancementRecord[] = journal.map((rec) => {
  const m = String(rec.target?.key ?? '')
    .match(/^(way\/-?\d+@(?:b|node)\/)(-?\d+)((?:~b)?(?:~r|~m)?)$/)
  if (!m) return rec
  const next = keyRemap.get(Number(m[2]))
  if (next === undefined) return rec
  return { ...rec, target: { ...rec.target, key: `${m[1]}${next}${m[3] ?? ''}` } }
})
const movedKeys = restoredJournal.filter((r, i) => r.target.key !== journal[i].target.key).length
console.log(`journal 鍵隨節點還原一起遷移：${movedKeys} 筆`)
const beforeBlocks = build(db, journal)
const restoredBlocks = build(restoredDb, restoredJournal)
console.log(`\n活躍區塊：現況 ${beforeBlocks.length} → 還原節點後 ${restoredBlocks.length}`
  + `（多出來的就是被拆回去、要靠 journal 接回的）`)

// 對每個還原的接點，找出兩側區塊並檢查能否合併。
//
// 不能只看「與被改名分段同名」的區塊：改名發生在側街上時（例如加昌路179巷），
// 被重新切開的是**主路**加昌路，同名過濾會整個漏掉那一刀，主路就這樣裂成兩段。
// 改成看實際拓撲——還原後任何一條 way 只要在該接點上有兩個區塊端點相接，就是
// 需要重現的捏合，與名稱無關。
const records: EnhancementRecord[] = []
let ok = 0
const failures: { rename: Rename; blocks: RoadFeature[]; reason: string }[] = []

// 邊做邊套用：連續捏合時後一筆要看到前一筆合併後的結果，
// 否則第二筆會指向已經被吸收掉的區塊鍵而靜默失效。
const working = build(restoredDb, restoredJournal)
const blocksAt = (node: number) => {
  const byWay = new Map<number, RoadFeature[]>()
  for (const b of working) {
    const ns = b.properties.nodes
    if (ns[0] !== node && ns[ns.length - 1] !== node) continue
    const list = byWay.get(b.properties.osm_id) ?? []
    list.push(b)
    byWay.set(b.properties.osm_id, list)
  }
  return byWay
}

const handled = new Set<number>()
for (const r of renames) {
  if (handled.has(r.restored)) continue
  handled.add(r.restored)
  let joined = false
  let lastPair: RoadFeature[] = []
  let lastReason = '此接點沒有任何 way 出現兩個相接區塊'
  for (const [, blocks] of blocksAt(r.restored)) {
    if (blocks.length !== 2) continue
    lastPair = blocks
    const check = checkRoadMerge(blocks[0], blocks[1])
    if (!check.ok) { lastReason = check.reason ?? '未知'; continue }
    const record: EnhancementRecord = {
      seq: 0, ts: new Date().toISOString(), author: 'migration', op: 'set',
      target: { type: 'road_merge', key: `merge/${check.primaryKey}+${check.secondaryKey}` },
      fields: {
        primary: check.primaryKey,
        secondary: check.secondaryKey,
        secondary_nodes: JSON.stringify(blocks[1].properties.nodes),
      },
    }
    records.push(record)
    applyRoadMerges(working, [record]) // 立刻反映，下一個接點才看得到正確拓撲
    joined = true
  }
  if (joined) ok++
  else failures.push({ rename: r, blocks: lastPair, reason: lastReason })
}
console.log(`\n可用 journal 重現的接點：${ok}／無法重現：${failures.length}`)

/** 接點的路口名稱：同節點上名稱不同的交會道路，方便在地圖上搜尋定位。 */
function junctionName(node: number, selfName: string, blocks: RoadFeature[]): string {
  const names = new Set<string>()
  for (const b of blocks) {
    if (!b.properties.nodes.includes(node)) continue
    const n = (b.properties.name ?? '').trim()
    if (!n || n === selfName) continue
    names.add(n)
  }
  if (!names.size) return `${selfName}（此接點無其他具名交會道路）`
  return `${selfName} × ${[...names].join('／')} 路口`
}

/** 兩段之間哪些欄位不一致——要照這個調整才能重新捏合。 */
function configDiff(a: RoadFeature, b: RoadFeature): string[] {
  const fields: [string, (r: RoadFeature) => unknown][] = [
    ['順向車道數', (r) => r.properties.lanesForward],
    ['逆向車道數', (r) => r.properties.lanesBackward],
    ['順向機車道', (r) => r.properties.motoF],
    ['逆向機車道', (r) => r.properties.motoB],
    ['單雙向', (r) => r.properties.oneway],
    ['道路等級', (r) => r.properties.highway],
  ]
  const out: string[] = []
  for (const [label, get] of fields) {
    if (String(get(a)) !== String(get(b))) {
      out.push(`${label} ${JSON.stringify(get(a))} ≠ ${JSON.stringify(get(b))}`)
    }
  }
  return out
}

if (failures.length) {
  console.log(`\n${'='.repeat(76)}`)
  console.log('會裂開、需要手動重新捏合的接點清單')
  console.log('='.repeat(76))
  failures.forEach((f, i) => {
    const { rename: r, blocks, reason } = f
    console.log(`\n${i + 1}. ${junctionName(r.restored, r.name, restoredBlocks)}`)
    console.log(`   接點節點 ${r.restored}｜原因：${reason}`)
    for (const b of blocks) {
      const cs = b.geometry.coordinates as [number, number][]
      const mid = cs[Math.floor(cs.length / 2)]
      console.log(`   ${blockKey(b)}`
        + `｜車道 ${b.properties.lanesForward}+${b.properties.lanesBackward}`
        + `｜機車道 ${b.properties.motoF ? '有' : '無'}/${b.properties.motoB ? '有' : '無'}`
        + `｜地圖座標 ${mid[1].toFixed(6)},${mid[0].toFixed(6)}`)
    }
    if (blocks.length >= 2) {
      const diff = configDiff(blocks[0], blocks[1])
      if (diff.length) console.log(`   → 要調成一致：${diff.join('；')}`)
    }
  })
  console.log(`\n${'='.repeat(76)}`)
}

if (unresolved.length) {
  console.log('\n以下接點連節點都還原不了（兩端都被切斷），維持現狀、仍是斷線：')
  for (const u of unresolved) console.log(`   ${u.name} node=${u.negative}`)
}

// ── 3. 遷移後的成效 ─────────────────────────────────────────────────────────
const migratedJournal = [...restoredJournal, ...records]
  .map((rec, i) => ({ ...rec, seq: i + 1 }))
const afterBlocks = build(restoredDb, migratedJournal)
console.log(`\n遷移後活躍區塊：${afterBlocks.length}（現況 ${beforeBlocks.length}）`)

const liveBefore = new Set(beforeBlocks.map(blockKey))
const liveAfter = new Set(afterBlocks.map(blockKey))
const orphansOf = (live: Set<string>, j: EnhancementRecord[]) =>
  [...foldJournal(j)].filter(([k]) => /^way\/-?\d+@b\/-?\d+$/.test(k) && !live.has(k))
console.log(`區塊鍵孤兒：現況 ${orphansOf(liveBefore, journal).length}`
  + ` → 遷移後 ${orphansOf(liveAfter, migratedJournal).length}`)

let restrictedNodes = 0
for (const b of afterBlocks) restrictedNodes += (b.properties.oneSideEntryNodes ?? []).length
console.log(`帶單向進入限制的接點：現況 `
  + `${beforeBlocks.reduce((n, b) => n + (b.properties.oneSideEntryNodes ?? []).length, 0)}`
  + ` → 遷移後 ${restrictedNodes}`)

if (!APPLY) {
  console.log('\n（模擬：未寫檔。加 --apply=<路徑> 才會產生遷移後的資料庫）')
  process.exit(0)
}
restoredDb.editor.journal = migratedJournal
restoredDb.editor.updated_at = new Date().toISOString()
restoredDb.updated_at = restoredDb.editor.updated_at
writeFileSync(APPLY, `${JSON.stringify(restoredDb)}\n`, 'utf8')
console.log(`\n已寫入 ${APPLY}`)
