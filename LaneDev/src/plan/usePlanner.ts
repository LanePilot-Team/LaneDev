// 路線規劃：起點/停靠點/終點狀態、A* 呼叫與路線繪製、車種（汽/機車）、
// 兩段式左轉/偏心道旗標標註。LaneDev / LaneNav 共用。
import { useRef, useState, type RefObject } from 'react'
import maplibregl from 'maplibre-gl'
import {
  mergeRoutes, laneOffsetCoords,
  type RouteResult, type Maneuver, type Profile,
} from '../core/graph'
import { annotateBays } from '../core/turnbays'
import { angleDelta } from '../core/geo'
import { EMPTY_FC, type MapCore, type Mode } from '../app/mapCore'

export interface Stop { id: number; pos: [number, number] | null }

export const DEMO_FROM: [number, number] = [120.2758, 22.7327] // 高雄大學
export const DEMO_TO: [number, number] = [120.3268, 22.7357] // 楠梓車站一帶

export interface Planner {
  stops: Stop[]
  stopsRef: RefObject<Stop[]>
  activeStop: number | null
  routeRef: RefObject<RouteResult | null>
  routeSummary: { km: number; min: number } | null
  routeError: string | null
  profile: Profile
  profileRef: RefObject<Profile>
  dragStopRef: RefObject<number | null>
  dragOverStop: number | null
  setDragOverStop: (fn: number | null | ((v: number | null) => number | null)) => void
  /** App 在 useDrive 建好後把 stopAllDrivers 塞進來（clearAllRoute 要用） */
  stopAllDriversRef: RefObject<() => void>
  startPick: (demo: boolean) => void
  clearAllRoute: () => void
  addVia: () => void
  resetStop: (id: number) => void
  removeStop: (id: number) => void
  moveStop: (fromId: number | null, toId: number) => void
  handlePickClick: (p: [number, number]) => void
  computeTwoStage: (m: Maneuver, prof: Profile) => boolean
  isTwoStage: (m: Maneuver | null) => boolean
  annotateTwoStage: (route: RouteResult) => void
  toggleProfile: (mode: Mode) => void
}

