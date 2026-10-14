import type { RouteFailureReason } from '../core/graph.ts'

export function routeFailureText(
  reason: RouteFailureReason | undefined,
  legNumber: number,
): string {
  if (reason === 'lane-direction') {
    return `第 ${legNumber} 段找不到符合車道方向限制的路線`
  }
  if (reason === 'no-projection') {
    return `第 ${legNumber} 段的座標不在可導航道路上，請重新選取`
  }
  return `第 ${legNumber} 段在目前路網中不連通，請調整停靠點`
}
