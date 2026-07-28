// Base Layer 人工修正（組員實地回報，OSM 資料落後現況）。載入時最先套用，
// 在 couplet 合併之前——改名會影響合併 scope（右昌大橋改名後才會併進藍昌路）。
// ⚠ 這些修正掛在 OSM way id / name 上：LanePilot 換新 PBF 快照後要重新驗證。
import { computeDerived, type RoadFeature } from './roads'

/** 路名修正（2026-07-15 組員回報：實地路牌已全面改名） */
const RENAMES: Record<string, string> = {
  右昌大橋: '藍昌路',
  援中港大橋: '楠海路',
  // OSM 同橋異名（同一座橋兩個方向的 way 被標成不同字）：不歸一名字，couplet
  // 合併的 name 分組會把兩個方向當成落單的獨立道路，永遠配不成對（見 elevation.ts）
  楠楊高架橋: '楠陽高架橋',
}

/** 車道數修正（way 級，單行 way 的 lanes = 該向車道數）。
 * 德民路接德民新橋走廊「三切二切三」：橋西德民路成對段與橋東土庫一路成對段
 * 實地為 3 車道，橋本體維持 2（tertiary 預設）。 */
const LANES_FIX: Record<number, number> = {
  75852429: 3, // 德民路 東北向（德民新橋西端）
  75852430: 3, // 德民路 西南向（德民新橋西端）
  126247891: 3, // 土庫一路 西向（德民新橋東端）
  1464614123: 3, // 土庫一路 東向（德民新橋東端）
}

/** 雙向化修正：OSM 把分隔道路拆成成對單行 way，但對向 way 在 shard 界外，
 * couplet 合併配不成對——把留在 shard 內的這條直接改雙向。
 * 翠華路（台17）楠梓段：實地雙向各 2 車道（2026-07-27 使用者確認）。 */
const TWO_WAY_FIX: Record<number, { lanesF: number; lanesB: number }> = {
  267715853: { lanesF: 2, lanesB: 2 }, // 翠華路
}

/** 已確認為 OSM 幾何殘段，不應進入顯示或路由。 */
export const REMOVED_WAY_IDS = new Set([
  287447934,
  287447935,
  799551653, // 德民路 × 惠都街旁的無名平行重複道路
  126247810,
  126247864,
  126247798,
])

/**
 * OSM 將分隔道路兩側各自接成相鄰路口；道路合併後若仍保留兩個中心點，
 * 會形成數公尺長、同時被主路與支路共用的粗短結。這些已人工確認的路口
 * 應正規化為單一十字路口中心。
 */
const COLLAPSED_INTERSECTION_NODES: [number, number][] = [
  [1398634938, 1398634137], // 德民路 × 中昌街
]

/** 已有共用 node，但支路仍停在合併前車道座標的路口；以最寬主路座標為準吸附。 */
const SNAPPED_INTERSECTION_NODES = [
  7477787914, // 德民路 × 惠都街
]

