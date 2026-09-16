/**
 * 中央島跨路口貫通接點（現地指定）。
 *
 * 有些路口的中央島實體上是連續的：主路兩段之間沒有開口，側街只能與相鄰的
 * 那一側車道互動，主路也不能在此迴轉。捏合（road_merge）本來就帶這套語意，
 * 但捏合要求兩段斷面一致——快慢分隔寬、車道數或路寬不同的兩段（例如外環西路
 * 在 way/268219234 與 way/1454602407 交界處）根本併不起來，機車道樣式也會被
 * 一起改掉。
 *
 * 這個模組只補上「島面連續」這一件事，兩段道路本身完全不動：
 *   - 視覺：medians.buildCenterIslands 讓兩段的島都畫到接點（見 islandSetbacks）
 *   - 導航：接點登記成中央島屏障（不得迴轉）＋ 側街單向進入，規則與捏合接縫
 *     共用 graph.transitionAllowed / oneSideEntryTransitionAllowed
 *
 * 側街可通行的主路方向由幾何推導（與 roadMerge.resolveSideAccess 同一套右轉
 * 判準），不寫死正反向——兩段的 digitize 方向本來就可能相反。
 */
import { angleDelta, bearing } from './geo.ts'
import type { OneSideEntryAccess, RoadFeature } from './roads.ts'

export interface CenterIslandJoinSpec {
  /** 接點 OSM node id */
  nodeId: number
  /** 現地說明（僅供訊息與稽核） */
  label: string
}

/** 現地指定清單：只有列出來的接點會被貫通，其他路口一律照原規則留開口。 */
export const CENTER_ISLAND_JOINS: CenterIslandJoinSpec[] = [
  {
    nodeId: 7244167956,
    label: '外環西路 × 外環西路側車道（way/268219234 ↔ way/1454602407）',
  },
]

const roadBlockKey = (road: RoadFeature) =>
  `way/${road.properties.osm_id}@b/${road.properties.blockNode}`

/** 側街轉進主路必須是右轉（右駕）；與 roadMerge 的判準一致。 */
const isRightTurn = (from: number, to: number) => {
  const delta = angleDelta(from, to)
  return delta >= 20 && delta <= 160
}

interface Arm {
  road: RoadFeature
  /** 由接點往外（沿該段離開路口）的方位角 */
  outward: number
  /** 由接點出發時是否為逆向使用——接點是該段最後一個 node 就是逆向 */
  departBack: boolean
}

/** 以接點為端點的路段；接點落在路段中間的不算（那是穿越，不是接合）。 */
function armsAt(roads: RoadFeature[], nodeId: number): Arm[] {
  const out: Arm[] = []
  for (const road of roads) {
    const nodes = road.properties.nodes
    const coords = road.geometry.coordinates as [number, number][]
    if (nodes.length !== coords.length || coords.length < 2) continue
    const index = nodes.indexOf(nodeId)
    if (index !== 0 && index !== nodes.length - 1) continue
    out.push({
      road,
      outward: index === 0 ? bearing(coords[0], coords[1])
        : bearing(coords[index], coords[index - 1]),
      departBack: index !== 0,
    })
  }
  return out
}

/** 主路兩臂：中央島貫通的前提是兩段都有實體中央島，且幾乎共線。 */
function mainArmPair(arms: Arm[]): [Arm, Arm] | null {
  const islandArms = arms.filter((arm) =>
    (arm.road.properties.centerM || 0) > 0 && arm.road.properties.centerKind === 'island')
  let best: { pair: [Arm, Arm]; straightness: number } | null = null
  for (let i = 0; i < islandArms.length; i++) {
    for (let j = i + 1; j < islandArms.length; j++) {
      const straightness = Math.abs(angleDelta(islandArms[i].outward, islandArms[j].outward))
      if (straightness < 150) continue
      if (!best || straightness > best.straightness) {
        best = { pair: [islandArms[i], islandArms[j]], straightness }
      }
    }
  }
  return best?.pair ?? null
}

