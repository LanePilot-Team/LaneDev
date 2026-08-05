import type { RouteFailureReason } from '../core/graph.ts'

export function routeFailureText(
  reason: RouteFailureReason | undefined,
  legNumber: number,
): string {
  if (reason === 'lane-direction') {
    return `第 ${legNumber} 段找不到符合車道方向限制的路線`
  }
  return `第 ${legNumber} 段規劃失敗，請調整位置`
}
