// 捏合接點的導航接回（純函式，只依賴 roads 型別，可單獨測試）。
//
// 舊捏合把主線上的交會 node 換成大負數，側街仍握著原本的正節點 → 兩者不再共用
// 節點，導航圖在那裡完全斷開。實測後果不是「連不上」而是「要繞一大圈」：
// 德中路 × 大學六十街直線 141m，實際要走 652m。
//
// collapseKnownIntersections 本來要救這件事，但它用「座標完全相同」比對，而
// couplet 合併已經把主線幾何移到兩條單行道的中線上，側街端點因此差了 6～12m，
// 永遠 match 不到。
//
// 這裡改用鄰近比對，而且**只作用在導航圖上**：回傳一份節點別名表，讓 RoadGraph
// 把「主線的負節點」與「側街的端點」視為同一個路口。靜態 node_refs 一個字都不動，
// 所以捏合的視覺連續、區塊鍵、既有覆寫全部不受影響。
import type { RoadFeature } from './roads'

// 刻意不 import ./geo：那是 value import，node --test 的 strip-only 型別剝除無法
// 解析無副檔名的相對路徑，整個模組就測不到。這裡只需要一個平面近似距離。
const distanceM = (a: [number, number], b: [number, number]) => {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(lat), (a[1] - b[1]) * 110540)
}

/** 只認捏合產生的大負數；建置腳本補的合成 id 是 -1、-2… 這種小負數 */
const MERGE_ARTIFACT = -1_000_000
/** 側街端點與主線接點的容許距離（公尺）。couplet 中線位移實測 6～12m。 */
const SNAP_M = 15
/** 空間分格邊長（度）；~20m，足以涵蓋 SNAP_M 且不必兩兩比對 */
const CELL = 0.0002

const cellKey = (c: [number, number]) =>
  `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`
const neighbourKeys = (c: [number, number]) => {
  const x = Math.floor(c[0] / CELL)
  const y = Math.floor(c[1] / CELL)
  const out: string[] = []
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(`${x + dx},${y + dy}`)
  return out
}

export interface JunctionAlias {
  /** 主線負節點 → 側街真實節點（導航圖用這個 id 當同一個路口） */
  alias: Map<number, number>
  /** 接回的接點數，供稽核輸出 */
  reconnected: number
}

/**
 * 找出「主線捏合負節點 ↔ 附近某條路的端點」配對，回傳導航用的節點別名表，
 * 並在主線上登記 oneSideEntryNodes（接回來的路口一律是單向進入的 T 字路口：
 * 主線正向可進出側街，反向只能直行，要互動得先到路口迴轉）。
 *
 * 安全條件（任一不滿足就不接）：
 *   - 必須是捏合產生的大負數節點，且位於主線內部（端點不算，那是路的盡頭）
 *   - 候選必須是「別條 way 的端點」——側街是在這裡到底的，才構成 T 字路口
 *   - SNAP_M 內的候選 way 只能有一條，多條並存時無法安全判定，寧可不接
 */
export function buildJunctionAliases(roads: RoadFeature[]): JunctionAlias {
  // 端點索引：座標分格 → 該格內所有 way 端點
  const endpoints = new Map<string, { node: number; pos: [number, number]; road: RoadFeature }[]>()
  for (const road of roads) {
    const ns = road.properties.nodes
    const cs = road.geometry.coordinates as [number, number][]
    if (ns.length !== cs.length || ns.length < 2) continue
    for (const i of [0, ns.length - 1]) {
      if (ns[i] < 0) continue // 端點本身是合成節點的不當作真實路口
      const key = cellKey(cs[i])
      const list = endpoints.get(key) ?? []
      list.push({ node: ns[i], pos: cs[i], road })
      endpoints.set(key, list)
    }
  }

  const alias = new Map<number, number>()
  let reconnected = 0
  for (const road of roads) {
    const ns = road.properties.nodes
    const cs = road.geometry.coordinates as [number, number][]
    if (ns.length !== cs.length) continue
    const restricted = new Set(road.properties.oneSideEntryNodes ?? [])
    // 只掃內部節點：首尾是這條路自己的盡頭，接回去是接續不是路口
    for (let i = 1; i < ns.length - 1; i++) {
      const node = ns[i]
      if (node > MERGE_ARTIFACT) continue
      const pos = cs[i]
      const cands: { node: number; d: number; road: RoadFeature }[] = []
      for (const key of neighbourKeys(pos)) {
        for (const e of endpoints.get(key) ?? []) {
          if (e.road === road) continue
          if (e.road.properties.osm_id === road.properties.osm_id) continue
          const d = distanceM(pos, e.pos)
          if (d < SNAP_M) cands.push({ node: e.node, d, road: e.road })
        }
      }
      if (!cands.length) continue
      // 多條不同的路同時在範圍內 → 無法安全判定是哪一條該接回來
      const ways = new Set(cands.map((c) => c.road.properties.osm_id))
      if (ways.size !== 1) continue
      cands.sort((a, b) => a.d - b.d)
      const canonical = cands[0].node
      alias.set(node, canonical)
      reconnected++
      // 同名續行不是側街：那是同一條路被切成兩個 way，兩個方向本來就該直行通過。
      // 對它套 T 字路口限制會把反向擋在自己的路上，反而繞得比不接更遠。
      const selfName = (road.properties.name ?? '').trim()
      const candName = (cands[0].road.properties.name ?? '').trim()
      if (selfName && selfName === candName) continue
      restricted.add(canonical)
    }
    road.properties.oneSideEntryNodes = restricted.size ? [...restricted] : undefined
  }
  return { alias, reconnected }
}
