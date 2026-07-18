// 真 3D 車輛模型：MapLibre 自訂圖層 + three.js。
// 模型用程式組（低多邊形轎車/機車+騎士），不依賴外部 glTF 檔。
//
// 座標系：場景錨定在楠梓中心，物件用公尺位移擺放（避免 mercator 絕對座標的
// float32 精度問題）。場景軸向：x=東、y=上、z=南（模型面朝 -z=北，yaw=-bearing）。
import * as THREE from 'three'
import maplibregl, { type Map as MLMap, type CustomLayerInterface } from 'maplibre-gl'
import { NANZI_CENTER } from './geo'
import type { PlacedVehicle } from './vehicles'

const CAR_COLORS = [0x2f66e5, 0xd33f49, 0x3aa17e, 0xe0a63c, 0x6b7280]

function colorFor(id: string): number {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return CAR_COLORS[h % CAR_COLORS.length]
}

const mat = (color: number) => new THREE.MeshLambertMaterial({ color })

function wheel(r: number, w: number, x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 12), mat(0x1a2230))
  m.rotation.z = Math.PI / 2
  m.position.set(x, r, z)
  return m
}

/** 低多邊形轎車（長 4.4m，面朝 -z） */
export function buildCar(body: number): THREE.Group {
  const g = new THREE.Group()
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 4.4), mat(body))
  b.position.y = 0.62
  g.add(b)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.52, 2.1), mat(0x18243c))
  cabin.position.set(0, 1.15, 0.25)
  g.add(cabin)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 1.7), mat(body))
  roof.position.set(0, 1.45, 0.25)
  g.add(roof)
  g.add(wheel(0.34, 0.26, 0.82, -1.45), wheel(0.34, 0.26, -0.82, -1.45))
  g.add(wheel(0.34, 0.26, 0.82, 1.4), wheel(0.34, 0.26, -0.82, 1.4))
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.1), mat(0xfff6c9))
  const head2 = head.clone()
  head.position.set(0.6, 0.62, -2.21)
  head2.position.set(-0.6, 0.62, -2.21)
  g.add(head, head2)
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.1), mat(0xc22b2b))
  const tail2 = tail.clone()
  tail.position.set(0.6, 0.66, 2.21)
  tail2.position.set(-0.6, 0.66, 2.21)
  g.add(tail, tail2)
  return g
}

/** 機車 + 騎士（長 1.9m，面朝 -z） */
export function buildScooter(helmet: number): THREE.Group {
  const g = new THREE.Group()
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 1.15), mat(0x2b3648))
  frame.position.set(0, 0.62, 0.15)
  g.add(frame)
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.66, 0.12), mat(0x39465e))
  front.position.set(0, 0.78, -0.72)
  front.rotation.x = 0.32
  g.add(front)
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.07, 0.07), mat(0x1a2230))
  bar.position.set(0, 1.06, -0.62)
  g.add(bar)
  const w1 = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.11, 12), mat(0x14181f))
  w1.rotation.z = Math.PI / 2
  w1.position.set(0, 0.26, -0.78)
  const w2 = w1.clone()
  w2.position.set(0, 0.26, 0.68)
  g.add(w1, w2)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.56, 0.3), mat(0x3d4a5c))
  torso.position.set(0, 1.12, 0.22)
  torso.rotation.x = -0.15
  g.add(torso)
  const headM = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat(helmet))
  headM.position.set(0, 1.56, 0.14)
  g.add(headM)
  return g
}

function selectionRing(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 1.9, 24),
    new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.06
  return m
}

export class VehicleModelLayer {
  id = 'vehicle-models'
  type = 'custom' as const
  renderingMode = '3d' as const

  private map: MLMap | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private placed = new THREE.Group()
  private nav: THREE.Group | null = null
  private navType: 'car' | 'moto' | null = null
  private originMatrix = new THREE.Matrix4()
  private originMerc = { x: 0, y: 0 }
  private mercScale = 1

  /** lng/lat → 場景公尺（用 MapLibre 的 Mercator 轉換，與地圖投影零誤差） */
  private toScene(lng: number, lat: number): [number, number] {
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, 0)
    return [
      (mc.x - this.originMerc.x) / this.mercScale, // 東
      -(mc.y - this.originMerc.y) / this.mercScale, // 北（mercator y 向南為正）
    ]
  }

  asLayer(): CustomLayerInterface {
    return this as unknown as CustomLayerInterface
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map
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
    this.scene.add(this.placed)
    // antialias 在內顯上很貴（之前 MapLibre 的 MSAA 就是卡頓元兇），共用 context 一律關
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(), context: gl, antialias: false,
    })
    this.renderer.autoClear = false
  }

  onRemove() {
    this.renderer?.dispose()
  }

  private tmpMatrix = new THREE.Matrix4()
  /** DEV 除錯：最近一幀的投影矩陣與 nav 場景位置 */
  lastMatrix: number[] | null = null
  get debugState() {
    return {
      origin: this.originMatrix.elements.slice(),
      nav: this.nav ? [this.nav.position.x, this.nav.position.y, this.nav.position.z] : null,
      lastMatrix: this.lastMatrix,
    }
  }

  // MapLibre v4 傳 (gl, matrix)、v5 傳 (gl, options)——兩種都接
  render(_gl: WebGL2RenderingContext, arg: unknown) {
    if (!this.renderer) return
    // 沒有任何車輛時整個 pass 跳過（省掉 resetState + render 的固定成本）
    if (this.placed.children.length === 0 && !this.nav) return
    const m: number[] = Array.isArray(arg)
      ? arg as number[]
      : ((arg as { defaultProjectionData?: { mainMatrix: number[] } })
        .defaultProjectionData?.mainMatrix ?? [])
    if (m.length !== 16) return
    this.lastMatrix = Array.from(m)
    this.camera.projectionMatrix = this.tmpMatrix.fromArray(m).multiply(this.originMatrix)
    this.renderer.resetState()
    this.renderer.render(this.scene, this.camera)
  }

  private place(g: THREE.Group, pos: [number, number], bearing: number, elevM = 0) {
    const [e, n] = this.toScene(pos[0], pos[1])
    g.position.set(e, elevM, -n)
    g.rotation.y = (-bearing * Math.PI) / 180
  }

  setVehicles(vs: PlacedVehicle[], selectedId: string | null) {
    this.placed.clear()
    for (const v of vs) {
      const g = v.type === 'car' ? buildCar(colorFor(v.id)) : buildScooter(0x22c55e)
      this.place(g, v.pos, v.bearing)
      if (v.id === selectedId) g.add(selectionRing())
      this.placed.add(g)
    }
    this.map?.triggerRepaint()
  }

  /** 導航自車（每幀更新）；type=null 隱藏。elevM = 高架高度（elevation.ts 剖面，
   * 上橋時車輛 z 跟著橋面抬） */
  setNav(pos: [number, number] | null, bearing = 0, type: 'car' | 'moto' | null = null, elevM = 0) {
    if (!pos || !type) {
      if (this.nav) { this.scene.remove(this.nav); this.nav = null; this.navType = null }
      this.map?.triggerRepaint()
      return
    }
    if (!this.nav || this.navType !== type) {
      if (this.nav) this.scene.remove(this.nav)
      this.nav = type === 'car' ? buildCar(0x2563eb) : buildScooter(0xf59e0b)
      this.navType = type
      this.scene.add(this.nav)
    }
    this.place(this.nav, pos, bearing, elevM)
  }
}
