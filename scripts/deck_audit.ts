// 高架橋面貼合審計（npx tsx scripts/deck_audit.ts）：
// 2026-07-25 「指引線沉入高架之下」的回歸驗證——
//   路線帶/車輛的高度必須等於「橋面實際高度」，低於橋面 > 0.1m 的取樣點會被
//   深度測試擋掉，藍線整段消失。
//   ⚠ 2026-08-07：舊來源會嚴重低估的成因（匝道貼邊滑行段的高度域重映射，hAt 把
//   [dA,dB] 拉伸成整條 way）已隨「匯流改用橋面疊合」一起移除，兩個來源現在本來
//   就該一致（實測只剩 6 點 ≤0.1m 的取樣內插誤差）。原本的對照組「舊來源真的會
//   沉入橋面下」因此失去前提，改成斷言兩者一致；主張仍是 surfaceHeightAt 必須
//   就是橋面高度。
// 方法：與 app 相同管線建底圖 → 建 ElevatedLayer（不需 GL context，mesh 幾何是純算）
//   → 對每條高架路段沿線比對 deckHeightAt（新來源）與 heightAtPos（舊來源）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildElevation, setActiveElevation } from '../src/core/elevation'
import { ElevatedLayer, setActiveElevatedLayer, surfaceHeightAt } from '../src/core/elevated3d'
import { pointAlong, cumulative } from '../src/core/geo'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

// 2026-08-05：原本讀 lanepilot 的兩份 shard，那是舊資料集（8776 區塊、高架 125），
// app 實際載入的是唯一靜態資料庫 road_database.json（11114 區塊、高架 150）——
// 對著舊 shard 跑會漏掉新進清單的高架，綠燈也證明不了現場。改讀同一份資料。
const db = JSON.parse(readFileSync(join(DATA, 'road_database.json'), 'utf8')) as {
  segments: unknown[]
  editor?: { journal?: EnhancementRecord[] }
}
const parsedDb = parseImported(db.segments.map((r) => JSON.stringify(r)).join('\n'))
if (parsedDb.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsedDb.fc))
applyToRoads(roads, foldJournal(db.editor?.journal ?? []))

const model = buildElevation(roads)
setActiveElevation(model)
const layer = new ElevatedLayer()
layer.setModel(model)
setActiveElevatedLayer(layer)
const elevated = roads.filter((r) => r.properties.elevated)
console.log(`底圖：${roads.length} 區塊，其中高架 ${elevated.length}`)
check('高架區塊有建立', elevated.length > 0, `${elevated.length} 區塊`)

// 沿每條高架路段每 5m 取樣，比對新舊高度來源
let withDeck = 0, samples = 0, sunk = 0, maxSink = 0, maxLift = 0
const worst: string[] = []
for (const r of elevated) {
  const cs = r.geometry.coordinates as [number, number][]
  if (cs.length < 2) continue
  const cum = cumulative(cs)
  const deckAt0 = layer.deckHeightAt(r, cs[0])
  if (deckAt0 === null) continue // 這條沒建橋面（dB-dA 太短）
  withDeck++
  let wSink = 0
  for (let d = 0; d <= cum[cum.length - 1]; d += 5) {
    const { pos } = pointAlong(cs, cum, d)
    const deck = layer.deckHeightAt(r, pos)
    if (deck === null) continue
    const old = model.heightAtPos(r, pos)
    samples++
    // old < deck ⇒ 舊來源把路線帶畫在橋面下（0.1m 以上就會被擋掉）
    if (old < deck - 0.1) { sunk++; wSink = Math.max(wSink, deck - old) }
    maxSink = Math.max(maxSink, deck - old)
    maxLift = Math.max(maxLift, old - deck)
    // 新來源必須就是橋面高度
    if (Math.abs(surfaceHeightAt(r, pos) - deck) > 1e-6) {
      worst.push(`surfaceHeightAt ≠ 橋面 @${r.properties.name ?? r.properties.osm_id}`)
    }
  }
  if (wSink > 0.5) {
    worst.push(`${r.properties.name ?? '(無名)'} way/${r.properties.osm_id}` +
      ` (${r.properties.highway})：舊來源最多沉入 ${wSink.toFixed(1)}m`)
  }
}
console.log(`取樣 ${samples} 點（有橋面的高架區塊 ${withDeck}/${elevated.length}）`)
console.log(`舊來源（ElevationModel.heightAtPos）低於橋面的點：${sunk}（最深 ${maxSink.toFixed(1)}m）、` +
  `高於橋面最多 ${maxLift.toFixed(1)}m`)
for (const w of worst.slice(0, 10)) console.log('   ' + w)
check('橋面高度與 ElevationModel 一致（高度域不再重映射）',
  maxSink <= 0.3 && maxLift <= 0.3,
  `最深沉入 ${maxSink.toFixed(2)}m、最高浮起 ${maxLift.toFixed(2)}m（門檻 0.3m）`
  + `｜低於橋面的點 ${sunk}/${samples}`)
check('新來源 surfaceHeightAt 與橋面完全一致',
  !worst.some((w) => w.startsWith('surfaceHeightAt')))

console.log(fails === 0 ? '✅ 全數通過' : `❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
