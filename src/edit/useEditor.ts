// 編輯模式（LaneDev 專屬，不同步到 LaneNav）：車道/待轉區/偏心道/車輛四種工具的
// 狀態、地圖點擊分派與 journal 寫入。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { GeoJSONSource, Map as MLMap, MapMouseEvent } from 'maplibre-gl'
import type { Profile, TurnOption } from '../core/graph'
import {
  appendRecord, applyToRoads, foldJournal, getAuthor, type EnhancementRecord,
} from '../core/enhancements'
import {
  activeMergeForRoad, previewRoadMerge, reloadAfterRoadMergeSave,
  type RoadMergeReplayRow,
} from '../core/roadMerge'
import { flushStaticEditorSave } from '../core/staticDatabase'
import { saveRoadMergeReloadState } from '../core/roadMergeReload'
import { newRoadsFromFolded, nextNewRoadIds } from '../core/newroads'
import { groundMoves, makeMotoBoxSlot, stopLineEdges } from '../core/turnbays'
import { haversine, bearing as geoBearing } from '../core/geo'
import type { PlacedVehicle } from '../core/vehicles'
import type { MapCore, Mode } from '../app/mapCore'
import {
  buildDividers, buildRoadSurfaces, computeDerived, type LaneMark, type RoadFeature,
} from '../core/roads'
import { groundMarkingPolygons } from '../core/groundMarkings'

export type EditTool = 'lane' | 'zone' | 'bay' | 'vehicle' | 'road'

/** 拉線吸附半徑（公尺）：頂點落在既有路網 node 這個距離內就吸上去 */
const ROAD_SNAP_M = 15

/** 拉線中的新道路草稿：座標與 node id 逐點對齊（null = 自由頂點，完成時配負數 id） */
export interface DraftRoad {
  coords: [number, number][]
  nodeIds: (number | null)[]
}

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

export function resizeLaneMarks(marks: (LaneMark | null)[], n: number): (LaneMark | null)[] {
  const out = marks.slice(0, n)
  while (out.length < n) out.push(null)
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
  motoCountF: number; motoCountB: number
  /** 快慢分隔帶寬（公尺；0 = 機車道白線、>0 = 實體島） */
  motoSepF: number; motoSepB: number
  motoEntryIconF: boolean; motoEntryIconB: boolean
  motoTextDiamondF: boolean; motoTextDiamondB: boolean
  stopLineF: boolean; stopLineB: boolean
  arrowDisplayF: boolean; arrowDisplayB: boolean
  startArrowDisplayF: boolean; startArrowDisplayB: boolean
  leftWaitAreaF: boolean; leftWaitAreaB: boolean
  startTurnLanes: string[]; startTurnLanesB: string[]
  segmentLengthM: number
  roadMarkingMode: 'all' | 'center' | 'none'
  centerM: number; centerKind: 'hatch' | 'island'
  islandBayMode: boolean
  centerExtendStart: boolean; centerExtendEnd: boolean
  /** 路寬微調（公尺，可負；對稱加減在斷面兩側，車道線不動） */
  extraM: number
  canCenter: boolean // 中央帶編輯只對 couplet 合併段開放
  fwdLabel: string; bwdLabel: string
  turnLanes: string[]
  turnLanesB: string[]
  motoTurnLanesF: string[]
  motoTurnLanesB: string[]
  /** 區塊兩端 node（偏心道 journal 鍵用：順向 bay 在 nodeLast、逆向在 nodeFirst） */
  nodeFirst: number; nodeLast: number
  /** 兩向偏心道轉向（BAY_TURN_CYCLE 值）；*0 = 開面板時的初值，儲存只寫差異 */
  bayF: string; bayB: string
  bayF0: string; bayB0: string
  /** 單邊偏心道另一端的處理；雙邊使用時此值不參與幾何。 */
  baySingleMode: 'capped' | 'ignore'
  baySingleMode0: 'capped' | 'ignore'
  /** 兩向地面規則（GROUND_RULES code，順序 = 選取順序 = 印字由上往下） */
  laneMarksF: (LaneMark | null)[]; laneMarksB: (LaneMark | null)[]
  /** 機車停等格涵蓋車道數及自駕駛視角左→右的起訖範圍；*0 = 開面板初值 */
  motoBoxF: number; motoBoxB: number
  motoBoxF0: number; motoBoxB0: number
  motoBoxMaxF: number; motoBoxMaxB: number
  motoBoxStartF: number; motoBoxEndF: number
  motoBoxStartB: number; motoBoxEndB: number
  motoBoxStartF0: number; motoBoxEndF0: number
  motoBoxStartB0: number; motoBoxEndB0: number
  motoBoxSlotsF: number; motoBoxSlotsB: number
  motoBoxMinF: number; motoBoxMinB: number
  /** 路口末端才分出的右轉專用道（獨立於整段基本車道數）。 */
  rightLaneF: boolean; rightLaneB: boolean
  rightLaneF0: boolean; rightLaneB0: boolean
  rightLaneLenF: number; rightLaneLenB: number
  rightLaneLenF0: number; rightLaneLenB0: number
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
  activeRoadMerge: RoadMergeReplayRow | null
  setActiveRoadMerge: React.Dispatch<React.SetStateAction<RoadMergeReplayRow | null>>
  undoRoadMerge: () => void
  handleEditClick: (map: MLMap, e: MapMouseEvent, p: [number, number]) => void
  saveRoadEdit: () => void
  /** 拉線新增道路（road 工具）：草稿與屬性 */
  draftRoad: DraftRoad | null
  draftName: string
  setDraftName: (v: string) => void
  draftOneway: boolean
  setDraftOneway: (v: boolean) => void
  undoDraftVertex: () => void
  cancelDraftRoad: () => void
  finishDraftRoad: () => void
  /** 點選到的既有自訂道路（可刪除） */
  selNewRoad: { osmId: number; name?: string } | null
  setSelNewRoad: (v: { osmId: number; name?: string } | null) => void
  deleteNewRoad: (osmId: number) => void
  deleteRoadSegment: () => void
  overrideBay: (key: string, fields: Record<string, string | number>) => void
  overrideRightLane: (key: string, fields: Record<string, string | number>) => void
  deleteVehicle: (id: string) => void
  clearVehicles: () => void
  /** 模式切換時關掉所有編輯面板並取消選取 */
  closeAll: () => void
}

