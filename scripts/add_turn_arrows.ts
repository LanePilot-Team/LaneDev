// 補回被漏畫的轉向箭頭（node scripts/run_offline.mjs scripts/add_turn_arrows.ts [--apply=<out>]）
//
// turn_arrow_gap_audit 找出「某轉向被車道箭頭擋掉、擋掉之後要繞遠路」的組合，
// 一共 37 組右轉 + 48 組左轉。每一組都拿 Google 地圖對照過：起訖點取在路口前後
// 70m 的實際道路上，向 Google 要一次汽車路線，比較「它走的距離」與「直接轉過去的
// 距離」。比值 ≈1 表示 Google 直接轉過去，那就是我們漏畫箭頭；比值明顯大於 1
// 表示 Google 也繞路，那是現地真的禁止。
//
// 判定結果（比值 >1.5 視為現地真的禁止，不動）：
//   右轉 37 組 → 補 32 個進入方向，3 組維持禁止
//     node/7391695965 楠海路→援港路    1.0km / 直接轉 104m（10×，台17線是分隔的）
//     node/257743123  楠陽路→朝新路    450m 途經楠陽路180巷 / 148m（3×）
//     node/12599114573 鳳楠路→經建路   400m / 145m（2.8×）
//   左轉 48 組 → 補 41 個進入方向，7 組維持禁止
//     node/7390303866  楠海路→援港路   2.1km / 99m（21×）
//     node/257742658   高楠公路續行     1.1km / 81m（14×）
//     node/257743123   楠陽路→朝仁路   650m / 150m（4.3×）
//     node/12598724571 楠陽路→鳳楠路   550m / 241m（2.3×）
//     node/1400036464  加昌路／外環西路→外環西路 110m / 49m（2.2×，兩個進入方向）
//     node/1400036204  加昌路→後昌路   200m / 101m（2.0×）
//     node/280277329   楠梓交流道→旗楠路 對照無效（Google 把起點吸到旗楠路526號的
//                      地下樓層，只走了 23m，等於沒測到那個轉向）。該進入方向只有一個
//                      right 箭頭，是國道匝道的單一指定行向，不臆測。
//
// 附帶結論：使用者提出的「有快慢分隔島的中央汽車道才禁止右轉」在這批資料上不成立
// ——7 組有快慢分隔島的路口（德民路×高楠公路、外環西路×壽民路／加昌路／智群路、
// 旗楠路×東寧路），Google 全部都直接右轉過去。所以一律以 Google 實測為準。
// 同樣地「左轉規則大部分已經清晰」也不成立：48 組被擋掉的左轉裡有 41 組實際可轉。
//
// 補法：右轉加在**最外側**車道、左轉加在**最內側**車道（索引 0 = 最內側）。
// 既有的箭頭一律保留，只加不減；已經有該轉向的會被跳過（可重複執行）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'
import {
  applyLaneBaseToRoads, buildLaneBaseIndex, extractLaneBase, remapLaneBase,
  guidanceForRoadDirection,
} from '../src/core/laneBase'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const DB_PATH = arg('db', join(HERE, '../public/data/road_database.json'))
const APPLY = arg('apply', '')

interface Target { key: string; back: boolean; at: number; note: string }