export function collapseKnownIntersections(
  roads: RoadFeature[], nodeRemap: Map<number, number>,
) {
  // 舊版「捏合」會把主路上的交會 node 改成負數，造成側街完全斷線。
  // 若負節點和另一條道路的真實正節點位於完全相同的位置，即可安全判定
  // 它是舊捏合留下的斷點。恢復共用 node，並在主路記錄單向入口限制：
  // forward 可右轉進入側街，backward 不可跨線左轉。
  const coordinateKey = (coord: [number, number]) =>
    `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`
  const positiveNodesAt = new Map<string, Set<number>>()
  for (const road of roads) {
    road.properties.nodes.forEach((node, index) => {
      if (node <= 0) return
      const key = coordinateKey(road.geometry.coordinates[index] as [number, number])
      const nodes = positiveNodesAt.get(key) ?? new Set<number>()
      nodes.add(node)
      positiveNodesAt.set(key, nodes)
    })
  }
  const legacyPairs: [number, number][] = []
  for (const road of roads) {
    const restricted = new Set(road.properties.oneSideEntryNodes ?? [])
    road.properties.nodes.forEach((node, index) => {
      if (node >= 0) return
      const key = coordinateKey(road.geometry.coordinates[index] as [number, number])
      const matches = [...(positiveNodesAt.get(key) ?? [])]
      // 多個不同真實 node 疊在同一座標時無法安全判定，不自動合併。
      if (matches.length !== 1) return
      legacyPairs.push([matches[0], node])
      restricted.add(matches[0])
    })
    road.properties.oneSideEntryNodes = restricted.size ? [...restricted] : undefined
  }

  const pairs = [...COLLAPSED_INTERSECTION_NODES, ...legacyPairs]
    .filter(([keep, drop], index, all) =>
      all.findIndex(([k, d]) => k === keep && d === drop) === index)
  for (const [keep, drop] of pairs) {
    const points: [number, number][] = []
    for (const r of roads) {
      r.properties.nodes.forEach((n, i) => {
        if (n === keep || n === drop) points.push(r.geometry.coordinates[i] as [number, number])
      })
    }
    if (!points.length) continue
    const center: [number, number] = [
      points.reduce((s, p) => s + p[0], 0) / points.length,
      points.reduce((s, p) => s + p[1], 0) / points.length,
    ]
    for (const r of roads) {
      const nodes: number[] = []
      const coords: [number, number][] = []
      r.properties.nodes.forEach((n, i) => {
        const normalized = n === drop ? keep : n
        const coord = normalized === keep ? center : r.geometry.coordinates[i] as [number, number]
        if (nodes[nodes.length - 1] === normalized) return
        nodes.push(normalized)
        coords.push(coord)
      })
      r.properties.nodes = nodes
      r.geometry.coordinates = coords
    }
    nodeRemap.set(drop, keep)
  }
  for (const node of SNAPPED_INTERSECTION_NODES) {
    let anchor: [number, number] | null = null
    let anchorWidth = -Infinity
    for (const r of roads) {
      const i = r.properties.nodes.indexOf(node)
      if (i < 0 || r.properties.width_m <= anchorWidth) continue
      anchor = r.geometry.coordinates[i] as [number, number]
      anchorWidth = r.properties.width_m
    }
    if (!anchor) continue
    for (const r of roads) {
      r.properties.nodes.forEach((n, i) => {
        if (n === node) r.geometry.coordinates[i] = [...anchor!] as [number, number]
      })
    }
  }
}

/** way 起點錯位殘尾：裁到指定 OSM node，保留後續主體。 */
const TRIM_WAY_START_NODE: Record<number, number> = {
  // Remove the tiny continuation across 外環西路; its round cap protrudes past the main road.
  126247903: 2206232306,
  287673498: 2912433399, // 援中路往益群橋下來，移除路口左側約 55m 多餘尾巴
}

/** 載入後、couplet 合併前呼叫（預設底圖與「匯入地圖」同一套） */
export function applyFixups(roads: RoadFeature[]) {
  for (const r of roads) {
    const p = r.properties
    const trimNode = TRIM_WAY_START_NODE[p.osm_id]
    if (trimNode !== undefined) {
      const i = p.nodes.indexOf(trimNode)
      if (i > 0 && i < r.geometry.coordinates.length - 1) {
        p.nodes = p.nodes.slice(i)
        r.geometry.coordinates = r.geometry.coordinates.slice(i)
        p.blockNode = trimNode
      }
    }
    const rename = p.name && RENAMES[p.name]
    if (rename) p.name = rename
    const lanes = LANES_FIX[p.osm_id]
    if (lanes !== undefined) {
      p.lanesForward = lanes
      if (p.oneway === 'no') p.lanesBackward = lanes
      computeDerived(p)
    }
    const twoWay = TWO_WAY_FIX[p.osm_id]
    if (twoWay !== undefined) {
      p.oneway = 'no'
      p.lanesForward = twoWay.lanesF
      p.lanesBackward = twoWay.lanesB
      computeDerived(p)
    }
  }
}
