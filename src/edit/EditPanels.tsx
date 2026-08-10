// 編輯模式 UI（LaneDev 專屬）：工具切換提示列 + 車道/待轉區/偏心道/車輛四個側面板。
import { useSyncExternalStore } from 'react'
import type { Profile } from '../core/graph'
import { exportEnhancements, getAuthor, setAuthor, stampAuthor } from '../core/enhancements'
import { makeZoneCtx, markZoneDeleted, planZone } from '../core/zones'
import { bayCandidatesAt, rightLaneCandidatesAt } from '../core/turnbays'
import { angleDelta, offsetMeters } from '../core/geo'
import type { PlacedVehicle } from '../core/vehicles'
import type { MapCore } from '../app/mapCore'
import { CAR_LANE_MARKS, MOTO_LANE_MARKS } from '../core/roadtext'
import type { LaneMark } from '../core/roads'
import {
  flushStaticEditorSave, getStaticSaveSnapshot, subscribeStaticSaveState,
} from '../core/staticDatabase'
import {
  compassOf, resizeLaneMarks, resizeTurnLanes, TURN_CYCLE, TURN_EDIT_GLYPH,
  BAY_TURN_CYCLE, BAY_TURN_GLYPH, type Editor, type EditTool,
} from './useEditor'
import { formatTaiwanHistoryTime } from './timeFormat'

const resizeDirectionMarks = (
  marks: (LaneMark | null)[], oldCars: number, newCars: number, moto: boolean | number,
) => {
  const count = typeof moto === 'number' ? moto : moto ? 1 : 0
  const motoMarks = count > 0 ? marks.slice(oldCars, oldCars + count) : []
  return [...resizeLaneMarks(marks.slice(0, oldCars), newCars), ...motoMarks]
}

const ARROW_OPTION_LABEL: Record<string, string> = {
  through: '↑',
  left: '↰',
  right: '↱',
  'left;through': '↰↑',
  'through;right': '↑↱',
  'through+right': '↑＋↱',
  'left;right': '↰↱',
  reverse: '↩',
}

/** 箭頭樣式直接下拉選取，不再逐次循環。 */
function ArrowStyleSelect({ value, onChange, label }: {
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <select
      className="lane-pick arrow-style-select"
      value={value}
      aria-label={label}
      title={label}
      onChange={(e) => onChange(e.target.value)}
    >
      {TURN_CYCLE.map((option) => (
        <option key={option} value={option}>
          {ARROW_OPTION_LABEL[option] ?? TURN_EDIT_GLYPH[option] ?? option}
        </option>
      ))}
    </select>
  )
}

