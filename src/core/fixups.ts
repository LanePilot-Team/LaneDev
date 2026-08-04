// Base Layer 人工修正（組員實地回報，OSM 資料落後現況）。載入時最先套用，
// 在 couplet 合併之前——改名會影響合併 scope（右昌大橋改名後才會併進藍昌路）。
// ⚠ 這些修正掛在 OSM way id / name 上：LanePilot 換新 PBF 快照後要重新驗證。
import { COS_LAT, cumulative } from './geo'
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

/**
 * 平行獨立高架貼齊主橋：高楠陸橋的機車專用道（way/25724904）在 OSM 是與主橋
 * 完全獨立的一條 way，中線離主橋 13.4m。elevated3d 依中心線各鋪各的橋面織帶，
 * 於是畫面上是「兩座分開的橋」；實地（2026-03 街景）兩者緊鄰，中間只隔一道矮
 * 混凝土墩。這裡把機車高架整條橫移到主橋旁，縫留給兩側護欄當分隔墩。
 *
 * ⚠ offsetM 是「到主橋中線」的絕對距離，不從 width_m 推算。主橋的車道數來自
 * journal（3+3，width_m 19.8m），而 journal 在 prepareBaseRoads **之後**才套用；
 * 管線中途讀到的是 couplet 合併給的 2+2（13.4m），據此推算會讓機車橋面壓進主橋。
 * 對應關係由 scripts/side_lane_hug_audit.ts 用「套完 journal 的最終寬度」驗證，
 * 車道數日後若改動，稽核會直接紅掉。
 *
 * 11.5m = 主橋半寬 9.9（19.8/2）＋ 機車道半寬 1.6（width_m 3.2/2），兩橋面**齊平**。
 * 刻意不留縫：elevated3d 依中心線各鋪各的織帶，留 0.6m 就會在中間開一道看得穿的
 * 天窗（同 elevated3d.ts:466 對中山高的描述）。齊平後兩座橋各自的側護欄（RAIL_H
 * 0.9m）背靠背，就是實地那道矮混凝土分隔墩。
 *
 * 為什麼不走 couplet.absorbSideWays 的斷面吸收（motoF＋motoSep）：那是平面主慢
 * 分離的模型，斷面吸收後機車道不再是獨立 way，也就沒有自己的橋面織帶——高架這
 * 裡需要它保持獨立幾何，只是靠過去。
 */
const SIDE_LANE_HUG: { wayId: number; hostWayId: number; offsetM: number }[] = [
  // 高楠陸橋：機車專用道高架 way/25724904 貼上合併後的主橋 way/23939182
  { wayId: 25724904, hostWayId: 23939182, offsetM: 11.5 },
]

const KX = 111320 * COS_LAT
const KY = 110540

/**
 * 點對折線的投影：回傳投影點、點落在折線哪一側（+1/-1），以及該段的單位法向量
 * （公尺座標系）。法向量取最近段的方向而非整條首尾連線，折線彎曲時才不會歪掉。
 */
function projectSigned(p: [number, number], cs: [number, number][], cum: number[]) {
  let best = {
    d: Infinity, pos: cs[0] as [number, number], side: 1, nx: 0, ny: 0, s: 0,
  }
  for (let i = 0; i < cs.length - 1; i++) {
    const dx = (cs[i + 1][0] - cs[i][0]) * KX
    const dy = (cs[i + 1][1] - cs[i][1]) * KY
    const px = (p[0] - cs[i][0]) * KX
    const py = (p[1] - cs[i][1]) * KY
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0
    const ex = px - t * dx
    const ey = py - t * dy
    const d = Math.hypot(ex, ey)
    if (d >= best.d) continue
    const len = Math.hypot(dx, dy) || 1
    best = {
      d,
      pos: [cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t],
      // 外積正負 = 點在行進方向的左（+）或右（-）側
      side: dx * py - dy * px >= 0 ? 1 : -1,
      nx: -dy / len,
      ny: dx / len,
      s: cum[i] + len * t, // 投影點在主體上的沿線位置
    }
  }
  return best
}

