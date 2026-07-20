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
interface Section { x: number; z: number; rx: number; rz: number; h: number; r: number }

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

/** 折線靠某端 ~100m 的片段（匝道裁切的 through 邊緣導引線） */
function nearEnd(cs: [number, number][], atStart: boolean): [number, number][] {
  const ordered = atStart ? cs : [...cs].reverse()
  const out: [number, number][] = [ordered[0]]
  let acc = 0
  for (let i = 1; i < ordered.length && acc < 100; i++) {
    acc += Math.hypot((ordered[i][0] - ordered[i - 1][0]) * KX, (ordered[i][1] - ordered[i - 1][1]) * KY)
    out.push(ordered[i])
  }
  return out
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

    // ── 匝道併入節點分析 ──
    // through = 同名（無名用 way id）在節點「一進一出」的直行主線；其餘 = joiner 匝道。
    // joiner 橋面裁到 through 邊緣（不再插到主線中心）＋ through 側護欄在併入口開缺。
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
    /** 匝道貼合：atStart 端（或 end 端）自切點起「貼著 through 邊緣」滑行到節點側方。
     * guide = 匝道實際貼著的那條導引線（單一條，避免兩條之間跳動）；
     * gDir = 該導引線段方向相對 through 行向的正負（導引線一律從節點往外排）；
     * side = 匝道在 through 行向的哪一側；jHalf = 匝道半寬（貼邊目標距 = wHalf+jHalf） */
    const trims = new Map<RoadFeature, {
      atStart: boolean; guide: [number, number][]; gDir: 1 | -1
      wHalf: number; jHalf: number; side: 1 | -1
    }[]>()
    /** 護欄缺口：自該區塊「節點端」起算的弧長區間 [d0, d1] */
    const railGaps = new Map<RoadFeature, { side: 1 | -1; atStart: boolean; d0: number; d1: number }[]>()
    /** 寬度融接：through 兩側寬度不同（岔口一分為二、車道數變化）時，
     * 窄側在節點端放寬到寬側的半寬、沿 ~30m 收回自身寬——不做會是寬度階梯硬接 */
    const widens = new Map<RoadFeature, { atStart: boolean; fromHalf: number }[]>()
    for (const refs of byNode.values()) {
      if (refs.length < 2) continue
      let thr: [EndRef, EndRef] | null = null
      for (const nm of new Set(refs.map((r) => r.name))) {
        const ins = refs.filter((r) => r.name === nm && !r.atStart)
        const outs = refs.filter((r) => r.name === nm && r.atStart)
        if (ins.length && outs.length) { thr = [ins[0], outs[0]]; break }
      }
      if (!thr) continue
      if (thr[0].w !== thr[1].w) {
        const [wide, narrow] = thr[0].w > thr[1].w ? [thr[0], thr[1]] : [thr[1], thr[0]]
        if (!widens.has(narrow.road)) widens.set(narrow.road, [])
        widens.get(narrow.road)!.push({ atStart: narrow.atStart, fromHalf: wide.w / 2 })
      }
      const joiners = refs.filter((r) => r !== thr![0] && r !== thr![1])
      if (!joiners.length) continue
      const wHalf = Math.max(thr[0].w, thr[1].w) / 2
      const outCs = thr[1].cs
      const node = outCs[0]
      const D = bearing(outCs[0], outCs[1]) // through 行向（出節點）
      const dE = Math.sin((D * Math.PI) / 180), dN = Math.cos((D * Math.PI) / 180)
      const guides = [nearEnd(thr[0].cs, thr[0].atStart), nearEnd(thr[1].cs, thr[1].atStart)]
      for (const j of joiners) {
        // 側判定：匝道離節點 ~12m 處在 through 行向的左/右（cross<0 = 右）
        const jcum = cumulative(j.cs)
        const jLen = jcum[jcum.length - 1]
        const probeD = j.atStart ? Math.min(12, jLen / 2) : jLen - Math.min(12, jLen / 2)
        const probe = pointAlong(j.cs, jcum, probeD).pos
        const pE = (probe[0] - node[0]) * KX, pN = (probe[1] - node[1]) * KY
        const side: 1 | -1 = dE * pN - dN * pE < 0 ? 1 : -1
        // 貼邊導引線只取一條：匝道實際趴著的那條（探測點距離較近者）。
        // guides[0] = in 區塊（行向朝節點 → 導引線與行向相反，gDir=-1）、
        // guides[1] = out 區塊（gDir=+1）
        const pIn = projToPolyArc(probe, guides[0])
        const pOut = projToPolyArc(probe, guides[1])
        const trail = pIn.lat <= pOut.lat
          ? { guide: guides[0], gDir: -1 as const }
          : { guide: guides[1], gDir: 1 as const }
        if (!trims.has(j.road)) trims.set(j.road, [])
        trims.get(j.road)!.push({
          atStart: j.atStart, guide: trail.guide, gDir: trail.gDir,
          wHalf, jHalf: j.w / 2, side,
        })
        // 護欄缺口：匝道貼邊滑行後，橋面自「切點」到節點側方全程貼著 through
        // 邊緣——這整段投影弧長區間 [d0,d1] 都要開（匝道趴在哪個區塊哪一側，
        // 缺口就自然落在那裡；另一側區塊只會有節點附近幾米的小圓角）
        const reach = wHalf + j.w + 1
        const sMax = Math.min(120, jLen / 2)
        for (const t of thr) {
          const guide = nearEnd(t.cs, t.atStart)
          let g0 = Infinity, g1 = -Infinity
          for (let s = 0; s <= sMax; s += 2) {
            const d = j.atStart ? s : jLen - s
            const { lat, arc } = projToPolyArc(pointAlong(j.cs, jcum, d).pos, guide)
            if (lat < reach) { g0 = Math.min(g0, arc - 1); g1 = Math.max(g1, arc + 2) }
          }
          if (g1 <= g0) continue
          g0 = Math.max(0, g0)
          g1 = Math.min(g0 + 80, g1)
          if (!railGaps.has(t.road)) railGaps.set(t.road, [])
          railGaps.get(t.road)!.push({ side, atStart: t.atStart, d0: g0, d1: g1 })
        }
      }
    }

    for (const { road, lenM, hM } of model.entries()) {
      const p = road.properties
      const coords = road.geometry.coordinates as [number, number][]
      const cum = cumulative(coords)
      const halfW = p.width_m / 2

      // 匝道貼合切點：併入端沿線掃到「離 through 中心線 ≥ 半寬＋匝道半寬」
      // （相切位置）。切點之外（近節點側）橋面不移除，改為貼著主線邊緣滑行
      let dA = 0, dB = lenM
      const flushes: {
        atStart: boolean
        /** 該貼合自己的切點（d 座標）：貼邊區間 = 切點到端點 */
        bound: number
        /** 匝道行進方向與 through 繪圖方向相反（楠陽雙向合併橋的對向匝道）——
         * 貼邊段 brg 要翻 180° 對齊匝道自身行向，否則與自然段銜接處斷面
         * 左右腳交叉、橋面扭轉；護欄跳空的左右側也要跟著翻 */
        flip: boolean
        t: NonNullable<ReturnType<typeof trims.get>>[number]
      }[] = []
      for (const t of trims.get(road) ?? []) {
        const target = t.wHalf + t.jHalf + 0.02
        let cut = 0
        const maxScan = Math.min(lenM / 2, 120)
        for (let s = 0; s <= maxScan; s += 2) {
          const d = t.atStart ? s : lenM - s
          const { pos } = pointAlong(coords, cum, d)
          cut = s
          if (projToPolyArc(pos, t.guide).lat >= target) break
        }
        if (t.atStart) dA = Math.max(dA, cut)
        else dB = Math.min(dB, lenM - cut)
        const boundD = t.atStart ? cut : lenM - cut
        // 切點處匝道自然行向 vs through 繪圖方向（D-frame 導引線首段）內積
        const nat = pointAlong(coords, cum, Math.max(0.5, Math.min(lenM - 0.5, boundD))).brg
        const natRad = (nat * Math.PI) / 180
        let gE = (t.guide[1][0] - t.guide[0][0]) * KX
        let gN = (t.guide[1][1] - t.guide[0][1]) * KY
        const gL = Math.hypot(gE, gN) || 1
        gE = (gE / gL) * t.gDir
        gN = (gN / gL) * t.gDir
        const flip = Math.sin(natRad) * gE + Math.cos(natRad) * gN < 0
        flushes.push({ atStart: t.atStart, bound: boundD, flip, t })
      }
      if (dB - dA < STEP_M) continue
      // 高度域重映射：匝道在「切點」（主線邊緣旁）就達到節點高度，之後貼邊
      // 滑行段全程與主線同高（超出域夾住 = 節點高度）
      const span = dB - dA
      const hAt = (d: number) =>
        model.heightAt(road, Math.max(0, Math.min(lenM, ((d - dA) * lenM) / span)))
      const taper = model.groundTaper(road)
      const roadWidens = widens.get(road) ?? []
      // 幾何取樣範圍：貼邊滑行段延伸到原始端點（節點正側方），不裁掉
      const gA = flushes.some((f) => f.atStart) ? 0 : dA
      const gB = flushes.some((f) => !f.atStart) ? lenM : dB

      // 斷面取樣：底下所有帶狀件共用（頂點對齊，接縫才不會裂）
      const section = (d: number): Section => {
        let { pos, brg } = pointAlong(coords, cum, d)
        // 貼邊滑行：切點到節點側方之間，中心推到主線邊緣外、走向改沿主線。
        // 區間內「一律」夾（不看單點距離——自然線在目標距附近擺動時，夾/不夾
        // 交替會讓橋面扭轉）。並向端點「削尖」：內緣貼住主線邊不動、外緣
        // 隨 tip 收斂到近 0 寬——匯入楔形
        let flushTip = 1
        for (const f of flushes) {
          const inFlush = f.atStart ? d < f.bound : d > f.bound
          if (!inFlush) continue
          const t = f.t
          const flushLen = f.atStart ? f.bound : lenM - f.bound
          if (flushLen < 1e-6) continue
          const tip = Math.max(0.04, (f.atStart ? d : lenM - d) / flushLen)
          const pr = projToPolyArc(pos, t.guide)
          const target = t.wHalf + 0.02 + t.jHalf * tip
          // 統一到「through 行向」座標系（gDir 修正導引線排列方向），再取
          // side 側的垂直向外推——兩種端別（on/off-ramp）行向都與 through 同向
          const tE = pr.dE * t.gDir, tN = pr.dN * t.gDir
          const uE = t.side > 0 ? tN : -tN
          const uN = t.side > 0 ? -tE : tE
          pos = [pr.q[0] + (uE * target) / KX, pr.q[1] + (uN * target) / KY]
          // brg 對齊匝道自身行向（對向匝道翻 180°）——位置推移（u）維持 D-frame
          const bE = f.flip ? -tE : tE, bN = f.flip ? -tN : tN
          brg = (Math.atan2(bE, bN) * 180) / Math.PI
          flushTip = Math.min(flushTip, tip)
        }
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
        r = Math.min(r, flushTip)
        // 寬度融接：節點端放寬到鄰接寬側（r > 1），沿 ~30m 線性收回自身寬
        for (const w of roadWidens) {
          const eD = w.atStart ? d : lenM - d
          const L = Math.min(30, lenM / 2)
          if (eD < L && w.fromHalf > halfW) {
            r *= (w.fromHalf + (halfW - w.fromHalf) * (eD / L)) / halfW
          }
        }
        // 場景 x=東、z=南；行進右向 =（cos brg, sin brg)（北向→右=東 ✓）
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h, r }
      }
      const at = (s: Section, off: number, y: number): V3 =>
        [s.x + s.rx * off * s.r, s.h + y, s.z + s.rz * off * s.r]

      // 中央分隔護欄：couplet 合併的雙向橋面（實體島 centerM）在分向位置建
      // 兩側板＋頂蓋的矮牆（紐澤西護欄）——不建的話兩向路面在橋上黏在一起
      const ctrHalf = (p.centerM || 0) / 2
      const hasCenterRail = p.oneway !== 'yes' && p.centerKind === 'island' && ctrHalf > 0
      const dvOff = p.divOffM || 0

      // 取樣（gA~gB，含貼邊滑行段）：高架區塊的地面路體已隱藏
      // （RoadProps.elevated 過濾），橋面連近地爬升段一起建
      const ds: number[] = []
      for (let d = gA; d <= gB; d += STEP_M) ds.push(d)
      if (ds[ds.length - 1] < gB) ds.push(gB)
      const secs = ds.map(section)

      const gaps = railGaps.get(road) ?? []
      for (let i = 1; i < secs.length; i++) {
        const a = secs[i - 1], b = secs[i]
        const dMid = (ds[i - 1] + ds[i]) / 2
        // 橋面（頂）＋底面＋兩側裙板（底/側從橋下可見——陸橋下平面路口）
        deckBuf.quad(at(a, -halfW, 0), at(a, halfW, 0), at(b, -halfW, 0), at(b, halfW, 0))
        sideBuf.quad(at(a, halfW, -DECK_T), at(a, -halfW, -DECK_T),
          at(b, halfW, -DECK_T), at(b, -halfW, -DECK_T))
        sideBuf.quad(at(a, -halfW, -DECK_T), at(a, -halfW, 0),
          at(b, -halfW, -DECK_T), at(b, -halfW, 0))
        sideBuf.quad(at(a, halfW, 0), at(a, halfW, -DECK_T),
          at(b, halfW, 0), at(b, halfW, -DECK_T))
        // 護欄：兩側直立板（DoubleSide 材質）。近地漸升（觸地端壓到 0 → 銜接感）；
        // 匝道併入口所在側開缺（讓車上得來）
        const rhA = RAIL_H * Math.min(1, a.h / RAIL_RAMP_H)
        const rhB = RAIL_H * Math.min(1, b.h / RAIL_RAMP_H)
        const arcL = (g: { atStart: boolean }) => (g.atStart ? dMid : lenM - dMid)
        // 匝道自身在貼邊滑行段：面向主線那側的護欄不建，否則會在兩橋面之間
        // 立一道牆。斷面左右以「匝道行向」為準——對向匝道（flip）左右對調
        const inFlushInner = (want: 1 | -1) => flushes.some((f) =>
          (f.atStart ? dMid < f.bound : dMid > f.bound)
          && (f.flip ? f.t.side : -f.t.side as 1 | -1) === want)
        const gapL = inFlushInner(-1)
          || gaps.some((g) => g.side === -1 && arcL(g) >= g.d0 && arcL(g) <= g.d1)
        const gapR = inFlushInner(1)
          || gaps.some((g) => g.side === 1 && arcL(g) >= g.d0 && arcL(g) <= g.d1)
        if (!gapL) {
          railBuf.quad(at(a, -halfW + 0.12, 0), at(a, -halfW + 0.12, rhA),
            at(b, -halfW + 0.12, 0), at(b, -halfW + 0.12, rhB))
        }
        if (!gapR) {
          railBuf.quad(at(a, halfW - 0.12, rhA), at(a, halfW - 0.12, 0),
            at(b, halfW - 0.12, rhB), at(b, halfW - 0.12, 0))
        }
        // 中央護欄：分向線位置（divOffM）兩側板＋頂蓋（同樣近地漸升）
        if (hasCenterRail) {
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
      // 首尾斷面封口（側裙端面）
      for (const [s, sgn] of [[secs[0], -1], [secs[secs.length - 1], 1]] as const) {
        sideBuf.quad(at(s, sgn * halfW, 0), at(s, -sgn * halfW, 0),
          at(s, sgn * halfW, -DECK_T), at(s, -sgn * halfW, -DECK_T))
      }

      // ── 車道標線（貼在橋面上 +3cm）──
      // 橫向偏移邏輯與 roads.buildDividers 同一套斷面模型（右正）
      const f = p.lanesForward
      const marks: { off: number; color: 'white' | 'yellow'; dash: boolean }[] = []
      marks.push({ off: -halfW + 0.35, color: 'white', dash: false })
      marks.push({ off: halfW - 0.35, color: 'white', dash: false })
      if (p.oneway === 'yes') {
        const total = f * LANE_WIDTH_M + (p.motoF ? MOTO_LANE_M + (p.motoSepF || 0) : 0)
        const left = -total / 2
        for (let k = 1; k < f; k++) marks.push({ off: left + k * LANE_WIDTH_M, color: 'white', dash: true })
      } else {
        const b = p.lanesBackward
        const c = (p.centerM || 0) / 2
        const dv = p.divOffM || 0
        if (c === 0) marks.push({ off: dv, color: 'yellow', dash: false })
        for (let k = 1; k < f; k++) marks.push({ off: dv + c + k * LANE_WIDTH_M, color: 'white', dash: true })
        for (let k = 1; k < b; k++) marks.push({ off: dv - c - k * LANE_WIDTH_M, color: 'white', dash: true })
      }
      for (const mk of marks) {
        const buf = mk.color === 'yellow' ? yellowBuf : whiteBuf
        const w = mk.color === 'yellow' ? 0.13 : 0.08 // 半寬
        const seg = (d0: number, d1: number) => {
          const a = section(d0), b2 = section(d1)
          buf.quad(at(a, mk.off - w, 0.03), at(a, mk.off + w, 0.03),
            at(b2, mk.off - w, 0.03), at(b2, mk.off + w, 0.03))
        }
        if (mk.dash) {
          for (let d = dA; d + DASH_ON <= dB; d += DASH_CYCLE) seg(d, d + DASH_ON)
        } else {
          // 實線直接沿取樣斷面連續鋪（頂點與橋面共用取樣，跟著爬升）
          for (let i = 1; i < secs.length; i++) {
            const a = secs[i - 1], b2 = secs[i]
            buf.quad(at(a, mk.off - w, 0.03), at(a, mk.off + w, 0.03),
              at(b2, mk.off - w, 0.03), at(b2, mk.off + w, 0.03))
          }
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
    // 每個取樣點的高度：detour 暫時路線（span 無 road）與非高架段 = 0
    const hs = band.coords.map((c, i) => {
      if (!model) return 0
      const span = spanAtDist(route, band.routeD[i])
      return span?.road?.properties.elevated ? model.heightAtPos(span.road, c) : 0
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
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h, r: 1 }
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
