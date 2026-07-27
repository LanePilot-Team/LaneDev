// 路線帶（藍線）橫向行為審計（npx tsx scripts/band_audit.ts）：
// 2026-07-25 導航指引線修正的回歸驗證——
//   1. 分流偵測：下匝道/左右分道（轉角 ≤25°、不產生 maneuver）要有 diverge 標記
//   2. 提前變道：分流鼻端前就要切到正確側車道，不是到了鼻端才橫切
//   3. 無橫向直角：整條帶的橫向變化率（Δ橫移/Δ里程）不得超過 MAX_RATE
// 對照組 oldOffsets() 重現修改前的演算法（巡航 = span.offM 直接跳、進彎固定 45m、
// 無分流處理），同一批路線 A/B，數字才有意義。
// 底圖管線與 app 相同（prepareBaseRoads + seed journal）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported, mergeMaps } from '../src/core/importmap'
import { roadsFromGeoJSON } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { RoadGraph, laneBand, LANE_CHANGE_M, type RouteResult } from '../src/core/graph'
import { pointAlong, bearing, LANE_WIDTH_M } from '../src/core/geo'
import { foldJournal, applyToRoads, type EnhancementRecord } from '../src/core/enhancements'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '../public/data')

let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!ok) fails++
}

// ── 底圖 ──
const shards = ['lanepilot/area_4212599.segments.jsonl', 'lanepilot/area_4212683.segments.jsonl']
  .map((f) => parseImported(readFileSync(join(DATA, f), 'utf8')))
  .filter((p) => p.kind === 'map') as { kind: 'map'; fc: never }[]
const fc = mergeMaps(shards).fc
const { roads } = prepareBaseRoads(roadsFromGeoJSON(fc))
const seed: EnhancementRecord[] = JSON.parse(readFileSync(join(DATA, 'seed_journal.json'), 'utf8'))
applyToRoads(roads, foldJournal(seed))
const graph = new RoadGraph(roads)
console.log(`底圖：${roads.length} 區塊`)

/**
 * 帶上每個取樣點相對路線中心線的橫向偏移（右正）——量幾何本身，不看內部變數：
 * 把「帶點 − 路線點」投影到該處的右向單位向量。
 */
function bandOffsets(route: RouteResult): { d: number; off: number }[] {
  const band = laneBand(route)
  return band.coords.map((c, i) => {
    const d = band.routeD[i]
    const { pos, brg } = pointAlong(route.coords, route.cum, d)
    const kx = 111320 * Math.cos((pos[1] * Math.PI) / 180), ky = 110540
    const ex = (c[0] - pos[0]) * kx, ny = (c[1] - pos[1]) * ky
    const rad = ((brg + 90) * Math.PI) / 180
    return { d, off: ex * Math.sin(rad) + ny * Math.cos(rad) }
  })
}

/** 對照組：修改前的偏移演算法（同樣的取樣里程） */
function oldOffsets(route: RouteResult, ds: number[]): number[] {
  const EXIT_MERGE_M = 25
  const mans = route.maneuvers.filter((m) => m.kind !== 'arrive')
  const out: number[] = []
  let si = 0, mi = 0
  for (const d of ds) {
    const { idx } = pointAlong(route.coords, route.cum, d)
    while (si < route.spans.length - 1 && route.spans[si].toIdx < idx) si++
    const span = route.spans[si]
    let off = span?.offM ?? 0
    if (span) {
      while (mi < mans.length && mans[mi].distM < d - 0.5) mi++
      const next = mi < mans.length ? mans[mi] : null
      const prev = mi > 0 ? mans[mi - 1] : null
      let entering = false
      if (next) {
        const hasBayWin = (next.bayOffM ?? next.rightOffM) !== undefined && next.bayMouthM !== undefined
        const rampStart = hasBayWin ? next.bayMouthM! + (next.bayTaperM ?? 15) : LANE_CHANGE_M
        const rampEnd = hasBayWin ? next.bayMouthM! : LANE_CHANGE_M * 0.4
        const gap = next.distM - d
        if (gap <= rampStart) {
          const t = Math.min(1, Math.max(0, (rampStart - gap) / Math.max(1, rampStart - rampEnd)))
          const tgt = next.kind === 'right' || next.kind === 'slight-right' ? next.rightOffM ?? span.rightM
            : next.kind === 'left' || next.kind === 'slight-left' || next.kind === 'uturn'
              ? (next.twoStage ? span.rightM : next.bayOffM ?? span.leftM) : span.offM
          off = span.offM + (tgt - span.offM) * t
          entering = true
        }
      }
      if (!entering && prev) {
        const e = d - prev.distM
        if (e < EXIT_MERGE_M) {
          const from = prev.kind === 'right' || prev.kind === 'slight-right' || prev.twoStage ? span.rightM
            : prev.kind === 'left' || prev.kind === 'slight-left' || prev.kind === 'uturn' ? span.leftM
            : span.offM
          off = from + (span.offM - from) * Math.max(0, e / EXIT_MERGE_M)
        }
      }
    }
    out.push(off)
  }
  return out
}

