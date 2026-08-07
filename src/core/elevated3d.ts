// 高架橋面 3D 圖層（方案 B：three.js 織帶橋面）：沿高架區塊中心線建帶狀 mesh
// ——橋面（含側裙/底面）＋車道標線（細長條 geometry）＋兩側護欄＋橋墩。
// 高度取自 elevation.ts 同一份剖面，與車輛 z 完全一致；匝道爬升因此連續不階梯。
//
// 座標/渲染模式照 models3d.ts：場景錨定楠梓中心、MercatorCoordinate 換算公尺
//（不自己湊常數——踩過的坑）、共用 MapLibre 的 WebGL context、antialias 一律關。
import * as THREE from 'three'
import maplibregl, { type Map as MLMap, type CustomLayerInterface } from 'maplibre-gl'
import { NANZI_CENTER, pointAlong, cumulative, bearing, COS_LAT, LANE_WIDTH_M } from './geo'
import { MOTO_LANE_M, type RoadFeature } from './roads'
import { activeElevation, type ElevationModel } from './elevation'
import { spanAtDist, type RouteResult, type LaneBandResult } from './graph'

/** 取樣間距（公尺）：橋面/護欄沿中心線的斷面密度（爬升段的平滑度來源） */
const STEP_M = 8
/** 橋面板厚 */
const DECK_T = 0.7
/** 護欄高 */
const RAIL_H = 0.9
/** 中央分隔護欄高（紐澤西護欄，比側護欄矮） */
const CENTER_RAIL_H = 0.8
/** 護欄漸升參考高：橋面低於此高度時護欄按比例壓低（觸地端 0 → 全高的銜接感） */
const RAIL_RAMP_H = 2
/** 接地端寬度收窄的作用範圍（距接地端沿線公尺） */
const TAPER_RANGE_M = 150
/** 對向並排合體（中山高型）：搜尋對向中心線的最大距離 */
const MEDIAN_SEARCH_M = 34
/** 同上：橋面往中線最多再延伸多少的上限（保險用；兩向真的分道揚鑣就各自成橋）。
 * 「中間有沒有匝道穿過」才是主判準——寬度門檻分不出「中央帶較寬」與
 * 「兩向繞開匝道」（本區資料兩者都落在 5~6m）。 */
const MEDIAN_EXTRA_MAX_M = 9
/** 合體→分離的漸變帶：接近上限時延伸量線性收回，橋面寬度不會在中途跳一階 */
const MEDIAN_FADE_M = 2
/** 中央帶裡有別的高架（匝道從兩向之間穿過）就不合體——橋面鋪過去會蓋掉匝道 */
const MEDIAN_CLEAR_M = 1.5
/** 中央分隔護欄的半寬（兩向各畫一半，於中線接合） */
const MEDIAN_RAIL_HALF = 0.15
/** 疊合判定的淨距門檻（公尺，量到鄰接橋面**邊緣**；負值 = 已在對方路面內）。
 * 三者分開調：側裙板只要沒插進對方路面就可以留（貼齊時仍是外緣）；護欄與標線
 * 「不能畫在任何一方的路面上」，所以要再往外留一段淨距才畫。 */
const EDGE_BURY_TOL_M = 0
/** 護欄：與鄰接橋面邊緣的淨距小於此就不建（含護欄自身厚度與一點視覺餘裕） */
const RAIL_CLEAR_M = 0.5
/** 標線：疊合區不畫線，同樣留一點餘裕免得線頭正好壓在接縫上 */
const MARK_CLEAR_M = 0.4

const KX = 111320 * COS_LAT
const KY = 110540
/** 橋墩間距 / 最低出現高度（爬升近地段不畫墩） */
const PIER_EVERY_M = 30
const PIER_MIN_H = 3
/** 車道虛線：4m 線段 + 6m 間隔（國道標線節奏） */
const DASH_ON = 4
const DASH_CYCLE = 10
/** 路線絲帶：高於這個高度視為「在高架上」（以下交給 MapLibre 平面路線帶） */
const ROUTE_ELEV_EPS = 0.05

type V3 = [number, number, number]

/** 三角形湯收集器：全部橋面合併成少數幾個 BufferGeometry（draw call 控制） */
class TriBuf {
  pos: number[] = []
  quad(a: V3, b: V3, c: V3, d: V3) {
    // a-b 為前一斷面、c-d 為下一斷面（同側順序），兩三角形
    this.pos.push(...a, ...b, ...d, ...a, ...d, ...c)
  }
  build(material: THREE.Material): THREE.Mesh | null {
    if (this.pos.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.computeVertexNormals()
    return new THREE.Mesh(g, material)
  }
}

/** 斷面：中心點場景座標 + 行進右向單位向量 + 高度 + 橫向縮放（接地收窄） */
interface Section {
  x: number; z: number; rx: number; rz: number; h: number; r: number
  /** 斷面中心的經緯度（橋面高度剖面用；場景座標是 Mercator 公尺，不另反推） */
  lng: number; lat: number
}

/** 點到折線的最短距離（lat）與投影點弧長（arc，自折線首點起算；皆公尺） */
interface PolyProj {
  lat: number
  arc: number
  /** 投影點（經緯度） */
  q: [number, number]
  /** 投影所在線段的單位方向（東/北分量） */
  dE: number
  dN: number
}

function projToPolyArc(p: [number, number], poly: [number, number][]): PolyProj {
  let best: PolyProj = { lat: Infinity, arc: 0, q: poly[0], dE: 1, dN: 0 }
  let acc = 0
  for (let i = 1; i < poly.length; i++) {
    const ax = (p[0] - poly[i - 1][0]) * KX, ay = (p[1] - poly[i - 1][1]) * KY
    const vx = (poly[i][0] - poly[i - 1][0]) * KX, vy = (poly[i][1] - poly[i - 1][1]) * KY
    const L2 = vx * vx + vy * vy
    const L = Math.sqrt(L2)
    const t = L2 > 0 ? Math.max(0, Math.min(1, (ax * vx + ay * vy) / L2)) : 0
    const d = Math.hypot(ax - vx * t, ay - vy * t)
    if (d < best.lat && L > 0) {
      best = {
        lat: d, arc: acc + L * t,
        q: [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t,
          poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t],
        dE: vx / L, dN: vy / L,
      }
    }
    acc += L
  }
  return best
}


export class ElevatedLayer {
  id = 'elevated-decks'
  type = 'custom' as const
  renderingMode = '3d' as const

