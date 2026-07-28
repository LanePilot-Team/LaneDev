// 導航 HUD（高德式）：頂部指引看板、車道列、速度圓標、底部資訊列、路口決策按鈕。
// guidanceText / ManeuverArrow 也給規劃側的轉彎步驟清單（plan/ManeuverList）重用。
import type { Maneuver, Profile } from '../core/graph'
import type { DriveState } from './drive'
import type { DecisionKind } from './useDrive'
import { LanePreviewPanel, TwoStageWaitSign } from './LanePreviewView'
import { buildLanePreview, selectLanePreviewGuidance } from './lanePreview'

// ── 距離分階段提醒（照 mvp）：250m 預備切車道(藍) → 60m 動作(橘紅) → 25m 內顯示「現在」──
const FAR_THRESHOLD = 250
const NEAR_THRESHOLD = 60
const PASS_THRESHOLD = 25

export type Phase = 'ahead' | 'far' | 'near'

function roundDistance(m: number): string {
  if (m < 100) return `${Math.round(m / 10) * 10}`
  return `${Math.round(m / 50) * 50}`
}

/**
 * 車道級指引文字（照 mvp laneGuidance）：
 * 一般左轉/迴轉 → 前往「左側」車道；機車兩段式才相反（靠右待轉）；
 * 機車「免待轉」左轉仍要先切左車道，只是不必靠右。
 */
export function guidanceText(m: Maneuver, phase: Phase, profile: Profile, twoStage: boolean, bay: boolean): string {
  const into = m.roadName ? `・進入${m.roadName}` : ''
  if (m.kind === 'arrive') return '即將抵達目的地'
  if (profile === 'moto' && m.motoLeftTurnLane &&
    (m.kind === 'left' || m.kind === 'slight-left' || m.kind === 'uturn')) {
    return '靠右前往機車專用左轉道'
  }
  if (twoStage) {
    return phase === 'near'
      ? '靠右進入待轉區（兩段式左轉）'
      : '準備兩段式左轉・稍後靠右待轉'
  }
  if (m.kind === 'uturn') {
    if (bay) return phase === 'near' ? `於左轉專用道迴轉${into}` : '進入左轉專用道・準備迴轉'
    return phase === 'near' ? `迴轉${into}` : '前往左側車道・準備迴轉'
  }
  if (m.kind === 'left') {
    const nb = profile === 'moto' ? '(免待轉)' : ''
    if (bay) {
      return phase === 'near'
        ? `於左轉專用道左轉${nb}${into}`
        : `進入左轉專用道・準備左轉${nb}`
    }
    if (profile === 'moto') {
      return phase === 'near'
        ? `於左側車道左轉(免待轉)${into}`
        : '前往左側車道・準備左轉(免待轉)'
    }
    return phase === 'near' ? `左轉${into}` : '前往左側車道・準備左轉'
  }
  if (m.kind === 'right') {
    return phase === 'near' ? `右轉${into}` : '前往右側車道・準備右轉'
  }
  if (m.kind === 'slight-left') return `靠左行駛${into}`
  return `靠右行駛${into}`
}

/** 連動指示（「隨後…」）的動作短語 */
const THEN_VERB: Record<Exclude<Maneuver['kind'], 'arrive'>, string> = {
  left: '左轉', right: '右轉', uturn: '迴轉',
  'slight-left': '靠左', 'slight-right': '靠右',
}

export function TopBanner({ drive, twoStage, profile }: {
  drive: DriveState; twoStage: boolean; profile: Profile
}) {
  const m = drive.next
  if (!m) return null
  const dist = drive.nextDistM
  const phase: Phase = dist < NEAR_THRESHOLD ? 'near' : dist < FAR_THRESHOLD ? 'far' : 'ahead'
  const distText = dist < PASS_THRESHOLD ? '現在'
    : dist > 1000 ? `前方 ${(dist / 1000).toFixed(1)} 公里`
      : `前方 ${roundDistance(dist)} 公尺`
  const tone = twoStage ? 'two-stage' : phase === 'near' ? 'near' : 'far'
  const guidance = selectLanePreviewGuidance({
    distanceM: dist,
    current: drive.roadLaneGuidance,
    maneuver: m.laneGuidance,
  })
  const bay = !twoStage && m.bayOffM !== undefined // 偏心左轉道（兩段式不進 bay）
  const lanePreview = buildLanePreview({
    laneCount: guidance?.laneCount,
    turnLanes: guidance?.laneMovements,
    guidanceSource: guidance?.source,
    maneuverKind: m.kind,
    distanceM: dist,
    twoStage,
  })
  return (
    <div className={`banner banner-${tone}`}>
      <div className="banner-main">
        <ManeuverArrow kind={twoStage ? 'two-stage' : m.kind} />
        <div className="banner-dist">
          <b>{distText}</b>
          <span>{guidanceText(m, phase, profile, twoStage, bay)}</span>
          {/* 下一個動作距離很近時預告，避免連續轉向來不及反應 */}
          {drive.next2 && drive.next2.kind !== 'arrive' && drive.next2.distM - m.distM < 60 && (
            <span className="banner-then">隨後{THEN_VERB[drive.next2.kind]}</span>
          )}
        </div>
        {lanePreview.showTwoStageSign && <TwoStageWaitSign />}
      </div>
      {m.kind !== 'arrive' && <LanePreviewPanel model={lanePreview} />}
    </div>
  )
}