/** 橫向變化率超過這個值就是「直角橫切」（1:4 已經比法規漸變段陡很多） */
const MAX_RATE = 0.25
/** 轉向點本身路線幾何就有折角，橫向偏移在那裡換座標系——這個範圍內不算折點 */
const CORNER_SKIP_M = 10

function kinks(route: RouteResult, ds: number[], offs: number[]): { d: number; rate: number }[] {
  const corners = route.maneuvers.filter((m) => m.kind !== 'arrive').map((m) => m.distM)
  const out: { d: number; rate: number }[] = []
  for (let i = 1; i < ds.length; i++) {
    const dd = ds[i] - ds[i - 1]
    if (dd < 0.5) continue
    if (corners.some((c) => ds[i] > c - CORNER_SKIP_M && ds[i - 1] < c + CORNER_SKIP_M)) continue
    const rate = Math.abs(offs[i] - offs[i - 1]) / dd
    if (rate > MAX_RATE) out.push({ d: ds[i], rate })
  }
  return out
}

/** laneBand 的 span 選法（依頂點 index），審計要用同一套才問得出「當時的目標車道」 */
function spanAt(route: RouteResult, d: number): RouteResult['spans'][number] {
  const { idx } = pointAlong(route.coords, route.cum, d)
  let si = 0
  while (si < route.spans.length - 1 && route.spans[si].toIdx < idx) si++
  return route.spans[si]
}

// ── 取樣路線 ──
const pts: [number, number][] = graph.intersections().map((i) => i.pos)
for (const r of roads) {
  const cs = r.geometry.coordinates as [number, number][]
  pts.push(cs[Math.floor(cs.length / 2)])
}
let s = 42
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648

const N = 300
const routes: RouteResult[] = []
for (let i = 0; i < N; i++) {
  const a = pts[Math.floor(rnd() * pts.length)]
  const b = pts[Math.floor(rnd() * pts.length)]
  if (a === b) continue
  const r = graph.route(a, b, 'car')
  if (r && r.lengthM > 300) routes.push(r)
}
console.log(`取樣路線：${routes.length} 條`)

// ── 1. 分流偵測 ──
const withDiv = routes.filter((r) => r.diverges.length > 0)
const divTotal = routes.reduce((n, r) => n + r.diverges.length, 0)
const linkDiv = routes.filter((r) => r.spans.some((sp) => sp.road?.properties.highway.endsWith('_link')))
console.log(`分流點：${divTotal} 個（${withDiv.length}/${routes.length} 條路線有）；` +
  `含匝道路段的路線 ${linkDiv.length} 條`)
check('有偵測到分流點', divTotal > 0, `${divTotal} 個`)

