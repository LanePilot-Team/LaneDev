import type { Maneuver, Profile } from '../core/graph'

// HUD 與語音共用的距離分階段提醒：250m 預備切車道 → 60m 動作 → 25m 內顯示「現在」。
export const FAR_THRESHOLD = 250
export const NEAR_THRESHOLD = 60
export const PASS_THRESHOLD = 25

export type Phase = 'ahead' | 'far' | 'near'
export type SpeechStage = 'far' | 'near' | 'now'

export function getGuidancePhase(distanceM: number): Phase {
  return distanceM < NEAR_THRESHOLD ? 'near' : distanceM <= FAR_THRESHOLD ? 'far' : 'ahead'
}

export function speechStage(distanceM: number): SpeechStage | null {
  if (!Number.isFinite(distanceM) || distanceM > FAR_THRESHOLD) return null
  if (distanceM <= PASS_THRESHOLD) return 'now'
  if (distanceM <= NEAR_THRESHOLD) return 'near'
  return 'far'
}

export function roundDistance(m: number): string {
  if (m < 100) return `${Math.round(m / 10) * 10}`
  return `${Math.round(m / 50) * 50}`
}

export function formatDistanceText(m: number): string {
  return m > 1000 ? `前方 ${(m / 1000).toFixed(1)} 公里`
    : `前方 ${roundDistance(m)} 公尺`
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

/** 連動指示（「隨後…」）的動作短語。 */
export const THEN_VERB: Record<Exclude<Maneuver['kind'], 'arrive'>, string> = {
  left: '左轉', right: '右轉', uturn: '迴轉',
  'slight-left': '靠左', 'slight-right': '靠右',
}

export function maneuverSpeechKey(m: Maneuver): string {
  return `${m.nodeId ?? `d${m.distM}`}:${m.kind}`
}

export function buildSpeechAnnouncement(args: {
  distanceM: number
  maneuver: Maneuver
  next2?: Maneuver | null
  profile: Profile
  twoStage: boolean
  stage: SpeechStage
}): string {
  const { distanceM, maneuver, next2, profile, twoStage, stage } = args
  const phase: Phase = stage === 'far' ? 'far' : 'near'
  const bay = !twoStage && maneuver.bayOffM !== undefined
  const guidance = guidanceText(maneuver, phase, profile, twoStage, bay).replaceAll('・', '，')
  const distance = stage === 'now' ? '現在' : formatDistanceText(distanceM)
  const after = stage === 'far' ? '後' : ''
  const preparation = stage === 'far' && maneuver.kind !== 'arrive'
    ? twoStage ? '，請提早靠右進入待轉區' : '，請提早變換車道'
    : ''
  const subsequent = stage === 'near' && next2 && next2.kind !== 'arrive'
    && next2.distM - maneuver.distM < 60
    ? `，隨後${THEN_VERB[next2.kind]}`
    : ''
  return `${distance}${after}${guidance}${preparation}${subsequent}`
}
