// 高架雙向合體審計（npx tsx scripts/median_audit.ts）：
// 2026-07-25 「中山高兩向黏在一起、中間用分隔隔開」的回歸驗證。
// 方法：直接量產出來的橋面三角形——從一側車行道中心線往對向掃一條垂線，
//   逐步檢查每個位置是否被橋面覆蓋。合體成功 = 一路連續蓋到中線（且過中線）。
// 對照組：把 motorway 的 oneway 暫時改成 'no'（合體條件之一），重建一次橋面——
//   合體關閉時同一條垂線必須出現空洞，否則這個量測沒有鑑別力。
// 匝道保護：motorway_link 不在合體名單內，其橋面/護欄計算式與修改前逐項等價
//   （edge() 在未配對時 ≡ ±halfW×r、護欄內縮 0.12×r），此處另檢查匝道橋面仍完整。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import maplibregl from 'maplibre-gl'
import { parseImported, mergeMaps } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { buildElevation } from '../src/core/elevation'
import { ElevatedLayer } from '../src/core/elevated3d'
import { NANZI_CENTER, COS_LAT, cumulative, pointAlong } from '../src/core/geo'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')
const KX = 111320 * COS_LAT, KY = 110540

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

const shards = ['lanepilot/area_4212599.segments.jsonl', 'lanepilot/area_4212683.segments.jsonl']
  .map((f) => parseImported(readFileSync(join(DATA, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: never }[]
const { roads } = prepareBaseRoads(roadsFromGeoJSON(mergeMaps(shards).fc))
const seed: EnhancementRecord[] = JSON.parse(readFileSync(join(DATA, 'seed_journal.json'), 'utf8'))
applyToRoads(roads, foldJournal(seed))
const model = buildElevation(roads)

// 場景座標換算（與 ElevatedLayer.toScene 同一套錨點）
const originMerc = maplibregl.MercatorCoordinate.fromLngLat(
  { lng: NANZI_CENTER[0], lat: NANZI_CENTER[1] }, 0)
const mercScale = originMerc.meterInMercatorCoordinateUnits()
function toScene(lng: number, lat: number): [number, number] {
  const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, 0)
  return [(mc.x - originMerc.x) / mercScale, -(mc.y - originMerc.y) / mercScale]
}

type Tri = { x: [number, number, number]; z: [number, number, number]; y: number }

/** 建一次橋面，取出「橋面鋪面」mesh 的三角形（場景 x/z 平面 + 平均高度） */
function buildDeckTris(): Tri[] {
  const layer = new ElevatedLayer()
  layer.setModel(model)
  const group = (layer as unknown as { group: THREE.Group }).group
  const mesh = group.children[0] as THREE.Mesh // add() 順序：deck 最先
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const out: Tri[] = []
  for (let i = 0; i + 2 < pos.count; i += 3) {
    out.push({
      x: [pos.getX(i), pos.getX(i + 1), pos.getX(i + 2)],
      z: [pos.getZ(i), pos.getZ(i + 1), pos.getZ(i + 2)],
      y: (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3,
    })
  }
  return out
}

/** 場景點是否落在任一橋面三角形內（高度需相符，避免匝道從上方/下方交叉誤判） */
function covered(tris: Tri[], x: number, z: number, y: number): boolean {
  for (const t of tris) {
    if (Math.abs(t.y - y) > 1.5) continue
    if (x < Math.min(...t.x) - 0.01 || x > Math.max(...t.x) + 0.01) continue
    if (z < Math.min(...t.z) - 0.01 || z > Math.max(...t.z) + 0.01) continue
    const [x0, x1, x2] = t.x, [z0, z1, z2] = t.z
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
    if (Math.abs(d) < 1e-9) continue
    const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d
    const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d
    const c = 1 - a - b
    if (a >= -0.02 && b >= -0.02 && c >= -0.02) return true
  }
  return false
}

function proj(p: [number, number], cs: [number, number][]) {
  let best = { d: Infinity, q: cs[0] }
  for (let i = 1; i < cs.length; i++) {
    const ax = (p[0] - cs[i - 1][0]) * KX, ay = (p[1] - cs[i - 1][1]) * KY
    const vx = (cs[i][0] - cs[i - 1][0]) * KX, vy = (cs[i][1] - cs[i - 1][1]) * KY
    const L2 = vx * vx + vy * vy
    const t = L2 > 0 ? Math.max(0, Math.min(1, (ax * vx + ay * vy) / L2)) : 0
    const d = Math.hypot(ax - vx * t, ay - vy * t)
    if (d < best.d) {
      best = { d, q: [cs[i - 1][0] + (cs[i][0] - cs[i - 1][0]) * t, cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * t] }
    }
  }
  return best
}

const mainline = roads.filter((r) =>
  r.properties.elevated && r.properties.highway === 'motorway' && r.geometry.coordinates.length >= 2)
console.log(`motorway 高架區塊：${mainline.length}`)

/** 取樣點：每條本線每 40m 一點，找出對向並排的另一半與間距 */
interface Probe { road: RoadFeature; pos: [number, number]; gap: number; toward: [number, number]; h: number }
const probes: Probe[] = []
for (const a of mainline) {
  const ca = a.geometry.coordinates as [number, number][]
  const cum = cumulative(ca)
  for (let d = 20; d < cum[cum.length - 1]; d += 40) {
    const { pos } = pointAlong(ca, cum, d)
    let best: { gap: number; q: [number, number] } | null = null
    for (const b of mainline) {
      if (b === a || b.properties.nodes.some((n) => a.properties.nodes.includes(n))) continue
      const hit = proj(pos, b.geometry.coordinates as [number, number][])
      if (hit.d < 34 && (!best || hit.d < best.gap)) best = { gap: hit.d, q: hit.q as [number, number] }
    }
    if (!best) continue
    const h = model.heightAtPos(a, pos)
    if (h < 1) continue // 接地爬升段：兩向本來就各自落地
    probes.push({ road: a, pos, gap: best.gap, toward: best.q, h })
  }
}
console.log(`並排取樣點：${probes.length}（間距 ${Math.min(...probes.map((p) => p.gap)).toFixed(1)}~${Math.max(...probes.map((p) => p.gap)).toFixed(1)}m）`)
check('找得到對向並排的本線', probes.length > 50, `${probes.length} 點`)

/** 從中心線往對向掃，回傳「連續被橋面覆蓋」到多遠（公尺） */
function reach(tris: Tri[], p: Probe): number {
  const dirE = ((p.toward[0] - p.pos[0]) * KX) / p.gap
  const dirN = ((p.toward[1] - p.pos[1]) * KY) / p.gap
  let last = 0
  for (let s = 0; s <= p.gap; s += 0.5) {
    const lng = p.pos[0] + (dirE * s) / KX, lat = p.pos[1] + (dirN * s) / KY
    const [x, n] = toScene(lng, lat)
    if (!covered(tris, x, -n, p.h)) break
    last = s
  }
  return last
}

const trisOn = buildDeckTris()
// 對照組：關閉合體條件（oneway 改 'no'）重建
const saved = mainline.map((r) => r.properties.oneway)
for (const r of mainline) r.properties.oneway = 'no'
const trisOff = buildDeckTris()
mainline.forEach((r, i) => { r.properties.oneway = saved[i] })

// 分類：中線離橋面邊緣 >MEDIAN_EXTRA_MAX_M（5m）的地方是刻意不合體的
// （兩向真的分開了，中間常是匝道穿越區，硬鋪過去會蓋掉匝道）
const MEDIAN_EXTRA_MAX_M = 5
let okOn = 0, okOff = 0, mergeable = 0, okMergeable = 0
const sumOn: number[] = [], sumOff: number[] = []
const wideGaps: number[] = []
for (const p of probes) {
  const rOn = reach(trisOn, p), rOff = reach(trisOff, p)
  sumOn.push(rOn / (p.gap / 2))
  sumOff.push(rOff / (p.gap / 2))
  const hit = rOn >= p.gap / 2 - 0.6
  if (hit) okOn++
  if (rOff >= p.gap / 2 - 0.6) okOff++
  if (p.gap / 2 - p.road.properties.width_m / 2 <= MEDIAN_EXTRA_MAX_M) {
    mergeable++
    if (hit) okMergeable++
  } else if (!hit) wideGaps.push(p.gap)
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
console.log(`橋面自中心線往對向的連續覆蓋（1.0 = 剛好到中線）：` +
  `合體後平均 ${mean(sumOn).toFixed(2)}、合體前平均 ${mean(sumOff).toFixed(2)}`)
console.log(`可合體取樣 ${mergeable}/${probes.length}；` +
  `刻意不合體（間距過寬）${wideGaps.length} 點` +
  (wideGaps.length ? `，間距 ${Math.min(...wideGaps).toFixed(1)}~${Math.max(...wideGaps).toFixed(1)}m` : ''))
check('可合體處橋面連續蓋到中線（兩向黏在一起）',
  mergeable > 50 && okMergeable === mergeable, `${okMergeable}/${mergeable} 點`)
check('對照組確實有天窗（量測有鑑別力）',
  okOff <= probes.length * 0.1, `合體前只有 ${okOff}/${probes.length} 點蓋到中線`)

// 同一區塊內若合體/不合體混雜，橋面寬度會在中途出現階梯——列出來人工判斷
const byRoad = new Map<RoadFeature, { hit: number; miss: number; gaps: number[] }>()
for (const p of probes) {
  const rec = byRoad.get(p.road) ?? { hit: 0, miss: 0, gaps: [] }
  if (reach(trisOn, p) >= p.gap / 2 - 0.6) rec.hit++
  else { rec.miss++; rec.gaps.push(p.gap) }
  byRoad.set(p.road, rec)
}
const mixed = [...byRoad].filter(([, v]) => v.hit > 0 && v.miss > 0)
console.log(`區塊層級：全合體 ${[...byRoad].filter(([, v]) => v.miss === 0).length}、` +
  `全分離 ${[...byRoad].filter(([, v]) => v.hit === 0).length}、混雜 ${mixed.length}`)
for (const [r, v] of mixed.slice(0, 6)) {
  console.log(`   way/${r.properties.osm_id} 寬${r.properties.width_m}m` +
    ` 合體${v.hit}/分離${v.miss}（分離處間距 ${Math.min(...v.gaps).toFixed(1)}~${Math.max(...v.gaps).toFixed(1)}m）`)
}

// 匝道：橋面仍完整（合體不該動到匝道——它們不在 carriages 名單內）
const links = roads.filter((r) =>
  r.properties.elevated && r.properties.highway === 'motorway_link' && r.geometry.coordinates.length >= 2)
let linkPts = 0, linkCovered = 0
for (const r of links) {
  const cs = r.geometry.coordinates as [number, number][]
  const cum = cumulative(cs)
  for (let d = 10; d < cum[cum.length - 1]; d += 25) {
    const { pos } = pointAlong(cs, cum, d)
    const h = model.heightAtPos(r, pos)
    if (h < 1) continue
    const [x, n] = toScene(pos[0], pos[1])
    linkPts++
    if (covered(trisOn, x, -n, h)) linkCovered++
  }
}
console.log(`匝道橋面取樣 ${linkPts} 點，中心線被橋面覆蓋 ${linkCovered}`)
check('匝道橋面仍完整（樣式未被破壞）',
  linkPts > 0 && linkCovered >= linkPts * 0.9, `${linkCovered}/${linkPts}`)

console.log(fails === 0 ? '✅ 全數通過' : `❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
