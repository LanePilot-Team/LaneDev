// 手機驗證用的定位紀錄：手機接電腦，Chrome 開 chrome://inspect 連上 App 的 WebView，
// Console 篩選「[gps]」。每筆定位印出與上一筆的間隔，重規劃前後若中斷會直接看到間隔拉長。

let lastArrival = 0

const clock = (ms: number) =>
  `${new Date(ms).toTimeString().slice(0, 8)}.${String(ms % 1000).padStart(3, '0')}`

export function gpsLog(event: string, detail = '') {
  console.log(`[gps] ${clock(Date.now())} ${event}${detail ? '  ' + detail : ''}`)
}

/** 距上一筆定位「送達」的間隔（跨 GpsDriver 共用，重開監聽造成的空窗也算得到） */
export function gpsFixGap(): string {
  const now = Date.now()
  const gap = lastArrival ? `${((now - lastArrival) / 1000).toFixed(1)}s` : '首筆'
  lastArrival = now
  return gap
}
