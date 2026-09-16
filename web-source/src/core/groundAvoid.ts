/**
 * 地面標線互相避讓的共用幾何。
 *
 * 路面印字、地面箭頭、路名都要避開「已經畫在那裡的東西」。各自重算一份別人的
 * 位置一定會漂移，所以統一成同一套：呼叫端把已算好的圖徵轉成 `GroundObstacle`，
 * 這裡負責投影到路段軸上、算出可用的縱向區間。
 */
import { COS_LAT } from './geo.ts'

const KX = 111320 * COS_LAT
const KY = 110540
const CELL_M = 48

/** 佔位圖徵：以取樣點 + 沿路軸／橫向的半尺寸表示。 */
export interface GroundObstacle {
  /** 佔位取樣點（單點圖示給 1 點、線段給兩端、方框給四角） */
  points: [number, number][]
  /** 沿路軸方向的半長（公尺） */
  alongHalfM?: number
  /** 橫向半寬（公尺） */
  crossHalfM?: number
}

export const obstacleCellKey = (p: [number, number]) =>
  `${Math.round((p[0] * KX) / CELL_M)},${Math.round((p[1] * KY) / CELL_M)}`

/** 障礙的粗略空間索引：每條路段只投影附近的障礙，避免 N×M 全比對。 */
export function indexObstacles(obstacles: GroundObstacle[]) {
  const grid = new Map<string, GroundObstacle[]>()
  for (const o of obstacles) {
    const keys = new Set<string>()
    for (const p of o.points) {
      const cx = Math.round((p[0] * KX) / CELL_M)
      const cy = Math.round((p[1] * KY) / CELL_M)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) keys.add(`${cx + dx},${cy + dy}`)
      }
    }
    for (const key of keys) {
      const bucket = grid.get(key)
      if (bucket) bucket.push(o)
      else grid.set(key, [o])
    }
  }
  return grid
}

export type ObstacleIndex = ReturnType<typeof indexObstacles>

/**
 * 點投影到路段折線 → 沿路軸距離 d 與橫向偏移 off（右正，同 turnbays.offsetAt）。
 *
 * 頭尾兩段**不夾住** t：疊在一起的兩條 way（OSM 常見的雙向 way + 兩條單行 way）
 * 會讓隔壁路的圖徵落在本路段端點之外，夾住 t 會把它算成「貼在端點、橫向很近」，
 * 橫向判定就誤以為是別的車道而不避讓。延伸端點線段後橫向偏移才是真的。
 */
export function projectOnEdge(
  p: [number, number], coords: [number, number][], cum: number[],
): { d: number; off: number; dist: number } {
  let best = { d: 0, off: Infinity, dist: Infinity }
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (p[0] - coords[i][0]) * KX
    const ay = (p[1] - coords[i][1]) * KY
    const vx = (coords[i + 1][0] - coords[i][0]) * KX
    const vy = (coords[i + 1][1] - coords[i][1]) * KY
    const len2 = vx * vx + vy * vy
    if (len2 <= 0) continue
    const raw = (ax * vx + ay * vy) / len2
    const t = Math.max(i === 0 ? -Infinity : 0,
      Math.min(i === coords.length - 2 ? Infinity : 1, raw))
    const ex = ax - vx * t
    const ey = ay - vy * t
    const dist = Math.hypot(ex, ey)
    if (dist >= best.dist) continue
    const len = Math.sqrt(len2)
    best = { d: cum[i] + t * len, off: (ex * vy - ey * vx) / len, dist }
  }
  return best
}

export interface ProjectedObstacle {
  d0: number
  d1: number
  off0: number
  off1: number
}

/** 取出路段附近的障礙並投影到路段軸上（含各自的半尺寸）。 */
export function projectNearbyObstacles(
  grid: ObstacleIndex, coords: [number, number][], cum: number[],
): ProjectedObstacle[] {
  const total = cum[cum.length - 1]
  const nearby = new Set<GroundObstacle>()
  // 沿線每半格取樣一次；障礙已登記在自身周圍 3×3 格內，取樣格命中即可
  for (let d = 0; d <= total + CELL_M / 2; d += CELL_M / 2) {
    const at = Math.min(d, total)
    let index = 0
    while (index < cum.length - 2 && cum[index + 1] < at) index++
    const span = cum[index + 1] - cum[index]
    const t = span > 0 ? (at - cum[index]) / span : 0
    const p: [number, number] = [
      coords[index][0] + (coords[index + 1][0] - coords[index][0]) * t,
      coords[index][1] + (coords[index + 1][1] - coords[index][1]) * t,
    ]
    for (const o of grid.get(obstacleCellKey(p)) ?? []) nearby.add(o)
  }
  return [...nearby].map((o) => {
    let d0 = Infinity, d1 = -Infinity, off0 = Infinity, off1 = -Infinity
    for (const point of o.points) {
      const hit = projectOnEdge(point, coords, cum)
      d0 = Math.min(d0, hit.d); d1 = Math.max(d1, hit.d)
      off0 = Math.min(off0, hit.off); off1 = Math.max(off1, hit.off)
    }
    const alongHalf = o.alongHalfM ?? 0
    const crossHalf = o.crossHalfM ?? 0
    return {
      d0: d0 - alongHalf, d1: d1 + alongHalf,
      off0: off0 - crossHalf, off1: off1 + crossHalf,
    }
  })
}

/** 區間扣除：free 內挖掉 [a, b] */
export function punchInterval(
  free: [number, number][], a: number, b: number,
): [number, number][] {
  const out: [number, number][] = []
  for (const [lo, hi] of free) {
    if (b <= lo || a >= hi) { out.push([lo, hi]); continue }
    if (a > lo) out.push([lo, a])
    if (b < hi) out.push([b, hi])
  }
  return out
}

/**
 * 指定橫向帶（車道中心 ± halfWidth）在 [lo, hi] 內還剩哪些縱向區間可用。
 * 橫向沒有真的蓋到這條帶的障礙不列入——隔壁車道的箭頭不影響本車道。
 */
export function freeIntervals(
  projected: ProjectedObstacle[],
  lo: number, hi: number,
  laneOffM: number, laneHalfM: number,
  clearM: number,
): [number, number][] {
  let free: [number, number][] = [[lo, hi]]
  for (const o of projected) {
    if (o.off1 < laneOffM - laneHalfM || o.off0 > laneOffM + laneHalfM) continue
    free = punchInterval(free, o.d0 - clearM, o.d1 + clearM)
  }
  return free
}
