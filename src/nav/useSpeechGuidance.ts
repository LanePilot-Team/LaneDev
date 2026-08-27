import { useEffect, useRef } from 'react'
import type { Profile } from '../core/graph'
import type { DriveState } from './drive'
import {
  buildSpeechAnnouncement,
  maneuverSpeechKey,
  speechStage,
  type SpeechStage,
} from './speechGuidance'

export interface UseSpeechGuidanceArgs {
  drive: DriveState | null
  profile: Profile
  twoStage: boolean
}

const START_KEY = 'start'
const ARRIVAL_KEY = 'arrival'

export function useSpeechGuidance({ drive, profile, twoStage }: UseSpeechGuidanceArgs): void {
  const spokenKeysRef = useRef(new Set<string>())
  const sessionStartedRef = useRef(false)
  const previousProgressRef = useRef<number | null>(null)

  function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    if (typeof SpeechSynthesisUtterance === 'undefined') return

    try {
      const synth = window.speechSynthesis
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-TW'
      utterance.rate = 0.95
      utterance.volume = 1
      const voices = synth.getVoices()
      const voice = voices.find((candidate) => candidate.lang.toLowerCase() === 'zh-tw')
        ?? voices.find((candidate) => candidate.lang.toLowerCase().startsWith('zh'))
      if (voice) utterance.voice = voice
      synth.cancel()
      synth.speak(utterance)
    } catch {
      // 語音權限、瀏覽器 autoplay 或裝置語音服務失敗時，不阻斷導航。
    }
  }

  useEffect(() => {
    function clearSession(): void {
      spokenKeysRef.current.clear()
      sessionStartedRef.current = false
      previousProgressRef.current = null
    }

    function resetIfProgressMovedBackwards(progressM: number): void {
      const previous = previousProgressRef.current
      if (previous !== null && progressM + 5 < previous) {
        spokenKeysRef.current.clear()
        sessionStartedRef.current = false
      }
      previousProgressRef.current = progressM
    }

    function speakOnce(key: string, text: string): void {
      if (spokenKeysRef.current.has(key)) return
      spokenKeysRef.current.add(key)
      speak(text)
    }

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
        speak('開始導航。已抵達目的地')
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
      speak(`開始導航。${announcement}`)
      return
    }

    if (drive.arrived) {
      speakOnce(ARRIVAL_KEY, '已抵達目的地')
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
    }))
  }, [drive, profile, twoStage])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel()
        } catch {
          // Cleanup must never make navigation unmount fail.
        }
      }
    }
  }, [])
}