  private map: MLMap | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private group = new THREE.Group()
  /** 路線絲帶（高架段的藍色路線帶＋chevron，畫在橋面上；平面段仍走 MapLibre） */
  private routeGroup = new THREE.Group()
  /** 每個高架區塊的橋面中心線取樣（經緯度）與其高度——deckHeightAt 查表用 */
  private deckProfile = new Map<RoadFeature, { pts: [number, number][]; hs: number[] }>()
  /** way id → 該 way 的橋面剖面。橋面建在 renderRoads 上，但路線帶/車輛查高度時
   * 拿的是 routingRoads 的 clone 物件（buildRoadMergeViews 兩份視圖不共用物件），
   * 只用物件當鍵會全部 miss → 退回 ElevationModel → 再 miss → 0 → 藍線沉到橋下。 */
  private deckProfileByWay = new Map<number, { pts: [number, number][]; hs: number[] }[]>()
  private originMatrix: THREE.Matrix4
  private originMerc: { x: number; y: number }
  private mercScale: number

  constructor() {
    // 錨點/矩陣不依賴 map，建構時就算好——setModel 可在 addLayer 之前呼叫
    const merc = maplibregl.MercatorCoordinate.fromLngLat(
      { lng: NANZI_CENTER[0], lat: NANZI_CENTER[1] }, 0)
    const s = merc.meterInMercatorCoordinateUnits()
    this.originMerc = { x: merc.x, y: merc.y }
    this.mercScale = s
    this.originMatrix = new THREE.Matrix4()
      .makeTranslation(merc.x, merc.y, merc.z ?? 0)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.4))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(120, 300, -180)
    this.scene.add(sun)
    this.scene.add(this.group)
    this.scene.add(this.routeGroup)
  }

  private toScene(lng: number, lat: number): [number, number] {
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, 0)
    return [
      (mc.x - this.originMerc.x) / this.mercScale, // 東
      -(mc.y - this.originMerc.y) / this.mercScale, // 北
    ]
  }

  asLayer(): CustomLayerInterface {
    return this as unknown as CustomLayerInterface
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map
    // antialias 在內顯上很貴（MSAA 卡頓前科），共用 context 一律關
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(), context: gl, antialias: false,
    })
    this.renderer.autoClear = false
  }

  onRemove() {
    this.disposeMeshes()
    this.disposeRoute()
    this.renderer?.dispose()
  }

  private disposeMeshes() {
    for (const m of this.group.children) (m as THREE.Mesh).geometry?.dispose()
    this.group.clear()
    this.deckProfile.clear()
    this.deckProfileByWay.clear()
    this.occlusionFaded = false
  }

  /**
   * 該路段在 pos 處的「橋面實際高度」（公尺）；null = 這條路沒有建橋面。
   * 用 deck mesh 的同一組斷面取樣內插——接地端裁切（DECK_END_TRIM_ENDS）把接地點
   * 往內移，取樣點之間也是線性內插，直接問 ElevationModel 會有落差；路線帶只要
   * 沉到橋面下就被深度測試擋掉（畫面上藍線整段消失）。
   */
  deckHeightAt(road: RoadFeature, pos: [number, number]): number | null {
    // 先認物件；認不到就退回同 way id 的所有剖面，取投影最近的那條
    const own = this.deckProfile.get(road)
    const candidates = own ? [own] : this.deckProfileByWay.get(road.properties.osm_id) ?? []
    let bestD2 = Infinity
    let best: number | null = null
    for (const pr of candidates) {
      if (pr.pts.length === 0) continue
      if (pr.pts.length === 1) {
        if (bestD2 === Infinity) best = pr.hs[0]
        continue
      }
      for (let i = 1; i < pr.pts.length; i++) {
        const a = pr.pts[i - 1], b = pr.pts[i]
        const ax = (pos[0] - a[0]) * KX, ay = (pos[1] - a[1]) * KY
        const vx = (b[0] - a[0]) * KX, vy = (b[1] - a[1]) * KY
        const L2 = vx * vx + vy * vy
        const t = L2 > 0 ? Math.max(0, Math.min(1, (ax * vx + ay * vy) / L2)) : 0
        const dx = ax - vx * t, dy = ay - vy * t
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) {
          bestD2 = d2
          best = pr.hs[i - 1] + (pr.hs[i] - pr.hs[i - 1]) * t
        }
      }
    }
    return best
  }

  private occlusionFaded = false

  /** 導航位於橋面下方時，只淡化橋體；車輛與 routeGroup 導航絲帶維持清楚。 */
  setOcclusionAt(pos: [number, number], vehicleElevM = 0) {
    let blocked = false
    for (const [road, profile] of this.deckProfile) {
      if (profile.pts.length < 2) continue
      const hit = projToPolyArc(pos, profile.pts)
      if (hit.lat > road.properties.width_m / 2 + 3) continue
      const deckH = this.deckHeightAt(road, pos)
      if (deckH !== null && deckH > vehicleElevM + 2) { blocked = true; break }
    }
    this.setOcclusionFade(blocked)
  }

  setOcclusionFade(faded: boolean) {
    if (this.occlusionFaded === faded) return
    this.occlusionFaded = faded
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        material.transparent = faded
        material.opacity = faded ? 0.25 : 1
        material.depthWrite = !faded
        material.needsUpdate = true
      }
    })
    this.map?.triggerRepaint()
  }

  private disposeRoute() {
    for (const m of this.routeGroup.children) (m as THREE.Mesh).geometry?.dispose()
    this.routeGroup.clear()
  }

  private tmpMatrix = new THREE.Matrix4()
  render(_gl: WebGL2RenderingContext, arg: unknown) {
    if (!this.renderer) return
    if (this.group.children.length === 0 && this.routeGroup.children.length === 0) return
    const m: number[] = Array.isArray(arg)
      ? arg as number[]
      : ((arg as { defaultProjectionData?: { mainMatrix: number[] } })
        .defaultProjectionData?.mainMatrix ?? [])
    if (m.length !== 16) return
    this.camera.projectionMatrix = this.tmpMatrix.fromArray(m).multiply(this.originMatrix)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
  }

  /** 依 elevation 模型重建全部橋面 mesh（底圖載入/更換時呼叫；靜態幾何，建一次） */
  setModel(model: ElevationModel | null) {
    this.disposeMeshes()
    if (!model || model.empty) { this.map?.triggerRepaint(); return }

    // 三角形湯不保證繞向，一律雙面（three 對 DoubleSide 背面自動翻法線，光照正確）
    const lambert = (color: number) =>
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })
    const deckBuf = new TriBuf() // 橋面鋪面（同路面色）
    const sideBuf = new TriBuf() // 側裙 + 底面（同 casing 色）
    const railBuf = new TriBuf() // 護欄（淺混凝土）
    const pierBuf = new TriBuf() // 橋墩
    const whiteBuf = new TriBuf() // 白標線（邊線/車道虛線）
    const yellowBuf = new TriBuf() // 黃標線（雙向分向線）

    interface DeckRef { road: RoadFeature; cs: [number, number][]; half: number }
    /** 匯流/分岔（共用節點且三線以上）的鄰接橋面——標線的疊合判定用：
     * 使用者要的是「交接的地方不畫線」，不是全圖只要疊到就不畫。 */
    const deckNeighbours = new Map<RoadFeature, DeckRef[]>()
    /** 路面真的重疊到的橋面（不限共用節點）——側裙板與護欄的判定用：
     * 「柵欄不要畫到任何一方的路面上」，並排高架（高楠陸橋 vs 旁邊的機車高架、
     * 德民新橋 vs 兩側機車道）沒有共用節點，但護欄一樣會站到對方路面上。 */
    const deckOverlaps = new Map<RoadFeature, DeckRef[]>()
    /** way id → 該 way 的所有高架區塊 */
    const blocksOfWay = new Map<number, DeckRef[]>()
    for (const { road } of model.entries()) {
      const id = road.properties.osm_id
      if (!blocksOfWay.has(id)) blocksOfWay.set(id, [])
      blocksOfWay.get(id)!.push({
        road, cs: road.geometry.coordinates as [number, number][],
        half: road.properties.width_m / 2,
      })
    }
    {
      const refs: (DeckRef & { box: [number, number, number, number] })[] = []
      for (const { road } of model.entries()) {
        const cs = road.geometry.coordinates as [number, number][]
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const c of cs) {
          x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1])
          x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1])
        }
        refs.push({ road, cs, half: road.properties.width_m / 2, box: [x0, y0, x1, y1] })
      }
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          const a = refs[i], b = refs[j]
          // 兩條中心線要接近到「路面會碰到」才算；bbox 先粗篩
          const reach = a.half + b.half + 1
          const padX = reach / KX, padY = reach / KY
          if (a.box[0] - padX > b.box[2] || a.box[2] + padX < b.box[0]
            || a.box[1] - padY > b.box[3] || a.box[3] + padY < b.box[1]) continue
          // 首尾相接的續行段（同一條路的前後區塊、或路口的兩條臂）在節點附近
          // 本來就會碰到，那不算「並排疊合」——只算離共用節點 ≥12m 之外、
          // 而且持續並排 ≥12m 的部分，否則整條續接路的護欄會被消掉。
          const shared: [number, number][] = []
          const bn = new Set(b.road.properties.nodes)
          a.road.properties.nodes.forEach((n, k) => {
            if (bn.has(n)) shared.push(a.cs[k] ?? a.cs[0])
          })
          const farFromJoint = (p: [number, number]) =>
            shared.every((s) => Math.hypot((p[0] - s[0]) * KX, (p[1] - s[1]) * KY) > 12)
          const sideBySide = (
            self: DeckRef, other: DeckRef, keep: (p: [number, number]) => boolean,
          ) => {
            let run = 0
            const cum = cumulative(self.cs)
            for (let d = 0; d <= cum[cum.length - 1]; d += 4) {
              const { pos } = pointAlong(self.cs, cum, d)
              if (keep(pos) && projToPolyArc(pos, other.cs).lat <= reach) run += 4
            }
            return run
          }
          if (sideBySide(a, b, farFromJoint) < 4 && sideBySide(b, a, farFromJoint) < 4) continue
          if (!deckOverlaps.has(a.road)) deckOverlaps.set(a.road, [])
          if (!deckOverlaps.has(b.road)) deckOverlaps.set(b.road, [])
          deckOverlaps.get(a.road)!.push(b)
          deckOverlaps.get(b.road)!.push(a)
        }
      }
    }

    // ── 匝道匯流／分岔節點分析 ──
    // 作法比照平面（roads.buildRoadSurfaces + buildDividers）：
    //   路面**各走各的中心線、各用各的寬度**，重疊處自然疊成一塊（同一種材質同色，
    //   法線都朝上，共面重疊不會看出接縫）；標線與護欄才在路口收邊。
    // 舊版反過來——把匯流的匝道推到對方邊緣「貼著滑行」、把 Y 形的兩臂搬到主幹
    // 左右半邊，橋面因此離開自己的中心線最多 9.65m，畫出來就是扭曲、沒接好。
    // 那些機制（trims/flushes、yArmAlign/openYEnds、railGaps）已整批移除。
    interface EndRef { road: RoadFeature; cs: [number, number][]; w: number; name: string; atStart: boolean }
    const byNode = new Map<number, EndRef[]>()
    for (const { road } of model.entries()) {
      const p = road.properties
      const cs = road.geometry.coordinates as [number, number][]
      const name = p.name ?? String(p.osm_id)
      for (const [n, atStart] of [[p.nodes[0], true], [p.nodes[p.nodes.length - 1], false]] as const) {
        if (!byNode.has(n)) byNode.set(n, [])
        byNode.get(n)!.push({ road, cs, w: p.width_m, name, atStart })
      }
    }
    /** 寬度融接：through 兩側寬度不同（岔口一分為二、車道數變化）時，
     * 窄側在節點端放寬到寬側的半寬、沿 ~30m 收回自身寬——不做會是寬度階梯硬接 */
    const widens = new Map<RoadFeature, { atStart: boolean; fromHalf: number }[]>()
    /** 路口收邊：該端是三線以上相接的節點時，標線自節點退縮這麼多公尺
     * （比照 roads.buildDividers 的「交叉路最大半寬 + 1.2m」）。 */
    const markSetback = new Map<RoadFeature, { atStart: boolean; m: number }[]>()
    const outwardDir = (r: EndRef): [number, number] => {
      const cs = r.atStart ? r.cs : [...r.cs].reverse()
      const probe = cs[Math.min(cs.length - 1, 1)]
      const e = (probe[0] - cs[0][0]) * KX
      const n = (probe[1] - cs[0][1]) * KY
      const l = Math.hypot(e, n) || 1
      return [e / l, n / l]
    }
    const angleDeg = (a: [number, number], b: [number, number]) =>
      (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI
    for (const refs of byNode.values()) {
      if (refs.length < 2) continue
      // through = 同名的一進一出，取最順直的那一組（用來做寬度融接）。
      // 陣列順序不代表幾何：匯流點常有兩條同名同寬的進入線（直行主線＋併入匝道）。
      let thr: [EndRef, EndRef] | null = null
      let thrTurn = Infinity
      for (const nm of new Set(refs.map((r) => r.name))) {
        for (const i of refs.filter((r) => r.name === nm && !r.atStart)) {
          for (const o of refs.filter((r) => r.name === nm && r.atStart)) {
            // 一進一出的 outwardDir 相反，順直 = 夾角接近 180°
            const turn = 180 - angleDeg(outwardDir(i), outwardDir(o))
            if (turn < thrTurn) { thrTurn = turn; thr = [i, o] }
          }
        }
      }
      // 寬度融接只在「單純的續接」做（一進一出、沒有第三條）：岔口有第三條時
      // 三片橋面本來就會疊在一起補滿，再放寬窄側只會多戳出一塊。
      if (thr && refs.length === 2 && thr[0].w !== thr[1].w) {
        const [wide, narrow] = thr[0].w > thr[1].w ? [thr[0], thr[1]] : [thr[1], thr[0]]
        if (!widens.has(narrow.road)) widens.set(narrow.road, [])
        widens.get(narrow.road)!.push({ atStart: narrow.atStart, fromHalf: wide.w / 2 })
      }
      // 路口收邊（三線以上相接）：比照平面 buildDividers——標線退到
      // 「交叉路最大半寬 + 1.2m」，路口範圍內不留車道線/邊線。
      if (refs.length >= 3) {
        for (const r of refs) {
          const others = refs.filter((o) => o !== r)
          const m = Math.max(...others.map((o) => o.w / 2)) + 1.2
          if (!markSetback.has(r.road)) markSetback.set(r.road, [])
          markSetback.get(r.road)!.push({ atStart: r.atStart, m })
          // 同節點的其他道路 = 疊合對象。收的是「那幾條 way 的所有區塊」而不是
          // 只有正好在此節點結束的那一塊——區塊邊界是路口切出來的，匝道往往
          // 貼著相鄰的下一塊走，只收端點那塊會漏掉那一段的護欄/標線。
          const list = deckNeighbours.get(r.road) ?? []
          for (const o of others) {
            for (const blk of blocksOfWay.get(o.road.properties.osm_id) ?? []) {
              if (blk.road === r.road || list.some((x) => x.road === blk.road)) continue
              list.push(blk)
            }
          }
          deckNeighbours.set(r.road, list)
        }
      }
    }

    // ── 對向並排合體（中山高型）──
    // 中山高在 OSM 是兩條對向 oneway，各自成橋的話中間會開一道天窗、還立兩排護欄。
    // 幾何/拓撲不動（合併成雙向 way 會讓 A* 允許逆向行駛，見 pipeline coupletCandidates），
    // 只在「畫」的時候把兩向橋面各自延伸到兩線中點接成一座，中線立紐澤西護欄。
    // 只吃 motorway 本線：匝道（motorway_link）走一般的疊合，不併中線。
    const allDecks = [...model.entries()].map((e) => e.road)
    const carriages = allDecks.filter((r) =>
      r.properties.highway === 'motorway' && r.properties.oneway === 'yes')
    /**
     * Lock every motorway carriageway to one opposing partner for its whole
     * segment.  Choosing the nearest road independently at every section lets
     * nearby ramps steal the match and makes the centre barrier jump sideways.
     */
    const medianPairs = new Map<RoadFeature, RoadFeature[]>()
    for (const self of carriages) {
      const sc = self.geometry.coordinates as [number, number][]
      const sCum = cumulative(sc), sLen = sCum[sCum.length - 1]
      let chosen: RoadFeature | null = null
      let chosenScore = Infinity
      for (const other of carriages) {
        if (other === self) continue
        const sameName = (self.properties.name ?? '') === (other.properties.name ?? '')
        if (!sameName) continue
        const oc = other.geometry.coordinates as [number, number][]
        let total = 0
        let valid = true
        for (const f of [0.2, 0.5, 0.8]) {
          const sample = pointAlong(sc, sCum, sLen * f)
          const pr = projToPolyArc(sample.pos, oc)
          const rad = (sample.brg * Math.PI) / 180
          const fE = Math.sin(rad), fN = Math.cos(rad)
          if (pr.lat > MEDIAN_SEARCH_M || fE * pr.dE + fN * pr.dN > -0.5) {
            valid = false
            break
          }
          total += pr.lat
        }
        if (!valid) continue
        const score = total / 3
        if (score < chosenScore) { chosen = other; chosenScore = score }
      }
      if (chosen) {
        // Follow only directly connected continuations of the chosen opposing
        // way. This bridges OSM way boundaries without allowing an unrelated
        // parallel mainline or ramp to take over halfway through the segment.
        const chain = new Set<RoadFeature>([chosen])
        const queue = [chosen]
        while (queue.length) {
          const cur = queue.shift()!
          const curNodes = new Set(cur.properties.nodes)
          for (const next of carriages) {
            if (chain.has(next) || next === self) continue
            if ((next.properties.name ?? '') !== (chosen.properties.name ?? '')) continue
            if (!next.properties.nodes.some((n) => curNodes.has(n))) continue
            const cc = cur.geometry.coordinates as [number, number][]
            const nc = next.geometry.coordinates as [number, number][]
            const cCum = cumulative(cc), nCum = cumulative(nc)
            const cb = pointAlong(cc, cCum, cCum[cCum.length - 1] / 2).brg
            const nb = pointAlong(nc, nCum, nCum[nCum.length - 1] / 2).brg
            const dot = Math.cos(((cb - nb) * Math.PI) / 180)
            if (dot < 0.65) continue
            chain.add(next)
            queue.push(next)
          }
        }
        medianPairs.set(self, [...chain])
      }
    }
    /** 該斷面處的對向並排：edge = 橋面該側要鋪到多遠、side = 對向在哪一側、
     * merged = 有鋪到中線（可立中央護欄；漸變帶裡是 false，兩向正在分開） */
    const medianAt = (self: RoadFeature, s: Section, halfW: number):
      { edge: number; side: 1 | -1; merged: boolean } | null => {
      let best: { edge: number; side: 1 | -1; merged: boolean; half: number; mid: [number, number]; other: RoadFeature } | null = null
      const pos: [number, number] = [s.lng, s.lat]
      const paired = medianPairs.get(self)
      if (!paired) return null
      for (const o of paired) {
        const pr = projToPolyArc(pos, o.geometry.coordinates as [number, number][])
        if (pr.lat > MEDIAN_SEARCH_M) continue
        // 對向才算（同向並排是主線＋輔助車道，不是一座橋的兩半）：
        // 自身行進方向（E,N）=(rz, rx)，與投影段方向內積 < -0.5 → 夾角 >120°
        if (s.rz * pr.dE + s.rx * pr.dN > -0.5) continue
        const half = pr.lat / 2
        const extra = half - halfW
        if (extra < 0) continue // 兩線太近，鋪到中線反而比自身還窄
        const t = Math.min(1, Math.max(0, (MEDIAN_EXTRA_MAX_M - extra) / MEDIAN_FADE_M))
        if (t <= 0) continue
        if (!best || half < best.half) {
          // 側別：自身右向（E,N）=(rx, −rz) 與「往對向」的向量內積
          const vE = (pr.q[0] - pos[0]) * KX, vN = (pr.q[1] - pos[1]) * KY
          best = {
            half, edge: halfW + extra * t, merged: t >= 0.999, other: o,
            side: vE * s.rx - vN * s.rz >= 0 ? 1 : -1,
            mid: [(pos[0] + pr.q[0]) / 2, (pos[1] + pr.q[1]) / 2],
          }
        }
      }
      if (!best) return null
      // 中央帶淨空檢查：兩向之間若有別的高架（匝道穿越交流道），維持分開各自成橋
      for (const o of allDecks) {
        if (o === self || o === best.other) continue
        const d = projToPolyArc(best.mid, o.geometry.coordinates as [number, number][]).lat
        if (d < best.half - MEDIAN_CLEAR_M) return null
      }
      return best
    }

    for (const { road, lenM, hM } of model.entries()) {
      const p = road.properties
      const coords = road.geometry.coordinates as [number, number][]
      const cum = cumulative(coords)
      const halfW = p.width_m / 2

      let dA = 0, dB = lenM
      // 現地指定的接地端裁切（DECK_END_TRIM_ENDS）：橋面停在平面路的路面邊緣，
      // 不鋪進對方路面。heightAt 已把接地點移到裁切處，這裡只縮取樣範圍
      const endTrim = model.endTrim(road)
      if (endTrim.t0 !== undefined) dA = Math.max(dA, endTrim.t0)
      if (endTrim.t1 !== undefined) dB = Math.min(dB, lenM - endTrim.t1)
      if (dB - dA < STEP_M) continue
      const hAt = (d: number) => model.heightAt(road, Math.max(0, Math.min(lenM, d)))
      const taper = model.groundTaper(road)
      const roadWidens = widens.get(road) ?? []
      const gA = dA, gB = dB

      // 斷面取樣：底下所有帶狀件共用（頂點對齊，接縫才不會裂）。
      // 中心線/走向一律取自路段本身——**任何情況都不把橋面推離自己的中心線**，
      // 匯流與分岔靠相鄰橋面自然疊合補滿（見上方節點分析的說明）
      const section = (d: number): Section => {
        const { pos, brg } = pointAlong(coords, cum, d)
        const [e, n] = this.toScene(pos[0], pos[1])
        const rad = (brg * Math.PI) / 180
        const h = hAt(d)
        // 接地端寬度收窄：與爬升同步（h/hM），從地面延續路寬 → 全寬。
        // 橋比地面路寬時（楠陽 19.8 vs 地面 13.4），端點不收窄會懸空蓋到旁路上
        let r = 1
        const fr = hM > 0 ? Math.min(1, h / hM) : 1
        if (taper.gw0 !== undefined && d - dA < TAPER_RANGE_M) {
          r = Math.min(r, (taper.gw0 / 2 + (halfW - taper.gw0 / 2) * fr) / halfW)
        }
        if (taper.gw1 !== undefined && dB - d < TAPER_RANGE_M) {
          r = Math.min(r, (taper.gw1 / 2 + (halfW - taper.gw1 / 2) * fr) / halfW)
        }
        // 寬度融接：節點端放寬到鄰接寬側（r > 1），沿 ~30m 線性收回自身寬
        for (const w of roadWidens) {
          const eD = w.atStart ? d : lenM - d
          const L = Math.min(30, lenM / 2)
          if (eD < L && Math.abs(w.fromHalf - halfW) > 0.02) {
            r *= (w.fromHalf + (halfW - w.fromHalf) * (eD / L)) / halfW
          }
        }
        // 場景 x=東、z=南；行進右向 =（cos brg, sin brg)（北向→右=東 ✓）
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h, r, lng: pos[0], lat: pos[1] }
      }
      const at = (s: Section, off: number, y: number): V3 =>
        [s.x + s.rx * off * s.r, s.h + y, s.z + s.rz * off * s.r]
      /** 同 at，但 off 已是最終偏移（不再乘收窄係數）——橋面邊緣/中線護欄用 */
      const atAbs = (s: Section, off: number, y: number): V3 =>
        [s.x + s.rx * off, s.h + y, s.z + s.rz * off]

      // 中央分隔護欄：couplet 合併的雙向橋面（實體島 centerM）在分向位置建
      // 兩側板＋頂蓋的矮牆（紐澤西護欄）——不建的話兩向路面在橋上黏在一起
      const ctrHalf = (p.centerM || 0) / 2
      const hasCenterRail = p.oneway !== 'yes' && p.centerKind === 'island' && ctrHalf > 0
      const dvOff = p.divOffM || 0

      // 取樣（gA~gB）：高架區塊的地面路體已隱藏
      // （RoadProps.elevated 過濾），橋面連近地爬升段一起建
      const ds: number[] = []
      for (let d = gA; d <= gB; d += STEP_M) ds.push(d)
      if (ds[ds.length - 1] < gB) ds.push(gB)
      const secs = ds.map(section)
      // 橋面高度剖面：路線帶/車輛要貼在橋面上，就得問「這裡的橋面多高」，
      // 而不是 model.heightAt（取樣內插與接地端裁切都會讓兩者有落差）
      const profile = {
        pts: secs.map((s) => [s.lng, s.lat] as [number, number]),
        hs: secs.map((s) => s.h),
      }
      this.deckProfile.set(road, profile)
      const wayId = road.properties.osm_id
      if (!this.deckProfileByWay.has(wayId)) this.deckProfileByWay.set(wayId, [])
      this.deckProfileByWay.get(wayId)!.push(profile)

      /**
       * 斷面上偏移 off 處，距離最近的鄰接橋面「邊緣」還有多少（負 = 已在對方路面內）。
       * 匯流/分岔處兩片橋面疊合，落在對方路面上的東西一律不畫——側裙板與護欄會
       * 變成一道穿過路面的假牆，車道線則會在疊合區交叉成一團。
       * 等同平面的作法：疊起來的路面只留最外圈輪廓，內部的邊界與標線都收掉。
       * 只比對「共用節點的鄰接橋面」——全圖兩兩比對太慢，且不相干的平行橋
       * （中山高本線 vs 匝道）本來就該各自留護欄。
       */
      const clearIn = (list: DeckRef[], s: Section, off: number): number => {
        if (!list.length) return Infinity
        // off 是斷面座標；換算成經緯度（右向 = (rx, rz) 對應東/南）
        const q: [number, number] =
          [s.lng + (s.rx * off) / KX, s.lat + (-s.rz * off) / KY]
        let best = Infinity
        for (const { road: o, cs, half } of list) {
          if (o === road) continue
          best = Math.min(best, projToPolyArc(q, cs).lat - half)
        }
        return best
      }
      /** 標線／側裙／護欄共用：任何路面真的疊到的橋面（含三線相接的鄰接橋面）。
       * 疊合區只留最外圈輪廓，內部不畫線也不立牆——與平面同一套邏輯。 */
      const bodyNeighbours = [...new Set([
        ...(deckOverlaps.get(road) ?? []), ...(deckNeighbours.get(road) ?? []),
      ])]
      const clearOf = (s: Section, off: number) => clearIn(bodyNeighbours, s, off)

      // 對向並排：合體側的橋面邊緣推到兩線中點（edge 回傳「已含收窄 r」的絕對偏移，
      // 所以用 atAbs 而不是 at——後者會再乘一次 r）
      const meds = carriages.includes(road)
        ? secs.map((s) => medianAt(road, s, halfW))
        : secs.map(() => null)
      /** 第 i 個斷面 side 側的橋面邊緣（帶正負號） */
      const edge = (i: number, side: 1 | -1) => {
        const m = meds[i]
        const base = halfW * secs[i].r
        return side * (m && m.side === side ? Math.max(base, m.edge * secs[i].r) : base)
      }
      /** 該側是不是「與對向接合的中線」（護欄/側裙要改樣式） */
      const isSeam = (i: number, side: 1 | -1) => meds[i]?.side === side && meds[i]!.merged

      /** 這一節的該側側裙板要不要畫：兩端**任一**端已在鄰接橋面內就不畫
       * （用 or 不用 and——寧可提早收掉，也不要有半截牆插進對方路面） */
      const skirtBuried = (i: number, side: 1 | -1) =>
        clearOf(secs[i - 1], edge(i - 1, side)) < EDGE_BURY_TOL_M
        || clearOf(secs[i], edge(i, side)) < EDGE_BURY_TOL_M
      /** 護欄同上，但量的是護欄自己的位置，而且要與對方路面留出淨距——
       * 「柵欄不要畫到任何一方的路面上」 */
      const railBuried = (i: number, side: 1 | -1) => {
        const off = (j: number) => edge(j, side) - side * 0.12 * secs[j].r
        return clearOf(secs[i - 1], off(i - 1)) < RAIL_CLEAR_M
          || clearOf(secs[i], off(i)) < RAIL_CLEAR_M
      }
      /** 中央/中線護欄同理：它長在自己路面的中間，但在匯流口一樣會伸到對方路面上 */
      const midRailBuried = (i: number, off: number) =>
        clearOf(secs[i - 1], off) < RAIL_CLEAR_M || clearOf(secs[i], off) < RAIL_CLEAR_M

      for (let i = 1; i < secs.length; i++) {
        const a = secs[i - 1], b = secs[i]
        const aL = edge(i - 1, -1), aR = edge(i - 1, 1)
        const bL = edge(i, -1), bR = edge(i, 1)
        const buriedL = skirtBuried(i, -1)
        const buriedR = skirtBuried(i, 1)
        const railL = railBuried(i, -1)
        const railR = railBuried(i, 1)
        // 橋面（頂）＋底面＋兩側裙板（底/側從橋下可見——陸橋下平面路口）。
        // 合體側不畫裙板：那裡是橋面中央，立一片垂直板會在橋底出現一道假邊
        deckBuf.quad(atAbs(a, aL, 0), atAbs(a, aR, 0), atAbs(b, bL, 0), atAbs(b, bR, 0))
        sideBuf.quad(atAbs(a, aR, -DECK_T), atAbs(a, aL, -DECK_T),
          atAbs(b, bR, -DECK_T), atAbs(b, bL, -DECK_T))
        if (!isSeam(i - 1, -1) && !isSeam(i, -1) && !buriedL) {
          sideBuf.quad(atAbs(a, aL, -DECK_T), atAbs(a, aL, 0),
            atAbs(b, bL, -DECK_T), atAbs(b, bL, 0))
        }
        if (!isSeam(i - 1, 1) && !isSeam(i, 1) && !buriedR) {
          sideBuf.quad(atAbs(a, aR, 0), atAbs(a, aR, -DECK_T),
            atAbs(b, bR, 0), atAbs(b, bR, -DECK_T))
        }
        // 護欄：兩側直立板（DoubleSide 材質）。近地漸升（觸地端壓到 0 → 銜接感）；
        // 邊緣被鄰接橋面蓋住的那一段不建（匯流口自然成為開缺，車上得來）
        const rhA = RAIL_H * Math.min(1, a.h / RAIL_RAMP_H)
        const rhB = RAIL_H * Math.min(1, b.h / RAIL_RAMP_H)
        // 護欄內縮量跟著收窄係數（= 原本 at(±halfW∓0.12) 的寫法），
        // 端點楔形尖端才不會因為固定 12cm 內縮而翻到另一側
        if (!railL && !isSeam(i - 1, -1) && !isSeam(i, -1)) {
          railBuf.quad(atAbs(a, aL + 0.12 * a.r, 0), atAbs(a, aL + 0.12 * a.r, rhA),
            atAbs(b, bL + 0.12 * b.r, 0), atAbs(b, bL + 0.12 * b.r, rhB))
        }
        if (!railR && !isSeam(i - 1, 1) && !isSeam(i, 1)) {
          railBuf.quad(atAbs(a, aR - 0.12 * a.r, rhA), atAbs(a, aR - 0.12 * a.r, 0),
            atAbs(b, bR - 0.12 * b.r, rhB), atAbs(b, bR - 0.12 * b.r, 0))
        }
        // 中線紐澤西護欄：兩向各畫「自己這半」（牆板 + 到中線的頂蓋），
        // 於中線接合成一道完整護欄——不必指定誰負責，也不會兩片重疊 z-fighting
        for (const side of [-1, 1] as const) {
          if (!isSeam(i - 1, side) || !isSeam(i, side)) continue
          if (midRailBuried(i, edge(i, side) - side * MEDIAN_RAIL_HALF)) continue
          const cA = CENTER_RAIL_H * Math.min(1, a.h / RAIL_RAMP_H)
          const cB = CENTER_RAIL_H * Math.min(1, b.h / RAIL_RAMP_H)
          const e0 = side < 0 ? aL : aR, e1 = side < 0 ? bL : bR
          const w0 = e0 - side * MEDIAN_RAIL_HALF, w1 = e1 - side * MEDIAN_RAIL_HALF
          railBuf.quad(atAbs(a, w0, 0), atAbs(a, w0, cA), atAbs(b, w1, 0), atAbs(b, w1, cB))
          railBuf.quad(atAbs(a, w0, cA), atAbs(a, e0, cA), atAbs(b, w1, cB), atAbs(b, e1, cB))
        }
        // 中央護欄：分向線位置（divOffM）兩側板＋頂蓋（同樣近地漸升）
        if (hasCenterRail && !midRailBuried(i, dvOff)) {
          const cA = CENTER_RAIL_H * Math.min(1, a.h / RAIL_RAMP_H)
          const cB = CENTER_RAIL_H * Math.min(1, b.h / RAIL_RAMP_H)
          railBuf.quad(at(a, dvOff - ctrHalf, 0), at(a, dvOff - ctrHalf, cA),
            at(b, dvOff - ctrHalf, 0), at(b, dvOff - ctrHalf, cB))
          railBuf.quad(at(a, dvOff + ctrHalf, cA), at(a, dvOff + ctrHalf, 0),
            at(b, dvOff + ctrHalf, cB), at(b, dvOff + ctrHalf, 0))
          railBuf.quad(at(a, dvOff - ctrHalf, cA), at(a, dvOff + ctrHalf, cA),
            at(b, dvOff - ctrHalf, cB), at(b, dvOff + ctrHalf, cB))
        }
      }
      // 首尾斷面封口（側裙端面）——寬度跟著該斷面的實際邊緣（含合體側延伸）。
      // 端點被鄰接橋面蓋住時不封口：那裡是疊合區的內部，封了就是一道假端面
      for (const [i, sgn] of [[0, -1], [secs.length - 1, 1]] as const) {
        if (clearOf(secs[i], edge(i, -1)) < EDGE_BURY_TOL_M
          && clearOf(secs[i], edge(i, 1)) < EDGE_BURY_TOL_M) continue
        const s = secs[i], eL = edge(i, -1), eR = edge(i, 1)
        sideBuf.quad(atAbs(s, sgn < 0 ? eL : eR, 0), atAbs(s, sgn < 0 ? eR : eL, 0),
          atAbs(s, sgn < 0 ? eL : eR, -DECK_T), atAbs(s, sgn < 0 ? eR : eL, -DECK_T))
      }

      // ── 車道標線（貼在橋面上 +3cm）──
      // 橫向偏移邏輯與 roads.buildDividers 同一套斷面模型（右正）
      const f = p.lanesForward
      const marks: { off: number; color: 'white' | 'yellow'; dash: boolean }[] = []
      if (p.roadMarkingMode !== 'none') {
        if (p.roadMarkingMode === 'all') {
          marks.push({ off: -halfW + 0.35, color: 'white', dash: false })
          marks.push({ off: halfW - 0.35, color: 'white', dash: false })
        }
        if (p.oneway === 'yes') {
          if (p.roadMarkingMode === 'all') {
            const total = f * LANE_WIDTH_M
              + (p.motoCountF > 0 ? p.motoCountF * MOTO_LANE_M + (p.motoSepF || 0) : 0)
            const left = -total / 2
            for (let k = 1; k < f; k++) {
              marks.push({ off: left + k * LANE_WIDTH_M, color: 'white', dash: true })
            }
          }
        } else {
          const b = p.lanesBackward
          const c = (p.centerM || 0) / 2
          const dv = p.divOffM || 0
          if (c === 0) marks.push({ off: dv, color: 'yellow', dash: false })
          if (p.roadMarkingMode === 'all') {
            for (let k = 1; k < f; k++) {
              marks.push({ off: dv + c + k * LANE_WIDTH_M, color: 'white', dash: true })
            }
            for (let k = 1; k < b; k++) {
              marks.push({ off: dv - c - k * LANE_WIDTH_M, color: 'white', dash: true })
            }
          }
        }
      }
      // 路口收邊：三線相接的端點附近不畫標線（比照平面 buildDividers）——
      // 匯流／分岔處三片橋面疊在一起，各畫各的車道線就會交叉成一團
      let mA = dA, mB = dB
      for (const sb of markSetback.get(road) ?? []) {
        if (sb.atStart) mA = Math.max(mA, dA + sb.m)
        else mB = Math.min(mB, dB - sb.m)
      }
      for (const mk of marks) {
        if (mB - mA < 1) break
        const buf = mk.color === 'yellow' ? yellowBuf : whiteBuf
        const w = mk.color === 'yellow' ? 0.13 : 0.08 // 半寬
        const seg = (d0: number, d1: number) => {
          const a = section(d0), b2 = section(d1)
          // 疊合區不畫線：兩片橋面併在一起時，各畫各的邊線/車道線會在中間交叉。
          // 節點端的退縮只管路口那一小段，兩條匝道並行貼近的整段要靠這個收掉
          if (clearOf(a, mk.off) < MARK_CLEAR_M || clearOf(b2, mk.off) < MARK_CLEAR_M) return
          buf.quad(at(a, mk.off - w, 0.03), at(a, mk.off + w, 0.03),
            at(b2, mk.off - w, 0.03), at(b2, mk.off + w, 0.03))
        }
        if (mk.dash) {
          for (let d = mA; d + DASH_ON <= mB; d += DASH_CYCLE) seg(d, d + DASH_ON)
        } else {
          // 實線沿取樣斷面連續鋪（頂點與橋面共用取樣，跟著爬升），收邊處補一小段
          let prev = mA
          for (let i = 1; i < secs.length; i++) {
            const d0 = Math.max(ds[i - 1], mA), d1 = Math.min(ds[i], mB)
            if (d1 - d0 < 0.05) continue
            seg(d0, d1)
            prev = d1
          }
          if (mB - prev > 0.05) seg(prev, mB)
        }
      }

      // ── 橋墩：每 ~30m 一根單柱（近地爬升段不畫）──
      for (let d = dA + PIER_EVERY_M / 2; d < dB; d += PIER_EVERY_M) {
        const s = section(d)
        if (s.h < PIER_MIN_H) continue
        const hw = 0.9 // 柱半寬
        const top = s.h - DECK_T
        // 四面直立矩形柱（沿行進向對齊）；頂/底面被橋面/地面遮住不用鋪
        const c4: [number, number][] = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]]
        for (let i = 0; i < 4; i++) {
          const [u0, v0] = c4[i], [u1, v1] = c4[(i + 1) % 4]
          const base0: V3 = [s.x + s.rx * u0 - s.rz * v0, 0, s.z + s.rz * u0 + s.rx * v0]
          const base1: V3 = [s.x + s.rx * u1 - s.rz * v1, 0, s.z + s.rz * u1 + s.rx * v1]
          pierBuf.quad(base0, base1,
            [base0[0], top, base0[2]], [base1[0], top, base1[2]])
        }
      }
    }

    const add = (m: THREE.Mesh | null) => { if (m) this.group.add(m) }
    add(deckBuf.build(lambert(0x4d5a74))) // 同 mapStyle C.surface
    add(sideBuf.build(lambert(0x39445e))) // 同 C.casing
    add(railBuf.build(lambert(0xb6bfcc)))
    add(pierBuf.build(lambert(0x8b95a8)))
    add(whiteBuf.build(new THREE.MeshBasicMaterial({ color: 0xe9edf2, side: THREE.DoubleSide })))
    add(yellowBuf.build(new THREE.MeshBasicMaterial({ color: 0xf5c542, side: THREE.DoubleSide })))
    this.map?.triggerRepaint()
  }

  /**
   * 路線帶上橋：把車道偏移路線帶（laneBand）依高度切成「平面段/高架段」——
   * 高架段在這裡建 3D 絲帶（casing＋藍帶＋白 chevron，貼橋面）；回傳平面段
   * 折線陣列，呼叫端拿去餵 MapLibre route source（平面路線帶與 chevron 照舊）。
   * route=null 清空絲帶。高度以 span 的路段身分查（與車輛 z 同一條路）。
   */
  setRoute(route: RouteResult | null, band?: LaneBandResult): [number, number][][] {
    this.disposeRoute()
    if (!route || !band || band.coords.length < 2) {
      this.map?.triggerRepaint()
      return band ? [band.coords] : []
    }
    const model = activeElevation()
    // 每個取樣點的高度：detour 暫時路線（span 無 road）與非高架段 = 0。
    // 高架段一律問橋面本身（deckHeightAt），沒建橋面才退回高度模型
    const hs = band.coords.map((c, i) => {
      if (!model) return 0
      const span = spanAtDist(route, band.routeD[i])
      const road = span?.road
      if (!road?.properties.elevated) return 0
      return this.deckHeightAt(road, c) ?? model.heightAtPos(road, c)
    })

    // 切段：地面（h≤eps）給 MapLibre、高架給 3D 絲帶；邊界各多含一點，接縫不斷
    const ground: [number, number][][] = []
    const rides: { pts: [number, number][]; h: number[] }[] = []
    let g: [number, number][] | null = null
    let r: { pts: [number, number][]; h: number[] } | null = null
    for (let i = 0; i < band.coords.length; i++) {
      const onDeck = hs[i] > ROUTE_ELEV_EPS
      if (!onDeck) {
        if (!g) {
          g = []
          ground.push(g)
          if (r) { r.pts.push(band.coords[i]); r.h.push(hs[i]); r = null } // 高架段收尾接地
        }
        g.push(band.coords[i])
      } else {
        if (!r) {
          r = { pts: [], h: [] }
          rides.push(r)
          if (i > 0) { r.pts.push(band.coords[i - 1]); r.h.push(hs[i - 1]) } // 從地面點起帶
          g = null
        }
        r.pts.push(band.coords[i])
        r.h.push(hs[i])
      }
    }

    const casing = new TriBuf()
    const line = new TriBuf()
    const chev = new TriBuf()
    for (const run of rides) {
      if (run.pts.length < 2) continue
      const cum = cumulative(run.pts)
      // 斷面（帶右向）＋沿線內插高度
      const secAt = (d: number): Section => {
        const { pos, brg, idx } = pointAlong(run.pts, cum, d)
        const segLen = cum[idx] - cum[idx - 1]
        const t = segLen > 0 ? (d - cum[idx - 1]) / segLen : 0
        const h = run.h[idx - 1] + (run.h[idx] - run.h[idx - 1]) * t
        const [e, n] = this.toScene(pos[0], pos[1])
        const rad = (brg * Math.PI) / 180
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h, r: 1, lng: pos[0], lat: pos[1] }
      }
      const at = (s: Section, off: number, y: number): V3 =>
        [s.x + s.rx * off, s.h + y, s.z + s.rz * off]
      const total = cum[cum.length - 1]
      const ds: number[] = []
      for (let d = 0; d <= total; d += 6) ds.push(d)
      if (ds[ds.length - 1] < total) ds.push(total)
      for (let i = 1; i < ds.length; i++) {
        const a = secAt(ds[i - 1]), b = secAt(ds[i])
        casing.quad(at(a, -1.5, 0.06), at(a, 1.5, 0.06), at(b, -1.5, 0.06), at(b, 1.5, 0.06))
        line.quad(at(a, -1.0, 0.1), at(a, 1.0, 0.1), at(b, -1.0, 0.1), at(b, 1.0, 0.1))
      }
      // chevron：每 25m 一枚白色 V（兩翼各一片薄矩形，尖端朝行進方向）
      for (let d = 12; d < total - 2; d += 25) {
        const s = secAt(d)
        // 行進方向（場景水平面）：right=(cos b, sin b) → dir=(sin b, −cos b)
        const fx = s.rz, fz = -s.rx
        const tip: V3 = [s.x + fx * 0.9, s.h + 0.14, s.z + fz * 0.9]
        for (const side of [-1, 1] as const) {
          // 翼向 = 後退 1.5m + 側向 0.9m
          const wx = -fx * 1.5 + s.rx * side * 0.9
          const wz = -fz * 1.5 + s.rz * side * 0.9
          const wl = Math.hypot(wx, wz)
          const nx = -wz / wl, nz = wx / wl // 翼的法向（寬度方向）
          const hw = 0.19
          chev.quad(
            [tip[0] + nx * hw, tip[1], tip[2] + nz * hw],
            [tip[0] - nx * hw, tip[1], tip[2] - nz * hw],
            [tip[0] + wx + nx * hw, tip[1], tip[2] + wz + nz * hw],
            [tip[0] + wx - nx * hw, tip[1], tip[2] + wz - nz * hw],
          )
        }
      }
    }
    // 半透明貼面：depthWrite 關（彼此不互擋）、renderOrder 固定疊序 casing→帶→chevron
    const push = (buf: TriBuf, color: number, opacity: number, order: number) => {
      const mesh = buf.build(new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false,
      }))
      if (mesh) { mesh.renderOrder = order; this.routeGroup.add(mesh) }
    }
    push(casing, 0x1d4ed8, 0.35, 1) // 同 mapStyle C.routeCasing
    push(line, 0x3b82f6, 0.55, 2) // 同 C.route
    push(chev, 0xffffff, 0.9, 3)
    this.map?.triggerRepaint()
    return ground
  }
}

// 目前生效的圖層實例（模組單例）：mapCore 建圖層時設定，
// usePlanner/useDrive 畫路線帶時直接取用——不用把 ref 穿過 App.tsx 接線
let activeLayer: ElevatedLayer | null = null

export function setActiveElevatedLayer(l: ElevatedLayer | null) { activeLayer = l }
export function activeElevatedLayer(): ElevatedLayer | null { return activeLayer }

/**
 * 路面高度（公尺）：高架段以「橋面實際高度」為準，其餘 0。
 * 車輛（drive/gpsNav → models3d 的 z）與路線帶共用這個入口，兩者才會同高——
 * 直接問 ElevationModel 會漏掉接地端裁切與取樣內插。沒建 3D 橋面時退回模型。
 */
export function surfaceHeightAt(road: RoadFeature, pos: [number, number]): number {
  if (!road.properties.elevated) return 0
  return activeLayer?.deckHeightAt(road, pos) ?? activeElevation()?.heightAtPos(road, pos) ?? 0
}
