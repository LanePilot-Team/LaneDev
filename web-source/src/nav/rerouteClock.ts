// 偏航重規劃的冷卻計時。路線搜尋在主執行緒同步跑（手機上數秒），冷卻要依實際耗時拉長，
// 連續重規劃都沒回到路線上時再加倍，避免畫面大半時間卡在算路線。

/**
 * 兩次 reroute 的最短間隔（毫秒），避免反覆重畫。時間戳記放在呼叫端傳進來的 RerouteClock，
 * 重新規劃後仍沿用。
 */
const REROUTE_COOLDOWN_MS = 5000
/** 冷卻至少是上次路線計算耗時的這麼多倍：計算期間主執行緒整個停住，不能讓它佔滿時間 */
const REROUTE_COST_FACTOR = 4
/** 連續重規劃都沒回到路線上時的冷卻上限（每次加倍） */
const REROUTE_MAX_COOLDOWN_MS = 30000

/**
 * reroute 計時（Date.now 毫秒）。cooldownMs 依上次計算耗時調整；streak = 連續重規劃
 * 但都還沒回到路線上的次數，回到路線上歸零。
 */
export interface RerouteClock { lastTs: number; cooldownMs?: number; streak?: number }

/** 重規劃算完（成功或失敗）時呼叫：從「算完」起算冷卻，耗時越久、連續越多次就隔越久 */
export function noteRerouteFinished(clock: RerouteClock, elapsedMs: number, nowMs: number) {
  const streak = (clock.streak ?? 0) + 1
  clock.streak = streak
  clock.lastTs = nowMs
  clock.cooldownMs = Math.min(REROUTE_MAX_COOLDOWN_MS,
    Math.max(REROUTE_COOLDOWN_MS, elapsedMs * REROUTE_COST_FACTOR) * 2 ** Math.min(streak - 1, 3))
}

export function rerouteReady(clock: RerouteClock, nowMs: number): boolean {
  return nowMs - clock.lastTs > (clock.cooldownMs ?? REROUTE_COOLDOWN_MS)
}
