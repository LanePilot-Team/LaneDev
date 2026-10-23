import { useEffect, useRef } from 'react'
import { speak, stopSpeech } from '../native/client.ts'
import type { Profile } from '../core/graph.ts'
import type { DriveState } from './driveState.ts'
import {
  arrivalAnnouncement,
  arrivingAnnouncement,
  buildSpeechAnnouncement,
  maneuverSpeechKey,
  speechStage,
  type SpeechStage,
} from './speechGuidance.ts'

export interface UseSpeechGuidanceArgs {
  enabled: boolean
  drive: DriveState | null
  profile: Profile
  twoStage: boolean
  /** 目的地名稱（有選地點才有）——收尾語音講得出名字，駕駛才確定系統認得自己到了 */
  destinationName?: string
}

const START_KEY = 'start'
const ARRIVING_KEY = 'arriving'
const ARRIVAL_KEY = 'arrival'
/**
 * 進度倒退超過這個距離才視為換了路線、重新播報。GPS 貼合本身允許倒退 25m（mapMatch
 * WINDOW_BACK_M），原本 5m 的門檻讓停車抖動就清空已播紀錄，同一句轉向一直重講。
 */
const ROUTE_RESET_BACKTRACK_M = 30

export function useSpeechGuidance({
  drive, profile, twoStage, destinationName, enabled,
}: UseSpeechGuidanceArgs): void {
  const spokenKeysRef = useRef(new Set<string>())
  const sessionStartedRef = useRef(false)
  const previousProgressRef = useRef<number | null>(null)

  useEffect(() => {
    function clearSession(): void {
      spokenKeysRef.current.clear()
      sessionStartedRef.current = false
      previousProgressRef.current = null
    }

    function resetIfProgressMovedBackwards(progressM: number): void {
      const previous = previousProgressRef.current
      if (previous !== null && progressM + ROUTE_RESET_BACKTRACK_M < previous) {
        spokenKeysRef.current.clear()
        sessionStartedRef.current = false
      }
      previousProgressRef.current = progressM
    }

    function speakOnce(key: string, text: string, priority = false): void {
      if (spokenKeysRef.current.has(key)) return
      spokenKeysRef.current.add(key)
      speak(text, priority)
    }
    // 迫近（near/now）的轉向與抵達要插隊，不能排在測速提示或過時的遠距預告後面
    const urgent = (stage: SpeechStage | null) => stage === 'near' || stage === 'now'

    if (!enabled) { stopSpeech(); return }
    if (!drive) {
      clearSession()
      return
    }

    resetIfProgressMovedBackwards(drive.traveledM)

    const stage: SpeechStage | null = drive.next ? speechStage(drive.nextDistM) : null
    if (!sessionStartedRef.current) {
      sessionStartedRef.current = true
      if (drive.arrived) {
        spokenKeysRef.current.add(START_KEY)
        spokenKeysRef.current.add(ARRIVAL_KEY)
        speak(arrivalAnnouncement(destinationName), true)
        return
      }
      if (!drive.next || !stage) {
        speakOnce(START_KEY, '開始導航')
        return
      }

      const key = `${maneuverSpeechKey(drive.next)}:${stage}`
      const announcement = buildSpeechAnnouncement({
        distanceM: drive.nextDistM,
        maneuver: drive.next,
        next2: drive.next2,
        profile,
        twoStage,
        stage,
      })
      spokenKeysRef.current.add(START_KEY)
      spokenKeysRef.current.add(key)
      speak(announcement, urgent(stage))
      return
    }

    if (drive.arrived) {
      speakOnce(ARRIVAL_KEY, arrivalAnnouncement(destinationName), true)
      return
    }

    // 收尾預告：剩餘距離進入抵達範圍就先說一次，導航才不會在終點「啪」地結束。
    if (drive.arriving && (!drive.next || drive.next.kind === 'arrive')) {
      speakOnce(ARRIVING_KEY, arrivingAnnouncement(destinationName))
      return
    }

    if (!drive.next || !stage) return
    const key = `${maneuverSpeechKey(drive.next)}:${stage}`
    if (spokenKeysRef.current.has(key)) return
    spokenKeysRef.current.add(key)
    speak(buildSpeechAnnouncement({
      distanceM: drive.nextDistM,
      maneuver: drive.next,
      next2: drive.next2,
      profile,
      twoStage,
      stage,
    }), urgent(stage))
  }, [drive, profile, twoStage, destinationName, enabled])

  useEffect(() => () => { stopSpeech() }, [])
}
