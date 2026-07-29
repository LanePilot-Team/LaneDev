// 從舊快照把「捏合」（節點改名）搬回目前的唯一靜態資料庫。
//
// 捏合只存在於 segments[].node_refs：把區塊接點換成合成負 id，讓那裡不再是路口。
// build_static_road_database.mjs 會整包重建 segments，所以捏合會被連根拔掉，
// 而 editor.journal（車道標記）原封不動——這就是「標記還在、捏合不見」的成因。
//
// 用座標配對而不是索引：重建後的 segments 節點數可能不同，只有經緯度是穩定的。
//
//   node scripts/restore_merges.mjs --from=<舊快照> [--name=藍昌路] [--out=<檔案>]
//
// 不給 --out 時只做 dry-run，印出會改哪些節點但不寫檔。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name, dflt) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt

const DB_PATH = resolve(arg('db', resolve(HERE, '../public/data/road_database.json')))
const FROM = resolve(arg('from', ''))
const NAME = arg('name', '')
const OUT = arg('out', '')

if (!FROM) {
  console.error('必須指定 --from=<舊快照路徑>')
  process.exit(2)
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const old = JSON.parse(readFileSync(FROM, 'utf8'))

const segKey = (s) => `${s.object_identity?.nav_segment_key}#${s.object_identity?.split_index ?? 0}`
const coordKey = (c) => `${Number(c[0]).toFixed(7)},${Number(c[1]).toFixed(7)}`
const roadName = (s) => String(s.lane_nav_tags?.road_name ?? '')

// 目前檔案已在用的節點 id，避免復原時撞號
const used = new Set()
for (const s of db.segments) for (const n of s.node_refs ?? []) used.add(Number(n))

const currentBySegment = new Map(db.segments.map((s) => [segKey(s), s]))

let restored = 0
let skippedMissing = 0
let skippedTaken = 0
const plan = []

for (const oldSeg of old.segments) {
  if (NAME && !roadName(oldSeg).includes(NAME)) continue
  const refs = oldSeg.node_refs ?? []
  const coords = oldSeg.geometry?.coordinates ?? []
  const target = currentBySegment.get(segKey(oldSeg))
  for (let i = 0; i < refs.length; i++) {
    const node = Number(refs[i])
    // 只搬「捏合產生的」大負數；build 腳本補的合成 id 是 -1、-2… 這種小負數
    if (node > -1_000_000) continue
    const coord = coords[i]
    if (!coord) continue
    if (!target) { skippedMissing++; continue }
    const targetCoords = target.geometry?.coordinates ?? []
    const at = targetCoords.findIndex((c) => coordKey(c) === coordKey(coord))
    if (at < 0) {
      skippedMissing++
      plan.push({ seg: segKey(oldSeg), name: roadName(oldSeg), node, coord, status: '找不到同座標節點' })
      continue
    }
    // 與捏合 API 同一道保險：只忽略「分段內部」的接點。改到端點會把這條路
    // 和相鄰路段整個斷開，那是斷線不是合併。
    if (at === 0 || at === target.node_refs.length - 1) {
      skippedMissing++
      plan.push({
        seg: segKey(oldSeg), name: roadName(oldSeg), node, coord,
        status: `重建後落在分段端點（index ${at}），跳過以免斷線`,
      })
      continue
    }
    const nowNode = Number(target.node_refs[at])
    if (nowNode === node) { plan.push({ seg: segKey(oldSeg), name: roadName(oldSeg), node, coord, status: '已是捏合狀態' }); continue }
    if (nowNode < 0) { skippedTaken++; plan.push({ seg: segKey(oldSeg), name: roadName(oldSeg), node, coord, status: `已是別的負節點 ${nowNode}` }); continue }
    if (used.has(node)) { skippedTaken++; plan.push({ seg: segKey(oldSeg), name: roadName(oldSeg), node, coord, status: '負節點 id 已被占用' }); continue }
    plan.push({ seg: segKey(oldSeg), name: roadName(oldSeg), node, coord, status: `${nowNode} → ${node}`, apply: [target, at] })
    used.add(node)
    restored++
  }
}

for (const p of plan) {
  console.log(`  ${p.seg}（${p.name}）@ ${coordKey(p.coord)}  ${p.status}`)
}
console.log(`\n可復原 ${restored} 個捏合接點；座標對不上 ${skippedMissing}；已被占用 ${skippedTaken}`)

if (!OUT) {
  console.log('（dry-run：未寫檔。加 --out=<路徑> 才會產生結果檔）')
  process.exit(0)
}

const renames = []
for (const p of plan) {
  if (!p.apply) continue
  const [seg, at] = p.apply
  renames.push({ from: Number(seg.node_refs[at]), to: p.node })
  seg.node_refs[at] = p.node
}

// 接點改名會讓區塊鍵跟著變，舊鍵就成了靜默失效的孤兒（車道標記不套用、
// deleted=1 讓被刪的路段復活）。與 enhancements.remapJournalNodes 同一套規則遷移。
const remap = new Map(renames.map(({ from, to }) => [from, to]))
let movedKeys = 0
for (const record of db.editor?.journal ?? []) {
  const m = String(record.target?.key ?? '')
    .match(/^(way\/-?\d+@(?:b|node)\/)(-?\d+)((?:~b)?(?:~r|~m)?)$/)
  if (!m) continue
  const next = remap.get(Number(m[2]))
  if (next === undefined) continue
  record.target.key = `${m[1]}${next}${m[3] ?? ''}`
  movedKeys++
}
if (movedKeys) console.log(`journal 鍵隨接點改名遷移：${movedKeys} 筆`)
db.editor.updated_at = new Date().toISOString()
db.updated_at = new Date().toISOString()
writeFileSync(resolve(OUT), `${JSON.stringify(db)}\n`, 'utf8')
console.log(`已寫入 ${resolve(OUT)}`)
