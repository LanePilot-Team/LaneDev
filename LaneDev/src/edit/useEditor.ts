// 編輯模式（LaneDev 專屬，不同步到 LaneNav）：車道/待轉區/偏心道/車輛四種工具的
// 狀態、地圖點擊分派與 journal 寫入。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl'
import type { Profile, TurnOption } from '../core/graph'
import { appendRecord, applyToRoads, foldJournal } from '../core/enhancements'
import { groundMoves } from '../core/turnbays'
import { haversine, bearing as geoBearing } from '../core/geo'
import type { PlacedVehicle } from '../core/vehicles'
import type { MapCore, Mode } from '../app/mapCore'

export type EditTool = 'lane' | 'zone' | 'bay' | 'vehicle'

export const TURN_CYCLE = ['through', 'left', 'right', 'left;through', 'through;right', 'through+right', 'left;right', 'reverse']
export const TURN_EDIT_GLYPH: Record<string, string> = {
  through: '↑', left: '↰', right: '↱', 'left;through': '↰↑',
  'through;right': '↑↱', 'through+right': '↑+↱', // +：並排式兩支完整箭頭
  'left;right': '↰↱', reverse: '↩',
}

/** 中央偏心道的轉向選項（none = 該行向路口前無偏心道） */
export const BAY_TURN_CYCLE = ['none', 'left', 'uturn', 'left|uturn']
export const BAY_TURN_GLYPH: Record<string, string> = {
  none: '無', left: '↰', uturn: '↩', 'left|uturn': '↰↩',
}

/** 車道數改變時調整 turn:lanes 陣列長度（新增車道預設直行） */
export function resizeTurnLanes(tl: string[], n: number): string[] {
  const out = tl.slice(0, n)
  while (out.length < n) out.push('through')
  return out
}

/** 方位角 → 中文方位（讓「順向/逆向」對應使用者腦中的東西南北） */
export function compassOf(brg: number): string {
  const dirs = ['北', '東北', '東', '東南', '南', '西南', '西', '西北']
  return dirs[Math.round((((brg % 360) + 360) % 360) / 45) % 8] + '向'
}

export interface EditRoadState {
  osmId: number; name?: string; oneway: string
  /** 區塊識別（way 依路口切塊）：編輯只影響這個路口到路口的區塊 */
  blockNode: number
  f: number; b: number; motoF: boolean; motoB: boolean
  centerM: number; centerKind: 'hatch' | 'island'
  /** 路寬微調（公尺，可負；對稱加減在斷面兩側，車道線不動） */
  extraM: number
  canCenter: boolean // 中央帶編輯只對 couplet 合併段開放
  fwdLabel: string; bwdLabel: string
  turnLanes: string[]
  turnLanesB: string[]
  /** 區塊兩端 node（偏心道 journal 鍵用：順向 bay 在 nodeLast、逆向在 nodeFirst） */
  nodeFirst: number; nodeLast: number
  /** 兩向偏心道轉向（BAY_TURN_CYCLE 值）；*0 = 開面板時的初值，儲存只寫差異 */
  bayF: string; bayB: string
  bayF0: string; bayB0: string
  /** 兩向地面規則（GROUND_RULES code，順序 = 選取順序 = 印字由上往下） */
  rulesF: string[]; rulesB: string[]
}

export interface Editor {
  editTool: EditTool
  setEditTool: (t: EditTool) => void
  editRoad: EditRoadState | null
  setEditRoad: React.Dispatch<React.SetStateAction<EditRoadState | null>>
  zonePanel: { nodeId: number; options: TurnOption[] } | null
  setZonePanel: (v: { nodeId: number; options: TurnOption[] } | null) => void
  bayPanel: { nodeId: number } | null
  setBayPanel: (v: { nodeId: number } | null) => void
  islandPanel: { pairKey: string; wEff?: number } | null
  setIslandPanel: (v: { pairKey: string; wEff?: number } | null) => void
  overrideTwin: (key: string, fields: Record<string, string | number>) => void
  editWarn: string | null
  handleEditClick: (map: MLMap, e: MapMouseEvent, p: [number, number]) => void
  saveRoadEdit: () => void
  overrideBay: (key: string, fields: Record<string, string | number>) => void
  overrideRightLane: (key: string, fields: Record<string, string | number>) => void
  deleteVehicle: (id: string) => void
  clearVehicles: () => void
  /** 模式切換時關掉所有編輯面板並取消選取 */
  closeAll: () => void
}

