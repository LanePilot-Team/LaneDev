// 側高架貼齊稽核（npm run audit:side-lane-hug）
//
// fixups.SIDE_LANE_HUG 把平行的獨立機車專用高架橫移貼到主橋旁。這支腳本走真實
// 載入管線量三件事：
//   1. 貼齊後的邊緣淨距（分隔墩寬）——用「套完 journal 的最終寬度」算，因為主橋
//      車道數來自 journal，管線中途的寬度是舊值。offsetM 是寫死的常數，車道數
//      日後若改動這裡就會紅，提醒同步調整。
//   2. 橋頭共用節點有沒有跟著移動（沒有的話橋頭會裂開）。
//   3. 貼齊後兩座橋面沒有互相壓進去。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseImported } from '../src/core/importmap'
import { roadsFromGeoJSON, type RoadFeature } from '../src/core/roads'
import { prepareBaseRoads } from '../src/core/pipeline'
import { foldJournal, applyToRoads } from '../src/core/enhancements'
import { haversine, cumulative, pointAlong } from '../src/core/geo'
import { buildElevation } from '../src/core/elevation'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = JSON.parse(readFileSync(join(HERE, '../public/data/road_database.json'), 'utf8'))
const parsed = parseImported(db.segments.map((r: unknown) => JSON.stringify(r)).join('\n'))
if (parsed.kind !== 'map') throw new Error('靜態資料庫格式錯誤')

const rawRoads = roadsFromGeoJSON(parsed.fc)
const rawGeom = new Map<number, [number, number][]>()
for (const r of rawRoads) {
  if (!rawGeom.has(r.properties.osm_id)) {
    rawGeom.set(r.properties.osm_id, r.geometry.coordinates.map((c) => [...c] as [number, number]))
  }
}
const { roads } = prepareBaseRoads(roadsFromGeoJSON(parsed.fc))
// 寬度必須是套完 journal 的最終值——主橋 2+2（管線）vs 3+3（journal）差 6.4m
applyToRoads(roads, foldJournal(db.editor?.journal ?? []))

const CASES = [
  {
    wayId: 25724904, hostWayId: 23939182, offsetM: 11.5, wantGapM: 0,
    name: '高楠陸橋 機車專用道高架',
  },
]

const blocksOf = (id: number) => roads.filter((r) => r.properties.osm_id === id)
/** 點到折線的垂距（公尺） */
const perpTo = (p: [number, number], cs: [number, number][]) => {
  let best = Infinity
  for (let i = 0; i < cs.length - 1; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const q: [number, number] = [
        cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t,
      ]
      best = Math.min(best, haversine(p, q))
    }
  }
  return best
}