/**
 * 側街貼著主路哪一個行向：
 *   - 由接點出發的那一向若可由側街右轉進入 → 相鄰的是「出」的方向
 *   - 進入接點的那一向若可右轉進側街       → 相鄰的是「進」的方向
 * 兩者同時成立或同時不成立就是判不出來（例如側街正對主路），跳過不設限制。
 */
function adjacentBackFor(arm: Arm, side: Arm): boolean | null {
  const sideOut = side.outward
  const sideIn = (side.outward + 180) % 360
  const inward = (arm.outward + 180) % 360
  const departing = isRightTurn(sideIn, arm.outward)
  const arriving = isRightTurn(inward, sideOut)
  if (departing === arriving) return null
  return departing ? arm.departBack : !arm.departBack
}

const addNode = (list: number[] | undefined, nodeId: number) => {
  const next = new Set(list ?? [])
  next.add(nodeId)
  return [...next]
}

const addPeer = (
  list: { nodeId: number; peerKey: string }[] | undefined,
  nodeId: number, peerKey: string,
) => {
  const next = list ?? []
  return next.some((peer) => peer.nodeId === nodeId && peer.peerKey === peerKey)
    ? next : [...next, { nodeId, peerKey }]
}

const addAccess = (
  list: OneSideEntryAccess[] | undefined, entry: OneSideEntryAccess,
) => {
  const next = (list ?? []).filter((existing) =>
    !(existing.nodeId === entry.nodeId && existing.sideRoadKey === entry.sideRoadKey))
  return [...next, entry]
}

export interface CenterIslandJoinResult {
  spec: CenterIslandJoinSpec
  applied: boolean
  detail: string
}

/**
 * 就地套用中央島貫通接點。roads 必須是某一份視圖（routing 或 render）的路段陣列；
 * 兩份視圖都要各套一次——導航吃 routing、島面吃 render。
 */
export function applyCenterIslandJoins(
  roads: RoadFeature[],
  specs: CenterIslandJoinSpec[] = CENTER_ISLAND_JOINS,
): CenterIslandJoinResult[] {
  return specs.map((spec) => {
    const arms = armsAt(roads, spec.nodeId)
    const pair = mainArmPair(arms)
    if (!pair) {
      return { spec, applied: false,
        detail: `接點 ${spec.nodeId} 找不到兩段共線的實體中央島路段（端點路段 ${arms.length} 段）` }
    }
    const [a, b] = pair
    // 續行對照：兩段 way id 不同時，單向進入規則要靠這份才不會把主路反向當側街
    a.road.properties.medianContinuityPeers = addPeer(
      a.road.properties.medianContinuityPeers, spec.nodeId, roadBlockKey(b.road))
    b.road.properties.medianContinuityPeers = addPeer(
      b.road.properties.medianContinuityPeers, spec.nodeId, roadBlockKey(a.road))
    for (const arm of pair) {
      arm.road.properties.centerIslandJoinNodes = addNode(
        arm.road.properties.centerIslandJoinNodes, spec.nodeId)
    }
    const sides = arms.filter((arm) => arm !== a && arm !== b)
    const notes: string[] = []
    for (const side of sides) {
      for (const arm of pair) {
        const allowedBack = adjacentBackFor(arm, side)
        if (allowedBack === null) {
          notes.push(`${roadBlockKey(side.road)} 與 ${roadBlockKey(arm.road)} 判不出相鄰行向`)
          continue
        }
        arm.road.properties.oneSideEntryAccess = addAccess(
          arm.road.properties.oneSideEntryAccess,
          { nodeId: spec.nodeId, allowedBack, sideRoadKey: roadBlockKey(side.road) },
        )
      }
    }
    return {
      spec,
      applied: true,
      detail: `${roadBlockKey(a.road)} ↔ ${roadBlockKey(b.road)}`
        + `，側街 ${sides.length} 條${notes.length ? `（${notes.join('；')}）` : ''}`,
    }
  })
}
