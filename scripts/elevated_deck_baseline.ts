// 高架橋面基準快照（npm run audit:deck-baseline [-- --write]）
//
// 動 elevated3d 之前先把「每個高架區塊餵給橋面建構的所有數值」записа下來，
// 改完再跑一次比對。只要基準沒變，中山高／楠陽高架／德民新橋等既有橋面就
// 不可能被波及——橋面幾何完全由這些值決定（見 elevated3d 的 secs/edge 計算）。
//
// 記錄的欄位就是 elevated3d 實際會讀的：
//   width_m（→ halfW）、layer（→ hM）、lenM、沿線高度剖面、接地端收窄 gw0/gw1
//
// 用法：
//   npm run audit:deck-baseline -- --write   建立/更新基準檔
//   npm run audit:deck-baseline              與基準檔比對，有差異就列出並回傳 1
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { buildElevation } from '../src/core/elevation'
import { cumulative } from '../src/core/geo'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'elevated_deck_baseline.json')
const write = process.argv.includes('--write')

const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
applyToRoads(roads, foldJournal(db.editor?.journal ?? []))
const active = roads.filter((r) => !r.properties.deleted)
const model = buildElevation(active)

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** 每個高架區塊的橋面輸入指紋 */
const snapshot: Record<string, unknown> = {}
for (const { road, lenM, hM } of model.entries()) {
  const p = road.properties
  const key = `way/${p.osm_id}@b/${p.blockNode ?? '-'}`
  const taper = model.groundTaper(road)
  // 沿線 11 點高度剖面（端點必取，中間等分）
  const hs: number[] = []
  for (let i = 0; i <= 10; i++) hs.push(r3(model.heightAt(road, (lenM * i) / 10)))
  snapshot[key] = {
    name: p.name ?? null,
    widthM: r3(p.width_m),
    lanesF: p.lanesForward,
    lanesB: p.lanesBackward,
    centerM: r3(p.centerM ?? 0),
    layer: p.layer,
    lenM: r3(lenM),
    hM: r3(hM),
    gw0: taper.gw0 === undefined ? null : r3(taper.gw0),
    gw1: taper.gw1 === undefined ? null : r3(taper.gw1),
    heights: hs,
  }
}

const keys = Object.keys(snapshot).sort()
console.log(`高架區塊 ${keys.length} 個`)

if (write) {
  // 排序後重建物件再序列化。不可用 JSON.stringify 的第二參數排序——那是
  // replacer 白名單，會把不在清單裡的巢狀欄位一併濾掉，基準檔會變空殼。
  const sorted: Record<string, unknown> = {}
  for (const k of keys) sorted[k] = snapshot[k]
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  console.log(`✓ 基準已寫入 ${BASELINE.split(/[\\/]/).pop()}`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.log('✗ 找不到基準檔，先跑：npm run audit:deck-baseline -- --write')
  process.exit(1)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>
const baseKeys = Object.keys(base).sort()
const added = keys.filter((k) => !(k in base))
const removed = baseKeys.filter((k) => !(k in snapshot))
const changed: string[] = []
for (const k of keys) {
  if (!(k in base)) continue
  if (JSON.stringify(base[k]) !== JSON.stringify(snapshot[k])) changed.push(k)
}

const nameOf = (k: string, src: Record<string, unknown>) =>
  (src[k] as { name?: string } | undefined)?.name ?? '(無名)'

if (added.length) {
  console.log(`\n新增 ${added.length} 個高架區塊：`)
  for (const k of added.slice(0, 20)) console.log(`  + ${k}  ${nameOf(k, snapshot)}`)
}
if (removed.length) {
  console.log(`\n消失 ${removed.length} 個高架區塊：`)
  for (const k of removed.slice(0, 20)) console.log(`  - ${k}  ${nameOf(k, base)}`)
}
if (changed.length) {
  console.log(`\n數值變動 ${changed.length} 個區塊：`)
  for (const k of changed.slice(0, 20)) {
    console.log(`  ~ ${k}  ${nameOf(k, snapshot)}`)
    const a = base[k] as Record<string, unknown>
    const b = snapshot[k] as Record<string, unknown>
    for (const f of Object.keys(b)) {
      if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue
      console.log(`      ${f}: ${JSON.stringify(a[f])} → ${JSON.stringify(b[f])}`)
    }
  }
}

const total = added.length + removed.length + changed.length
console.log(total === 0
  ? '\n✅ 與基準完全一致——既有橋面未受影響'
  : `\n⚠ 共 ${total} 個區塊與基準不同（新增 ${added.length}／消失 ${removed.length}／變動 ${changed.length}）`)
process.exit(total === 0 ? 0 : 1)
