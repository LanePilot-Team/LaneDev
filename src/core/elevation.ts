// 高架路段高度剖面：哪些路段是「真立體交叉」＋沿線任一點的高度（公尺）。
// 渲染（elevated3d 橋面）與車輛（drive/gpsNav → models3d 的 z）共用同一份模型，
// 兩邊高度才會一致。
//
// 判準（2026-07-18 方案 B 拍板）：
//   - OSM `bridge=yes` ≠ 高架——仁武橋/惠豐橋/林頭橋/援中港大橋等跨河橋實際與
//     路面同高，不抬。起步用手動清單，之後可再做「橋下有別條路穿過」自動偵測。
//   - OSM `layer` 只是疊序沒有公尺高度：layer 1 ≈ 6m、layer 2 ≈ 12m 合成。
//   - 橋段兩端與匝道在 ~100m 內從 0 平滑爬升（smoothstep）；「接地」的判定 =
//     端節點有平面道路共用（資料邊界的斷頭不算，維持全高不落地）。
//   - 連續高架（匝道銜接國道、layer 1 接 layer 2）中間不下地：接地距離用
//     整個高架子網路的沿線最短路（多源 Dijkstra）算，不是逐區塊各自爬升。
import type { RoadFeature } from './roads'
import { COS_LAT, cumulative, bearing, angleDelta } from './geo'

/** OSM layer → 公尺（1≈6m、2≈12m；缺省/0 視同 1 層） */
export const LAYER_HEIGHT_M = 6
/** 接地端爬升距離：沿線這個距離內從 0 平滑升到全高
 * （2026-07-19 100→70：降得太慢會長距離懸在旁邊的地面機車道上方） */
const RAMP_M = 70
/** 層級銜接（layer 1↔2 節點）的高度過渡距離——與接地爬升分開調 */
const NODE_BLEND_M = 100

/** 真立體交叉手動清單（中山高本線＋楠梓交流道匝道改用 highway+bridge/layer 判準，
 * 見 isElevated）。couplet 合併 keep 側保留原 osm_id，清單不受合併影響；
 * drop 側整條併入 keep 幾何，掉出清單也無妨。 */
const ELEVATED_WAY_IDS = new Set([
  // 高楠公路北側獨立陸橋（primary，layer=1）
  // way/23939182@b/257742658 已由使用者確認為高架；它是 couplet 合併
  // 保留側，加入後會連同配對方向一併使用同一座雙向高架橋面。
  // way/25724904@b/280507545 為平行的獨立機車專用高架，保持原始間距。
  23939182, 25724904, 103678994, 103679015,
  // 楠陽高架橋（tertiary，layer=1/2；「楠楊高架橋」為 OSM 同橋異名，交流道疊層）
  271982150, 103678963, 103678964,
  // 陸橋/高架橋銜接匝道（primary_link，bridge=yes layer=1）：高楠陸橋↔楠陽高架的
  // 無名連絡道與「高楠路橋-台南/高雄市區」匝道。不列的話它們被當平面路，
  // 會把陸橋中段的共用節點判成接地、整座橋被壓回地面
  103678962, 103678985, 103679016, 103679009, 765913728, 28526279,
  // 德民新橋主橋與兩側機車道（bridge=yes, layer=1）
  126247872, 126247885, 126247846, 126247898,
])

/** 是否為高架路段：國道體系（motorway/motorway_link）整段視為高架
 * （楠梓段本線多為高架橋；路堤段一併以高架呈現，避免主線在橋段之間反覆下地——
 * 高度剖面會變雲霄飛車），其餘用手動清單。 */
export function isElevated(p: RoadFeature['properties']): boolean {
  if (p.highway === 'motorway' || p.highway === 'motorway_link') return true
  return ELEVATED_WAY_IDS.has(p.osm_id)
}

const KX = 111320 * COS_LAT // 經度 1 度 ≈ 公尺
const KY = 110540

interface BlockElev {
  road: RoadFeature
  coords: [number, number][]
  cum: number[]
  lenM: number
  /** 全高（公尺）：max(1, layer) × LAYER_HEIGHT_M */
  hM: number
  n0: number
  n1: number
  /** 接地端的「地面延續路寬」（公尺）：橋面在該端從此寬度漸變到全寬
   * （橋比地面路寬時，端點不收窄會懸空蓋到旁邊的平面路上） */
  gw0?: number
  gw1?: number
}

