// 捏合接點的單向進入規則（純函式，只有型別相依，可單獨測試）。
import type { RoadFeature } from './roads'

/**
 * 捏合道路的中間接點仍保留拓撲，但退化成 T 字路口：只有主路「正向」那一側能與
 * 側街互動，反向那一側進出都不行。
 *
 *   主路正向 → 側街    ✅ 右轉進入
 *   側街     → 主路正向 ✅ 駛出
 *   主路反向 → 側街    ❌ 不可跨線左轉
 *   側街     → 主路反向 ❌ 不可逆向切入，要先走正向再迴轉
 *   主路反向 → 主路     ✅ 沿主路直行不受影響
 *
 * 進出兩個方向都要擋——只擋進入的話，車輛仍可從側街逆向切進對向車道，
 * 等於從另一邊繞過同一個限制。
 */
export function oneSideEntryTransitionAllowed(
  incomingRoad: RoadFeature | undefined,
  incomingBack: boolean,
  outgoingRoad: RoadFeature,
  outgoingBack: boolean,
  nodeId: number,
): boolean {
  if (!incomingRoad) return true
  // 同一條 way 續行（含反向直行、迴轉）不受限制
  if (outgoingRoad.properties.osm_id === incomingRoad.properties.osm_id) return true
  const restricted = (road: RoadFeature) =>
    road.properties.oneSideEntryNodes?.includes(nodeId) ?? false
  if (incomingBack && restricted(incomingRoad)) return false // 反向 → 側街
  if (outgoingBack && restricted(outgoingRoad)) return false // 側街 → 反向
  return true
}