/** Google 地圖確認可以右轉的進入方向。 */
const RIGHT: Target[] = [
  { key: 'way/267715930@b/2430791063', back: false, at: 262101326, note: '大學二十九路→藍田路' },
  { key: 'way/339750731@b/262101326', back: true, at: 262101326, note: '大學二十九路→藍田路' },
  { key: 'way/75852429@b/895427266', back: true, at: 895427266, note: '德民路→高楠公路' },
  { key: 'way/126247850@b/7048711974', back: false, at: 258785797, note: '德民路→高楠公路' },
  { key: 'way/267715881@b/1398634938', back: true, at: 1398634938, note: '德民路→晉昌街' },
  { key: 'way/267715881@b/256455983', back: true, at: 256455983, note: '德民路→右昌街' },
  { key: 'way/799115397@b/2264471214', back: false, at: 1932046293, note: '楠梓路→創新路' },
  { key: 'way/268219234@b/2206324424', back: false, at: 2206324417, note: '外環西路→創意南路' },
  { key: 'way/387524927@b/2896477627', back: false, at: 1400036726, note: '外環西路→壽民路' },
  { key: 'way/280277100@b/1400036721', back: false, at: 260269205, note: '外環西路→加昌路' },
  { key: 'way/268219237@b/1400036726', back: false, at: 1400036767, note: '外環西路→智群路' },
  { key: 'way/293422503@b/304709043', back: true, at: 304709043, note: '加昌路→科技路' },
  { key: 'way/312878599@b/258785457', back: false, at: 258785439, note: '德惠路→德民路' },
  { key: 'way/916797954@b/7390303866', back: false, at: 1397383132, note: '楠海路→典昌街' },
  { key: 'way/916797955@b/8512750895', back: false, at: 1080697389, note: '楠海路→大學南路' },
  { key: 'way/246576623@b/-4573', back: false, at: -4466, note: '左營大路→海功路' },
  { key: 'way/383642188@b/3004962043', back: false, at: 3004962044, note: '軍校路→藍昌路' },
  { key: 'way/383642188@b/3004962043', back: true, at: 3004962043, note: '軍校路→右昌街' },
  { key: 'way/125062082@b/-3122', back: false, at: -3139, note: '軍校路→實踐路' },
  { key: 'way/38367687@b/265599378', back: true, at: 265599378, note: '世運大道→軍校路' },
  { key: 'way/231194640@b/1451068704', back: false, at: 1451068688, note: '楠梓交流道→鳳仁路' },
  { key: 'way/23683308@b/256245260', back: true, at: 256245260, note: '後昌路→區東路' },
  { key: 'way/23683301@b/256245260', back: true, at: 256245260, note: '後昌路→後昌路' },
  { key: 'way/1464405421@b/343046787', back: true, at: 343046787, note: '藍田路→大學十七街' },
  { key: 'way/1464405422@b/259481981', back: false, at: 343046787, note: '藍田路→大學十七街' },
  { key: 'way/1464405420@b/1080697136', back: false, at: 343046787, note: '大學十七街→藍田路' },
  { key: 'way/254325309@b/1080697129', back: true, at: 1080697129, note: '藍田路→大學二十五路' },
  { key: 'way/23787579@b/12556600783', back: false, at: 12598724571, note: '楠陽路→鳳楠路' },
  { key: 'way/430411159@b/2261344414', back: false, at: 280277428, note: '楠梓新路→建楠路' },
  { key: 'way/271982114@b/8198448994', back: false, at: 1932046238, note: '旗楠路→東寧路' },
  { key: 'way/24465741@b/1398634371', back: false, at: 265968406, note: '藍昌路→東昌街' },
  { key: 'way/208652154@b/2264471150', back: false, at: 988779697, note: '土庫路→清豐一路' },
]