/** 主體沿線 s 公尺處，往 side 側偏移 offset 公尺的點 */
function offsetPointAt(
  cs: [number, number][], cum: number[], s: number, side: number, offset: number,
): [number, number] {
  let i = 0
  while (i < cs.length - 2 && cum[i + 1] < s) i++
  const segLen = cum[i + 1] - cum[i] || 1
  const t = Math.max(0, Math.min(1, (s - cum[i]) / segLen))
  const dx = (cs[i + 1][0] - cs[i][0]) * KX
  const dy = (cs[i + 1][1] - cs[i][1]) * KY
  const len = Math.hypot(dx, dy) || 1
  const base: [number, number] = [
    cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t,
    cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t,
  ]
  return [
    base[0] + ((-dy / len) * side * offset) / KX,
    base[1] + ((dx / len) * side * offset) / KY,
  ]
}

/**
 * SIDE_LANE_HUG：把平行的獨立側車道／側高架整條橫移貼齊主體，共用節點連帶移動。
 * 冪等——位置每次都由主體中線重新投影算出，不是相對位移，重複呼叫結果相同。
 * 必須在 couplet 合併**之後**呼叫：主橋合併後中線才會落在兩向的中間。
 */
export function hugSideLanes(roads: RoadFeature[]) {
  for (const { wayId, hostWayId, offsetM } of SIDE_LANE_HUG) {
    const side = roads.find((r) => r.properties.osm_id === wayId)
    const host = roads.find((r) => r.properties.osm_id === hostWayId)
    if (!side || !host || host.geometry.coordinates.length < 2) continue
    const hostCs = host.geometry.coordinates as [number, number][]
    const hostCum = cumulative(hostCs)
    const target = offsetM
    const moved = new Map<number, [number, number]>()
    const cs = side.geometry.coordinates as [number, number][]

    // 每個原頂點投影到主體，再沿法向推 target 公尺。
    //
    // ⚠ 不要為了讓線形更貼合而「補點加密」：補出來的頂點需要節點 id，而
    // collapseKnownIntersections 把**所有負數節點**視為舊捏合留下的斷點
    // （`if (node >= 0) return`），會拿它們去跟同座標的正節點配對重映射。
    // 2026-08-04 實測補點後 severed-routes 從 0 變 23 個孤島、one-side-entry
    // 32 個側街被切斷。要更貼合只能改渲染端，不能在這裡加節點。
    const anchors = cs.map((c) => projectSigned(c, hostCs, hostCum))
    const sgn = anchors[0].side
    side.geometry.coordinates = anchors.map((a, i) => {
      const out = offsetPointAt(hostCs, hostCum, a.s, sgn, target)
      const node = side.properties.nodes[i]
      if (node !== undefined) moved.set(node, out)
      return out
    })
    // 兩端共用節點：持有同一 node 的其他 way（橋頭引道）跟著收到新位置，
    // 否則橋頭會裂開一條數公尺的縫。
    if (!moved.size) continue
    for (const r of roads) {
      if (r === side) continue
      r.properties.nodes.forEach((n, i) => {
        const pos = moved.get(n)
        if (pos) r.geometry.coordinates[i] = [...pos] as [number, number]
      })
    }
  }
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

/**
 * 釘回原始 OSM 座標的路口節點：[lng, lat]。
 *
 * couplet 合併會把共用節點搬到兩條單行道的中線上。多數路口無妨，但主線在路口
 * 附近轉向時，被搬走的起點會在那裡扯出一個折角——路口整體也離開了實際位置。
 * 這裡把節點釘回 OSM 原值；共用它的道路一起回去，所以彼此不會產生新的錯位。
 *
 * 德民路 × 海專路：合併把節點往南拉了 10.77m，德民路第一段從 14.8m@58° 變成
 * 24.7m@24°（轉折 34°，其餘 10 個節點都在 5° 以內）。四條路（德民路 256044039／
 * 286066491、海專路 286066494／286066495）共用此節點，一起釘回即可。
 */
const PINNED_ORIGINAL_NODES: Record<number, [number, number]> = {
  265748817: [120.3105336, 22.7266391], // 德民路 × 海專路
}

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
  // 釘回原始 OSM 座標：所有持有該節點的道路一起移動，不會製造新的錯位。
  for (const [id, pos] of Object.entries(PINNED_ORIGINAL_NODES)) {
    const node = Number(id)
    for (const r of roads) {
      r.properties.nodes.forEach((n, i) => {
        if (n === node) r.geometry.coordinates[i] = [...pos] as [number, number]
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
