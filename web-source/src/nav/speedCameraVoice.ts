// 測速提示使用 Android 原生 TTS，共用語音開關。
//
// 去重是這裡的重點：狀態機每 160ms 就會算出一次同樣的提示，若不記住講過什麼，
// 同一句會被重複觸發到蓋掉自己。key 由 core/speedCameras 產生（相機 id + 階段）。
import type { SpeedCameraAnnouncement } from '../core/speedCameras.ts'
import { speak, stopSpeech } from '../native/client.ts'

export class SpeedCameraVoice {
  private spoken = new Set<string>()

  /** 語音開關由 native/client 的 speak() 統一把關，關掉時只停播報，畫面提示照舊 */
  say(announcement: SpeedCameraAnnouncement | null) {
    if (!announcement || this.spoken.has(announcement.key)) return
    this.spoken.add(announcement.key)
    speak(announcement.text)
  }

  /** 換路線（偏航重規劃）：只清講過的紀錄，同一台相機才會重新提醒；不切斷正在播的轉向指示 */
  forget() {
    this.spoken.clear()
  }

  /** 結束導航：清紀錄並停止播報 */
  reset() {
    this.forget()
    stopSpeech()
  }
}
