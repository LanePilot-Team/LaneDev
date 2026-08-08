// 捏合接點的單向進入規則（純函式，只有型別相依，可單獨測試）。
import type { RoadFeature } from './roads'

const roadBlockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

/**
 * 「這兩段是同一條主路的續行」——同 way id 是最常見的情形，但跨 way 的捏合
 * 與中央島貫通接點都會讓續行段的 way id 不同。這時要看登記的續行對照，
 * 否則主路反向會被自己那一側的 T 字限制擋住（實測：外環西路北向整段不通）。
 */
export function medianContinuationAt(
  a: RoadFeature, b: RoadFeature, nodeId: number,
): boolean {
  if (a.properties.osm_id === b.properties.osm_id) return true
  const peers = (road: RoadFeature, other: RoadFeature) =>
    road.properties.medianContinuityPeers?.some((peer) =>
      peer.nodeId === nodeId && peer.peerKey === roadBlockKey(other)) ?? false
  return peers(a, b) || peers(b, a)
}

/** 該節點的中央島是否連續（捏合接縫或現地指定的貫通接點）——主路不得在此迴轉。 */
export function medianBarrierAt(road: RoadFeature, nodeId: number): boolean {
  return (road.properties.roadMergeBarrierNodes?.includes(nodeId) ?? false)
    || (road.properties.centerIslandJoinNodes?.includes(nodeId) ?? false)
}

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
  const accessAt = (road: RoadFeature, counterpart: RoadFeature) => {
    const entries = road.properties.oneSideEntryAccess
      ?.filter((entry) => entry.nodeId === nodeId) ?? []
    const explicit = entries.find((entry) => entry.sideRoadKey === roadBlockKey(counterpart))
      ?? entries.find((entry) => !entry.sideRoadKey)
    if (explicit) return explicit
    return road.properties.oneSideEntryNodes?.includes(nodeId)
      ? { nodeId, allowedBack: false } : undefined
  }
  const incomingAccess = accessAt(incomingRoad, outgoingRoad)
  const outgoingAccess = accessAt(outgoingRoad, incomingRoad)
  // 同一條主路同方向續行不受限制；在接縫切換方向就是跨中央島迴轉。
  if (medianContinuationAt(incomingRoad, outgoingRoad, nodeId)) {
    if (!incomingAccess && !outgoingAccess) return true
    // 兩個來源路段的 digitize 方向可能相反。各自都有方向資訊時，應比較
    // 「是否位於分隔島相鄰側」，而不是直接比較 back 布林值。
    if (incomingAccess && outgoingAccess) {
      return (incomingBack === incomingAccess.allowedBack)
        === (outgoingBack === outgoingAccess.allowedBack)
    }
    return incomingBack === outgoingBack
  }
  if (incomingAccess && incomingBack !== incomingAccess.allowedBack) return false
  if (outgoingAccess && outgoingBack !== outgoingAccess.allowedBack) return false
  return true
}
