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
import { COS_LAT, cumulative, bearing, angleDelta, pointAlong } from './geo'

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
export const ELEVATED_WAY_IDS = new Set([
  // 高楠公路北側獨立陸橋（primary，layer=1）
  // way/23939182@b/257742658 已由使用者確認為高架；它是 couplet 合併
  // 保留側，加入後會連同配對方向一併使用同一座雙向高架橋面。
  // way/25724904@b/280507545 為平行的獨立機車專用高架，保持原始間距。
  23939182, 25724904, 103678994, 103679015,
  // 上面那條機車專用高架的續行段：同一座橋在 OSM 被切成五條 way，只列頭一條的話
  // 橋面在 node/1196965025 就結束，往南整段變平面（way/799123656 南下的實測症狀）
  103679024, 230213636, 230216189, 230216191,
  // 高楠陸橋南端上橋段（way/103679008@b/1196964560，OSM 名「縱貫公路」，
  // bridge=yes layer=1）：北接 way/23939182 的橋面。漏列時北段橋面在
  // node/1196964578 從 6m 直接斷在這段的 0m 上，這段被當平面路畫地面標線。
  // 南端 node/1196964560 接平面的 way/268219246（高楠公路上橋引道）＝接地點，
  // 爬升剖面由該節點起算。
  103679008,
  // 楠陽高架橋（tertiary，layer=1/2；「楠楊高架橋」為 OSM 同橋異名，交流道疊層）
  271982150, 103678963, 103678964,
  // 陸橋/高架橋銜接匝道（primary_link，bridge=yes layer=1）：高楠陸橋↔楠陽高架的
  // 無名連絡道與「高楠路橋-台南/高雄市區」匝道。不列的話它們被當平面路，
  // 會把陸橋中段的共用節點判成接地、整座橋被壓回地面
  103678962, 103678985, 103679016, 103679009, 765913728, 28526279,
  // 德民新橋主橋與兩側機車道（bridge=yes, layer=1）
  126247872, 126247885, 126247846, 126247898,
  // 左營高架橋（primary，bridge=yes layer=1）：跨中華一路與翠華路匝道
  92071680,
  // 大中快速道路高架段＋鼎金系統匝道（trunk/trunk_link，layer=1/2）。整條主線在
  // 翠華路、高鐵路、大中二路、華夏路、文川路、博愛四路上方連續通過，layer 2 段
  // 再疊在自己的 layer 1 段上；漏列會讓快速道路整條貼地穿過底下的平面路口。
  // 銜接的國道（高雄支線/鼎金系統）由 isElevated 的 motorway 判準自動抬升，
  // 兩者共用同一個高架子網路算接地距離。
  9846630, 24159889, 28526262, 38367691, 125061994, 125062015,
  125062023, 125062047, 125062062, 215166832, 256319334, 256319769,
  277512390, 277512391, 288653008, 313823898, 313823901, 313823903,
  313823905, 457972351, 457972352, 1270874472,
])

/**
 * 現地指定：這些接地端的橋面要裁到「路面邊緣」，不要鋪進交會道路的路面裡。
 * key = `${osm_id}@${nodeId}`（同 roads.PARALLEL_CROSS_ENDS 的寫法）。
 *
 * 匝道落地端與平面路共用節點時，節點在交會道路的**中心線**上，橋面鋪到節點
 * 就是整片壓在對方路面上（way/230290999 末端實測插進旗楠路 13m）。橋面之間
 * 已有貼邊裁切（elevated3d 的 trims），但那只在兩邊都是高架時成立。
 *
 * 裁切量不寫死：由該節點實際的平面路寬推導（沿匝道往回走到中心線離開所有
 * 路面為止），所以編輯車道數改了路寬，裁切量會跟著走。
 */
const DECK_END_TRIM_ENDS = new Set([
  // 楠梓交流道下匝道南端 × 旗楠路（土庫八街口北側）：整片橋面插進旗楠路路面
  '230290999@280277330',
  // 旗楠路上匝道（上楠梓交流道）東端 × 旗楠路：同上，起端插進路面
  '131904685@1451068275',
])

/** 已人工確認「底下有路穿過但不抬」的 bridge/layer 路段——audit:elevated 的
 * 立體交叉偵測會把它們當漏列嫌疑，列在這裡表示判斷過了，不是還沒處理。 */