// 交流道匝道（高快速道路等級）必須在進匝道前有指引。
// 註：tertiary_link 在本區資料多半是與母路重疊的巷口引道（Δ≈0°、無左右之分），
// 不在此列——那裡沒有「該切哪邊」可言。
const RAMP = new Set(['motorway_link', 'trunk_link', 'primary_link'])
// 節點座標 → id（只有鄰接 ≥3 的才是路口；其餘節點必無岔路）
const nodeAt = new Map(graph.intersections().map((i) => [`${i.pos[0]},${i.pos[1]}`, i.id]))
let rampRoutes = 0, rampMarked = 0
for (const r of routes) {
  for (let i = 0; i < r.spans.length; i++) {
    const cur = r.spans[i].road, prv = i > 0 ? r.spans[i - 1].road : undefined
    if (!cur || !prv) continue
    if (!RAMP.has(cur.properties.highway) || RAMP.has(prv.properties.highway)) continue
    // 該節點要真的有選擇（≥2 條可走的出邊）才談得上「該切哪邊」；
    // 主線直接收束成匝道的續行節點沒有岔路，不列入
    const ii = r.spans[i - 1].toIdx
    const id = nodeAt.get(`${r.coords[ii][0]},${r.coords[ii][1]}`)
    const inBrg = bearing(r.coords[ii - 1], r.coords[ii])
    if (id === undefined || graph.alternativesAt(id, inBrg, 'car').length < 2) continue
    rampRoutes++
    const at = r.cum[r.spans[i - 1].toIdx]
    const marked = r.diverges.some((g) => Math.abs(g.distM - at) < 2) ||
      r.maneuvers.some((m) => Math.abs(m.distM - at) < 2 && m.kind !== 'arrive')
    if (marked) rampMarked++
    break
  }
}
check('交流道匝道處有指引（分流或轉向）', rampRoutes > 0 && rampMarked === rampRoutes,
  `${rampMarked}/${rampRoutes}`)

// ── 2. 提前變道：分流點前就位 ──
let early = 0, late = 0
const lateEx: string[] = []
for (const r of routes) {
  const os = bandOffsets(r)
  for (const g of r.diverges) {
    const sp = spanAt(r, g.distM - 1) // 鼻端上游那一段
    const target = g.side === 'right' ? sp.rightM : sp.leftM
    // 鼻端前 15m 應該已經在目標車道（容差半個車道）
    const at = os.filter((o) => o.d > g.distM - 18 && o.d <= g.distM).pop()
    if (!at) continue
    if (Math.abs(at.off - target) <= LANE_WIDTH_M / 2) early++
    else { late++; if (lateEx.length < 5) lateEx.push(`${g.side} @${Math.round(g.distM)}m off=${at.off.toFixed(1)} 目標=${target.toFixed(1)}`) }
  }
}
check('分流鼻端前已在目標車道', late === 0, `就位 ${early}、未就位 ${late}`)
for (const e of lateEx) console.log('   ' + e)

// 提前量：從「切到定位」到鼻端還有多遠（使用者的抱怨就是這個值太小）
const leads: { m: number; hw: string; room: number }[] = []
for (const r of routes) {
  const os = bandOffsets(r)
  for (const g of r.diverges) {
    const sp = spanAt(r, g.distM - 1)
    const target = g.side === 'right' ? sp.rightM : sp.leftM
    let from: number | null = null
    for (const o of os) {
      if (o.d > g.distM) break
      if (Math.abs(o.off - target) <= 0.5) { if (from === null) from = o.d } else from = null
    }
    if (from !== null) {
      // room = 上一個匝道交織點到鼻端的距離（沒有交織點 = 不受限）
      const w = Math.max(0, ...r.weaves.filter((x) => x < g.distM - 1))
      leads.push({
        m: g.distM - from,
        hw: sp.road?.properties.highway ?? '?',
        room: w > 0 ? g.distM - w : Infinity,
      })
    }
  }
}
const byClass = new Map<string, number[]>()
for (const l of leads) byClass.set(l.hw, [...(byClass.get(l.hw) ?? []), l.m])
for (const [hw, ms] of [...byClass].sort()) {
  ms.sort((a, b) => a - b)
  console.log(`   提前量 ${hw}：中位 ${Math.round(ms[ms.length >> 1])}m（${Math.round(ms[0])}–${Math.round(ms[ms.length - 1])}m，n=${ms.length}）`)
}
// 設計值 = 速率 × DIVERGE_SETTLE_S（60km/h → 167m）。前面有匝道交織點時提前量會被
// 刻意夾短（長途過兩個交流道才下去，早於前一個交流道切出去等於掛在別人的匝道上），
// 所以門檻取「設計值」與「交織點到鼻端的距離」兩者較小者。
const fast = leads.filter((l) => l.hw === 'motorway' || l.hw === 'trunk' || l.hw === 'primary')
const shortfall = fast.filter((l) => l.m < Math.min(150, l.room * 0.7))
check('快速道路分流提前量足夠', fast.length > 0 && shortfall.length === 0,
  `n=${fast.length}、不足 ${shortfall.length}（受交織點限制 ${fast.filter((l) => l.room < 250).length} 例）`)