export function useEditor(core: MapCore, profileRef: RefObject<Profile>, modeRef: RefObject<Mode>): Editor {
  const [editTool, setEditToolState] = useState<EditTool>('lane')
  const [activeRoadMerge, setActiveRoadMerge] = useState<RoadMergeReplayRow | null>(null)
  const editToolRef = useRef<EditTool>('lane')
  const setEditTool = (t: EditTool) => {
    editToolRef.current = t
    setEditToolState(t)
    if (t !== 'road') { updateDraft(null); setSelNewRoad(null) } // 換工具＝放棄拉線草稿
  }
  const [editRoad, setEditRoad] = useState<EditRoadState | null>(null)

  function rememberRoadMergeReloadState() {
    const map = core.mapRef.current
    if (!map) return
    const center = map.getCenter()
    saveRoadMergeReloadState(window.sessionStorage, {
      camera: {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      },
      mode: 'edit',
      editTool,
      editRoad,
    })
  }
  const [zonePanel, setZonePanel] = useState<{ nodeId: number; options: TurnOption[] } | null>(null)
  const [bayPanel, setBayPanel] = useState<{ nodeId: number } | null>(null)
  const [islandPanel, setIslandPanel] = useState<{ pairKey: string; wEff?: number } | null>(null)
  const [bayTick, setBayTick] = useState(0) // journal 覆寫後讓面板重算
  void bayTick
  const [editWarn, setEditWarn] = useState<string | null>(null)
  const editWarnTimer = useRef<number>(0)
  // ── 拉線新增道路（road 工具）──
  const draftRoadRef = useRef<DraftRoad | null>(null) // 地圖 handler 讀 ref，state 給面板
  const [draftRoad, setDraftRoadState] = useState<DraftRoad | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftOneway, setDraftOneway] = useState(false)
  const [selNewRoad, setSelNewRoad] = useState<{ osmId: number; name?: string } | null>(null)

  /** 草稿更新三合一：ref（點擊 handler）+ state（面板）+ 地圖預覽 */
  function updateDraft(d: DraftRoad | null) {
    draftRoadRef.current = d
    setDraftRoadState(d)
    if (!core.mapRef.current) return
    const features: object[] = []
    if (d && d.coords.length >= 2) {
      features.push({
        type: 'Feature', properties: { kind: 'line' },
        geometry: { type: 'LineString', coordinates: d.coords },
      })
    }
    if (d) {
      d.coords.forEach((c, i) => features.push({
        type: 'Feature', properties: { kind: 'vertex', snapped: d.nodeIds[i] !== null },
        geometry: { type: 'Point', coordinates: c },
      }))
    }
    core.src('draftroad').setData({ type: 'FeatureCollection', features } as never)
  }

  /** 找 ROAD_SNAP_M 內最近的既有路網頂點（node id 與座標對齊的路才可靠） */
  function snapToNode(p: [number, number]): { pos: [number, number]; id: number } | null {
    let best: { pos: [number, number]; id: number; d: number } | null = null
    for (const r of core.roadsRef.current) {
      const ns = r.properties.nodes
      const cs = r.geometry.coordinates as [number, number][]
      if (ns.length !== cs.length) continue
      for (let i = 0; i < ns.length; i++) {
        const d = haversine(p, cs[i])
        if (d < ROAD_SNAP_M && (!best || d < best.d)) best = { pos: cs[i], id: ns[i], d }
      }
    }
    return best
  }

  /** 依 journal 重新物化自訂道路並重建路網（新增/刪除後）。
   * 底圖（含 couplet 合併的負 id 路段）不動，userRoad 全部重生成——journal 是唯一真相 */
  function rebuildNewRoads() {
    const folded = foldJournal(core.journalRef.current)
    const base = core.roadsRef.current.filter((r) => !r.properties.userRoad)
    const news = newRoadsFromFolded(folded, core.nodeRemapRef.current)
    applyToRoads(news, folded) // 車道覆寫也套在新路上（base 已套過，只補新物化的）
    core.replaceBaseMap([...base, ...news])
  }

  function undoDraftVertex() {
    const d = draftRoadRef.current
    if (!d) return
    updateDraft(d.coords.length <= 1 ? null
      : { coords: d.coords.slice(0, -1), nodeIds: d.nodeIds.slice(0, -1) })
  }

  function cancelDraftRoad() {
    updateDraft(null)
  }

  function finishDraftRoad() {
    const d = draftRoadRef.current
    if (!d || d.coords.length < 2) { warn('至少要兩個頂點才能成路'); return }
    const ids = nextNewRoadIds(core.journalRef.current)
    let nodeSeq = ids.nodeId
    const nodes = d.nodeIds.map((n) => n ?? nodeSeq--)
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set',
      target: { type: 'new_road', key: `way/${ids.wayId}` },
      fields: {
        geometry: JSON.stringify(d.coords.map((c) => [+c[0].toFixed(7), +c[1].toFixed(7)])),
        nodes: JSON.stringify(nodes),
        ...(draftName.trim() ? { name: draftName.trim() } : {}),
        highway: 'residential',
        oneway: draftOneway ? 'yes' : 'no',
      },
    })
    rebuildNewRoads()
    updateDraft(null)
    setDraftName('')
    setDraftOneway(false)
    const endsSnapped = (d.nodeIds[0] !== null ? 1 : 0)
      + (d.nodeIds[d.nodeIds.length - 1] !== null ? 1 : 0)
    warn(endsSnapped === 0
      ? '已新增道路，但兩端都沒接上既有路網——導航到不了，建議刪除重畫並吸附路口'
      : `已新增道路（way/${ids.wayId}）：可用「車道」工具繼續編輯斷面`)
  }

  function deleteNewRoad(osmId: number) {
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'delete', target: { type: 'new_road', key: `way/${osmId}` },
    })
    setSelNewRoad(null)
    rebuildNewRoads()
  }
  const mergeFirstRef = useRef<{ osmId: number; blockNode: number } | null>(null)

  // 編輯中的即時預覽只重算目前道路區塊，不修改正式 roadsRef 或 journal。
  useEffect(() => {
    const map = core.mapRef.current
    if (!map?.isStyleLoaded()) return
    const source = map.getSource('roadPreview') as GeoJSONSource | undefined
    if (!source) return
    if (!editRoad) {
      source.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const original = core.roadsRef.current.find((road) =>
      road.properties.osm_id === editRoad.osmId
      && road.properties.blockNode === editRoad.blockNode)
    if (!original) return
    const preview: RoadFeature = {
      ...original,
      properties: {
        ...original.properties,
        lanesForward: editRoad.f,
        lanesBackward: editRoad.oneway === 'yes' ? 0 : editRoad.b,
        lanes: editRoad.f + (editRoad.oneway === 'yes' ? 0 : editRoad.b),
        motoF: editRoad.motoF,
        motoB: editRoad.oneway === 'yes' ? false : editRoad.motoB,
        motoCountF: editRoad.motoCountF,
        motoCountB: editRoad.oneway === 'yes' ? 0 : editRoad.motoCountB,
        motoSepF: editRoad.motoF ? editRoad.motoSepF : 0,
        motoSepB: editRoad.oneway === 'yes' || !editRoad.motoB ? 0 : editRoad.motoSepB,
        centerM: editRoad.oneway === 'yes' ? 0 : editRoad.centerM,
        centerKind: editRoad.centerKind,
        islandBayMode: editRoad.islandBayMode,
        centerExtendStart: editRoad.centerExtendStart,
        centerExtendEnd: editRoad.centerExtendEnd,
        extraM: editRoad.extraM,
        roadMarkingMode: editRoad.roadMarkingMode,
        sharedLane: editRoad.oneway === 'no' && editRoad.f + editRoad.b === 1
          && !editRoad.motoF && !editRoad.motoB,
        arrowDisplayF: editRoad.arrowDisplayF,
        arrowDisplayB: editRoad.oneway === 'yes' ? false : editRoad.arrowDisplayB,
        startArrowDisplayF: editRoad.startArrowDisplayF,
        startArrowDisplayB: editRoad.oneway === 'yes' ? false : editRoad.startArrowDisplayB,
        leftWaitAreaF: editRoad.leftWaitAreaF,
        leftWaitAreaB: editRoad.oneway === 'yes' ? false : editRoad.leftWaitAreaB,
        startTurnLanes: editRoad.startTurnLanes,
        startTurnLanesB: editRoad.startTurnLanesB,
        turnLanes: editRoad.turnLanes,
        turnLanesB: editRoad.turnLanesB,
        motoTurnLanesF: editRoad.motoTurnLanesF,
        motoTurnLanesB: editRoad.motoTurnLanesB,
        laneMarksF: editRoad.laneMarksF,
        laneMarksB: editRoad.laneMarksB,
      },
    }
    computeDerived(preview.properties)
    const surfaces = buildRoadSurfaces([preview])
    const dividerLines = buildDividers([preview])
    const dividers = groundMarkingPolygons(
      dividerLines,
      (p) => p?.kind === 'center' ? 0.3
        : ['lane', 'center-double', 'moto'].includes(String(p?.kind)) ? 0.15 : null,
      (p) => p?.kind === 'lane',
    )
    source.setData({
      type: 'FeatureCollection',
      features: [...surfaces.features, ...dividers.features],
    } as never)
  }, [core, editRoad])

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
      const ctrlSelect = e.originalEvent.ctrlKey || e.originalEvent.metaKey
      if (ctrlSelect) {
        const firstKey = mergeFirstRef.current
        if (!firstKey) {
          mergeFirstRef.current = {
            osmId: road.properties.osm_id,
            blockNode: road.properties.blockNode,
          }
          warn('已選取第一段；請繼續按住 Ctrl 點選相接且平行的第二段')
          // 繼續開啟第一段面板／預覽，作為清楚的選取提示。
        } else {
          const first = core.roadsRef.current.find((r) =>
            r.properties.osm_id === firstKey.osmId
            && r.properties.blockNode === firstKey.blockNode)
          if (!first) {
            mergeFirstRef.current = null
            warn('第一段已不存在，請重新選取')
            return
          }
          const preview = previewRoadMerge(
            core.roadsRef.current, core.journalRef.current, first, road)
          if (!preview.ok || !preview.record) {
            warn(`無法捏合：${preview.reason ?? '驗證失敗'}`)
            return
          }
          const ok = window.confirm(
            `確定將這兩段「${first.properties.name ?? '未命名道路'}」捏合為同一路段嗎？\n\n`
            + `保留：${String(preview.record.fields?.primary)}\n`
            + `接合：${String(preview.record.fields?.secondary)}\n\n`
            + '捏合後：\n'
            + '・主路與中央島跨接縫連續繪製\n'
            + '・側路仍保留並連接相鄰方向\n'
            + '・禁止跨中央島左轉、直穿及迴轉\n'
            + '・原始道路與路口來源保留，可由歷程撤銷'
          )
          if (!ok) return
          const author = getAuthor()
          const previewRecord: EnhancementRecord = {
            ...preview.record,
            seq: (core.journalRef.current[core.journalRef.current.length - 1]?.seq ?? 0) + 1,
            ts: new Date().toISOString(),
            author,
          }
          if (!core.previewJournal([...core.journalRef.current, previewRecord])) {
            warn('捏合預覽未通過，未寫入紀錄')
            return
          }
          rememberRoadMergeReloadState()
          mergeFirstRef.current = null
          setEditRoad(null)
          core.journalRef.current = appendRecord(core.journalRef.current, preview.record, author)
          warn('捏合已確認，正在儲存並重新載入路網…')
          void reloadAfterRoadMergeSave(
            flushStaticEditorSave,
            () => window.location.reload(),
          ).catch((error) => {
            console.error('道路捏合儲存失敗', error)
            warn('道路捏合尚未完成儲存，頁面未重新載入')
          })
          return
        }
      } else {
        mergeFirstRef.current = null
      }
      const p2 = road.properties
      const cs = road.geometry.coordinates as [number, number][]
      const brg = geoBearing(cs[0], cs[cs.length - 1])
      const segmentLengthM = cs.slice(1).reduce(
        (sum, point, index) => sum + haversine(cs[index], point),
        0,
      )
      // 面板初始值 = 路面圖示（有真值用真值，否則同 buildLaneArrows 的預設推導）
      const g = core.graphRef.current
      const tl = g ? groundMoves(g, core.baysRef.current, road, false, core.rightLanesRef.current)
        : Array.from({ length: p2.lanesForward }, () => 'through')
      const tlB = g && p2.oneway === 'no'
        ? groundMoves(g, core.baysRef.current, road, true, core.rightLanesRef.current)
        : Array.from({ length: Math.max(1, p2.lanesBackward) }, () => 'through')
      // 停等格／偏心道鍵必須採 RoadGraph 實際行向終點；couplet、反向 way、
      // 切塊後 properties.nodes 的首尾不一定等於 graph edge 的 toNode。
      // 收邊參數與停止線/停等格一致（stopLineEdges）：停等格資格要看 endSetbackM，
      // 面板若用別組參數判定，就會給出建置端一定會拒絕的設定入口。
      const directionEdges = g ? stopLineEdges(g, (candidate) => candidate === road) : []
      const forwardEdge = directionEdges.find((edge) => !edge.back)
      const backwardEdge = directionEdges.find((edge) => edge.back)
      const nodeLast = forwardEdge?.toNode ?? p2.nodes[p2.nodes.length - 1] ?? 0
      const nodeFirst = backwardEdge?.toNode ?? p2.nodes[0] ?? 0
      // 兩向偏心道現況（folded journal 已反映在 baysRef）
      const bayOf = (key: string) =>
        core.baysRef.current.find((b) => b.key === key)?.turns ?? 'none'
      const bayF = bayOf(`way/${p2.osm_id}@node/${nodeLast}`)
      const bayB = bayOf(`way/${p2.osm_id}@node/${nodeFirst}~b`)
      const activeBay = core.baysRef.current.find((b) =>
        b.key === `way/${p2.osm_id}@node/${nodeLast}`
        || b.key === `way/${p2.osm_id}@node/${nodeFirst}~b`)
      const baySingleMode = activeBay?.singleMode ?? 'capped'
      // 地面規則現況（無人工設定時顯示 fallback，讓使用者看到現有印字的來源）
      const rulesF = p2.rulesF ?? (p2.motorcycle === 'no' ? ['no_moto'] : [])
      const rulesB = p2.oneway === 'no'
        ? (p2.rulesB ?? (p2.motorcycle === 'no' ? ['no_moto'] : []))
        : []
      const legacyMarks = (rules: string[], lanes: number, motoCount: number) => {
        const mark = rules.includes('no_moto') ? { text: '禁行機車', color: '#facc15' } : null
        return [...Array.from({ length: lanes }, () => mark),
          ...Array.from({ length: motoCount }, () => null)]
      }
      const laneMarksF = resizeLaneMarks(
        p2.laneMarksF ?? legacyMarks(rulesF, p2.lanesForward, p2.motoCountF),
        p2.lanesForward + p2.motoCountF)
      const laneMarksB = resizeLaneMarks(
        p2.laneMarksB ?? legacyMarks(rulesB, p2.lanesBackward, p2.motoCountB),
        p2.lanesBackward + p2.motoCountB)
      // 機車停等格現況（refreshBays 已把 folded journal 反映在 motoBoxesRef）
      const mbOf = (dirKey: string) =>
        core.motoBoxesRef.current.find((m) => m.dir === dirKey)
      const mbF = mbOf(`${p2.osm_id}@${nodeLast}`)
      const mbB = mbOf(`${p2.osm_id}@${nodeFirst}~b`)
      const rlF = core.rightLanesRef.current.find((r) =>
        r.wayId === p2.osm_id && r.nodeId === nodeLast && !r.back)
      const rlB = core.rightLanesRef.current.find((r) =>
        r.wayId === p2.osm_id && r.nodeId === nodeFirst && r.back)
      // 某些方向不在自動生成 scope，motoBoxesRef 沒有候選；改用與 buildMotoBoxes
      // 同一份判定（makeMotoBoxSlot）算人工新增的上限——不合資格的行向回 0，
      // 面板就不顯示 stepper，不會出現「設得上去、存檔後被刷回關閉」。
      const motoBoxSlot = g ? makeMotoBoxSlot(g) : null
      const inferMotoBox = (back: boolean) => {
        const edge = back ? backwardEdge : forwardEdge
        if (!motoBoxSlot || !edge) return { max: 0, start: 0, end: 0 }
        const slot = motoBoxSlot(edge)
        // 快慢分隔島只影響自動產生；人工編輯仍應能選擇是否繪製停等格。
        // buildMotoBoxes 會以明確的 moto_box journal 設定覆蓋自動篩選。
        if (!slot.eligible) return { max: 0, start: 0, end: 0 }
        const lanes = p2.oneway === 'yes'
          ? p2.lanesForward : back ? p2.lanesBackward : p2.lanesForward
        const moto = p2.oneway === 'yes' ? p2.motoF : back ? p2.motoB : p2.motoF
        return {
          max: slot.maxLanes,
          start: slot.firstLegalLane,
          end: lanes + (moto ? 1 : 0),
        }
      }
      const inferredF = inferMotoBox(false)
      const inferredB = inferMotoBox(true)
      const motoBoxF = mbF?.coveredLanes ?? 0
      const motoBoxB = mbB?.coveredLanes ?? 0
      setActiveRoadMerge(activeMergeForRoad(core.mergeReplayRef.current, road) ?? null)
      setEditRoad({
        osmId: p2.osm_id, name: p2.name, oneway: p2.oneway,
        blockNode: p2.blockNode,
        f: p2.lanesForward, b: p2.lanesBackward,
        motoF: p2.motoF, motoB: p2.motoB,
        motoCountF: p2.motoCountF, motoCountB: p2.motoCountB,
        motoSepF: p2.motoSepF || 0, motoSepB: p2.motoSepB || 0,
        motoEntryIconF: !!p2.motoEntryIconF,
        motoEntryIconB: !!p2.motoEntryIconB,
        motoTextDiamondF: !!p2.motoTextDiamondF,
        motoTextDiamondB: !!p2.motoTextDiamondB,
        stopLineF: p2.stopLineF !== false,
        stopLineB: p2.stopLineB !== false,
        arrowDisplayF: p2.arrowDisplayF !== false,
        arrowDisplayB: p2.arrowDisplayB !== false,
        startArrowDisplayF: !!p2.startArrowDisplayF,
        startArrowDisplayB: !!p2.startArrowDisplayB,
        leftWaitAreaF: !!p2.leftWaitAreaF,
        leftWaitAreaB: !!p2.leftWaitAreaB,
        startTurnLanes: resizeTurnLanes(p2.startTurnLanes ?? tl, p2.lanesForward),
        startTurnLanesB: resizeTurnLanes(
          p2.startTurnLanesB ?? tlB,
          Math.max(1, p2.lanesBackward),
        ),
        segmentLengthM,
        roadMarkingMode: p2.roadMarkingMode,
        centerM: p2.centerM || 0,
        extraM: p2.extraM || 0,
        centerKind: p2.centerKind === 'island' ? 'island' : 'hatch',
        islandBayMode: !!p2.islandBayMode,
        centerExtendStart: !!p2.centerExtendStart,
        centerExtendEnd: !!p2.centerExtendEnd,
        canCenter: !!p2.coupletMerged || (p2.centerM || 0) > 0,
        fwdLabel: compassOf(brg), bwdLabel: compassOf(brg + 180),
        turnLanes: resizeTurnLanes(tl, p2.lanesForward),
        turnLanesB: resizeTurnLanes(tlB, Math.max(1, p2.lanesBackward)),
        motoTurnLanesF: resizeTurnLanes(p2.motoTurnLanesF ?? [], p2.motoCountF),
        motoTurnLanesB: resizeTurnLanes(p2.motoTurnLanesB ?? [], p2.motoCountB),
        nodeFirst, nodeLast,
        bayF, bayB, bayF0: bayF, bayB0: bayB,
        baySingleMode, baySingleMode0: baySingleMode,
        laneMarksF, laneMarksB,
        motoBoxF, motoBoxB, motoBoxF0: motoBoxF, motoBoxB0: motoBoxB,
        motoBoxMaxF: mbF?.maxLanes ?? inferredF.max,
        motoBoxMaxB: mbB?.maxLanes ?? inferredB.max,
        motoBoxStartF: mbF?.startLane ?? inferredF.start,
        motoBoxEndF: mbF?.endLane ?? inferredF.end,
        motoBoxStartB: mbB?.startLane ?? inferredB.start,
        motoBoxEndB: mbB?.endLane ?? inferredB.end,
        motoBoxStartF0: mbF?.startLane ?? inferredF.start,
        motoBoxEndF0: mbF?.endLane ?? inferredF.end,
        motoBoxStartB0: mbB?.startLane ?? inferredB.start,
        motoBoxEndB0: mbB?.endLane ?? inferredB.end,
        motoBoxSlotsF: p2.lanesForward + p2.motoCountF + (rlF ? 1 : 0),
        motoBoxSlotsB: p2.lanesBackward + p2.motoCountB + (rlB ? 1 : 0),
        motoBoxMinF: inferredF.start,
        motoBoxMinB: inferredB.start,
        rightLaneF: !!rlF, rightLaneB: !!rlB,
        rightLaneF0: !!rlF, rightLaneB0: !!rlB,
        rightLaneLenF: Math.round(rlF?.lenM ?? 20),
        rightLaneLenB: Math.round(rlB?.lenM ?? 20),
        rightLaneLenF0: Math.round(rlF?.lenM ?? 20),
        rightLaneLenB0: Math.round(rlB?.lenM ?? 20),
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
    } else if (editToolRef.current === 'road') {
      // 拉線新增道路：沒在拉線時點自訂道路（負 id）= 選取可刪；否則放頂點（自動吸附）
      if (!draftRoadRef.current) {
        const hit = map.queryRenderedFeatures(e.point, { layers: ['road-surface', 'roads-simple'] })
        // 只認 userRoad 旗標——couplet 合併路段也是負 id，不能拿來刪
        if (hit[0]?.properties?.userRoad) {
          const hitId = Number(hit[0].properties.osm_id)
          const road = core.roadsRef.current.find((r) => r.properties.osm_id === hitId)
          setSelNewRoad({ osmId: hitId, name: road?.properties.name })
          return
        }
      }
      setSelNewRoad(null)
      const snap = snapToNode(p)
      const d = draftRoadRef.current
      updateDraft({
        coords: [...(d?.coords ?? []), snap?.pos ?? p],
        nodeIds: [...(d?.nodeIds ?? []), snap?.id ?? null],
      })
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
        core.selectedZoneRef.current = null
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
        shared_lane: editRoad.oneway === 'no' && editRoad.f + editRoad.b === 1
          && !editRoad.motoF && !editRoad.motoB ? 1 : 0,
        moto_forward: editRoad.motoCountF,
        moto_backward: editRoad.oneway === 'yes' ? 0 : editRoad.motoCountB,
        moto_sep_f: editRoad.motoF ? editRoad.motoSepF : 0,
        moto_sep_b: editRoad.oneway === 'yes' || !editRoad.motoB ? 0 : editRoad.motoSepB,
        moto_entry_icon_f: editRoad.motoEntryIconF ? 1 : 0,
        moto_entry_icon_b: editRoad.oneway === 'yes' ? 0 : (editRoad.motoEntryIconB ? 1 : 0),
        moto_text_diamond_f: editRoad.motoTextDiamondF ? 1 : 0,
        moto_text_diamond_b: editRoad.oneway === 'yes' ? 0 : (editRoad.motoTextDiamondB ? 1 : 0),
        stop_line_f: editRoad.stopLineF ? 1 : 0,
        stop_line_b: editRoad.oneway === 'yes' ? 0 : (editRoad.stopLineB ? 1 : 0),
        arrow_display_f: editRoad.arrowDisplayF ? 1 : 0,
        arrow_display_b: editRoad.oneway === 'yes' ? 0 : (editRoad.arrowDisplayB ? 1 : 0),
        start_arrow_display_f: editRoad.startArrowDisplayF ? 1 : 0,
        start_arrow_display_b: editRoad.oneway === 'yes'
          ? 0
          : (editRoad.startArrowDisplayB ? 1 : 0),
        left_wait_area_f: editRoad.leftWaitAreaF ? 1 : 0,
        left_wait_area_b: editRoad.oneway === 'yes' ? 0 : (editRoad.leftWaitAreaB ? 1 : 0),
        start_turn_lanes: editRoad.startTurnLanes.join('|'),
        start_turn_lanes_backward: editRoad.oneway === 'yes'
          ? ''
          : editRoad.startTurnLanesB.join('|'),
        road_marking_mode: editRoad.roadMarkingMode,
        center_m: editRoad.oneway === 'yes' ? 0 : editRoad.centerM,
        center_kind: editRoad.centerKind,
        island_bay_mode: editRoad.islandBayMode ? 1 : 0,
        center_extend_start: editRoad.centerExtendStart ? 1 : 0,
        center_extend_end: editRoad.centerExtendEnd ? 1 : 0,
        extra_width_m: editRoad.extraM,
        turn_lanes: editRoad.turnLanes.join('|'),
        moto_turn_lanes_forward: editRoad.motoTurnLanesF.join('|'),
        lane_marks_forward: JSON.stringify(editRoad.laneMarksF),
        ...(editRoad.oneway === 'no'
          ? {
            turn_lanes_backward: editRoad.turnLanesB.join('|'),
            moto_turn_lanes_backward: editRoad.motoTurnLanesB.join('|'),
            lane_marks_backward: JSON.stringify(editRoad.laneMarksB),
          }
          : {}),
      },
    })
    // 偏心道轉向（有動才寫）：none = 該行向關閉、其餘 = 開啟並指定轉向
    const singleBayModeApplies =
      (editRoad.bayF !== 'none') !== (editRoad.bayB !== 'none')
    const writeBay = (key: string, v: string, v0: string) => {
      const modeChanged = singleBayModeApplies && v !== 'none'
        && editRoad.baySingleMode !== editRoad.baySingleMode0
      // 單邊模式必須把未使用端明確寫成 present:0。只靠畫面上的 none 不夠：
      // 若該端沒有 journal 覆寫，refreshBays 會依自動左轉配對再次生成，造成
      // 第一次儲存短暫變成雙邊使用、第二次關閉才生效。
      const lockUnusedEnd = singleBayModeApplies && v === 'none'
      if (v === v0 && !modeChanged && !lockUnusedEnd) return
      core.journalRef.current = appendRecord(core.journalRef.current, {
        op: 'set', target: { type: 'turn_bay', key },
        fields: v === 'none'
          ? { present: 0 }
          : {
            present: 1,
            turns: v,
            ...(singleBayModeApplies ? { single_mode: editRoad.baySingleMode } : {}),
          },
      })
    }
    const bayKeyF = `way/${editRoad.osmId}@node/${editRoad.nodeLast}`
    const bayKeyB = `way/${editRoad.osmId}@node/${editRoad.nodeFirst}~b`
    if (editRoad.oneway === 'no') {
      writeBay(bayKeyF, editRoad.bayF, editRoad.bayF0)
      writeBay(bayKeyB, editRoad.bayB, editRoad.bayB0)
    }
    // 路口末端右轉專用道：只是末端分流，不改整段基本車道數。
    const writeRightLane = (
      nodeId: number, back: boolean, enabled: boolean, enabled0: boolean,
      lenM: number, lenM0: number,
    ) => {
      if (enabled === enabled0 && lenM === lenM0) return
      core.journalRef.current = appendRecord(core.journalRef.current, {
        op: 'set',
        target: {
          type: 'right_lane',
          key: `way/${editRoad.osmId}@node/${nodeId}${back ? '~b' : ''}~r`,
        },
        fields: { present: enabled ? 1 : 0, len_m: lenM },
      })
    }
    writeRightLane(
      editRoad.nodeLast, false, editRoad.rightLaneF, editRoad.rightLaneF0,
      editRoad.rightLaneLenF, editRoad.rightLaneLenF0)
    if (editRoad.oneway === 'no') {
      writeRightLane(
        editRoad.nodeFirst, true, editRoad.rightLaneB, editRoad.rightLaneB0,
        editRoad.rightLaneLenB, editRoad.rightLaneLenB0)
    }
    // 機車停等格以左→右的起訖車道保存；lanes 同時保留供舊版相容。
    const writeMotoBox = (
      nodeId: number, back: boolean, v: number, v0: number,
      start: number, end: number, start0: number, end0: number,
    ) => {
      if (v === v0 && start === start0 && end === end0) return
      core.journalRef.current = appendRecord(core.journalRef.current, {
        op: 'set',
        target: {
          type: 'moto_box',
          key: `way/${editRoad.osmId}@node/${nodeId}${back ? '~b' : ''}~m`,
        },
        fields: v > 0
          ? { lanes: Math.max(0, end - start), start_lane: start, end_lane: end }
          : { lanes: 0, start_lane: 0, end_lane: 0 },
      })
    }
    writeMotoBox(
      editRoad.nodeLast, false, editRoad.motoBoxF, editRoad.motoBoxF0,
      editRoad.motoBoxStartF, editRoad.motoBoxEndF,
      editRoad.motoBoxStartF0, editRoad.motoBoxEndF0,
    )
    if (editRoad.oneway === 'no') {
      writeMotoBox(
        editRoad.nodeFirst, true, editRoad.motoBoxB, editRoad.motoBoxB0,
        editRoad.motoBoxStartB, editRoad.motoBoxEndB,
        editRoad.motoBoxStartB0, editRoad.motoBoxEndB0,
      )
    }
    // 本次只變更一個 OSM block，不需要把完整 journal 重套到所有道路。
    const changedRoads = core.roadsRef.current.filter((road) =>
      road.properties.osm_id === editRoad.osmId
      && road.properties.blockNode === editRoad.blockNode)
    applyToRoads(changedRoads, foldJournal(core.journalRef.current))
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
    // 停等格同樣要回饋：設了涵蓋車道數但幾何放不下（格寬 <1.2m）時不要靜默還原
    const motoFailed: string[] = []
    const boxDrawn = (nodeId: number, back: boolean) =>
      !!core.motoBoxesRef.current.find(
        (m) => m.dir === `${editRoad.osmId}@${nodeId}${back ? '~b' : ''}`)?.ring
    if (editRoad.motoBoxF > 0 && !boxDrawn(editRoad.nodeLast, false)) {
      motoFailed.push(editRoad.fwdLabel)
    }
    if (editRoad.oneway === 'no' && editRoad.motoBoxB > 0
      && !boxDrawn(editRoad.nodeFirst, true)) {
      motoFailed.push(editRoad.bwdLabel)
    }
    if (motoFailed.length) {
      warn(`${motoFailed.join('、')}機車停等格未生成：此行向路口前放不下停等格`)
    }
    setEditRoad(null)
  }

  function deleteRoadSegment() {
    if (!editRoad) return
    const roadName = editRoad.name ?? `way/${editRoad.osmId}`
    const ok = window.confirm(
      `確定刪除「${roadName}」目前選取的整條路段嗎？\n\n`
      + '此操作會刪除這個路口到路口區塊的道路本體、標線，並從導航路網排除。'
    )
    if (!ok) return
    const key = `way/${editRoad.osmId}@b/${editRoad.blockNode}`
    core.journalRef.current = appendRecord(core.journalRef.current, {
      op: 'set',
      target: { type: 'road', key },
      fields: { deleted: 1 },
    })
    const remaining = core.roadsRef.current.filter((road) =>
      !(road.properties.osm_id === editRoad.osmId
        && road.properties.blockNode === editRoad.blockNode))
    setEditRoad(null)
    core.replaceBaseMap(remaining)
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
    setActiveRoadMerge(null)
    updateDraft(null)
    setSelNewRoad(null)
    core.selectedZoneRef.current = null
    core.selectedVehicleRef.current = null
  }

  function undoRoadMerge() {
    const row = activeRoadMerge
    if (!row) return
    const tombstone: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'> = {
      op: 'delete',
      target: { type: 'road_merge', key: row.mergeKey },
      fields: { supersedes_seq: row.resolved?.sourceSeq ?? 0 },
    }
    const author = getAuthor()
    const previewRecord: EnhancementRecord = {
      ...tombstone,
      seq: (core.journalRef.current[core.journalRef.current.length - 1]?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      author,
    }
    if (!core.previewJournal([...core.journalRef.current, previewRecord])) {
      warn('撤銷預覽失敗，未變更歷程')
      return
    }
    rememberRoadMergeReloadState()
    core.journalRef.current = appendRecord(core.journalRef.current, tombstone, author)
    setActiveRoadMerge(null)
    warn('撤銷已確認，正在儲存並重新載入路網…')
    void reloadAfterRoadMergeSave(
      flushStaticEditorSave,
      () => window.location.reload(),
    ).catch((error) => {
      console.error('道路捏合撤銷儲存失敗', error)
      warn('道路捏合撤銷尚未完成儲存，頁面未重新載入')
    })
  }

  // ── 鍵盤：Del 刪除選取的車輛（待轉區改由面板管理，不再拖曳/旋轉）。
  // 行駛中的鍵盤操作（變速/橫向漂移）在 useDrive 自己的 effect 裡處理 ──
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (modeRef.current !== 'edit') return
      if (editToolRef.current === 'road' && ev.key === 'Escape') {
        updateDraft(null)
        setSelNewRoad(null)
        return
      }
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
    activeRoadMerge, setActiveRoadMerge, undoRoadMerge,
    handleEditClick, saveRoadEdit, deleteRoadSegment,
    overrideBay, overrideRightLane, overrideTwin,
    draftRoad, draftName, setDraftName, draftOneway, setDraftOneway,
    undoDraftVertex, cancelDraftRoad, finishDraftRoad,
    selNewRoad, setSelNewRoad, deleteNewRoad,
    deleteVehicle, clearVehicles, closeAll,
  }
}