export const AT_GRADE_BRIDGE_WAY_IDS = new Set([
  // 德惠路 way/23875933（tertiary，bridge=yes layer=1）：跨後勁溪，底下穿過的
  // way/287447933、way/287673498 是溪岸的堤防道路。抬高的是堤防路往下沉，
  // 不是德惠路往上爬——依檔頭判準「跨河橋與路面同高」，街面維持平面。
  23875933,
  // 中路巷 way/297229540（residential，bridge=yes layer=1）：跨中山高。國道被
  // isElevated 無條件抬成 6m，把這條也抬到 6m 只會兩者穿模；維持平面反而讓
  // 國道正確蓋在上面。真要處理得先讓 motorway 的高度隨 layer 走。
  297229540,
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

/** 接地端裁切的掃描上限（公尺）——超過這個距離就當作量錯了，不裁 */
const DECK_TRIM_MAX_M = 40

/** 點到折線的最近距離（公尺） */
function distToLineM(p: [number, number], cs: [number, number][]): number {
  let best = Infinity
  const px = p[0] * KX, py = p[1] * KY
  for (let i = 0; i + 1 < cs.length; i++) {
    const ax = cs[i][0] * KX, ay = cs[i][1] * KY
    const vx = cs[i + 1][0] * KX - ax, vy = cs[i + 1][1] * KY - ay
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
    best = Math.min(best, Math.hypot(px - (ax + vx * t), py - (ay + vy * t)))
  }
  return best
}

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
  /** 接地端橋面裁切長度（公尺，見 DECK_END_TRIM_ENDS） */
  trim0?: number
  trim1?: number
}

const smoothstep = (t: number) => t * t * (3 - 2 * t)

export class ElevationModel {
  private blocks = new Map<RoadFeature, BlockElev>()
  /** way id → 該 way 的高架區塊。模型建在 renderRoads 上（mapCore.rebuildElevation），
   * 但路線帶與車輛查高度時拿的是 routingRoads 的物件——buildRoadMergeViews 讓
   * 兩份視圖各自 clone，物件完全不共用，純用物件當鍵一定 miss、高度回 0，
   * 藍線與車就整段沉到橋面下。以 way id 補查即可，仍不會誤抬從橋下穿過的
   * 平面路（那條的 osm_id 不同，查無區塊）。 */
  private byWay = new Map<number, BlockElev[]>()
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
      if (!this.byWay.has(p.osm_id)) this.byWay.set(p.osm_id, [])
      this.byWay.get(p.osm_id)!.push(b)
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

    // 6) 現地指定的接地端橋面裁切：沿橋往回走，走到中心線離開該節點上「所有」
    //    平面路的路面為止（每 0.5m 取樣）。量的是本塊自己的幾何，所以裁切量
    //    會隨編輯後的路寬改變；找不到出口就不裁（維持原樣，不會憑空縮短）。
    for (const b of this.blocks.values()) {
      for (const [n, atStart] of [[b.n0, true], [b.n1, false]] as const) {
        if ((this.dGround.get(n) ?? Infinity) !== 0) continue
        if (!DECK_END_TRIM_ENDS.has(`${b.road.properties.osm_id}@${n}`)) continue
        const surfaces: { cs: [number, number][]; half: number }[] = []
        for (const r of roads) {
          if (this.blocks.has(r) || !r.properties.nodes.includes(n)) continue
          const cs = r.geometry.coordinates as [number, number][]
          if (cs.length >= 2) surfaces.push({ cs, half: r.properties.width_m / 2 })
        }
        if (!surfaces.length) continue
        const maxTrim = Math.min(b.lenM / 2, DECK_TRIM_MAX_M)
        let trim: number | undefined
        for (let s = 0; s <= maxTrim; s += 0.5) {
          const { pos } = pointAlong(b.coords, b.cum, atStart ? s : b.lenM - s)
          if (surfaces.every((g) => distToLineM(pos, g.cs) > g.half)) { trim = s; break }
        }
        if (trim === undefined) continue
        if (atStart) b.trim0 = trim
        else b.trim1 = trim
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

  /** 接地端橋面裁切長度（沒指定 = undefined，橋面鋪到端節點） */
  endTrim(road: RoadFeature): { t0?: number; t1?: number } {
    const b = this.blocks.get(road)
    return b ? { t0: b.trim0, t1: b.trim1 } : {}
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
    // 接地爬升：距最近接地點的「沿高架網」距離 → smoothstep 升到全高。
    // 端點被裁切（DECK_END_TRIM_ENDS）時接地點就在裁切處，不在端節點——
    // 扣掉裁切長度，橋面／路線帶／車輛三者才會在同一點落地。
    const dg = Math.max(0, Math.min(
      (this.dGround.get(b.n0) ?? Infinity) + x - (b.trim0 ?? 0),
      (this.dGround.get(b.n1) ?? Infinity) + (b.lenM - x) - (b.trim1 ?? 0),
    ))
    return dg >= RAMP_M ? base : base * smoothstep(dg / RAMP_M)
  }

  /** 位置投影到區塊中心線：回傳垂距平方與沿線里程 */
  private project(b: BlockElev, pos: [number, number]): { d2: number; at: number } {
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
    return { d2: bestD2, at: bestAt }
  }

  /** 該路段對應的高架區塊：先認物件，再退回同 way id 中離 pos 最近的區塊
   * （導航視圖的 clone 物件走這條路，見 byWay 的說明）。 */
  private blockFor(road: RoadFeature, pos: [number, number]): BlockElev | undefined {
    const own = this.blocks.get(road)
    if (own) return own
    const sameWay = this.byWay.get(road.properties.osm_id)
    if (!sameWay?.length) return undefined
    if (sameWay.length === 1) return sameWay[0]
    let best = sameWay[0]
    let bestD2 = Infinity
    for (const b of sameWay) {
      const { d2 } = this.project(b, pos)
      if (d2 < bestD2) { bestD2 = d2; best = b }
    }
    return best
  }

  /** 位置投影到該路段最近點後查高度（車輛用：路段身分由路線 span 提供，
   * 不做「找最近高架」——平面路從高架正下方穿過時純位置查詢會誤抬） */
  heightAtPos(road: RoadFeature, pos: [number, number]): number {
    const b = this.blockFor(road, pos)
    if (!b) return 0
    return this.heightAt(b.road, this.project(b, pos).at)
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