let fail = 0
for (const c of CASES) {
  const side = blocksOf(c.wayId)
  const host = blocksOf(c.hostWayId)
  console.log(`\n=== ${c.name}（way/${c.wayId} → way/${c.hostWayId}）===`)
  if (!side.length || !host.length) { console.log('  ✗ 找不到路段'); fail++; continue }

  const hostW = host[0].properties.width_m
  const sideW = side[0].properties.width_m
  const wantOffset = hostW / 2 + c.wantGapM + sideW / 2
  console.log(`  主橋 width_m=${hostW.toFixed(2)}（lanesF=${host[0].properties.lanesForward}`
    + `/lanesB=${host[0].properties.lanesBackward}、centerM=${host[0].properties.centerM}）`
    + `｜機車高架 width_m=${sideW.toFixed(2)}`)
  console.log(`  設定 offsetM=${c.offsetM}｜依最終寬度應為 ${wantOffset.toFixed(2)}`)
  if (Math.abs(wantOffset - c.offsetM) > 0.05) {
    console.log(`  ✗ offsetM 與最終寬度不一致（差 ${(wantOffset - c.offsetM).toFixed(2)} m）`
      + '——主橋車道數變過了，請同步改 fixups.SIDE_LANE_HUG')
    fail++
  } else {
    console.log('  ✓ offsetM 與最終寬度一致')
  }

  const hostCs = host.flatMap((b) => b.geometry.coordinates as [number, number][])
  const sidePts = side.flatMap((b) => b.geometry.coordinates as [number, number][])
  const before = (rawGeom.get(c.wayId) ?? []).map((p) => perpTo(p, rawGeom.get(c.hostWayId) ?? []))
  const after = sidePts.map((p) => perpTo(p, hostCs))
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
  console.log(`  貼齊前中線間距（對未合併的南下 way）：${avg(before).toFixed(2)} m`)
  console.log(`  貼齊後中線間距：${avg(after).toFixed(2)} m`
    + `（最小 ${Math.min(...after).toFixed(2)} / 最大 ${Math.max(...after).toFixed(2)}）`)
  const off = Math.max(...after.map((d) => Math.abs(d - c.offsetM)))
  if (off > 0.2) { console.log(`  ✗ 有頂點偏離 offsetM 達 ${off.toFixed(2)} m`); fail++ } else {
    console.log(`  ✓ 全部頂點落在 offsetM ±0.2 m 內（最大偏離 ${off.toFixed(3)} m）`)
  }
  // 齊平目標：淨距 0。正值 = 中間開天窗（看得穿）；負值 = 橋面互相壓入（z-fighting）
  const gaps = after.map((d) => d - hostW / 2 - sideW / 2)
  const worst = Math.max(...gaps.map(Math.abs))
  const ok = worst <= 0.2
  if (!ok) fail++
  console.log(`  → 兩橋面邊緣淨距：最小 ${Math.min(...gaps).toFixed(2)} /`
    + ` 最大 ${Math.max(...gaps).toFixed(2)} m`)
  console.log(`     ${ok ? '✓ 齊平（無天窗、無重疊）'
    : `✗ 偏離齊平 ${worst.toFixed(2)} m —— 正值是天窗、負值是橋面互壓`}`)
}

console.log('\n=== 橋頭裂縫（共用節點是否一起移動）===')
const nodeUse = new Map<number, Set<number>>()
for (const r of roads) {
  for (const n of r.properties.nodes) {
    if (!nodeUse.has(n)) nodeUse.set(n, new Set())
    nodeUse.get(n)!.add(r.properties.osm_id)
  }
}
for (const c of CASES) {
  const side = blocksOf(c.wayId)
  const ends = [side[0]?.properties.nodes[0],
    side[side.length - 1]?.properties.nodes.slice(-1)[0]].filter((n): n is number => n !== undefined)
  for (const n of ends) {
    const pts: [number, number][] = []
    for (const r of roads) {
      const i = r.properties.nodes.indexOf(n)
      if (i >= 0) pts.push(r.geometry.coordinates[i] as [number, number])
    }
    let maxGap = 0
    for (const p of pts) for (const q of pts) maxGap = Math.max(maxGap, haversine(p, q))
    const ok = maxGap < 0.05
    if (!ok) fail++
    console.log(`  node ${n}（${[...(nodeUse.get(n) ?? [])].join(',')}）`
      + ` 最大座標差 ${maxGap.toFixed(3)} m ${ok ? '✓ 無裂縫' : '✗ 裂開'}`)
  }
}