export function ManeuverArrow({ kind }: { kind: Maneuver['kind'] | 'two-stage' }) {
  const d: Record<Maneuver['kind'] | 'two-stage', string> = {
    // 兩段式左轉：先靠右進待轉格（右鉤），再左向
    'two-stage': 'M16 44 L16 34 Q16 26 24 26 L31 26 M26 20 L32 26 L26 32 M38 16 L24 16 M28 10 L23 16 L28 21',
    left: 'M30 44 L30 26 Q30 18 22 18 L14 18 M20 10 L12 18 L20 26',
    right: 'M18 44 L18 26 Q18 18 26 18 L34 18 M28 10 L36 18 L28 26',
    'slight-left': 'M28 44 L28 30 L18 18 M18 28 L18 16 L30 16',
    'slight-right': 'M20 44 L20 30 L30 18 M30 28 L30 16 L18 16',
    // 左迴轉（台灣迴轉方向）：右側上去、左側下來
    uturn: 'M32 44 L32 22 Q32 12 24 12 Q16 12 16 22 L16 32 M24 26 L16 34 L8 26',
    arrive: 'M24 44 L24 10 M24 12 L38 17 L24 22',
  }
  return (
    <svg className="man-arrow" viewBox="0 0 48 52">
      <path d={d[kind]} fill="none" stroke="currentColor" strokeWidth="5.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const DECISION_LABEL: Record<DecisionKind, string> = { left: '左轉', straight: '直行', right: '右轉' }

/** 導航中（drive 模式）的整組 HUD：看板、速度、決策按鈕、底部列；GPS 未定位時顯示過渡列 */
export function DriveHUD({
  drive, twoStage, profile, gpsMsg, multiplier, decisionOptions,
  onEnd, onReplay, onCycleMultiplier, onTakeAlternative, onSwitchLane,
}: {
  drive: DriveState | null
  twoStage: boolean
  profile: Profile
  gpsMsg: string | null
  multiplier: number
  decisionOptions: { kind: DecisionKind }[]
  onEnd: () => void
  /** 模擬到達後的「再跑一次」；GPS 導航不傳（不顯示按鈕） */
  onReplay?: () => void
  onCycleMultiplier: () => void
  onTakeAlternative: (kind: DecisionKind) => void
  onSwitchLane: (dir: -1 | 1) => void
}) {
  // 換車道按鈕只在桌面顯示（跟鍵盤變速一樣不給手機用，觸控版另外設計）
  const isDesktop = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches

  // ── GPS 導航還沒收到第一筆定位（或定位失敗）時的過渡畫面 ──
  if (!drive) {
    return (
      <div className="bottom-bar">
        <button className="end-btn" onClick={onEnd}>✕ 結束</button>
        <div className="trip"><b>{gpsMsg ?? '準備中…'}</b></div>
      </div>
    )
  }

  return (
    <>
      {/* ── 頂部導航看板 ── */}
      <TopBanner drive={drive} twoStage={twoStage} profile={profile} />

      {/* ── 速度圓標 ── */}
      <div className="speed-badge">
        <div className="speed-num">{Math.round(drive.speedKmh)}</div>
        <div className="speed-unit">km/h</div>
      </div>

      {/* ── 路口決策 + 底部資訊列 ── */}
      {decisionOptions.length > 0 && (
        <div className="decision-row">
          {decisionOptions.map((a) => (
            <button key={a.kind} className="decision-btn" onClick={() => onTakeAlternative(a.kind)}>
              不照指引：{DECISION_LABEL[a.kind]}
            </button>
          ))}
        </div>
      )}
      <div className="bottom-bar">
        <button className="end-btn" onClick={onEnd}>✕ 結束</button>
        {drive.arrived && onReplay && (
          <button className="replay-btn" onClick={onReplay}>↺ 再跑一次</button>
        )}
        {isDesktop && (
          <button className="lane-btn" onClick={() => onSwitchLane(-1)} title="換到左邊車道">◀</button>
        )}
        <div className="trip">
          <b>{drive.remainM > 1000 ? `${(drive.remainM / 1000).toFixed(1)} 公里` : `${Math.round(drive.remainM)} 公尺`}</b>
          <span>
            {drive.arrived ? '已抵達' :
              new Date(Date.now() + drive.remainS * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) + ' 抵達'}
          </span>
          {drive.roadName && <span className="trip-road">{drive.roadName}</span>}
        </div>
        {isDesktop && (
          <button className="lane-btn" onClick={() => onSwitchLane(1)} title="換到右邊車道">▶</button>
        )}
        <button className="mult-btn" onClick={onCycleMultiplier}>{multiplier}x</button>
      </div>
    </>
  )
}