export function useEditor(core: MapCore, profileRef: RefObject<Profile>, modeRef: RefObject<Mode>): Editor {
  const [editTool, setEditToolState] = useState<EditTool>('lane')
  const editToolRef = useRef<EditTool>('lane')
  const setEditTool = (t: EditTool) => { editToolRef.current = t; setEditToolState(t) }
  const [editRoad, setEditRoad] = useState<EditRoadState | null>(null)
  const [zonePanel, setZonePanel] = useState<{ nodeId: number; options: TurnOption[] } | null>(null)
  const [bayPanel, setBayPanel] = useState<{ nodeId: number } | null>(null)
  const [islandPanel, setIslandPanel] = useState<{ pairKey: string; wEff?: number } | null>(null)
  const [bayTick, setBayTick] = useState(0) // journal 覆寫後讓面板重算
  void bayTick
  const [editWarn, setEditWarn] = useState<string | null>(null)
  const editWarnTimer = useRef<number>(0)

  function warn(msg: string) {
    setEditWarn(msg)
    window.clearTimeout(editWarnTimer.current)
    editWarnTimer.current = window.setTimeout(() => setEditWarn(null), 2500)
  }

  /** edit 模式的地圖點擊分派（App 的 dispatcher 只在 mode==='edit' 時呼叫） */
  function handleEditClick(map: MLMap, e: MapMouseEvent, p: [number, number]) {
    if (editToolRef.current === 'lane') {
      // 顯式配對分隔島（高雄大學路等）：點島面 → 島寬/開關面板
      const hitIsland = map.queryRenderedFeatures(e.point, { layers: ['median-fill'] })
      const pairKey = hitIsland[0]?.properties?.pairKey as string | undefined
      if (pairKey) {
        const wEff = hitIsland[0].properties.wEff
        setIslandPanel({ pairKey, wEff: typeof wEff === 'number' ? wEff : undefined })
        setEditRoad(null)
        return
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['road-surface', 'roads-simple'] })
      if (hit.length === 0) { setEditRoad(null); setIslandPanel(null); return }
      // way 已依路口切塊：osm_id + blockNode 才唯一指到點選的區塊
      const road = core.roadsRef.current.find(
        (r) => r.properties.osm_id === Number(hit[0].properties.osm_id)
          && r.properties.blockNode === Number(hit[0].properties.blockNode))
      if (!road) return
      const p2 = road.properties
      const cs = road.geometry.coordinates as [number, number][]
      const brg = geoBearing(cs[0], cs[cs.length - 1])
      // 面板初始值 = 路面圖示（有真值用真值，否則同 buildLaneArrows 的預設推導）
      const g = core.graphRef.current
      const tl = g ? groundMoves(g, core.baysRef.current, road, false, core.rightLanesRef.current)
        : Array.from({ length: p2.lanesForward }, () => 'through')
      const tlB = g && p2.oneway === 'no'
        ? groundMoves(g, core.baysRef.current, road, true, core.rightLanesRef.current)
        : Array.from({ length: Math.max(1, p2.lanesBackward) }, () => 'through')
      const nodeFirst = p2.nodes[0] ?? 0
      const nodeLast = p2.nodes[p2.nodes.length - 1] ?? 0
      // 兩向偏心道現況（folded journal 已反映在 baysRef）
      const bayOf = (key: string) =>
        core.baysRef.current.find((b) => b.key === key)?.turns ?? 'none'
      const bayF = bayOf(`way/${p2.osm_id}@node/${nodeLast}`)
      const bayB = bayOf(`way/${p2.osm_id}@node/${nodeFirst}~b`)
      // 地面規則現況（無人工設定時顯示 fallback，讓使用者看到現有印字的來源）
      const rulesF = p2.rulesF ?? (p2.motorcycle === 'no' ? ['no_moto'] : [])
      const rulesB = p2.oneway === 'no'
        ? (p2.rulesB ?? (p2.motorcycle === 'no' ? ['no_moto'] : []))
        : []
      setEditRoad({
        osmId: p2.osm_id, name: p2.name, oneway: p2.oneway,
        blockNode: p2.blockNode,
        f: p2.lanesForward, b: p2.lanesBackward,
        motoF: p2.motoF, motoB: p2.motoB,
        centerM: p2.centerM || 0,
        extraM: p2.extraM || 0,
        centerKind: p2.centerKind === 'island' ? 'island' : 'hatch',
        canCenter: !!p2.coupletMerged || (p2.centerM || 0) > 0,
        fwdLabel: compassOf(brg), bwdLabel: compassOf(brg + 180),
        turnLanes: resizeTurnLanes(tl, p2.lanesForward),
        turnLanesB: resizeTurnLanes(tlB, Math.max(1, p2.lanesBackward)),
        nodeFirst, nodeLast,
        bayF, bayB, bayF0: bayF, bayB0: bayB,
        rulesF: [...rulesF], rulesB: [...rulesB],
      })
    } else if (editToolRef.current === 'vehicle') {
      // three.js 圖層不能用 queryRenderedFeatures，改用距離命中
      let hitV: PlacedVehicle | null = null
      let hitD = 4 // 公尺
      for (const v of core.vehiclesRef.current) {
        const d = haversine(p, v.pos)
        if (d < hitD) { hitD = d; hitV = v }
      }
      if (hitV) {
        core.selectedVehicleRef.current = hitV.id
        core.refreshVehicles()
        return
      }
      const snap = core.graphRef.current?.snapToLane(p, profileRef.current)
      if (!snap || haversine(p, snap.pos) > 20) {
        warn('請點在道路附近放置車輛')
        return
      }
      const v: PlacedVehicle = {
        id: `veh-${Date.now().toString(36)}`,
        type: profileRef.current,
        pos: snap.pos,
        bearing: snap.bearing,
        road: snap.road,
      }
      core.vehiclesRef.current = [...core.vehiclesRef.current, v]
      core.selectedVehicleRef.current = v.id
      core.refreshVehicles()
    } else if (editToolRef.current === 'bay') {
      // 偏心左轉道：點路口 → 面板列出各進入行向的 bay 狀態（開/關/參數，journal 覆寫）
      let nodeId: number | null = null
      let bestD = 25
      for (const it of core.intersectionsRef.current) {
        const d = haversine(p, it.pos)
        if (d < bestD) { bestD = d; nodeId = it.id }
      }
      if (nodeId === null) {
        warn('請點選路口（25 公尺內）')
        return
      }
      setBayPanel({ nodeId })
    } else {
      // 待轉區 v2：點路口 → 面板列出左轉配對，位置自動計算（不能自由放）
      const hitZone = map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] })
      let nodeId: number | null = null
      if (hitZone.length > 0) {
        const z = core.zonesRef.current.find((z) => z.id === String(hitZone[0].properties.id))
        if (z) { core.selectedZoneRef.current = z.id; nodeId = z.intersectionId }
      } else {
        let bestD = 25
        for (const it of core.intersectionsRef.current) {
          const d = haversine(p, it.pos)
          if (d < bestD) { bestD = d; nodeId = it.id }
        }
      }
      if (nodeId === null) {
        warn('請點選路口（25 公尺內）')
        return
      }
      const options = core.graphRef.current?.leftTurnOptions(nodeId) ?? []
      setZonePanel({ nodeId, options })
      core.refreshZones()
    }
  }

  function saveRoadEdit() {
    if (!editRoad) return
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set',
      // 區塊級鍵：只影響點選的「路口到路口」區塊（舊 way 級紀錄仍相容、先套用）
      target: { type: 'road', key: `way/${editRoad.osmId}@b/${editRoad.blockNode}` },
      fields: {
        lanes_forward: editRoad.f,
        lanes_backward: editRoad.oneway === 'yes' ? 0 : editRoad.b,
        moto_forward: editRoad.motoF ? 1 : 0,
        moto_backward: editRoad.oneway === 'yes' ? 0 : (editRoad.motoB ? 1 : 0),
        center_m: editRoad.oneway === 'yes' ? 0 : editRoad.centerM,
        center_kind: editRoad.centerKind,
        extra_width_m: editRoad.extraM,
        turn_lanes: editRoad.turnLanes.join('|'),
        rules_forward: editRoad.rulesF.join('|'),
        ...(editRoad.oneway === 'no'
          ? {
            turn_lanes_backward: editRoad.turnLanesB.join('|'),
            rules_backward: editRoad.rulesB.join('|'),
          }
          : {}),
      },
    })
    // 偏心道轉向（有動才寫）：none = 該行向關閉、其餘 = 開啟並指定轉向
    const writeBay = (key: string, v: string, v0: string) => {
      if (v === v0) return
      core.journalRef.current = appendRecord(core.journalRef.current, {
        op: 'set', target: { type: 'turn_bay', key },
        fields: v === 'none' ? { present: 0 } : { present: 1, turns: v },
      })
    }
    const bayKeyF = `way/${editRoad.osmId}@node/${editRoad.nodeLast}`
    const bayKeyB = `way/${editRoad.osmId}@node/${editRoad.nodeFirst}~b`
    if (editRoad.oneway === 'no') {
      writeBay(bayKeyF, editRoad.bayF, editRoad.bayF0)
      writeBay(bayKeyB, editRoad.bayB, editRoad.bayB0)
    }
    applyToRoads(core.roadsRef.current, foldJournal(core.journalRef.current))
    // 編輯即所見：路寬與車道線立即重繪（bay 橫向位置依斷面寬，也要跟著動）
    core.redrawRoads()
    core.refreshBays()
    // 生成失敗回饋：設了偏心道轉向但幾何放不下（超短區塊）時明講，不要靜默失敗
    if (editRoad.oneway === 'no') {
      const failed: string[] = []
      if (editRoad.bayF !== 'none' && !core.baysRef.current.some((b) => b.key === bayKeyF)) {
        failed.push(editRoad.fwdLabel)
      }
      if (editRoad.bayB !== 'none' && !core.baysRef.current.some((b) => b.key === bayKeyB)) {
        failed.push(editRoad.bwdLabel)
      }
      if (failed.length) warn(`${failed.join('、')}偏心道未生成：此區塊太短，放不下儲車段`)
    }
    setEditRoad(null)
  }

  /** 偏心道覆寫寫入 journal 並立即重算（present:0 關閉、present:1 開啟、附參數） */
  function overrideBay(key: string, fields: Record<string, string | number>) {
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set', target: { type: 'turn_bay', key }, fields,
    })
    core.refreshBays()
    setBayTick((t) => t + 1)
  }

  /** 右轉附加車道覆寫（present 開關 / len_m 儲車長），寫入即重算 */
  function overrideRightLane(key: string, fields: Record<string, string | number>) {
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set', target: { type: 'right_lane', key }, fields,
    })
    core.refreshBays()
    setBayTick((t) => t + 1)
  }

  /** 顯式配對分隔島覆寫（w 島寬 / present 開關），寫入即重算 */
  function overrideTwin(key: string, fields: Record<string, string | number>) {
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set', target: { type: 'twin_island', key }, fields,
    })
    core.refreshBays()
    setBayTick((t) => t + 1)
  }

  function deleteVehicle(id: string) {
    core.vehiclesRef.current = core.vehiclesRef.current.filter((v) => v.id !== id)
    core.selectedVehicleRef.current = null
    core.refreshVehicles()
  }

  function clearVehicles() {
    core.vehiclesRef.current = []
    core.selectedVehicleRef.current = null
    core.refreshVehicles()
  }

  function closeAll() {
    setEditRoad(null)
    setZonePanel(null)
    setBayPanel(null)
    setIslandPanel(null)
    core.selectedZoneRef.current = null
    core.selectedVehicleRef.current = null
  }

  // ── 鍵盤：Del 刪除選取的車輛（待轉區改由面板管理，不再拖曳/旋轉）。
  // 行駛中的鍵盤操作（變速/橫向漂移）在 useDrive 自己的 effect 裡處理 ──
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (modeRef.current !== 'edit') return
      if (editToolRef.current === 'vehicle' && core.selectedVehicleRef.current &&
        (ev.key === 'Delete' || ev.key === 'Backspace')) {
        core.vehiclesRef.current = core.vehiclesRef.current.filter(
          (v) => v.id !== core.selectedVehicleRef.current)
        core.selectedVehicleRef.current = null
        core.refreshVehicles()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    editTool, setEditTool, editRoad, setEditRoad, zonePanel, setZonePanel,
    bayPanel, setBayPanel, islandPanel, setIslandPanel, editWarn,
    handleEditClick, saveRoadEdit, overrideBay, overrideRightLane, overrideTwin,
    deleteVehicle, clearVehicles, closeAll,
  }
}