const smoothstep = (t: number) => t * t * (3 - 2 * t)

export class ElevationModel {
  private blocks = new Map<RoadFeature, BlockElev>()
  /** 高架端節點 → 沿高架網到最近「接地節點」的距離（不接地 = 不在表內 = ∞） */
  private dGround = new Map<number, number>()
  /** 高架端節點 → 鄰接高架區塊最大全高（layer 1↔2 銜接的節點高度） */
  private nodeH = new Map<number, number>()

  constructor(roads: RoadFeature[]) {
    // 1) 高架區塊收集（splitAtIntersections 之後的區塊；端節點 = nodes 首尾）
    const adj = new Map<number, BlockElev[]>()
    for (const r of roads) {
      const p = r.properties
      if (!isElevated(p)) continue
      const coords = r.geometry.coordinates as [number, number][]
      if (coords.length < 2 || p.nodes.length !== coords.length) continue
      const cum = cumulative(coords)
      const b: BlockElev = {
        road: r, coords, cum, lenM: cum[cum.length - 1],
        hM: Math.max(1, p.layer) * LAYER_HEIGHT_M,
        n0: p.nodes[0], n1: p.nodes[p.nodes.length - 1],
      }
      this.blocks.set(r, b)
      for (const n of [b.n0, b.n1]) {
        if (!adj.has(n)) adj.set(n, [])
        adj.get(n)!.push(b)
      }
    }
    if (this.blocks.size === 0) return

    // 2) 接地節點：端節點被平面路段共用，且是高架鏈的「終端」（該節點只有
    //    一個高架區塊相接）。高架續行中的節點就算有地面路共用（橋下岔路口、
    //    couplet 合併後被移植上來的岔口——高楠陸橋×縱貫公路、楠梓交流道
    //    node 4425325537 實例）也不落地，否則高架中途壓到 0 再爬回來變雲霄飛車。
    //    資料邊界的斷頭節點沒有平面路 → 不接地，高架維持全高直接結束。
    const groundNodes = new Set<number>()
    for (const r of roads) {
      if (this.blocks.has(r)) continue
      for (const n of r.properties.nodes) {
        if (adj.has(n) && adj.get(n)!.length === 1) groundNodes.add(n)
      }
    }

    // 3) 節點高度 = 鄰接高架最大全高（layer 1 塊靠近 layer 2 節點時往上爬）
    for (const [n, bs] of adj) {
      this.nodeH.set(n, Math.max(...bs.map((b) => b.hM)))
    }

    // 4) 多源 Dijkstra：接地節點出發沿高架網算最短距離——爬升剖面跨區塊連續，
    //    短區塊鏈不會各自從 0 重爬（高架網僅數十區塊，陣列掃描即可）
    const dist = this.dGround
    const todo: number[] = []
    for (const n of groundNodes) { dist.set(n, 0); todo.push(n) }
    while (todo.length) {
      let bi = 0
      for (let i = 1; i < todo.length; i++) {
        if ((dist.get(todo[i]) ?? Infinity) < (dist.get(todo[bi]) ?? Infinity)) bi = i
      }
      const n = todo.splice(bi, 1)[0]
      const dn = dist.get(n)!
      for (const b of adj.get(n) ?? []) {
        const other = b.n0 === n ? b.n1 : b.n0
        const nd = dn + b.lenM
        if (nd < (dist.get(other) ?? Infinity)) {
          dist.set(other, nd)
          if (!todo.includes(other)) todo.push(other)
        }
      }
    }

    // 5) 接地端的地面延續路寬：與端節點共用、走向為「延續」（夾角 >130°，排除
    //    橫向街）的平面路寬總和。橋面收窄錨定用（elevated3d），拿不到就不收窄
    for (const b of this.blocks.values()) {
      for (const [n, atStart] of [[b.n0, true], [b.n1, false]] as const) {
        if ((this.dGround.get(n) ?? Infinity) !== 0) continue
        const endIdx = atStart ? 0 : b.coords.length - 1
        const inIdx = atStart ? 1 : b.coords.length - 2
        const bridgeAway = bearing(b.coords[endIdx], b.coords[inIdx])
        let sum = 0
        let allOneway = true
        for (const r of roads) {
          if (this.blocks.has(r)) continue
          const gi = r.properties.nodes.indexOf(n)
          if (gi < 0) continue
          const gc = r.geometry.coordinates as [number, number][]
          if (gc.length < 2 || gi >= gc.length) continue
          const groundAway = bearing(gc[gi], gc[gi === 0 ? 1 : gi - 1])
          if (Math.abs(angleDelta(bridgeAway, groundAway)) > 130) {
            sum += r.properties.width_m
            if (r.properties.oneway !== 'yes') allOneway = false
          }
        }
        // couplet 合併的雙向橋若只接到「單向半邊」的地面路（合併尾段常見：
        // 對向在別的節點接地），只用單邊寬會把整座橋掐細——單向延續 ×2 視為全廊寬
        if (sum > 0 && b.road.properties.coupletMerged && allOneway) sum *= 2
        if (sum > 0) {
          const gw = Math.min(b.road.properties.width_m, Math.max(6, sum))
          if (atStart) b.gw0 = gw
          else b.gw1 = gw
        }
      }
    }
  }