export function usePlanner(core: MapCore): Planner {
  // ── 路線停靠點（mvp 還原：起點/停靠點/終點，可逐一重設）──
  const [stops, setStopsState] = useState<Stop[]>([{ id: 1, pos: null }, { id: 2, pos: null }])
  const stopsRef = useRef<Stop[]>([{ id: 1, pos: null }, { id: 2, pos: null }])
  const stopSeq = useRef(2)
  const activeStopRef = useRef<number | null>(1)
  const [activeStop, setActiveStopState] = useState<number | null>(1)
  const setActiveStop = (id: number | null) => { activeStopRef.current = id; setActiveStopState(id) }

  const routeRef = useRef<RouteResult | null>(null)
  const [routeSummary, setRouteSummary] = useState<{ km: number; min: number } | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [profile, setProfileState] = useState<Profile>('car')
  const profileRef = useRef<Profile>('car')
  const dragStopRef = useRef<number | null>(null) // 停靠點拖曳排序：拖曳中的 stop id
  const [dragOverStop, setDragOverStop] = useState<number | null>(null)
  const stopAllDriversRef = useRef<() => void>(() => {})

  // ── 停靠點操作（只用 ref，讓地圖 handler 安全呼叫）──
  function setStops(next: Stop[]) {
    stopsRef.current = next
    setStopsState(next)
    syncEndpoints()
    routeFromStops()
  }

  function syncEndpoints() {
    if (!core.mapRef.current) return
    const n = stopsRef.current.length
    core.src('endpoints').setData({
      type: 'FeatureCollection',
      features: stopsRef.current
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.pos)
        .map(({ s, i }) => ({
          type: 'Feature',
          properties: { kind: i === 0 ? 'start' : i === n - 1 ? 'end' : 'via' },
          geometry: { type: 'Point', coordinates: s.pos! },
        })),
    } as never)
  }

  function routeFromStops() {
    setRouteError(null)
    const pts = stopsRef.current.map((s) => s.pos)
    const g = core.graphRef.current
    if (!g || pts.some((p) => !p)) { clearRouteLine(); return }
    const legs: RouteResult[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const leg = g.route(pts[i]!, pts[i + 1]!, profileRef.current)
      if (!leg) {
        clearRouteLine()
        setRouteError(`第 ${i + 1} 段規劃失敗，請調整位置`)
        return
      }
      legs.push(leg)
    }
    const route = legs.length > 1 ? mergeRoutes(legs) : legs[0]
    annotateTwoStage(route)
    routeRef.current = route
    // 路線帶偏移到實際行駛車道（車道級導航的視覺核心）
    core.src('route').setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: laneOffsetCoords(route) },
      }],
    } as never)
    const b = route.coords.reduce(
      (acc, c) => acc.extend(c as [number, number]),
      new maplibregl.LngLatBounds(route.coords[0], route.coords[0]))
    core.mapRef.current!.fitBounds(b, { padding: { top: 80, bottom: 80, left: 80, right: 240 }, pitch: 0, bearing: 0 })
    setRouteSummary({ km: route.lengthM / 1000, min: route.timeS / 60 })
  }

  function clearRouteLine() {
    routeRef.current = null
    setRouteSummary(null)
    if (core.mapRef.current) core.src('route').setData(EMPTY_FC as never)
  }

  /** 進入規劃模式的停靠點初始化（模式切換本身由 App 的 switchMode/setMode 處理） */
  function startPick(demo: boolean) {
    clearAllRoute()
    if (demo) {
      stopSeq.current = 2
      setStops([{ id: 1, pos: DEMO_FROM }, { id: 2, pos: DEMO_TO }])
      setActiveStop(null)
    } else {
      stopSeq.current = 2
      setStops([{ id: 1, pos: null }, { id: 2, pos: null }])
      setActiveStop(1)
    }
  }

  function clearAllRoute() {
    stopAllDriversRef.current()
    clearRouteLine()
    setRouteError(null)
    if (core.mapRef.current) {
      core.src('endpoints').setData(EMPTY_FC as never)
    }
  }

  function addVia() {
    const list = stopsRef.current
    const id = ++stopSeq.current
    const next = [...list.slice(0, -1), { id, pos: null }, list[list.length - 1]]
    setStops(next)
    setActiveStop(id)
  }

  function resetStop(id: number) {
    setStops(stopsRef.current.map((s) => (s.id === id ? { ...s, pos: null } : s)))
    setActiveStop(id)
  }

  function removeStop(id: number) {
    setStops(stopsRef.current.filter((s) => s.id !== id))
    if (activeStopRef.current === id) {
      const nextEmpty = stopsRef.current.find((s) => !s.pos)
      setActiveStop(nextEmpty ? nextEmpty.id : null)
    }
  }

  /** 拖曳排序：把 fromId 移到 toId 的位置（角色跟著新順序走，setStops 會自動重算路線） */
  function moveStop(fromId: number | null, toId: number) {
    if (fromId === null || fromId === toId) return
    const list = [...stopsRef.current]
    const fi = list.findIndex((s) => s.id === fromId)
    const ti = list.findIndex((s) => s.id === toId)
    if (fi < 0 || ti < 0) return
    const [moved] = list.splice(fi, 1)
    list.splice(ti, 0, moved)
    setStops(list)
  }

  /** pick 模式的地圖點擊：指派給「作用中」的停靠點；沒有就找第一個未設定的 */
  function handlePickClick(p: [number, number]) {
    const list = stopsRef.current
    let idx = list.findIndex((s) => s.id === activeStopRef.current)
    if (idx < 0 || list[idx].pos) idx = list.findIndex((s) => !s.pos)
    if (idx < 0) return
    const next = list.map((s, i) => (i === idx ? { ...s, pos: p } : s))
    stopsRef.current = next
    setStopsState(next)
    const nextEmpty = next.find((s) => !s.pos)
    setActiveStop(nextEmpty ? nextEmpty.id : null)
    syncEndpoints()
    routeFromStops()
  }

  /**
   * 兩段式左轉判定：機車 + 左轉 + 該路口有待轉區
   * 且「進入行向」與待轉區設定的方向一致（同路口其他方向的左轉不觸發）。
   */
  function computeTwoStage(m: Maneuver, prof: Profile): boolean {
    if (prof !== 'moto') return false
    if (m.kind !== 'left' && m.kind !== 'uturn' && m.kind !== 'slight-left') return false
    return core.zonesRef.current.some((z) =>
      m.nodeId !== undefined && z.intersectionId === m.nodeId &&
      m.fromBearing !== undefined &&
      Math.abs(angleDelta(z.from.bearing, m.fromBearing)) < 50)
  }

  function isTwoStage(m: Maneuver | null): boolean {
    return !!m && computeTwoStage(m, profile)
  }

  /** 路線建好後標記兩段式旗標與偏心左轉道（變道規則與絲帶都靠它；bay 要在
   * 兩段式之後標——兩段式左轉不進 bay） */
  function annotateTwoStage(route: RouteResult) {
    for (const m of route.maneuvers) m.twoStage = computeTwoStage(m, profileRef.current)
    annotateBays(route, core.baysRef.current)
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__route = route
  }

  function toggleProfile(mode: Mode) {
    const next: Profile = profileRef.current === 'car' ? 'moto' : 'car'
    profileRef.current = next
    setProfileState(next)
    if (mode === 'pick') routeFromStops() // 換車種即重算
  }

  return {
    stops, stopsRef, activeStop, routeRef, routeSummary, routeError,
    profile, profileRef, dragStopRef, dragOverStop, setDragOverStop, stopAllDriversRef,
    startPick, clearAllRoute, addVia, resetStop, removeStop, moveStop, handlePickClick,
    computeTwoStage, isTwoStage, annotateTwoStage, toggleProfile,
  }
}