/** Google 地圖確認可以左轉的進入方向。 */
const LEFT: Target[] = [
  { key: 'way/23683308@b/258784517', back: false, at: 256245267, note: '後昌路→加昌路' },
  { key: 'way/254325307@b/256245347', back: true, at: 256245347, note: '藍昌路→大學南路' },
  { key: 'way/231194640@b/1451068704', back: false, at: 1451068688, note: '楠梓交流道→鳳楠路' },
  { key: 'way/38367687@b/265599378', back: true, at: 265599378, note: '世運大道→軍校路' },
  { key: 'way/280277090@b/1400036566', back: false, at: 895427266, note: '德民路→高楠公路' },
  { key: 'way/268219230@b/10894062953', back: false, at: 304709043, note: '加昌路→科技路' },
  { key: 'way/254325307@b/7243024857', back: false, at: 258784609, note: '藍昌路→藍田路' },
  { key: 'way/280277091@b/3853782600', back: false, at: 258785439, note: '德民路→德惠路' },
  { key: 'way/246576623@b/-4573', back: false, at: -4466, note: '左營大路→海功東路' },
  { key: 'way/93228856@b/262840908', back: true, at: 262840908, note: '大學南路→高雄大學路' },
  { key: 'way/126247850@b/258785765', back: true, at: 258785765, note: '德民路→惠豐街' },
  { key: 'way/267727286@b/-5097', back: false, at: -5379, note: '海功東路→翠華路' },
  { key: 'way/281341659@b/1400036204', back: true, at: 1400036204, note: '後昌路→加昌路' },
  { key: 'way/1464405422@b/343046730', back: true, at: 343046730, note: '藍田路→大學二十一路' },
  { key: 'way/231785289@b/273103109', back: true, at: 273103109, note: '後昌路→和光街' },
  { key: 'way/23976945@b/1401138499', back: false, at: 289126281, note: '加昌路→區東路' },
  { key: 'way/230216178@b/2624297542', back: true, at: 2624297542, note: '加昌路→金富街' },
  { key: 'way/312878599@b/258785457', back: true, at: 258785457, note: '德惠路→德賢路' },
  { key: 'way/271982144@b/2987047184', back: false, at: 12598724579, note: '建楠路→建楠路' },
  { key: 'way/339750712@b/265968403', back: true, at: 265968403, note: '德民路→東昌街' },
  { key: 'way/281341661@b/1398635085', back: false, at: 1372607168, note: '後昌路→民昌街' },
  { key: 'way/208652154@b/2264471150', back: false, at: 988779697, note: '土庫路→清豐一路' },
  { key: 'way/254325309@b/291592355', back: false, at: 1080697129, note: '藍田路→大學二十五路' },
  { key: 'way/267715881@b/1398634938', back: true, at: 1398634938, note: '德民路→中昌街' },
  { key: 'way/94402836@b/258785531', back: true, at: 258785531, note: '德惠路→德信街' },
  { key: 'way/1464405421@b/343046787', back: true, at: 343046787, note: '藍田路→大學十七街' },
  { key: 'way/297138318@b/262840830', back: true, at: 262840830, note: '藍田路→高雄大學路' },
  { key: 'way/297205391@b/4586456368', back: false, at: 295692586, note: '左楠路→後昌路' },
  { key: 'way/125062053@b/-4466', back: true, at: -4466, note: '海功路→左營大路' },
  { key: 'way/1464405420@b/1080697136', back: false, at: 343046787, note: '大學十七街→藍田路' },
  { key: 'way/23875893@b/1080696860', back: false, at: 262101326, note: '藍田路→大學二十九路' },
  { key: 'way/23875894@b/258784649', back: true, at: 258784649, note: '援中路→藍田路' },
  { key: 'way/231785289@b/273103101', back: false, at: 2401070584, note: '後昌路→新昌街' },
  { key: 'way/297138334@b/262840700', back: false, at: 256593792, note: '藍田路→大學十一街' },
  { key: 'way/267715881@b/1398634938', back: false, at: 261697052, note: '德民路→民昌街' },
  { key: 'way/297133986@b/1400036204', back: true, at: 1400036204, note: '加昌路→後昌路' },
  { key: 'way/297138329@b/256593792', back: true, at: 256593792, note: '藍田路→大學十一街' },
  { key: 'way/93228856@b/260130552', back: true, at: 260130552, note: '大學南路→大學東路' },
  { key: 'way/230282047@b/2261344406', back: false, at: 12598724579, note: '建楠路→鳳楠路' },
  { key: 'way/339750721@b/262101326', back: true, at: 262101326, note: '藍田路→大學二十九路' },
]

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
const journal: EnhancementRecord[] = db.editor.journal
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const prepared = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
const roads = prepared.roads
const extraction = extractLaneBase(Array.isArray(db.annotations) ? db.annotations : [])
const remapped = remapLaneBase(extraction.records, {
  existingWayIds: new Set(roads.map((r) => r.properties.osm_id)),
  nodeRemap: prepared.nodeRemap,
  wayRemap: prepared.wayRemap,
  wayApproachNodes: roads.reduce((index, road) => {
    const nodes = index.get(road.properties.osm_id) ?? {
      forward: new Set<number>(), backward: new Set<number>(),
    }
    nodes.forward.add(road.properties.nodes.at(-1)!)
    if (road.properties.oneway !== 'yes') nodes.backward.add(road.properties.nodes[0])
    index.set(road.properties.osm_id, nodes)
    return index
  }, new Map<number, { forward: Set<number>; backward: Set<number> }>()),
})
applyLaneBaseToRoads(roads, buildLaneBaseIndex(remapped.records))
applyToRoads(roads, foldJournal(journal))

