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
import type { ElevationModel } from './elevation'

/** 取樣間距（公尺）：橋面/護欄沿中心線的斷面密度（爬升段的平滑度來源） */
const STEP_M = 8
/** 橋面板厚 */
const DECK_T = 0.7
/** 護欄高 */
const RAIL_H = 0.9
/** 橋墩間距 / 最低出現高度（爬升近地段不畫墩） */
const PIER_EVERY_M = 30
const PIER_MIN_H = 3
/** 低於這個高度的斷面不建橋面（近地段讓 MapLibre 平面路面自然接手） */
const MIN_DECK_H = 0.3
/** 車道虛線：4m 線段 + 6m 間隔（國道標線節奏） */
const DASH_ON = 4
const DASH_CYCLE = 10

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
    this.renderer?.dispose()
  }

  private disposeMeshes() {
    for (const m of this.group.children) (m as THREE.Mesh).geometry?.dispose()
    this.group.clear()
  }

  private tmpMatrix = new THREE.Matrix4()
  render(_gl: WebGL2RenderingContext, arg: unknown) {
    if (!this.renderer || this.group.children.length === 0) return
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

      // 高度足夠的取樣段落（近地段不建，切成多段 run）
      const ds: number[] = []
      for (let d = 0; d <= lenM; d += STEP_M) ds.push(d)
      if (ds[ds.length - 1] < lenM) ds.push(lenM)
      const runs: Section[][] = []
      let cur: Section[] | null = null
      for (const d of ds) {
        const s = section(d)
        if (s.h >= MIN_DECK_H) {
          if (!cur) runs.push(cur = [])
          cur.push(s)
        } else cur = null
      }

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
          if (a.h < MIN_DECK_H || b2.h < MIN_DECK_H) return
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
}
