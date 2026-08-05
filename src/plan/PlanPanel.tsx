// 路線規劃側面板（mvp 起點/停靠點/終點還原）＋ 車種切換 ＋ 轉彎步驟清單。
// LaneDev / LaneNav 共用：狀態與操作都在 usePlanner，這裡只是畫面。
import { isSecureContext } from '../nav/gpsNav'
import { ManeuverList } from './ManeuverList'
import type { Planner } from './usePlanner'

export function PlanPanel({ planner, onClose, startDrive, startGpsNav }: {
  planner: Planner
  onClose: () => void
  startDrive: () => void
  startGpsNav: () => void
}) {
  const { stops, activeStop, dragOverStop, routeError, routeSummary, profile } = planner

  const stopLabel = (i: number) =>
    i === 0 ? '起點' : i === stops.length - 1 ? '終點' : `停靠點 ${i}`
  const stopColor = (i: number) =>
    i === 0 ? '#22c55e' : i === stops.length - 1 ? '#ef4444' : '#1565c0'

  return (
    <div className="side-panel">
      <div className="sp-head">
        <b>路線規劃</b>
        <span className="sp-profile">{profile === 'car' ? '🚗' : '🛵'}</span>
        <button className="sp-close" onClick={onClose}>✕</button>
      </div>
      {/* 車種切換（換車種即重算路線；機車走兩段式/避開禁行路段） */}
      <div className="sp-vehicle">
        <button className={`mini${profile === 'car' ? ' on' : ''}`}
          onClick={() => profile !== 'car' && planner.toggleProfile('pick')}>🚗 汽車</button>
        <button className={`mini${profile === 'moto' ? ' on' : ''}`}
          onClick={() => profile !== 'moto' && planner.toggleProfile('pick')}>🛵 機車</button>
      </div>
      {stops.map((s, i) => (
        <div key={s.id}
          className={`sp-stop${activeStop === s.id ? ' active' : ''}${dragOverStop === s.id ? ' drag-over' : ''}`}
          draggable
          onDragStart={() => { planner.dragStopRef.current = s.id }}
          onDragOver={(e) => { e.preventDefault(); if (dragOverStop !== s.id) planner.setDragOverStop(s.id) }}
          onDragLeave={() => planner.setDragOverStop((v) => (v === s.id ? null : v))}
          onDrop={(e) => { e.preventDefault(); planner.setDragOverStop(null); planner.moveStop(planner.dragStopRef.current, s.id); planner.dragStopRef.current = null }}
          onDragEnd={() => { planner.setDragOverStop(null); planner.dragStopRef.current = null }}>
          <span className="sp-grip" title="拖曳調整順序">⋮⋮</span>
          <span className="sp-dot" style={{ background: stopColor(i) }} />
          <span className="sp-label">{stopLabel(i)}</span>
          <span className={`sp-pos${s.label ? ' named' : ''}`}>
            {s.label ? (
              <><b>{s.label}</b><small>{s.pos
                ? `${s.pos[0].toFixed(4)}, ${s.pos[1].toFixed(4)}`
                : '附近找不到可導航道路'}</small></>
            ) : s.pos ? `${s.pos[0].toFixed(4)}, ${s.pos[1].toFixed(4)}`
              : activeStop === s.id ? '👉 點擊地圖設定' : '未設定'}
          </span>
          {s.pos && <button className="mini" onClick={() => planner.resetStop(s.id)}>重設</button>}
          {i > 0 && i < stops.length - 1 && (
            <button className="mini" onClick={() => planner.removeStop(s.id)}>✕</button>
          )}
        </div>
      ))}
      <button className="sp-add" onClick={planner.addVia}>＋ 新增停靠點</button>
      {routeError && <div className="sp-error">{routeError}</div>}
      {routeSummary && (
        <div className="sp-summary">
          <b>{routeSummary.km.toFixed(1)} 公里</b> · 約 {Math.max(1, Math.round(routeSummary.min))} 分鐘
          <button className="mini go" onClick={startDrive}>開始模擬</button>
          <button className="mini go" onClick={startGpsNav} disabled={!isSecureContext()}
            title={isSecureContext() ? '' : '需要 HTTPS，用 tailscale serve 開啟或改到手機瀏覽器'}>
            📡 開始導航（GPS）
          </button>
        </div>
      )}
      {/* 轉彎步驟清單：routeSummary 更新時 routeRef 也已是同一條路線 */}
      {routeSummary && planner.routeRef.current && (
        <ManeuverList route={planner.routeRef.current} profile={profile} />
      )}
    </div>
  )
}