// ── 橋面接縫掃描 ──
// 中線距對了不代表畫面貼合：elevated3d 的橋面半寬是 width_m/2 × r，r 是接地端
// 收窄係數。這裡沿主橋每 10m 取樣，複製同一條算式量兩座橋面的實際邊緣間距。
// 正值 = 看得穿的天窗、負值 = 橋面互壓，兩者都是使用者看得到的缺陷。
console.log('\n=== 橋面接縫掃描（含接地端收窄 r）===')
const model = buildElevation(roads.filter((r) => !r.properties.deleted))
const TAPER_RANGE_M = 150
const LAYER_H = 6
const renderedHalf = (road: RoadFeature, d: number, lenM: number) => {
  const halfW = road.properties.width_m / 2
  const taper = model.groundTaper(road)
  const fr = Math.min(1, model.heightAt(road, d) / LAYER_H)
  let r = 1
  if (taper.gw0 !== undefined && d < TAPER_RANGE_M) {
    r = Math.min(r, (taper.gw0 / 2 + (halfW - taper.gw0 / 2) * fr) / halfW)
  }
  if (taper.gw1 !== undefined && lenM - d < TAPER_RANGE_M) {
    r = Math.min(r, (taper.gw1 / 2 + (halfW - taper.gw1 / 2) * fr) / halfW)
  }
  return halfW * r
}
for (const c of CASES) {
  const sideBlocks = blocksOf(c.wayId)
  let worstGap = 0; let worstOverlap = 0; let n = 0
  for (const host of blocksOf(c.hostWayId)) {
    const hc = host.geometry.coordinates as [number, number][]
    const hcum = cumulative(hc)
    const hlen = hcum[hcum.length - 1]
    for (let d = 0; d <= hlen; d += 10) {
      const pos = pointAlong(hc, hcum, d).pos
      let best: { road: RoadFeature; d: number; dist: number } | null = null
      for (const m of sideBlocks) {
        const mc = m.geometry.coordinates as [number, number][]
        const mcum = cumulative(mc)
        for (let md = 0; md <= mcum[mcum.length - 1]; md += 5) {
          const dist = haversine(pos, pointAlong(mc, mcum, md).pos)
          if (!best || dist < best.dist) best = { road: m, d: md, dist }
        }
      }
      if (!best) continue
      const mlen = cumulative(best.road.geometry.coordinates as [number, number][]).slice(-1)[0]
      const seam = best.dist - renderedHalf(host, d, hlen) - renderedHalf(best.road, best.d, mlen)
      if (seam > 0.3 || seam < -0.3) {
        console.log(`     ⚠ d=${d}m 於主橋 block ${host.properties.blockNode}`
          + `：縫 ${seam.toFixed(2)} m（中線距 ${best.dist.toFixed(2)}）`)
      }
      worstGap = Math.max(worstGap, seam)
      worstOverlap = Math.min(worstOverlap, seam)
      n++
    }
  }
  const ok = worstGap <= 0.35 && worstOverlap >= -0.35
  if (!ok) fail++
  console.log(`  ${c.name}：取樣 ${n} 點`)
  console.log(`     最大天窗 ${worstGap.toFixed(2)} m｜最大重疊 ${worstOverlap.toFixed(2)} m`)
  console.log(`     ${ok ? '✓ 全線貼合（±0.35m 內）' : '✗ 接縫超標——畫面上看得到縫或穿模'}`)
}

// ── 機車專用道高架鏈 ──
// 楠梓交流道的機車專用道匝道在 OSM 標了 layer=1，但 elevation 用手動名單，
// 漏列就會被當平面路畫在地上、與旁邊 6m 高的主橋分裂（2026-08-04 使用者回報）。
// 這裡確認整條鏈都拿到 elevated 旗標，且高度真的離地。
console.log('\n=== 機車專用道高架鏈 ===')
const MOTO_FLYOVER = [
  { id: 103679024, note: '匝道 65m（layer=1，無 bridge tag）' },
  { id: 230216189, note: '匝道 61m' },
  { id: 230216191, note: '匝道 115m' },
  { id: 230213636, note: '匝道 57m，接上 way/25724904' },
  { id: 25724904, note: '機車專用道高架本體 530m' },
]
for (const { id, note } of MOTO_FLYOVER) {
  const bs = blocksOf(id)
  if (!bs.length) { console.log(`  way/${id}: ✗ 找不到`); fail++; continue }
  const allElevated = bs.every((b) => b.properties.elevated === true)
  const maxH = Math.max(...bs.map((b) => {
    const cum = cumulative(b.geometry.coordinates as [number, number][])
    const len = cum[cum.length - 1]
    let h = 0
    for (let d = 0; d <= len; d += Math.max(5, len / 10)) {
      h = Math.max(h, model.heightAt(b, d))
    }
    return h
  }))
  const ok = allElevated && maxH > 1
  if (!ok) fail++
  console.log(`  way/${id}（${note}）：${bs.length} 區塊`
    + `｜elevated=${allElevated}｜最高 ${maxH.toFixed(1)} m ${ok ? '✓' : '✗ 沒抬起來'}`)
}
// 地面路名標籤不可出現在高架區塊上（mapStyle road-label filter）
const groundLabelled = roads.filter((r) => r.properties.elevated
  && r.properties.name && r.properties.roadMarkingMode !== 'none')
console.log(`\n  高架且有路名的區塊 ${groundLabelled.length} 個`
  + '——road-label 圖層已加 elevated 排除，這些不會再把名字印在地面')

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項未通過`)
process.exit(fail === 0 ? 0 : 1)