  /** 有任何高架區塊才需要建 3D 圖層/查高度 */
  get empty(): boolean { return this.blocks.size === 0 }

  /** 全部高架區塊（elevated3d 橋面 mesh 生成用） */
  entries(): { road: RoadFeature; lenM: number; hM: number }[] {
    return [...this.blocks.values()].map((b) => ({ road: b.road, lenM: b.lenM, hM: b.hM }))
  }

  /** 接地端的地面延續路寬（該端沒接地/查無延續 = undefined，不收窄） */
  groundTaper(road: RoadFeature): { gw0?: number; gw1?: number } {
    const b = this.blocks.get(road)
    return b ? { gw0: b.gw0, gw1: b.gw1 } : {}
  }

  /** 該路段沿線 d 公尺處的高度；非高架路段回傳 0 */
  heightAt(road: RoadFeature, d: number): number {
    const b = this.blocks.get(road)
    if (!b) return 0
    const x = Math.max(0, Math.min(d, b.lenM))
    // 層級銜接：端節點高度（鄰接最大）在 NODE_BLEND_M 內線性趨回本塊全高
    const h0 = this.nodeH.get(b.n0) ?? b.hM
    const h1 = this.nodeH.get(b.n1) ?? b.hM
    const base = b.hM +
      (h0 - b.hM) * Math.max(0, 1 - x / NODE_BLEND_M) +
      (h1 - b.hM) * Math.max(0, 1 - (b.lenM - x) / NODE_BLEND_M)
    // 接地爬升：距最近接地點的「沿高架網」距離 → smoothstep 升到全高
    const dg = Math.min(
      (this.dGround.get(b.n0) ?? Infinity) + x,
      (this.dGround.get(b.n1) ?? Infinity) + (b.lenM - x),
    )
    return dg >= RAMP_M ? base : base * smoothstep(dg / RAMP_M)
  }

  /** 位置投影到該路段最近點後查高度（車輛用：路段身分由路線 span 提供，
   * 不做「找最近高架」——平面路從高架正下方穿過時純位置查詢會誤抬） */
  heightAtPos(road: RoadFeature, pos: [number, number]): number {
    const b = this.blocks.get(road)
    if (!b) return 0
    let bestD2 = Infinity
    let bestAt = 0
    for (let i = 1; i < b.coords.length; i++) {
      const a = b.coords[i - 1], c = b.coords[i]
      const ax = (pos[0] - a[0]) * KX, ay = (pos[1] - a[1]) * KY
      const vx = (c[0] - a[0]) * KX, vy = (c[1] - a[1]) * KY
      const L2 = vx * vx + vy * vy
      const t = L2 > 0 ? Math.max(0, Math.min(1, (ax * vx + ay * vy) / L2)) : 0
      const dx = ax - vx * t, dy = ay - vy * t
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2) {
        bestD2 = d2
        bestAt = b.cum[i - 1] + Math.sqrt(L2) * t
      }
    }
    return this.heightAt(road, bestAt)
  }
}

export function buildElevation(roads: RoadFeature[]): ElevationModel {
  return new ElevationModel(roads)
}

// 目前生效的模型（模組單例）：mapCore 在底圖就緒/更換時設定，drive/gpsNav 直接讀
// ——避免為了傳一個 ref 動到 LaneDev/LaneNav 各自的 App.tsx 接線
let active: ElevationModel | null = null

export function setActiveElevation(m: ElevationModel | null) { active = m }
export function activeElevation(): ElevationModel | null { return active }
