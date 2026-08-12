// 測速提示的語音播報。用瀏覽器內建的 Web Speech API（zh-TW），不帶任何音檔——
// 這個專案沒有音訊資產管線，而且動態內容（距離、速限、超速多少）本來就得合成。
//
// 去重是這裡的重點：狀態機每 160ms 就會算出一次同樣的提示，若不記住講過什麼，
// 同一句會被重複觸發到蓋掉自己。key 由 core/speedCameras 產生（相機 id + 階段）。
import type { SpeedCameraAnnouncement } from '../core/speedCameras'

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null
}

export class SpeedCameraVoice {
  private spoken = new Set<string>()
  /** 使用者關掉語音時只停播報，畫面提示照舊 */
  enabled = true

  say(announcement: SpeedCameraAnnouncement | null) {
    if (!announcement || this.spoken.has(announcement.key)) return
    this.spoken.add(announcement.key)
    if (!this.enabled) return
    const s = synth()
    if (!s) return
    const u = new SpeechSynthesisUtterance(announcement.text)
    u.lang = 'zh-TW'
    u.rate = 1.05 // 開車中的提示要快一點講完，但別到聽不清楚
    // 導航指引沒有語音，所以這裡不必排隊；有殘留的就直接蓋掉（舊的距離已經過期）
    s.cancel()
    s.speak(u)
  }

  /** 換路線／重新開始導航：講過的紀錄要清掉，同一台相機才會重新提醒 */
  reset() {
    this.spoken.clear()
    synth()?.cancel()
  }
}