// 交織點約束：經過交織點時，還不能已經切過去一半以上
let weaveViol = 0, weaveCases = 0
const weaveEx: string[] = []
for (const r of routes) {
  if (r.weaves.length === 0) continue
  const os = bandOffsets(r)
  for (const g of r.diverges) {
    // 只看「真的會綁住提前量」的交織點（500m 內）
    const near = r.weaves.filter((x) => x < g.distM - 1 && x > g.distM - 500)
    if (!near.length) continue
    const w = Math.max(...near)
    // 交織點附近另有轉向/其他分流 → 那裡的橫移本來就該發生，不算
    if (r.maneuvers.some((m) => m.kind !== 'arrive' && Math.abs(m.distM - w) < 80)) continue
    if (r.diverges.some((x) => x !== g && Math.abs(x.distM - w) < 80)) continue
    const sw = spanAt(r, w)
    const target = g.side === 'right' ? sw.rightM : sw.leftM
    if (Math.abs(target - sw.offM) < 0.2) continue // 該處沒有別的車道可切
    const o = os.find((x) => x.d >= w - 3)
    if (!o) continue
    weaveCases++
    // 交織點就是路段交界，巡航偏移本來就會在此漸變（車道數/路寬改變）——
    // 落在前後兩段巡航值之間都算「還在巡航車道」，不是提前切出
    const cru = [spanAt(r, Math.max(0, w - 12)).offM, sw.offM]
    const lo = Math.min(...cru), hi = Math.max(...cru)
    const base = o.off > hi ? hi : o.off < lo ? lo : o.off
    const progress = (base - sw.offM) / (target - sw.offM) // 1 = 已完全切到目標車道
    if (progress > 0.5) {
      weaveViol++
      if (weaveEx.length < 5) {
        weaveEx.push(`分流@${Math.round(g.distM)} 交織點@${Math.round(w)}` +
          ` 已切出 ${(progress * 100).toFixed(0)}%（off ${o.off.toFixed(1)}、巡航 ${lo.toFixed(1)}~${hi.toFixed(1)}、目標 ${target.toFixed(1)}）`)
      }
    }
  }
}
check('經過匝道交織點時尚未切出', weaveViol === 0, `檢查 ${weaveCases} 例、違反 ${weaveViol}`)
for (const e of weaveEx) console.log('   ' + e)

// ── 3. 橫向直角（A/B）──
let oldK = 0, newK = 0, oldMax = 0, newMax = 0
const newEx: string[] = []
for (const r of routes) {
  const os = bandOffsets(r)
  const ds = os.map((o) => o.d)
  const nOff = os.map((o) => o.off)
  const oOff = oldOffsets(r, ds)
  const kn = kinks(r, ds, nOff), ko = kinks(r, ds, oOff)
  newK += kn.length; oldK += ko.length
  for (const k of kn) newMax = Math.max(newMax, k.rate)
  for (const k of ko) oldMax = Math.max(oldMax, k.rate)
  if (kn.length && newEx.length < 5) {
    newEx.push(`@${Math.round(kn[0].d)}m 變化率 ${kn[0].rate.toFixed(2)}（路線長 ${Math.round(r.lengthM)}m）`)
  }
}
console.log(`橫向直角（>${MAX_RATE}）：修改前 ${oldK} 處（最陡 ${oldMax.toFixed(2)}）→ 修改後 ${newK} 處（最陡 ${newMax.toFixed(2)}）`)
for (const e of newEx) console.log('   ' + e)
check('橫向折點明顯減少', newK < oldK / 2, `${oldK} → ${newK}`)

console.log(fails === 0 ? '✅ 全數通過' : `❌ ${fails} 項未通過`)
process.exit(fails === 0 ? 0 : 1)
