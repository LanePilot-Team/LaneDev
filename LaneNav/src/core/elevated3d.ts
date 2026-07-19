// 高架橋面 3D 圖層（方案 B：three.js 織帶橋面）：沿高架區塊中心線建帶狀 mesh
// ——橋面（含側裙/底面）＋車道標線（細長條 geometry）＋兩側護欄＋橋墩。
// 高度取自 elevation.ts 同一份剖面，與車輛 z 完全一致；匝道爬升因此連續不階梯。
//
// 座標/渲染模式照 models3d.ts：場景錨定楠梓中心、MercatorCoordinate 換算公尺
//（不自己湊常數——踩過的坑）、共用 MapLibre 的 WebGL context、antialias 一律關。
import * as THREE from 'three'
import maplibregl, { type Map as MLMap, type CustomLayerInterface } from 'maplibre-gl'
import { NANZI_CENTER, pointAlong, cumulative, LANE_WIDTH_M } from './geo'
import { MOTO_LANE_M } from './roads'
import { activeElevation, type ElevationModel } from './elevation'
import { spanAtDist, type RouteResult, type LaneBandResult } from './graph'

/** 取樣間距（公尺）：橋面/護欄沿中心線的斷面密度（爬升段的平滑度來源） */
const STEP_M = 8
/** 橋面板厚 */
const DECK_T = 0.7
/** 護欄高 */
const RAIL_H = 0.9
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

/** 斷面：中心點場景座標 + 行進右向單位向量 + 高度 */
interface Section { x: number; z: number; rx: number; rz: number; h: number }

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

    for (const { road, lenM } of model.entries()) {
      const p = road.properties
      const coords = road.geometry.coordinates as [number, number][]
      const cum = cumulative(coords)
      const halfW = p.width_m / 2

      // 斷面取樣：底下所有帶狀件共用（頂點對齊，接縫才不會裂）
      const section = (d: number): Section => {
        const { pos, brg } = pointAlong(coords, cum, d)
        const [e, n] = this.toScene(pos[0], pos[1])
        const rad = (brg * Math.PI) / 180
        // 場景 x=東、z=南；行進右向 =（cos brg, sin brg)（北向→右=東 ✓）
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h: model.heightAt(road, d) }
      }
      const at = (s: Section, off: number, y: number): V3 =>
        [s.x + s.rx * off, s.h + y, s.z + s.rz * off]

      // 全長取樣：高架區塊的地面路體已隱藏（RoadProps.elevated 過濾），
      // 橋面連近地爬升段一起建，銜接處與平面路自然對齊
      const ds: number[] = []
      for (let d = 0; d <= lenM; d += STEP_M) ds.push(d)
      if (ds[ds.length - 1] < lenM) ds.push(lenM)
      const runs: Section[][] = [ds.map(section)]

      for (const run of runs) {
        for (let i = 1; i < run.length; i++) {
          const a = run[i - 1], b = run[i]
          // 橋面（頂）＋底面＋兩側裙板（底/側從橋下可見——陸橋下平面路口）
          deckBuf.quad(at(a, -halfW, 0), at(a, halfW, 0), at(b, -halfW, 0), at(b, halfW, 0))
          sideBuf.quad(at(a, halfW, -DECK_T), at(a, -halfW, -DECK_T),
            at(b, halfW, -DECK_T), at(b, -halfW, -DECK_T))
          sideBuf.quad(at(a, -halfW, -DECK_T), at(a, -halfW, 0),
            at(b, -halfW, -DECK_T), at(b, -halfW, 0))
          sideBuf.quad(at(a, halfW, 0), at(a, halfW, -DECK_T),
            at(b, halfW, 0), at(b, halfW, -DECK_T))
          // 護欄：兩側直立板（DoubleSide 材質）
          railBuf.quad(at(a, -halfW + 0.12, 0), at(a, -halfW + 0.12, RAIL_H),
            at(b, -halfW + 0.12, 0), at(b, -halfW + 0.12, RAIL_H))
          railBuf.quad(at(a, halfW - 0.12, RAIL_H), at(a, halfW - 0.12, 0),
            at(b, halfW - 0.12, RAIL_H), at(b, halfW - 0.12, 0))
        }
        // 首尾斷面封口（側裙端面）
        for (const [s, sgn] of [[run[0], -1], [run[run.length - 1], 1]] as const) {
          sideBuf.quad(at(s, sgn * halfW, 0), at(s, -sgn * halfW, 0),
            at(s, sgn * halfW, -DECK_T), at(s, -sgn * halfW, -DECK_T))
        }
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
          for (let d = 0; d + DASH_ON <= lenM; d += DASH_CYCLE) seg(d, d + DASH_ON)
        } else {
          for (const run of runs) {
            // 實線直接沿取樣斷面連續鋪（頂點與橋面共用取樣，跟著爬升）
            for (let i = 1; i < run.length; i++) {
              const a = run[i - 1], b2 = run[i]
              buf.quad(at(a, mk.off - w, 0.03), at(a, mk.off + w, 0.03),
                at(b2, mk.off - w, 0.03), at(b2, mk.off + w, 0.03))
            }
          }
        }
      }

      // ── 橋墩：每 ~30m 一根單柱（近地爬升段不畫）──
      for (let d = PIER_EVERY_M / 2; d < lenM; d += PIER_EVERY_M) {
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
        return { x: e, z: -n, rx: Math.cos(rad), rz: Math.sin(rad), h }
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