function MotoBoxRangeEditor({ label, enabled, start, end, min, slots, laneLabel, onChange }: {
  label: string
  enabled: boolean
  start: number
  end: number
  min: number
  slots: number
  laneLabel: (index: number) => string
  onChange: (enabled: boolean, start: number, end: number) => void
}) {
  const safeStart = Math.max(min, Math.min(Math.max(min, slots - 1), start))
  const safeEnd = Math.max(safeStart + 1, Math.min(slots, end))
  return (
    <div className="lane-mark-group">
      <div className="edit-row">
        <span>{label}機車停等格</span>
        <button className={`mini${enabled ? ' on' : ''}`}
          onClick={() => onChange(!enabled, safeStart, safeEnd)}>
          {enabled ? '已開啟' : '關閉'}
        </button>
      </div>
      {enabled && slots > 0 && (
        <div className="edit-row" style={{ flexWrap: 'wrap' }}>
          <span>涵蓋範圍</span>
          <select value={safeStart}
            onChange={(e) => {
              const next = Number(e.target.value)
              onChange(true, next, Math.max(next + 1, safeEnd))
            }}>
            {Array.from({ length: Math.max(0, slots - min) }, (_, i) => min + i)
              .map((i) => <option key={i} value={i}>從 {laneLabel(i)}</option>)}
          </select>
          <span>至</span>
          <select value={safeEnd}
            onChange={(e) => onChange(true, safeStart, Number(e.target.value))}>
            {Array.from({ length: Math.max(0, slots - safeStart) }, (_, i) => safeStart + i + 1)
              .map((i) => <option key={i} value={i}>{laneLabel(i - 1)}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}

/** 地面規則選取列（點選加入/移除；選取順序 = 從路口入口沿行進方向排列） */
function LaneMarkEditor({ label, marks, carLanes, motoLanes, onChange }: {
  label: string; marks: (LaneMark | null)[]; carLanes: number; motoLanes: number
  onChange: (marks: (LaneMark | null)[]) => void
}) {
  const set = (i: number, mark: LaneMark | null) => {
    const next = [...marks]; next[i] = mark; onChange(next)
  }
  return (
    <div className="lane-mark-group">
      <div className="edit-row"><span><b className="row-title">{label}</b>每條車道只能設定一種資訊，也可以保持空白。</span></div>
      {marks.map((mark, i) => {
        const moto = i >= carLanes && i < carLanes + motoLanes
        const presets = moto ? MOTO_LANE_MARKS : CAR_LANE_MARKS
        const preset = presets.find((p) => p.text === mark?.text && p.color === mark?.color)
        const value = !mark ? '' : preset?.text ?? '__custom__'
        return <div className="lane-mark-row" key={i}>
          <b>{moto ? `機車道 ${i - carLanes + 1}` : `汽車道 ${i + 1}`}</b>
          <select value={value} onChange={(e) => {
            const v = e.target.value
            if (!v) set(i, null)
            // 從預設項目切到「自訂」時不可沿用完全相同的預設文字與顏色；
            // 否則下一次 render 會再次被辨識成預設項目，選單看起來就像跳回去。
            else if (v === '__custom__') set(i, {
              text: preset ? '' : (mark?.text ?? ''),
              color: mark?.color ?? '#ffffff',
            })
            else {
              const p = presets.find((x) => x.text === v)
              set(i, p ? { ...p } : null)
            }
          }}>
            <option value="">不印文字</option>
            {presets.map((p) => <option key={p.text} value={p.text}>{p.text}</option>)}
            <option value="__custom__">自訂文字與顏色</option>
          </select>
          {value === '__custom__' && <>
            <input className="lane-mark-text" value={mark?.text ?? ''} maxLength={12}
              placeholder="輸入路面文字" onChange={(e) => set(i, { text: e.target.value, color: mark?.color ?? '#ffffff' })} />
            <input type="color" value={mark?.color ?? '#ffffff'}
              onChange={(e) => set(i, { text: mark?.text ?? '', color: e.target.value })} />
          </>}
        </div>
      })}
    </div>
  )
}

const TOOL_HINTS: Record<EditTool, {
  short: (profile: Profile) => string
  full: (profile: Profile) => string
}> = {
  lane: {
    short: () => '點道路編輯 · 再點一下換疊在下面的路 · Ctrl 點兩段捏合',
    full: () => '點選道路編輯車道；同一點再按一下可換下一條疊在一起的路；'
      + '按住 Ctrl 依序點兩段相接、平行道路可捏合路段',
  },
  zone: {
    short: () => '點路口 → 面板選左轉方向',
    full: () => '點選「路口」→ 右側面板選左轉方向（位置自動計算）',
  },
  bay: {
    short: () => '點路口 → 開關偏心左轉／右轉道',
    full: () => '點選「路口」→ 開關/調整偏心左轉道與右轉附加車道',
  },
  road: {
    short: () => '點地圖放頂點（自動吸附）→ 面板「完成」· 點自訂道路可刪',
    full: () => '點地圖依序放頂點（靠近既有路口/節點會自動吸附）→ 面板按「完成」成路'
      + ' · 點自訂道路可刪除',
  },
  vehicle: {
    short: (profile) => `點道路放${profile === 'car' ? '汽車' : '機車'} · 點模型可選取／刪除`,
    full: (profile) => `點擊道路放置${profile === 'car' ? '汽車' : '機車'}模型 · 點模型可選取/刪除`,
  },
}

export function EditHintBar({ core, editor, profile, zoneCount, vehicleCount }: {
  core: MapCore; editor: Editor; profile: Profile; zoneCount: number; vehicleCount: number
}) {
  const { editTool, editWarn } = editor
  const saveSnapshot = useSyncExternalStore(
    subscribeStaticSaveState, getStaticSaveSnapshot, getStaticSaveSnapshot)
  const [saveStatus, saveDetail = ''] = saveSnapshot.split('|')
  const saveLabel = saveStatus === 'saving' ? '儲存中…'
    : saveStatus === 'dirty' ? '儲存目前變更'
      : saveStatus === 'error' ? '儲存失敗'
        : '已儲存'
  return (
    <div className={`hint${editWarn ? ' warn' : ''}`}>
      <span className="tool-toggle">
        <button className={`mini${editTool === 'lane' ? ' on' : ''}`}
          onClick={() => { editor.setEditTool('lane'); editor.setEditRoad(null); editor.setZonePanel(null); editor.setBayPanel(null) }}>車道</button>
        <button className={`mini${editTool === 'zone' ? ' on' : ''}`}
          onClick={() => { editor.setEditTool('zone'); editor.setEditRoad(null); editor.setBayPanel(null) }}>待轉區</button>
        <button className={`mini${editTool === 'bay' ? ' on' : ''}`}
          onClick={() => { editor.setEditTool('bay'); editor.setEditRoad(null); editor.setZonePanel(null) }}>偏心道</button>
        <button className={`mini${editTool === 'vehicle' ? ' on' : ''}`}
          onClick={() => { editor.setEditTool('vehicle'); editor.setEditRoad(null); editor.setZonePanel(null); editor.setBayPanel(null) }}>車輛</button>
        <button className={`mini${editTool === 'road' ? ' on' : ''}`}
          onClick={() => { editor.setEditTool('road'); editor.setEditRoad(null); editor.setZonePanel(null); editor.setBayPanel(null) }}>新路</button>
      </span>
      <button className={`mini${saveStatus === 'saved' ? '' : ' go'}`}
        disabled={saveStatus === 'saving'}
        title={saveDetail || '立即將全部人工標註寫入唯一靜態資料庫'}
        onClick={() => {
          void flushStaticEditorSave().catch((error) => {
            alert(`儲存失敗：${error instanceof Error ? error.message : String(error)}`)
          })
        }}>
        {saveLabel}
      </button>
      {editWarn ?? (
        <span className="hint-text" title={TOOL_HINTS[editTool].full(profile)}>
          {TOOL_HINTS[editTool].short(profile)}
        </span>
      )}
      {!editWarn && (
        <button className="mini"
          onClick={() => {
            // 署名預設空白：匯出當下才問，帶入上次填的值（Enter 直接沿用）。
            const input = prompt('標註者署名（寫進匯出檔，並補上未署名的紀錄）', getAuthor())
            if (input === null) return // 取消 = 不匯出
            const author = input.trim()
            setAuthor(author)
            core.journalRef.current = stampAuthor(core.journalRef.current, author)
            exportEnhancements(core.journalRef.current, core.zonesRef.current,
              core.vehiclesRef.current, core.baysRef.current, core.rightLanesRef.current, author)
          }}>
          匯出 ({core.journalRef.current.length + zoneCount + vehicleCount})
        </button>
      )}
    </div>
  )
}

/** 側面板：車道編輯 */
export function LaneEditPanel({ editor }: { editor: Editor }) {
  const { editRoad, setEditRoad, stackPicks, stackIndex, pickStacked } = editor
  if (!editRoad) return null
  return (
    <div className="side-panel lane-editor">
      <div className="sp-head">
        <div><span className="sp-kicker">路段斷面編輯</span><b>{editRoad.name ?? '（未命名道路）'}</b></div>
        <button className="sp-close" onClick={() => setEditRoad(null)}>✕</button>
      </div>
      <div className="road-src">
        way/{editRoad.osmId}@b/{editRoad.blockNode} · {editRoad.oneway === 'yes' ? '單行' : '雙向'}
        {' '}· 僅影響目前兩個路口之間的區塊
      </div>
      {stackPicks.length > 1 && (
        <div className="stack-picker">
          <div className="stack-head">
            此處疊了 {stackPicks.length} 條路；可直接選擇，或在地圖同一點再次點擊切換
          </div>
          {stackPicks.map((pick, index) => (
            <button
              key={pick.key}
              className={`stack-item${index === stackIndex ? ' on' : ''}`}
              onClick={() => pickStacked(index)}
            >
              <b>{pick.name}</b>
              <span>{pick.detail}</span>
            </button>
          ))}
        </div>
      )}
      {editor.activeRoadMerge && (
        <section className="edit-section">
          <h3>道路捏合歷程</h3>
          <p>此區塊目前屬於一筆可追溯捏合；撤銷只會追加歷程，不會刪除原紀錄。</p>
          <div className="road-src">
            作者：{editor.activeRoadMerge.resolved?.sourceAuthor ?? '未知'} ·
            {' '}時間：{formatTaiwanHistoryTime(editor.activeRoadMerge.resolved?.sourceTs)}<br />
            主段：{editor.activeRoadMerge.primaryKey}<br />
            次段：{editor.activeRoadMerge.secondaryKey}<br />
            解析：{editor.activeRoadMerge.resolved?.resolvedBy ?? editor.activeRoadMerge.status}
          </div>
          <div className="edit-row">
            <span>恢復原始道路與路口拓撲</span>
            <button className="mini danger" onClick={editor.undoRoadMerge}>撤銷捏合</button>
          </div>
        </section>
      )}
      <div className="edit-notice">先調整下列設定；按「儲存並套用」後才會寫入 journal 並重繪道路。</div>

      <section className="edit-section">
      <h3>1. 行車空間</h3>
      <p>汽車道數不包含機車道；開啟機車道會在該方向最外側另外增加一條。</p>
      <div className="edit-row">
        <span>{editRoad.oneway === 'yes' ? `${editRoad.fwdLabel}（單行）` : editRoad.fwdLabel}汽車道</span>
        <button className="mini" onClick={() => setEditRoad((er) => {
          if (!er) return er
          const canShareOneLane = er.oneway === 'no' && er.b === 1 && !er.motoF && !er.motoB
          const min = er.motoF || canShareOneLane ? 0 : 1
          const f = Math.max(min, er.f - 1)
          return { ...er, f, turnLanes: resizeTurnLanes(er.turnLanes, f),
            startTurnLanes: resizeTurnLanes(er.startTurnLanes, f),
            laneMarksF: resizeDirectionMarks(er.laneMarksF, er.f, f, er.motoCountF) }
        })}>−</button>
        <b>{editRoad.f}</b>
        <button className="mini" onClick={() => setEditRoad((er) => er && ({
          ...er, f: Math.min(6, er.f + 1),
          turnLanes: resizeTurnLanes(er.turnLanes, Math.min(6, er.f + 1)),
          startTurnLanes: resizeTurnLanes(er.startTurnLanes, Math.min(6, er.f + 1)),
          laneMarksF: resizeDirectionMarks(er.laneMarksF, er.f, Math.min(6, er.f + 1), er.motoCountF),
        }))}>＋</button>
        <button className={`mini${editRoad.motoF ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => {
            if (!er) return er
            // 關機車道時若車道 0，自動補回 1（斷面不能空）
            const f = er.motoF && er.f === 0 ? 1 : er.f
            const motoF = !er.motoF
            const motoCountF = motoF ? 1 : 0
            const oldSlots = er.motoBoxSlotsF
            const motoBoxSlotsF = f + motoCountF + (er.rightLaneF ? 1 : 0)
            const wantedEnd = motoF && er.motoBoxF > 0 && er.motoBoxEndF >= oldSlots
              ? motoBoxSlotsF : Math.min(er.motoBoxEndF, motoBoxSlotsF)
            const motoBoxEndF = Math.max(1, wantedEnd)
            const motoBoxStartF = Math.min(er.motoBoxStartF, motoBoxEndF - 1)
            return { ...er, motoF, motoCountF, f,
              motoTurnLanesF: resizeTurnLanes(er.motoTurnLanesF, motoCountF),
              turnLanes: resizeTurnLanes(er.turnLanes, f),
              startTurnLanes: resizeTurnLanes(er.startTurnLanes, f),
              laneMarksF: er.motoF
                ? resizeLaneMarks(er.laneMarksF.slice(0, er.f), f)
                : [...resizeLaneMarks(er.laneMarksF, f), null],
              motoBoxSlotsF,
              motoBoxMaxF: Math.max(er.motoBoxMaxF, motoBoxSlotsF - er.motoBoxMinF),
              motoBoxStartF,
              motoBoxEndF,
              motoBoxF: er.motoBoxF > 0 ? motoBoxEndF - motoBoxStartF : 0 }
          })}>
          {editRoad.motoF ? '已設機車道' : '＋機車道'}
        </button>
      </div>
      {editRoad.motoF && (
        <>
        <div className="edit-row">
          <span>{editRoad.fwdLabel}機車道數</span>
          <button className="mini" disabled={editRoad.motoCountF <= 1}
            onClick={() => setEditRoad((er) => {
              if (!er || er.motoCountF <= 1) return er
              const count = er.motoCountF - 1
              return { ...er, motoCountF: count,
                laneMarksF: resizeLaneMarks(er.laneMarksF, er.f + count),
                motoTurnLanesF: resizeTurnLanes(er.motoTurnLanesF, count),
                motoBoxSlotsF: er.motoBoxSlotsF - 1 }
            })}>−</button>
          <b>{editRoad.motoCountF}</b>
          <button className="mini" disabled={editRoad.motoCountF >= 4}
            onClick={() => setEditRoad((er) => {
              if (!er || er.motoCountF >= 4) return er
              const count = er.motoCountF + 1
              return { ...er, motoCountF: count,
                laneMarksF: resizeLaneMarks(er.laneMarksF, er.f + count),
                motoTurnLanesF: resizeTurnLanes(er.motoTurnLanesF, count),
                motoBoxSlotsF: er.motoBoxSlotsF + 1 }
            })}>＋</button>
        </div>
        <div className="edit-row">
          <span>{editRoad.fwdLabel}快慢分隔</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoSepF: Math.max(0, +(er.motoSepF - 0.2).toFixed(1)),
          }))}>−</button>
          <b>{editRoad.motoSepF > 0 ? `${editRoad.motoSepF.toFixed(1)}m` : '無(白線)'}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoSepF: Math.min(3.2, +(er.motoSepF + 0.2).toFixed(1)),
          }))}>＋</button>
        </div>
        </>
      )}
      {editRoad.oneway === 'no' && (
        <div className="edit-row">
        <span>{editRoad.bwdLabel}汽車道</span>
          <button className="mini" onClick={() => setEditRoad((er) => {
            if (!er) return er
            const canShareOneLane = er.f === 1 && !er.motoF && !er.motoB
            const min = er.motoB || canShareOneLane ? 0 : 1
            const b = Math.max(min, er.b - 1)
            return { ...er, b, turnLanesB: resizeTurnLanes(er.turnLanesB, b),
              startTurnLanesB: resizeTurnLanes(er.startTurnLanesB, b),
              laneMarksB: resizeDirectionMarks(er.laneMarksB, er.b, b, er.motoCountB) }
          })}>−</button>
          <b>{editRoad.b}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, b: Math.min(6, er.b + 1),
            turnLanesB: resizeTurnLanes(er.turnLanesB, Math.min(6, er.b + 1)),
            startTurnLanesB: resizeTurnLanes(er.startTurnLanesB, Math.min(6, er.b + 1)),
            laneMarksB: resizeDirectionMarks(er.laneMarksB, er.b, Math.min(6, er.b + 1), er.motoCountB),
          }))}>＋</button>
          <button className={`mini${editRoad.motoB ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => {
              if (!er) return er
              const b = er.motoB && er.b === 0 ? 1 : er.b
              const motoB = !er.motoB
              const motoCountB = motoB ? 1 : 0
              const oldSlots = er.motoBoxSlotsB
              const motoBoxSlotsB = b + motoCountB + (er.rightLaneB ? 1 : 0)
              const wantedEnd = motoB && er.motoBoxB > 0 && er.motoBoxEndB >= oldSlots
                ? motoBoxSlotsB : Math.min(er.motoBoxEndB, motoBoxSlotsB)
              const motoBoxEndB = Math.max(1, wantedEnd)
              const motoBoxStartB = Math.min(er.motoBoxStartB, motoBoxEndB - 1)
              return { ...er, motoB, motoCountB, b,
                motoTurnLanesB: resizeTurnLanes(er.motoTurnLanesB, motoCountB),
                turnLanesB: resizeTurnLanes(er.turnLanesB, b),
                startTurnLanesB: resizeTurnLanes(er.startTurnLanesB, b),
                laneMarksB: er.motoB
                  ? resizeLaneMarks(er.laneMarksB.slice(0, er.b), b)
                  : [...resizeLaneMarks(er.laneMarksB, b), null],
                motoBoxSlotsB,
                motoBoxMaxB: Math.max(er.motoBoxMaxB, motoBoxSlotsB - er.motoBoxMinB),
                motoBoxStartB,
                motoBoxEndB,
                motoBoxB: er.motoBoxB > 0 ? motoBoxEndB - motoBoxStartB : 0 }
            })}>
            {editRoad.motoB ? '已設機車道' : '＋機車道'}
          </button>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.motoB && (
        <>
        <div className="edit-row">
          <span>{editRoad.bwdLabel}機車道數</span>
          <button className="mini" disabled={editRoad.motoCountB <= 1}
            onClick={() => setEditRoad((er) => {
              if (!er || er.motoCountB <= 1) return er
              const count = er.motoCountB - 1
              return { ...er, motoCountB: count,
                laneMarksB: resizeLaneMarks(er.laneMarksB, er.b + count),
                motoTurnLanesB: resizeTurnLanes(er.motoTurnLanesB, count),
                motoBoxSlotsB: er.motoBoxSlotsB - 1 }
            })}>−</button>
          <b>{editRoad.motoCountB}</b>
          <button className="mini" disabled={editRoad.motoCountB >= 4}
            onClick={() => setEditRoad((er) => {
              if (!er || er.motoCountB >= 4) return er
              const count = er.motoCountB + 1
              return { ...er, motoCountB: count,
                laneMarksB: resizeLaneMarks(er.laneMarksB, er.b + count),
                motoTurnLanesB: resizeTurnLanes(er.motoTurnLanesB, count),
                motoBoxSlotsB: er.motoBoxSlotsB + 1 }
            })}>＋</button>
        </div>
        <div className="edit-row">
          <span>{editRoad.bwdLabel}快慢分隔</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoSepB: Math.max(0, +(er.motoSepB - 0.2).toFixed(1)),
          }))}>−</button>
          <b>{editRoad.motoSepB > 0 ? `${editRoad.motoSepB.toFixed(1)}m` : '無(白線)'}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoSepB: Math.min(3.2, +(er.motoSepB + 0.2).toFixed(1)),
          }))}>＋</button>
        </div>
        </>
      )}
      <div className="edit-help">快慢分隔為 0 時繪製白實線；調高後改為同寬度的實體分隔島。</div>
      {editRoad.oneway === 'no' && editRoad.f + editRoad.b === 1 && !editRoad.motoF && !editRoad.motoB && (
        <div className="edit-help">目前為正反共用一道寬：道路仍維持雙向通行，且不繪製中央線。</div>
      )}
      </section>

      <section className="edit-section">
      <h3>2. 道路斷面</h3>
      <div className="edit-row">
        <span>外側路肩增減</span>
        <button className="mini" onClick={() => setEditRoad((er) => er && ({
          ...er, extraM: Math.max(-3.2, +(er.extraM - 0.4).toFixed(1)),
        }))}>−</button>
        <b>{editRoad.extraM >= 0 ? '+' : ''}{editRoad.extraM.toFixed(1)}m</b>
        <button className="mini" onClick={() => setEditRoad((er) => er && ({
          ...er, extraM: Math.min(6.4, +(er.extraM + 0.4).toFixed(1)),
        }))}>＋</button>
      </div>
      <div className="edit-help">只改變路面外緣總寬，既有車道與標線位置不會平移。</div>
      {editRoad.oneway === 'no' && editRoad.canCenter && (
        <div className="edit-row">
          <span>中央帶寬度</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, centerM: Math.max(0, +(er.centerM - 0.8).toFixed(1)),
          }))}>−</button>
          <b>{editRoad.centerM.toFixed(1)}m</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, centerM: Math.min(6.4, +(er.centerM + 0.8).toFixed(1)),
          }))}>＋</button>
        </div>
      )}
      </section>

      <section className="edit-section">
      <h3>3. 路口前配置</h3>
      <p>以下設定套用在此區塊末端接近路口的位置，並依各方向分別處理。</p>
      {editRoad.oneway === 'no' && editRoad.canCenter && (
        <div className="edit-row">
          <span>中央帶類型</span>
          <button className={`mini${editRoad.centerKind !== 'island' ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er, centerKind: 'hatch', islandBayMode: false,
            }))}>
            槽化（可偏心）
          </button>
          <button className={`mini${editRoad.centerKind === 'island' && !editRoad.islandBayMode ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              // 直接點「分隔島」時中央帶還是 0 → 自動給 1.6m，島才有空間
              ...er,
              centerKind: 'island',
              islandBayMode: false,
              centerM: er.centerM > 0 ? er.centerM : 1.6,
            }))}>
            分隔島
          </button>
          <button className={`mini${editRoad.centerKind === 'island' && editRoad.islandBayMode ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er,
              centerKind: 'island',
              islandBayMode: true,
              baySingleMode: 'ignore',
              centerM: er.centerM > 0 ? er.centerM : 3.2,
            }))}>
            中央帶＋路口左轉道
          </button>
        </div>
      )}
      {editRoad.oneway === 'no' && (
        <div className="edit-row">
          <span>
            <b className="row-title">中央線與分隔島延伸至圓形端頭</b>
            前、後兩端可分別設定；預設不延伸，包含快慢分隔島與實體中央島。
          </span>
          <button
            className={`mini${editRoad.centerExtendStart ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er,
              centerExtendStart: !er.centerExtendStart,
            }))}
          >{editRoad.bwdLabel}端 {editRoad.centerExtendStart ? '延伸' : '不延伸'}</button>
          <button
            className={`mini${editRoad.centerExtendEnd ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er,
              centerExtendEnd: !er.centerExtendEnd,
            }))}
          >{editRoad.fwdLabel}端 {editRoad.centerExtendEnd ? '延伸' : '不延伸'}</button>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.centerM > 0
        && (editRoad.centerKind !== 'island' || editRoad.islandBayMode) && (
        <>
          <div className="edit-row">
            <span>中央偏心道用途</span>
            <button className="mini" onClick={() => setEditRoad((er) => er && ({
              ...er, bayF: BAY_TURN_CYCLE[(BAY_TURN_CYCLE.indexOf(er.bayF) + 1) % BAY_TURN_CYCLE.length],
            }))}>{editRoad.fwdLabel} {BAY_TURN_GLYPH[editRoad.bayF] ?? '無'}</button>
            <button className="mini" onClick={() => setEditRoad((er) => er && ({
              ...er, bayB: BAY_TURN_CYCLE[(BAY_TURN_CYCLE.indexOf(er.bayB) + 1) % BAY_TURN_CYCLE.length],
            }))}>{editRoad.bwdLabel} {BAY_TURN_GLYPH[editRoad.bayB] ?? '無'}</button>
          </div>
          {editRoad.centerKind === 'island' ? (
            <div className="edit-row">
              <span>中央帶切出格式</span>
              <b>{editRoad.bayF !== 'none' && editRoad.bayB !== 'none'
                ? '雙向接近路口時切出'
                : editRoad.bayF !== 'none' || editRoad.bayB !== 'none'
                  ? '單向接近路口時切出'
                  : '尚未選擇方向'}</b>
            </div>
          ) : editRoad.bayF !== 'none' && editRoad.bayB !== 'none' ? (
            <div className="edit-row">
              <span>偏心道格式</span>
              <b>雙邊使用</b>
            </div>
          ) : (editRoad.bayF !== 'none' || editRoad.bayB !== 'none') && (
            <div className="edit-row" style={{ alignItems: 'stretch' }}>
              <span>偏心道格式</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <button className={`mini${editRoad.baySingleMode === 'capped' ? ' on' : ''}`}
                  onClick={() => setEditRoad((er) => er && ({ ...er, baySingleMode: 'capped' }))}>
                  單邊使用，另一端封口
                </button>
                <button className={`mini${editRoad.baySingleMode === 'ignore' ? ' on' : ''}`}
                  onClick={() => setEditRoad((er) => er && ({ ...er, baySingleMode: 'ignore' }))}>
                  單邊使用，另一端完全忽略
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <div className="edit-row">
        <span><b className="row-title">{editRoad.fwdLabel}車道箭頭</b></span>
        <button
          className={`mini${editRoad.arrowDisplayF ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => er && ({ ...er, arrowDisplayF: !er.arrowDisplayF }))}
        >{editRoad.arrowDisplayF ? '顯示開啟' : '顯示關閉'}</button>
      </div>
      <div className="edit-lanes">
        {editRoad.turnLanes.map((v, i) => (
          <ArrowStyleSelect key={i} value={v} label={`${editRoad.fwdLabel}第 ${i + 1} 車道箭頭`}
            onChange={(value) => setEditRoad((er) => {
              if (!er) return er
              const next = [...er.turnLanes]
              next[i] = value
              return { ...er, turnLanes: next }
            })} />
        ))}
      </div>
      {(editRoad.bayF !== 'none' || editRoad.turnLanes[0]?.includes('left')) && (
        <div className="edit-row">
          <span>{editRoad.fwdLabel}左轉待轉區</span>
          <button
            className={`mini${editRoad.leftWaitAreaF ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er, leftWaitAreaF: !er.leftWaitAreaF,
            }))}
          >{editRoad.leftWaitAreaF ? '已開啟' : '關閉'}</button>
        </div>
      )}
      {editRoad.segmentLengthM >= 50 && editRoad.bayF !== 'none' && (
        <>
          <div className="edit-row">
            <span>{editRoad.fwdLabel}道路開頭箭頭</span>
            <button
              className={`mini${editRoad.startArrowDisplayF ? ' on' : ''}`}
              onClick={() => setEditRoad((er) => er && ({
                ...er,
                startArrowDisplayF: !er.startArrowDisplayF,
              }))}
            >{editRoad.startArrowDisplayF ? '顯示開啟' : '顯示關閉'}</button>
          </div>
          {editRoad.startArrowDisplayF && (
            <div className="edit-lanes">
              {editRoad.startTurnLanes.map((v, i) => (
                <ArrowStyleSelect key={i} value={v}
                  label={`${editRoad.fwdLabel}道路開頭第 ${i + 1} 車道箭頭`}
                  onChange={(value) => setEditRoad((er) => {
                    if (!er) return er
                    const next = [...er.startTurnLanes]
                    next[i] = value
                    return { ...er, startTurnLanes: next }
                  })} />
              ))}
            </div>
          )}
        </>
      )}
      {editRoad.oneway === 'no' && (
        <>
          <div className="edit-row">
            <span><b className="row-title">{editRoad.bwdLabel}車道箭頭</b></span>
            <button
              className={`mini${editRoad.arrowDisplayB ? ' on' : ''}`}
              onClick={() => setEditRoad((er) => er && ({ ...er, arrowDisplayB: !er.arrowDisplayB }))}
            >{editRoad.arrowDisplayB ? '顯示開啟' : '顯示關閉'}</button>
          </div>
          <div className="edit-lanes">
            {editRoad.turnLanesB.map((v, i) => (
              <ArrowStyleSelect key={i} value={v} label={`${editRoad.bwdLabel}第 ${i + 1} 車道箭頭`}
                onChange={(value) => setEditRoad((er) => {
                  if (!er) return er
                  const next = [...er.turnLanesB]
                  next[i] = value
                  return { ...er, turnLanesB: next }
                })} />
            ))}
          </div>
          {(editRoad.bayB !== 'none' || editRoad.turnLanesB[0]?.includes('left')) && (
            <div className="edit-row">
              <span>{editRoad.bwdLabel}左轉待轉區</span>
              <button
                className={`mini${editRoad.leftWaitAreaB ? ' on' : ''}`}
                onClick={() => setEditRoad((er) => er && ({
                  ...er, leftWaitAreaB: !er.leftWaitAreaB,
                }))}
              >{editRoad.leftWaitAreaB ? '已開啟' : '關閉'}</button>
            </div>
          )}
          {editRoad.segmentLengthM >= 50 && editRoad.bayB !== 'none' && (
            <>
              <div className="edit-row">
                <span>{editRoad.bwdLabel}道路開頭箭頭</span>
                <button
                  className={`mini${editRoad.startArrowDisplayB ? ' on' : ''}`}
                  onClick={() => setEditRoad((er) => er && ({
                    ...er,
                    startArrowDisplayB: !er.startArrowDisplayB,
                  }))}
                >{editRoad.startArrowDisplayB ? '顯示開啟' : '顯示關閉'}</button>
              </div>
              {editRoad.startArrowDisplayB && (
                <div className="edit-lanes">
                  {editRoad.startTurnLanesB.map((v, i) => (
                    <ArrowStyleSelect key={i} value={v}
                      label={`${editRoad.bwdLabel}道路開頭第 ${i + 1} 車道箭頭`}
                      onChange={(value) => setEditRoad((er) => {
                        if (!er) return er
                        const next = [...er.startTurnLanesB]
                        next[i] = value
                        return { ...er, startTurnLanesB: next }
                      })} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
      <div className="edit-row">
        <span>
          <b className="row-title">{editRoad.fwdLabel}路口前右轉專用道</b>
          僅在末端展寬，不改變整段基本車道數。
        </span>
        <button className={`mini${editRoad.rightLaneF ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => er && ({
            ...er,
            rightLaneF: !er.rightLaneF,
            motoBoxSlotsF: Math.max(1, er.motoBoxSlotsF + (er.rightLaneF ? -1 : 1)),
            motoBoxEndF: er.rightLaneF
              ? Math.min(er.motoBoxEndF, er.motoBoxSlotsF - 1)
              : er.motoBoxEndF,
          }))}>
          {editRoad.rightLaneF ? '已新增' : '不新增'}
        </button>
        {editRoad.rightLaneF && <>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, rightLaneLenF: Math.max(10, er.rightLaneLenF - 5),
          }))}>−5m</button>
          <b>{editRoad.rightLaneLenF}m</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, rightLaneLenF: Math.min(60, er.rightLaneLenF + 5),
          }))}>＋5m</button>
        </>}
      </div>
      {editRoad.oneway === 'no' && (
        <div className="edit-row">
          <span><b className="row-title">{editRoad.bwdLabel}路口前右轉專用道</b></span>
          <button className={`mini${editRoad.rightLaneB ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              ...er,
              rightLaneB: !er.rightLaneB,
              motoBoxSlotsB: Math.max(1, er.motoBoxSlotsB + (er.rightLaneB ? -1 : 1)),
              motoBoxEndB: er.rightLaneB
                ? Math.min(er.motoBoxEndB, er.motoBoxSlotsB - 1)
                : er.motoBoxEndB,
            }))}>
            {editRoad.rightLaneB ? '已新增' : '不新增'}
          </button>
          {editRoad.rightLaneB && <>
            <button className="mini" onClick={() => setEditRoad((er) => er && ({
              ...er, rightLaneLenB: Math.max(10, er.rightLaneLenB - 5),
            }))}>−5m</button>
            <b>{editRoad.rightLaneLenB}m</b>
            <button className="mini" onClick={() => setEditRoad((er) => er && ({
              ...er, rightLaneLenB: Math.min(60, er.rightLaneLenB + 5),
            }))}>＋5m</button>
          </>}
        </div>
      )}
      {editRoad.motoBoxMaxF > 0 && (
        <MotoBoxRangeEditor
          label={editRoad.fwdLabel}
          enabled={editRoad.motoBoxF > 0}
          start={editRoad.motoBoxStartF}
          end={editRoad.motoBoxEndF}
          min={editRoad.motoBoxMinF}
          slots={editRoad.motoBoxSlotsF}
          laneLabel={(i) => i < editRoad.f
            ? `汽車道 ${i + 1}`
            : i === editRoad.f && editRoad.motoF ? '機車道' : '右轉專用道'}
          onChange={(enabled, start, end) => setEditRoad((er) => er && ({
            ...er,
            motoBoxF: enabled ? Math.max(1, end - start) : 0,
            motoBoxStartF: start,
            motoBoxEndF: end,
          }))}
        />
      )}
      {editRoad.oneway === 'no' && editRoad.motoBoxMaxB > 0 && (
        <MotoBoxRangeEditor
          label={editRoad.bwdLabel}
          enabled={editRoad.motoBoxB > 0}
          start={editRoad.motoBoxStartB}
          end={editRoad.motoBoxEndB}
          min={editRoad.motoBoxMinB}
          slots={editRoad.motoBoxSlotsB}
          laneLabel={(i) => i < editRoad.b
            ? `汽車道 ${i + 1}`
            : i === editRoad.b && editRoad.motoB ? '機車道' : '右轉專用道'}
          onChange={(enabled, start, end) => setEditRoad((er) => er && ({
            ...er,
            motoBoxB: enabled ? Math.max(1, end - start) : 0,
            motoBoxStartB: start,
            motoBoxEndB: end,
          }))}
        />
      )}
      <div className="edit-help">
        車道依駕駛視角由左至右編號；可避開最右側右轉專用道。禁行機車車道仍不可納入。
      </div>
      </section>

      <section className="edit-section">
      <h3>4. 各車道的地面資訊</h3>
      <p>只畫在離開路口、剛進入此路段的位置。汽車道提供「禁行機車」；已定義的機車道另提供專用與優先標字。每條車道只能選一種，也可留空或自訂文字顏色。</p>
      <LaneMarkEditor label={editRoad.fwdLabel} marks={editRoad.laneMarksF}
        carLanes={editRoad.f} motoLanes={editRoad.motoCountF}
        onChange={(laneMarksF) => setEditRoad((er) => er && ({ ...er, laneMarksF }))} />
      {editRoad.oneway === 'no' && (
        <LaneMarkEditor label={editRoad.bwdLabel} marks={editRoad.laneMarksB}
          carLanes={editRoad.b} motoLanes={editRoad.motoCountB}
          onChange={(laneMarksB) => setEditRoad((er) => er && ({ ...er, laneMarksB }))} />
      )}
      {editRoad.motoCountF >= 2 && (
        <div className="lane-mark-group">
          <div className="edit-row"><b>{editRoad.fwdLabel}機車道路口箭頭</b></div>
          <div className="edit-row" style={{ flexWrap: 'wrap' }}>
            {editRoad.motoTurnLanesF.map((move, i) => (
              <ArrowStyleSelect key={i} value={move}
                label={`${editRoad.fwdLabel}機車道 ${i + 1} 箭頭`}
                onChange={(value) => setEditRoad((er) => {
                  if (!er) return er
                  const next = [...er.motoTurnLanesF]; next[i] = value
                  return { ...er, motoTurnLanesF: next }
                })} />
            ))}
          </div>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.motoCountB >= 2 && (
        <div className="lane-mark-group">
          <div className="edit-row"><b>{editRoad.bwdLabel}機車道路口箭頭</b></div>
          <div className="edit-row" style={{ flexWrap: 'wrap' }}>
            {editRoad.motoTurnLanesB.map((move, i) => (
              <ArrowStyleSelect key={i} value={move}
                label={`${editRoad.bwdLabel}機車道 ${i + 1} 箭頭`}
                onChange={(value) => setEditRoad((er) => {
                  if (!er) return er
                  const next = [...er.motoTurnLanesB]; next[i] = value
                  return { ...er, motoTurnLanesB: next }
                })} />
            ))}
          </div>
        </div>
      )}
      </section>

      <section className="edit-section">
      <h3>5. 道路繪圖開關</h3>
      <p>各路段可單獨選擇完整顯示、只留中央格式，或清空所有道路繪製；道路面本身不受影響。</p>
      <div className="edit-row" style={{ alignItems: 'stretch' }}>
        <span>本路段道路繪圖</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        {([
          ['all', '全部資訊顯示'],
          ['center', '保留中線格式其他不顯示'],
          ['none', '全部資訊不顯示'],
        ] as const).map(([mode, label]) => (
          <button key={mode} className={`mini${editRoad.roadMarkingMode === mode ? ' on' : ''}`}
            style={{ width: '100%' }}
            onClick={() => setEditRoad((er) => er && ({ ...er, roadMarkingMode: mode }))}>
            {label}
          </button>
        ))}
        </div>
      </div>
      <div className="edit-row">
        <span>{editRoad.fwdLabel}停止線</span>
        <button className={`mini${editRoad.stopLineF ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => er && ({ ...er, stopLineF: !er.stopLineF }))}>
          {editRoad.stopLineF ? '需要' : '不需要'}
        </button>
      </div>
      {editRoad.oneway === 'no' && <div className="edit-row">
        <span>{editRoad.bwdLabel}停止線</span>
        <button className={`mini${editRoad.stopLineB ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => er && ({ ...er, stopLineB: !er.stopLineB }))}>
          {editRoad.stopLineB ? '需要' : '不需要'}
        </button>
      </div>}
      {editRoad.motoF && <>
        <div className="edit-row">
          <span>{editRoad.fwdLabel}機車道入口圖示</span>
          <button className={`mini${editRoad.motoEntryIconF ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({ ...er, motoEntryIconF: !er.motoEntryIconF }))}>
            {editRoad.motoEntryIconF ? '繪製' : '不繪製'}
          </button>
        </div>
        <div className="edit-row">
          <span>{editRoad.fwdLabel}機車道文字菱形</span>
          <button className={`mini${editRoad.motoTextDiamondF ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({ ...er, motoTextDiamondF: !er.motoTextDiamondF }))}>
            {editRoad.motoTextDiamondF ? '上下加菱形' : '不加菱形'}
          </button>
        </div>
      </>}
      {editRoad.oneway === 'no' && editRoad.motoB && <>
        <div className="edit-row">
          <span>{editRoad.bwdLabel}機車道入口圖示</span>
          <button className={`mini${editRoad.motoEntryIconB ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({ ...er, motoEntryIconB: !er.motoEntryIconB }))}>
            {editRoad.motoEntryIconB ? '繪製' : '不繪製'}
          </button>
        </div>
        <div className="edit-row">
          <span>{editRoad.bwdLabel}機車道文字菱形</span>
          <button className={`mini${editRoad.motoTextDiamondB ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({ ...er, motoTextDiamondB: !er.motoTextDiamondB }))}>
            {editRoad.motoTextDiamondB ? '上下加菱形' : '不加菱形'}
          </button>
        </div>
      </>}
      </section>
      <div className="edit-actions">
        <button className="mini go" onClick={editor.saveRoadEdit}>儲存並套用</button>
        <button className="mini" onClick={() => setEditRoad(null)}>取消</button>
      </div>
      <div className="road-danger-zone">
        <button className="road-delete-link" onClick={editor.deleteRoadSegment}>
          刪除此路段…
        </button>
      </div>
    </div>
  )
}

/** 側面板：顯式配對分隔島（點島面開啟，島寬/開關覆寫記入 journal） */
export function TwinIslandPanel({ editor }: { editor: Editor }) {
  const { islandPanel, setIslandPanel } = editor
  if (!islandPanel) return null
  const w = islandPanel.wEff
  const setW = (next: number) => {
    editor.overrideTwin(islandPanel.pairKey, { present: 1, w: next })
    setIslandPanel({ ...islandPanel, wEff: next })
  }
  return (
    <div className="side-panel">
      <div className="sp-head">
        <b>分隔島（配對）</b>
        <button className="sp-close" onClick={() => setIslandPanel(null)}>✕</button>
      </div>
      <div className="road-src">{islandPanel.pairKey} · 覆寫將記入 journal</div>
      <div className="edit-row">
        <span>島寬</span>
        <button className="mini" onClick={() => setW(Math.max(0.8, +(((w ?? 2.4)) - 0.8).toFixed(1)))}>−</button>
        <b>{w !== undefined ? `${w.toFixed(1)}m` : '自動（鋪滿）'}</b>
        <button className="mini" onClick={() => setW(Math.min(20, +(((w ?? 2.4)) + 0.8).toFixed(1)))}>＋</button>
      </div>
      <div className="edit-row">
        <button className="mini" onClick={() => {
          editor.overrideTwin(islandPanel.pairKey, { present: 1, w: -1 }) // w<0 = 回復自動
          setIslandPanel({ ...islandPanel, wEff: undefined })
        }}>自動鋪滿</button>
        <button className="mini warn-btn" onClick={() => {
          editor.overrideTwin(islandPanel.pairKey, { present: 0 })
          setIslandPanel(null)
        }}>關閉此配對</button>
      </div>
    </div>
  )
}

/** 側面板：路口待轉區（選左轉配對，位置自動） */
export function ZonePanel({ core, editor }: { core: MapCore; editor: Editor }) {
  const { zonePanel, setZonePanel } = editor
  if (!zonePanel) return null
  const zoneMoveLimitM = 16
  const updateZone = (id: string, patch: Record<string, unknown>) => {
    core.zonesRef.current = core.zonesRef.current.map((z) =>
      z.id === id ? { ...z, ...patch } : z)
    core.refreshZones()
  }
  const moveZone = (id: string, lateralOffsetM: number, forwardOffsetM: number) => {
    const lateral = Math.max(-zoneMoveLimitM, Math.min(zoneMoveLimitM, lateralOffsetM))
    const forward = Math.max(-zoneMoveLimitM, Math.min(zoneMoveLimitM, forwardOffsetM))
    core.zonesRef.current = core.zonesRef.current.map((z) => {
      if (z.id !== id) return z
      const baseCenter = z.baseCenter ?? z.center
      const a = (z.bearing * Math.PI) / 180
      const f: [number, number] = [Math.sin(a), Math.cos(a)]
      const r: [number, number] = [Math.cos(a), -Math.sin(a)]
      return {
        ...z,
        baseCenter,
        lateralOffsetM: lateral,
        forwardOffsetM: forward,
        center: offsetMeters(
          baseCenter,
          lateral * r[0] + forward * f[0],
          lateral * r[1] + forward * f[1],
        ),
      }
    })
    core.refreshZones()
  }
  const rotateZone = (id: string, rotationDeg: number) => {
    core.zonesRef.current = core.zonesRef.current.map((z) => {
      if (z.id !== id) return z
      const baseBearing = z.baseBearing ?? z.bearing
      return { ...z, baseBearing, rotationDeg, bearing: baseBearing + rotationDeg }
    })
    core.refreshZones()
  }
  return (
    <div className="side-panel">
      <div className="sp-head">
        <b>路口待轉區</b>
        <button className="sp-close" onClick={() => setZonePanel(null)}>✕</button>
      </div>
      <div className="road-src">node/{zonePanel.nodeId} · 選擇要標註的左轉方向</div>
      {zonePanel.options.length === 0 && (
        <div className="sp-error">此路口找不到左轉配對</div>
      )}
      {zonePanel.options.map((o, i) => {
        const exists = core.zonesRef.current.some((z) =>
          z.intersectionId === zonePanel.nodeId &&
          Math.abs(angleDelta(z.from.bearing, o.fromBearing)) < 20 &&
          Math.abs(angleDelta(z.to.bearing, o.toBearing)) < 20)
        return (
          <div key={i} className="sp-stop">
            <span className="sp-pos">
              {o.fromName ?? '未命名'}（{compassOf(o.fromBearing)}）左轉 →{' '}
              {o.toName ?? '未命名'}（{compassOf(o.toBearing)}）
            </span>
            {exists
              ? <span className="sp-done">已設</span>
              : <button className="mini go" onClick={() => {
                const g = core.graphRef.current
                core.zonesRef.current = [...core.zonesRef.current,
                  planZone(o, g ? makeZoneCtx(g) : undefined)]
                core.refreshZones()
              }}>新增</button>}
          </div>
        )
      })}
      {core.zonesRef.current.some((z) => z.intersectionId === zonePanel.nodeId) && (
        <>
          <div className="road-src" style={{ marginTop: 10 }}>此路口已設定：</div>
          <div className="road-src">停用後不會顯示，也不會被機車導航採用。</div>
          {core.zonesRef.current
            .filter((z) => z.intersectionId === zonePanel.nodeId)
            .map((z) => (
              <div key={z.id}
                className={`sp-stop zone-item${core.selectedZoneRef.current === z.id ? ' selected-zone' : ''}`}>
                <span className="sp-pos">
                  {z.from.name ?? '未命名'}（{compassOf(z.from.bearing)}）→{' '}
                  {z.to.name ?? '未命名'}（{compassOf(z.to.bearing)}）
                </span>
                <button className={`mini${z.visible !== false ? ' on' : ''}`} onClick={() => {
                  core.zonesRef.current = core.zonesRef.current.map((x) =>
                    x.id === z.id ? { ...x, visible: x.visible === false } : x)
                  core.refreshZones()
                }}>{z.visible === false ? '啟用' : '停用'}</button>
                <button className="mini warn-btn" onClick={() => {
                  markZoneDeleted(z.id)
                  core.zonesRef.current = core.zonesRef.current.filter((x) => x.id !== z.id)
                  core.refreshZones()
                }}>刪除</button>
                {z.visible !== false && (
                  <div className="zone-custom">
                    <label>形狀
                      <select value={z.shape ?? (Math.abs(z.sk ?? 0) > 0.04 ? 'parallelogram' : 'rectangle')}
                        onChange={(e) => updateZone(z.id, { shape: e.target.value })}>
                        <option value="rectangle">長方形</option>
                        <option value="square">正方形</option>
                        <option value="parallelogram">平行四邊形</option>
                      </select>
                    </label>
                    <label>寬度 {z.w.toFixed(1)}m
                      <input type="range" min="2" max="8" step="0.2" value={z.w}
                        onChange={(e) => updateZone(z.id, { w: Number(e.target.value) })} />
                    </label>
                    {(z.shape ?? 'rectangle') !== 'square' && (
                      <label>深度 {z.d.toFixed(1)}m
                        <input type="range" min="1.6" max="6" step="0.2" value={z.d}
                          onChange={(e) => updateZone(z.id, { d: Number(e.target.value) })} />
                      </label>
                    )}
                    {(z.shape ?? (Math.abs(z.sk ?? 0) > 0.04 ? 'parallelogram' : 'rectangle')) === 'parallelogram' && (
                      <label>傾斜量 {(z.shapeSkew ?? z.sk ?? 0.25).toFixed(2)}
                        <input type="range" min="-0.7" max="0.7" step="0.05"
                          value={z.shapeSkew ?? z.sk ?? 0.25}
                          onChange={(e) => updateZone(z.id, { shapeSkew: Number(e.target.value) })} />
                      </label>
                    )}
                    <label>左右微調 {(z.lateralOffsetM ?? 0).toFixed(1)}m
                      <input type="range" min={-zoneMoveLimitM} max={zoneMoveLimitM} step="0.2"
                        value={z.lateralOffsetM ?? 0}
                        onChange={(e) => moveZone(z.id, Number(e.target.value), z.forwardOffsetM ?? 0)} />
                    </label>
                    <label>前後微調 {(z.forwardOffsetM ?? 0).toFixed(1)}m
                      <input type="range" min={-zoneMoveLimitM} max={zoneMoveLimitM} step="0.2"
                        value={z.forwardOffsetM ?? 0}
                        onChange={(e) => moveZone(z.id, z.lateralOffsetM ?? 0, Number(e.target.value))} />
                    </label>
                    <label>旋轉 {(z.rotationDeg ?? 0).toFixed(0)}°
                      <input type="range" min="-35" max="35" step="1"
                        value={z.rotationDeg ?? 0}
                        onChange={(e) => rotateZone(z.id, Number(e.target.value))} />
                    </label>
                    <div className="zone-actions">
                      <button className="mini" onClick={() => moveZone(z.id, 0, 0)}>位置復原</button>
                      <button className="mini" onClick={() => rotateZone(z.id, 0)}>角度復原</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </>
      )}
    </div>
  )
}

/** 側面板：路口偏心左轉道 + 右轉附加車道（開/關/參數，journal 覆寫） */
export function BayPanel({ core, editor }: { core: MapCore; editor: Editor }) {
  const { bayPanel, setBayPanel } = editor
  if (!bayPanel) return null
  const cands = core.graphRef.current
    ? bayCandidatesAt(core.graphRef.current, core.journalRef.current, core.baysRef.current, bayPanel.nodeId)
    : []
  const rlCands = core.graphRef.current
    ? rightLaneCandidatesAt(core.graphRef.current, core.journalRef.current, core.rightLanesRef.current, bayPanel.nodeId)
    : []
  return (
    <div className="side-panel">
      <div className="sp-head">
        <b>偏心左轉道 / 右轉道</b>
        <button className="sp-close" onClick={() => setBayPanel(null)}>✕</button>
      </div>
      <div className="road-src">node/{bayPanel.nodeId} · 覆寫將記入 journal</div>
      {cands.length === 0 && (
        <div className="sp-error">此路口沒有實驗範圍內的進入行向（目前僅藍田路，且需有左轉/迴轉配對）</div>
      )}
      {cands.map((c) => (
        <div key={c.key} className="sp-stop" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="sp-pos">
            {c.roadName ?? '未命名'}（{compassOf(c.approachBearing)}進入）
            {c.state === 'default' ? ' · 預設生成' : c.state === 'manual' ? ' · 人工設定' : ''}
          </span>
          {(c.state === 'default' || c.state === 'manual') && c.bay && (
            <>
              <span>儲車 {Math.round(c.bay.bayLenM)}m</span>
              <button className="mini" onClick={() =>
                editor.overrideBay(c.key, { present: 1, bay_len_m: Math.max(15, Math.round(c.bay!.bayLenM) - 5) })}>−5</button>
              <button className="mini" onClick={() =>
                editor.overrideBay(c.key, { present: 1, bay_len_m: Math.min(60, Math.round(c.bay!.bayLenM) + 5) })}>＋5</button>
              <button className="mini warn-btn" onClick={() => editor.overrideBay(c.key, { present: 0 })}>關閉</button>
            </>
          )}
          {c.state === 'off' && (
            <button className="mini go" onClick={() => editor.overrideBay(c.key, { present: 1 })}>重新開啟</button>
          )}
          {c.state === 'blocked' && (
            <>
              <span className="sp-error">{c.blockedReason}</span>
              {c.canForce && (
                <button className="mini go" onClick={() => editor.overrideBay(c.key, { present: 1 })}>
                  直接開啟
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <div className="road-src" style={{ marginTop: 10 }}>
        右轉附加車道（路口前最外車道外側加寬）：
      </div>
      {rlCands.length === 0 && (
        <div className="sp-error">此路口找不到進入行向</div>
      )}
      {rlCands.map((c) => (
        <div key={c.key} className="sp-stop" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="sp-pos">{c.roadName ?? '未命名'}（{compassOf(c.approachBearing)}進入）</span>
          {c.rl ? (
            <>
              <span>儲車 {Math.round(c.rl.lenM)}m</span>
              <button className="mini" onClick={() =>
                editor.overrideRightLane(c.key, { present: 1, len_m: Math.max(10, Math.round(c.rl!.lenM) - 5) })}>−5</button>
              <button className="mini" onClick={() =>
                editor.overrideRightLane(c.key, { present: 1, len_m: Math.min(60, Math.round(c.rl!.lenM) + 5) })}>＋5</button>
              <button className="mini warn-btn" onClick={() => editor.overrideRightLane(c.key, { present: 0 })}>關閉</button>
            </>
          ) : c.failed ? (
            <span className="sp-error">路段太短，放不下右轉道</span>
          ) : (
            <button className="mini go" onClick={() => editor.overrideRightLane(c.key, { present: 1 })}>新增</button>
          )}
        </div>
      ))}
    </div>
  )
}

/** 側面板：選取中的車輛模型 */
export function VehiclePanel({ core, editor, selectedVehicle, vehicleCount }: {
  core: MapCore; editor: Editor; selectedVehicle: PlacedVehicle | null; vehicleCount: number
}) {
  if (!selectedVehicle) return null
  return (
    <div className="side-panel">
      <div className="sp-head">
        <b>{selectedVehicle.type === 'car' ? '🚗 汽車' : '🛵 機車'}模型</b>
        <button className="sp-close" onClick={() => {
          core.selectedVehicleRef.current = null; core.refreshVehicles()
        }}>✕</button>
      </div>
      <div className="road-src">
        {selectedVehicle.road ?? '未知道路'} · 朝向 {Math.round(selectedVehicle.bearing)}°
      </div>
      <div className="edit-row">
        <button className="mini warn-btn" onClick={() => editor.deleteVehicle(selectedVehicle.id)}>刪除此車</button>
        <button className="mini" onClick={editor.clearVehicles}>清空全部 ({vehicleCount})</button>
      </div>
    </div>
  )
}

/** 側面板：拉線新增道路（草稿屬性與完成；或選取既有自訂道路刪除） */
export function RoadDrawPanel({ editor }: { editor: Editor }) {
  const { draftRoad, selNewRoad } = editor
  if (selNewRoad) {
    return (
      <div className="side-panel">
        <div className="sp-head">
          <div><span className="sp-kicker">自訂道路</span><b>{selNewRoad.name ?? '（未命名道路）'}</b></div>
          <button className="sp-close" onClick={() => editor.setSelNewRoad(null)}>✕</button>
        </div>
        <div className="road-src">way/{selNewRoad.osmId} · 使用者拉線新增（journal new_road）</div>
        <div className="edit-notice">刪除只移除這條自訂道路；車道等覆寫紀錄留在 journal 不影響其他路。</div>
        <div className="edit-row">
          <button className="mini warn-btn" onClick={() => editor.deleteNewRoad(selNewRoad.osmId)}>刪除這條道路</button>
        </div>
      </div>
    )
  }
  if (!draftRoad) return null
  const n = draftRoad.coords.length
  const snapped = draftRoad.nodeIds.filter((x) => x !== null).length
  const endsSnapped = draftRoad.nodeIds[0] !== null || draftRoad.nodeIds[n - 1] !== null
  return (
    <div className="side-panel">
      <div className="sp-head">
        <div><span className="sp-kicker">新增道路</span><b>拉線草稿</b></div>
        <button className="sp-close" onClick={editor.cancelDraftRoad}>✕</button>
      </div>
      <div className="road-src">頂點 {n} · 已吸附 {snapped}（藍點）· Esc 取消</div>
      <div className="edit-notice">
        端點要吸附在既有路口/節點上（藍點）路網才會連通、可導航。
        完成後預設雙向 1+1 車道，可用「車道」工具繼續編輯斷面。
      </div>
      <div className="edit-row">
        <span>道路名稱</span>
        <input value={editor.draftName} maxLength={20} placeholder="（可留白）"
          onChange={(e) => editor.setDraftName(e.target.value)} />
      </div>
      <div className="edit-row">
        <span>單行道（依繪製方向）</span>
        <input type="checkbox" checked={editor.draftOneway}
          onChange={(e) => editor.setDraftOneway(e.target.checked)} />
      </div>
      {!endsSnapped && n >= 2 && (
        <div className="edit-notice">⚠ 目前兩端都沒吸附到既有路網，完成後導航到不了這條路。</div>
      )}
      <div className="edit-row">
        <button className="mini" onClick={editor.undoDraftVertex}>回退頂點</button>
        <button className="mini" onClick={editor.cancelDraftRoad}>取消</button>
        <button className="mini go" disabled={n < 2} onClick={editor.finishDraftRoad}>完成成路</button>
      </div>
    </div>
  )
}
