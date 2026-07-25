// 編輯模式 UI（LaneDev 專屬）：工具切換提示列 + 車道/待轉區/偏心道/車輛四個側面板。
import type { Profile } from '../core/graph'
import { exportEnhancements } from '../core/enhancements'
import { makeZoneCtx, planZone } from '../core/zones'
import { bayCandidatesAt, rightLaneCandidatesAt } from '../core/turnbays'
import { angleDelta } from '../core/geo'
import type { PlacedVehicle } from '../core/vehicles'
import type { MapCore } from '../app/mapCore'
import { CAR_LANE_MARKS, MOTO_LANE_MARKS } from '../core/roadtext'
import type { LaneMark } from '../core/roads'
import {
  compassOf, resizeLaneMarks, resizeTurnLanes, TURN_CYCLE, TURN_EDIT_GLYPH,
  BAY_TURN_CYCLE, BAY_TURN_GLYPH, type Editor,
} from './useEditor'

const resizeDirectionMarks = (marks: (LaneMark | null)[], oldCars: number, newCars: number, moto: boolean) => {
  const motoMark = moto ? marks[oldCars] ?? null : null
  return [...resizeLaneMarks(marks.slice(0, oldCars), newCars), ...(moto ? [motoMark] : [])]
}

/** 地面規則選取列（點選加入/移除；選取順序 = 從路口入口沿行進方向排列） */
function LaneMarkEditor({ label, marks, carLanes, hasMoto, onChange }: {
  label: string; marks: (LaneMark | null)[]; carLanes: number; hasMoto: boolean
  onChange: (marks: (LaneMark | null)[]) => void
}) {
  const set = (i: number, mark: LaneMark | null) => {
    const next = [...marks]; next[i] = mark; onChange(next)
  }
  return (
    <div className="lane-mark-group">
      <div className="edit-row"><span><b className="row-title">{label}</b>每條車道只能設定一種資訊，也可以保持空白。</span></div>
      {marks.map((mark, i) => {
        const moto = hasMoto && i === carLanes
        const presets = moto ? MOTO_LANE_MARKS : CAR_LANE_MARKS
        const preset = presets.find((p) => p.text === mark?.text && p.color === mark?.color)
        const value = !mark ? '' : preset?.text ?? '__custom__'
        return <div className="lane-mark-row" key={i}>
          <b>{moto ? '機車道' : `汽車道 ${i + 1}`}</b>
          <select value={value} onChange={(e) => {
            const v = e.target.value
            if (!v) set(i, null)
            else if (v === '__custom__') set(i, mark ?? { text: '', color: '#ffffff' })
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

export function EditHintBar({ core, editor, profile, zoneCount, vehicleCount }: {
  core: MapCore; editor: Editor; profile: Profile; zoneCount: number; vehicleCount: number
}) {
  const { editTool, editWarn } = editor
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
      </span>
      {editWarn ?? (editTool === 'lane'
        ? '點選道路 → 右側面板編輯車道（雙向道可設中央帶）'
        : editTool === 'zone'
          ? '點選「路口」→ 右側面板選左轉方向（位置自動計算）'
          : editTool === 'bay'
            ? '點選「路口」→ 開關/調整偏心左轉道與右轉附加車道'
            : `點擊道路放置${profile === 'car' ? '汽車' : '機車'}模型 · 點模型可選取/刪除`)}
      {!editWarn && (
        <button className="mini"
          onClick={() => exportEnhancements(core.journalRef.current, core.zonesRef.current, core.vehiclesRef.current, core.baysRef.current, core.rightLanesRef.current)}>
          匯出 ({core.journalRef.current.length + zoneCount + vehicleCount})
        </button>
      )}
    </div>
  )
}

/** 側面板：車道編輯 */
export function LaneEditPanel({ editor }: { editor: Editor }) {
  const { editRoad, setEditRoad } = editor
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
      <div className="edit-notice">先調整下列設定；按「儲存並套用」後才會寫入 journal 並重繪道路。</div>

      <section className="edit-section">
      <h3>1. 行車空間</h3>
      <p>汽車道數不包含機車道；開啟機車道會在該方向最外側另外增加一條。</p>
      <div className="edit-row">
        <span>{editRoad.oneway === 'yes' ? `${editRoad.fwdLabel}（單行）` : editRoad.fwdLabel}汽車道</span>
        <button className="mini" onClick={() => setEditRoad((er) => {
          if (!er) return er
          const min = er.motoF ? 0 : 1 // 有機車道可減到 0 = 該向純機車道
          const f = Math.max(min, er.f - 1)
          return { ...er, f, turnLanes: resizeTurnLanes(er.turnLanes, f),
            laneMarksF: resizeDirectionMarks(er.laneMarksF, er.f, f, er.motoF) }
        })}>−</button>
        <b>{editRoad.f}</b>
        <button className="mini" onClick={() => setEditRoad((er) => er && ({
          ...er, f: Math.min(6, er.f + 1),
          turnLanes: resizeTurnLanes(er.turnLanes, Math.min(6, er.f + 1)),
          laneMarksF: resizeDirectionMarks(er.laneMarksF, er.f, Math.min(6, er.f + 1), er.motoF),
        }))}>＋</button>
        <button className={`mini${editRoad.motoF ? ' on' : ''}`}
          onClick={() => setEditRoad((er) => {
            if (!er) return er
            // 關機車道時若車道 0，自動補回 1（斷面不能空）
            const f = er.motoF && er.f === 0 ? 1 : er.f
            return { ...er, motoF: !er.motoF, f, turnLanes: resizeTurnLanes(er.turnLanes, f),
              laneMarksF: er.motoF
                ? resizeLaneMarks(er.laneMarksF.slice(0, er.f), f)
                : [...resizeLaneMarks(er.laneMarksF, f), null] }
          })}>
          {editRoad.motoF ? '已設機車道' : '＋機車道'}
        </button>
      </div>
      {editRoad.motoF && (
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
      )}
      {editRoad.oneway === 'no' && (
        <div className="edit-row">
        <span>{editRoad.bwdLabel}汽車道</span>
          <button className="mini" onClick={() => setEditRoad((er) => {
            if (!er) return er
            const min = er.motoB ? 0 : 1
            const b = Math.max(min, er.b - 1)
            return { ...er, b, turnLanesB: resizeTurnLanes(er.turnLanesB, b),
              laneMarksB: resizeDirectionMarks(er.laneMarksB, er.b, b, er.motoB) }
          })}>−</button>
          <b>{editRoad.b}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, b: Math.min(6, er.b + 1),
            turnLanesB: resizeTurnLanes(er.turnLanesB, Math.min(6, er.b + 1)),
            laneMarksB: resizeDirectionMarks(er.laneMarksB, er.b, Math.min(6, er.b + 1), er.motoB),
          }))}>＋</button>
          <button className={`mini${editRoad.motoB ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => {
              if (!er) return er
              const b = er.motoB && er.b === 0 ? 1 : er.b
              return { ...er, motoB: !er.motoB, b, turnLanesB: resizeTurnLanes(er.turnLanesB, b),
                laneMarksB: er.motoB
                  ? resizeLaneMarks(er.laneMarksB.slice(0, er.b), b)
                  : [...resizeLaneMarks(er.laneMarksB, b), null] }
            })}>
            {editRoad.motoB ? '已設機車道' : '＋機車道'}
          </button>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.motoB && (
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
      )}
      <div className="edit-help">快慢分隔為 0 時繪製白實線；調高後改為同寬度的實體分隔島。</div>
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
            onClick={() => setEditRoad((er) => er && ({ ...er, centerKind: 'hatch' }))}>
            槽化（可偏心）
          </button>
          <button className={`mini${editRoad.centerKind === 'island' ? ' on' : ''}`}
            onClick={() => setEditRoad((er) => er && ({
              // 直接點「分隔島」時中央帶還是 0 → 自動給 1.6m，島才有空間
              ...er, centerKind: 'island', centerM: er.centerM > 0 ? er.centerM : 1.6,
            }))}>
            分隔島
          </button>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.centerKind !== 'island' && editRoad.centerM > 0 && (
        <div className="edit-row">
          <span>中央偏心道用途</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, bayF: BAY_TURN_CYCLE[(BAY_TURN_CYCLE.indexOf(er.bayF) + 1) % BAY_TURN_CYCLE.length],
          }))}>{editRoad.fwdLabel} {BAY_TURN_GLYPH[editRoad.bayF] ?? '無'}</button>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, bayB: BAY_TURN_CYCLE[(BAY_TURN_CYCLE.indexOf(er.bayB) + 1) % BAY_TURN_CYCLE.length],
          }))}>{editRoad.bwdLabel} {BAY_TURN_GLYPH[editRoad.bayB] ?? '無'}</button>
        </div>
      )}
      <div className="edit-row"><span><b className="row-title">{editRoad.fwdLabel}車道箭頭</b>依該方向駕駛視角，由左至右排列；點擊圖示切換。</span></div>
      <div className="edit-lanes">
        {editRoad.turnLanes.map((v, i) => (
          <button key={i} className="lane-pick" onClick={() => setEditRoad((er) => {
            if (!er) return er
            const next = [...er.turnLanes]
            next[i] = TURN_CYCLE[(TURN_CYCLE.indexOf(v) + 1) % TURN_CYCLE.length]
            return { ...er, turnLanes: next }
          })}>{TURN_EDIT_GLYPH[v] ?? '↑'}</button>
        ))}
      </div>
      {editRoad.oneway === 'no' && (
        <>
          <div className="edit-row"><span><b className="row-title">{editRoad.bwdLabel}車道箭頭</b>依該方向駕駛視角，由左至右排列；點擊圖示切換。</span></div>
          <div className="edit-lanes">
            {editRoad.turnLanesB.map((v, i) => (
              <button key={i} className="lane-pick" onClick={() => setEditRoad((er) => {
                if (!er) return er
                const next = [...er.turnLanesB]
                next[i] = TURN_CYCLE[(TURN_CYCLE.indexOf(v) + 1) % TURN_CYCLE.length]
                return { ...er, turnLanesB: next }
              })}>{TURN_EDIT_GLYPH[v] ?? '↑'}</button>
            ))}
          </div>
        </>
      )}
      {editRoad.motoBoxMaxF > 0 && (
        <div className="edit-row">
          <span>{editRoad.fwdLabel}機車停等格</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoBoxF: Math.max(0, er.motoBoxF - 1),
          }))}>−</button>
          <b>{editRoad.motoBoxF === 0 ? '關閉' : `外側 ${editRoad.motoBoxF} 道`}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoBoxF: Math.min(er.motoBoxMaxF, er.motoBoxF + 1),
          }))}>＋</button>
        </div>
      )}
      {editRoad.oneway === 'no' && editRoad.motoBoxMaxB > 0 && (
        <div className="edit-row">
          <span>{editRoad.bwdLabel}機車停等格</span>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoBoxB: Math.max(0, er.motoBoxB - 1),
          }))}>−</button>
          <b>{editRoad.motoBoxB === 0 ? '關閉' : `外側 ${editRoad.motoBoxB} 道`}</b>
          <button className="mini" onClick={() => setEditRoad((er) => er && ({
            ...er, motoBoxB: Math.min(er.motoBoxMaxB, er.motoBoxB + 1),
          }))}>＋</button>
        </div>
      )}
      <div className="edit-help">停等格自最外側車道往內涵蓋；禁行機車車道不可涵蓋，上限已依現況鎖定。</div>
      </section>

      <section className="edit-section">
      <h3>4. 各車道的地面資訊</h3>
      <p>只畫在離開路口、剛進入此路段的位置。汽車道提供「禁行機車」；已定義的機車道另提供專用與優先標字。每條車道只能選一種，也可留空或自訂文字顏色。</p>
      <LaneMarkEditor label={editRoad.fwdLabel} marks={editRoad.laneMarksF}
        carLanes={editRoad.f} hasMoto={editRoad.motoF}
        onChange={(laneMarksF) => setEditRoad((er) => er && ({ ...er, laneMarksF }))} />
      {editRoad.oneway === 'no' && (
        <LaneMarkEditor label={editRoad.bwdLabel} marks={editRoad.laneMarksB}
          carLanes={editRoad.b} hasMoto={editRoad.motoB}
          onChange={(laneMarksB) => setEditRoad((er) => er && ({ ...er, laneMarksB }))} />
      )}
      </section>
      <div className="edit-actions">
        <button className="mini go" onClick={editor.saveRoadEdit}>儲存並套用</button>
        <button className="mini" onClick={() => setEditRoad(null)}>取消</button>
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
          {core.zonesRef.current
            .filter((z) => z.intersectionId === zonePanel.nodeId)
            .map((z) => (
              <div key={z.id} className="sp-stop">
                <span className="sp-pos">
                  {z.from.name ?? '未命名'}（{compassOf(z.from.bearing)}）→{' '}
                  {z.to.name ?? '未命名'}（{compassOf(z.to.bearing)}）
                </span>
                <button className="mini warn-btn" onClick={() => {
                  core.zonesRef.current = core.zonesRef.current.filter((x) => x.id !== z.id)
                  core.refreshZones()
                }}>刪除</button>
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
