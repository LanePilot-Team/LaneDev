// 測速提示使用 Android 原生 TTS，共用語音開關。
//
// 去重是這裡的重點：狀態機每 160ms 就會算出一次同樣的提示，若不記住講過什麼，
// 同一句會被重複觸發到蓋掉自己。key 由 core/speedCameras 產生（相機 id + 階段）。
import type { SpeedCameraAnnouncement } from '../core/speedCameras'
import { speak, stopSpeech } from '../native/client'

export class SpeedCameraVoice {
  private spoken = new Set<string>()
  /** 使用者關掉語音時只停播報，畫面提示照舊 */
  enabled = true

  say(announcement: SpeedCameraAnnouncement | null) {
    if (!announcement || this.spoken.has(announcement.key)) return
    this.spoken.add(announcement.key)
    if (!this.enabled) return
    speak(announcement.text)
  }

  /** 換路線／重新開始導航：講過的紀錄要清掉，同一台相機才會重新提醒 */
  reset() {
    this.spoken.clear()
    stopSpeech()
  }
}