const key = (r: RoadFeature) => `way/${r.properties.osm_id}@b/${r.properties.blockNode}`
const byKey = new Map(roads.map((r) => [key(r), r]))

/** 在指定側的車道加上該轉向；已經有的不動，其餘車道原樣保留。 */
function withMove(movements: string[], move: 'left' | 'right'): string[] {
  const out = [...movements]
  const index = move === 'right' ? out.length - 1 : 0
  const moves = new Set(out[index].split(/[;+]/).map((s) => s.trim()).filter(Boolean))
  if (moves.has(move)) return out
  moves.delete('none')
  moves.add(move)
  out[index] = [...moves].join(';')
  return out
}

// 同一個區塊方向可能同時要補左轉與右轉，必須疊加後才寫一筆，否則後寫的會蓋掉先寫的
const pending = new Map<string, { key: string; back: boolean; before: string; notes: string[]; movements: string[] }>()
const skipped: string[] = []
for (const [move, list] of [['right', RIGHT], ['left', LEFT]] as ['left' | 'right', Target[]][]) {
  for (const t of list) {
    const road = byKey.get(t.key)
    if (!road) { skipped.push(`${t.key}：區塊不存在`); continue }
    const id = `${t.key}|${t.back}`
    let entry = pending.get(id)
    if (!entry) {
      const guidance = guidanceForRoadDirection(road, t.back)
      const movements = guidance.laneMovements
      if (!movements?.length) { skipped.push(`${t.key}${t.back ? '(逆)' : ''}：沒有箭頭資料`); continue }
      if (movements.length !== guidance.laneCount) {
        skipped.push(`${t.key}${t.back ? '(逆)' : ''}：箭頭 ${movements.length} 筆 ≠ 車道 ${guidance.laneCount}`)
        continue
      }
      entry = { key: t.key, back: t.back, before: movements.join('|'), notes: [], movements: [...movements] }
      pending.set(id, entry)
    }
    const next = withMove(entry.movements, move)
    if (next.join('|') === entry.movements.join('|')) {
      skipped.push(`${t.key}${t.back ? '(逆)' : ''} ${t.note}：已經有 ${move}`)
      continue
    }
    entry.movements = next
    entry.notes.push(`${move === 'right' ? '右' : '左'}｜${t.note}`)
  }
}
const added = [...pending.values()].filter((e) => e.notes.length)

console.log(`目標：右轉 ${RIGHT.length} + 左轉 ${LEFT.length} 個進入方向`
  + `｜實際要改 ${added.length} 個區塊方向｜跳過 ${skipped.length}\n`)
for (const a of added) {
  console.log(`  + ${a.key}${a.back ? '(逆)' : ''}｜${a.notes.join('、')}`)
  console.log(`      ${a.before}  →  ${a.movements.join('|')}`)
}
for (const s of skipped) console.log(`  · 跳過 ${s}`)

if (!APPLY) {
  console.log('\n（預演，未寫檔。加 --apply=<路徑> 才會寫入）')
} else {
  for (const a of added) {
    journal.push({
      seq: 0, ts: new Date().toISOString(), author: 'anna', op: 'set',
      target: { type: 'road', key: a.key },
      fields: { [a.back ? 'turn_lanes_backward' : 'turn_lanes']: a.movements.join('|') },
    })
  }
  db.editor.journal = journal.map((r: EnhancementRecord, i: number) => ({ ...r, seq: i + 1 }))
  db.editor.updated_at = new Date().toISOString()
  db.updated_at = db.editor.updated_at
  writeFileSync(APPLY, `${JSON.stringify(db)}\n`, 'utf8')
  console.log(`\n已寫入 ${APPLY}：改了 ${added.length} 個區塊方向的箭頭`)
}
