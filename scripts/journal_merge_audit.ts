// journal 捏合驗證（node scripts/run_offline.mjs scripts/journal_merge_audit.ts）
//
// 走與 app 完全相同的載入管線，證明「捏合改成 journal 紀錄」達成三件事：
//   1. 兩個區塊真的接成一段（活躍區塊數 -1）
//   2. 靜態 segments 一個位元組都沒被改 —— 重建 segments 炸不到捏合
//   3. 保留段的區塊鍵不變 —— 不會像改名接點那樣把既有覆寫變成孤兒
//      （這正是 deleted:1 會失效、被刪路段自己復活的成因）
// 另外驗接點的 T 字路口語意：只有主路正向那一側能與側街互動。
//
// 參數：--db=<path> --way=<id>（預設掃全圖找第一組可捏合的相鄰區塊）
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import {
  foldJournal, applyToRoads, applyRoadMerges, checkRoadMerge, journalForMergedRoads,
  type EnhancementRecord,
} from '../src/core/enhancements'
import { oneSideEntryTransitionAllowed } from '../src/core/oneSideEntry'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const WAY = Number(arg('way', '0'))

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const blockKey = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

function build(journal: EnhancementRecord[]) {
  const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
  if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
  const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
  applyToRoads(roads, foldJournal(journal))
  const merged = applyRoadMerges(roads, journal)
  return { roads, active: roads.filter((r) => !r.properties.deleted), merged }
}

const baseJournal: EnhancementRecord[] = db.editor?.journal ?? []
const segmentsBefore = JSON.stringify(db.segments)
const before = build(baseJournal)
console.log(`基準：活躍區塊 ${before.active.length}，既有 journal 捏合 ${before.merged} 組`)

// 找一組真的可以捏合的相鄰區塊
let pair: { a: RoadFeature; b: RoadFeature } | null = null
const pool = WAY
  ? before.active.filter((r) => r.properties.osm_id === WAY)
  : before.active
for (const a of pool) {
  for (const b of pool) {
    if (a === b) continue
    if (checkRoadMerge(a, b).ok) { pair = { a, b }; break }
  }
  if (pair) break
}
if (!pair) {
  console.log('❌ 找不到任何可捏合的相鄰區塊，無法驗證')
  process.exit(1)
}
const primaryKey = blockKey(pair.a)
const secondaryKey = blockKey(pair.b)
console.log(`受測：保留 ${primaryKey}（${pair.a.properties.name ?? '未命名'}）`)
console.log(`      合併 ${secondaryKey}`)

const withMerge: EnhancementRecord[] = [...baseJournal, {
  seq: baseJournal.length + 1,
  ts: new Date().toISOString(),
  author: 'audit',
  op: 'set',
  target: { type: 'road_merge', key: `merge/${primaryKey}+${secondaryKey}` },
  fields: {
    primary: primaryKey,
    secondary: secondaryKey,
    secondary_nodes: JSON.stringify(pair.b.properties.nodes),
  },
}]
const after = build(withMerge)

check('活躍區塊數少一段', after.active.length === before.active.length - 1,
  `${before.active.length} → ${after.active.length}`)
check('新增了一組 journal 捏合', after.merged === before.merged + 1,
  `${before.merged} → ${after.merged}`)

const afterKeys = new Set(after.active.map(blockKey))
check('保留段的區塊鍵原封不動（既有覆寫不會變孤兒）', afterKeys.has(primaryKey), primaryKey)
check('次段已退出活躍路網', !afterKeys.has(secondaryKey), secondaryKey)

const survivor = after.active.find((r) => blockKey(r) === primaryKey)
const expectedNodes = pair.a.properties.nodes.length + pair.b.properties.nodes.length - 1
check('接合後節點數 = 兩段相加去掉共用點', survivor?.properties.nodes.length === expectedNodes,
  `${survivor?.properties.nodes.length} vs ${expectedNodes}`)

check('靜態 segments 完全沒被改動', JSON.stringify(db.segments) === segmentsBefore)

// 接點不是「完全不連接」，而是 T 字路口：只有主路正向那一側能與側街互動。
const joinNodes = (survivor?.properties.oneSideEntryNodes ?? [])
const midNodes = new Set((survivor?.properties.nodes ?? []).slice(1, -1))
check('接點已登記為單向進入限制', joinNodes.some((n) => midNodes.has(n)),
  `oneSideEntryNodes=${JSON.stringify(joinNodes)}`)
const joinNode = joinNodes.find((n) => midNodes.has(n))
if (survivor && joinNode !== undefined) {
  const other = after.active.find((r) => r !== survivor && r.properties.nodes.includes(joinNode)
    && r.properties.osm_id !== survivor.properties.osm_id)
  check('正向仍可轉入該接點的側街',
    !other || oneSideEntryTransitionAllowed(survivor, false, other, false, joinNode),
    other ? `側街 way/${other.properties.osm_id}（${other.properties.name ?? '未命名'}）` : '該接點無側街')
  check('對向不可跨線左轉進入側街（需迴轉到正向）',
    !other || !oneSideEntryTransitionAllowed(survivor, true, other, false, joinNode))
  check('側街可駛出到主路正向',
    !other || oneSideEntryTransitionAllowed(other, false, survivor, false, joinNode))
  check('側街不可逆向切入主路反向（要先走正向再迴轉）',
    !other || !oneSideEntryTransitionAllowed(other, false, survivor, true, joinNode))
  check('對向仍可沿主路直行通過接點',
    oneSideEntryTransitionAllowed(survivor, true, survivor, true, joinNode))
}

// 全圖孤兒不因捏合而增加——這是舊做法最傷的地方
const liveBefore = new Set(before.roads.map(blockKey))
const liveAfter = new Set(after.roads.map(blockKey))
const orphanOf = (live: Set<string>, journal: EnhancementRecord[]) =>
  [...foldJournal(journal)].filter(([k]) => /^way\/-?\d+@b\/-?\d+$/.test(k) && !live.has(k))
const orphansBefore = orphanOf(liveBefore, baseJournal)
const orphansAfter = orphanOf(liveAfter, withMerge)
check('捏合沒有製造新的孤兒區塊鍵',
  orphansAfter.length <= orphansBefore.length + 1,
  `${orphansBefore.length} → ${orphansAfter.length}（次段自己那筆不算）`)
check('沒有任何 deleted:1 變成孤兒',
  orphansAfter.filter(([, v]) => Number(v.deleted) > 0).length === 0)

// 路口元件的鍵視圖
const view = journalForMergedRoads(withMerge)
check('journalForMergedRoads 不改動原始歷程長度', view.length === withMerge.length,
  `${withMerge.length} → ${view.length}`)

console.log(fails === 0 ? '\n✅ 全數通過' : `\n❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
