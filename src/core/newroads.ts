// 自訂新增道路（Enhancement Layer）：使用者在編輯模式拉線畫出 OSM 沒有的路。
//
// journal target type = 'new_road'，key = "way/-N"（負數 way id，永不與 OSM 撞號）。
// fields：
//   geometry = JSON 座標串 [[lng,lat],...]
//   nodes    = JSON node id 串（與座標逐點對齊；吸附到既有路網的頂點沿用原
//              node id、新頂點配負數 id）——RoadGraph 依「node 被引用 ≥2 次」
//              切邊，端點吸附既有 node 即自動連通路網、可導航
//   name / highway / oneway（其餘車道屬性走既有 road 覆寫，鍵空間相同）
//
// 物化 = 轉成與 shard 相同欄位丟回 roadsFromGeoJSON：屬性正規化、車道預設值、
// 斷面計算全部與 Base Layer 共用，畫完即可用車道工具編輯。
import type { Feature, FeatureCollection, LineString } from 'geojson'
import { roadsFromGeoJSON, type RoadFeature } from './roads'
import type { EnhancementRecord } from './enhancements'

export const NEW_ROAD_KEY_RE = /^way\/(-\d+)$/

/** 折疊後 journal → 自訂道路 RoadFeature（nodeRemap：couplet 合併後的 node 遷移） */
export function newRoadsFromFolded(
  folded: Map<string, Record<string, string | number>>,
  nodeRemap?: Map<number, number>,
): RoadFeature[] {
  const features: Feature<LineString>[] = []
  for (const [key, fields] of folded) {
    const m = NEW_ROAD_KEY_RE.exec(key)
    if (!m || fields.geometry === undefined || fields.nodes === undefined) continue
    try {
      const coords = JSON.parse(String(fields.geometry)) as [number, number][]
      const nodes = JSON.parse(String(fields.nodes)) as number[]
      if (!Array.isArray(coords) || !Array.isArray(nodes)) continue
      if (coords.length < 2 || coords.length !== nodes.length) continue
      features.push({
        type: 'Feature',
        properties: {
          osm_id: Number(m[1]),
          name: fields.name ? String(fields.name) : undefined,
          highway: String(fields.highway ?? 'residential'),
          oneway: String(fields.oneway ?? 'no'),
          // 正 id（吸附點）跟著 couplet 合併遷移；負 id（新頂點）不受影響
          nodes: nodes.map((n) => (n >= 0 ? nodeRemap?.get(n) ?? n : n)),
        },
        geometry: { type: 'LineString', coordinates: coords },
      })
    } catch { /* 壞紀錄不擋整體載入 */ }
  }
  if (!features.length) return []
  const out = roadsFromGeoJSON({ type: 'FeatureCollection', features })
  // 自訂路標記：編輯器據此區分「使用者新增」與 couplet 合併的負 id 路段
  for (const r of out) r.properties.userRoad = true
  return out
}

/** 下一個可用的負數 way id / 新頂點 node id 起值。
 * 掃整份 journal（含已刪除紀錄）——id 永不重用，避免刪掉再畫撞到舊區塊覆寫鍵。
 * node id 從 -1_000_001 起跳，與 way id 空間錯開，肉眼可辨。 */
export function nextNewRoadIds(journal: EnhancementRecord[]): { wayId: number; nodeId: number } {
  let minWay = 0
  let minNode = -1_000_000
  for (const rec of journal) {
    if (rec.target.type !== 'new_road') continue
    const m = NEW_ROAD_KEY_RE.exec(rec.target.key)
    if (m) minWay = Math.min(minWay, Number(m[1]))
    try {
      const nodes = JSON.parse(String(rec.fields?.nodes ?? '[]')) as unknown[]
      for (const n of nodes) if (typeof n === 'number' && n < minNode) minNode = n
    } catch { /* ignore */ }
  }
  return { wayId: minWay - 1, nodeId: minNode - 1 }
}
