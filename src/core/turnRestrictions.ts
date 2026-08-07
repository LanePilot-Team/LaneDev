import type { Profile } from './graph.ts'
import type { RoadFeature } from './roads.ts'

interface DirectedRoadRef {
  osmId: number
  blockNode: number
  back: boolean
}

interface ProfileTurnRestriction {
  profile: Profile
  viaNode: number
  from: DirectedRoadRef
  to: DirectedRoadRef
}

/**
 * 現地確認的車種別轉向限制。只封鎖指定「進入邊 → 接點 → 離開邊」，不會把整段
 * 道路設成禁行，也不影響另一車種。未來若編輯器支援 turn_restriction journal，
 * 可將這份清單遷移為同一資料模型。
 */
export const PROFILE_TURN_RESTRICTIONS: ProfileTurnRestriction[] = [
  {
    profile: 'moto',
    viaNode: 1400036034,
    from: { osmId: 1464614119, blockNode: 1400036034, back: true },
    to: { osmId: 1464614121, blockNode: 1400036034, back: false },
  },
  {
    // 此處只是一般楠梓路折返點，不是現地指定的機車迴轉道；若不封鎖，A* 會因
    // 距離較短而在同一區塊原地折返，跳過 230071783→230071784→230071785。
    profile: 'moto',
    viaNode: 2264502074,
    from: { osmId: 268219239, blockNode: 2264502074, back: true },
    to: { osmId: 268219239, blockNode: 2264502074, back: false },
  },
]

const matches = (ref: DirectedRoadRef, road: RoadFeature, back: boolean) =>
  ref.osmId === road.properties.osm_id
  && ref.blockNode === road.properties.blockNode
  && ref.back === back

export function profileTurnAllowed(
  profile: Profile,
  nodeId: number,
  incomingRoad: RoadFeature,
  incomingBack: boolean,
  outgoingRoad: RoadFeature,
  outgoingBack: boolean,
): boolean {
  return !PROFILE_TURN_RESTRICTIONS.some((restriction) =>
    restriction.profile === profile
    && restriction.viaNode === nodeId
    && matches(restriction.from, incomingRoad, incomingBack)
    && matches(restriction.to, outgoingRoad, outgoingBack))
}
