// 跨 shard 分段的 node_refs 補齊與去重（純函式，可單獨測試）。
//
// 為什麼要有這支：LanePilot 依行政區匯出 shard，跨區界的 way 兩份 extract 都會收，
// 而 build_static_road_database.mjs 過去是純串接、整條鏈上沒有任何唯一性檢查，
// 同一條路進來兩份 → 切塊後放大成數百組重複區塊鍵 → 各自套用覆寫、各自畫中央帶。
//
// 兩個關鍵順序，弄反就會出事：
//   1. node_refs 補齊必須在去重之前。跨區界的 57 個分段在左營側完全沒有 node_refs，
//      若先去重再補齊，regions 順序就決定了資料品質（左營在前 → 保留缺節點的版本）。
//   2. 合成負節點依「座標排序」配號，不依載入順序，否則反轉 regions 順序會產生
//      不同的負節點編號，輸出不可重現。

/** 座標 → 節點對照用的鍵；7 位小數約 1cm，足以辨識同一個 OSM 節點 */
const coordinateKey = (point) => `${Number(point[0]).toFixed(7)},${Number(point[1]).toFixed(7)}`

/** 深度比較用的正規化字串：鍵排序後序列化，避免欄位順序造成假性差異 */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 身分：同一條 way 的不同 split_index 是不同分段，不可互相去重 */
export const segmentIdentity = (s) =>
  `${s.object_identity?.nav_segment_key ?? s.osm_id}#${s.object_identity?.split_index ?? 0}`

const differingFields = (a, b) => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]))
}

/**
 * 用「所有 shard」的真實 OSM 節點補齊 node_refs，回傳補齊後的新紀錄陣列。
 * 不修改輸入物件——呼叫端可能還要拿原始資料做比對或報告。
 */
export function backfillNodeRefs(entries) {
  const nodeByCoordinate = new Map()
  for (const { record } of entries) {
    const coordinates = record.geometry?.coordinates ?? []
    const nodes = record.node_refs
    if (!Array.isArray(nodes) || nodes.length !== coordinates.length) continue
    coordinates.forEach((point, index) => {
      const key = coordinateKey(point)
      // 真實 OSM 節點優先；已登記過就不覆寫，避免兩份 shard 互相蓋來蓋去
      if (!nodeByCoordinate.has(key)) nodeByCoordinate.set(key, nodes[index])
    })
  }
  // 仍然沒有真實節點的座標才配合成 id，且依座標排序決定編號（順序無關）
  const needsSynthetic = new Set()
  for (const { record } of entries) {
    const coordinates = record.geometry?.coordinates ?? []
    if (Array.isArray(record.node_refs) && record.node_refs.length === coordinates.length) continue
    for (const point of coordinates) {
      const key = coordinateKey(point)
      if (!nodeByCoordinate.has(key)) needsSynthetic.add(key)
    }
  }
  let nextSynthetic = -1
  for (const key of [...needsSynthetic].sort()) nodeByCoordinate.set(key, nextSynthetic--)

  return entries.map((entry) => {
    const { record } = entry
    const coordinates = record.geometry?.coordinates ?? []
    if (Array.isArray(record.node_refs) && record.node_refs.length === coordinates.length) {
      return entry
    }
    return {
      ...entry,
      record: {
        ...record,
        node_refs: coordinates.map((point) => nodeByCoordinate.get(coordinateKey(point))),
      },
    }
  })
}

/**
 * 補齊 → 去重。first-wins 保留（去重必須有可重現的贏家），但**補齊後才做深度比較**：
 * 內容相同才算 exact duplicate；仍有差異的歸為 conflict，照樣輸出候選但要進報告。
 *
 * @param entries [{ record, source, line }]
 * @returns { segments, exactDuplicates, conflicts }
 */
export function prepareSegments(entries) {
  const filled = backfillNodeRefs(entries)
  const firstByIdentity = new Map()
  const segments = []
  const exactDuplicates = []
  const conflicts = []
  for (const entry of filled) {
    const id = segmentIdentity(entry.record)
    const first = firstByIdentity.get(id)
    if (!first) {
      firstByIdentity.set(id, entry)
      segments.push(entry.record)
      continue
    }
    const provenance = {
      key: id,
      kept: { source: first.source, line: first.line },
      rejected: { source: entry.source, line: entry.line },
    }
    if (canonicalJson(first.record) === canonicalJson(entry.record)) {
      exactDuplicates.push(provenance)
    } else {
      conflicts.push({
        ...provenance,
        differing_fields: differingFields(first.record, entry.record),
      })
    }
  }
  return { segments, exactDuplicates, conflicts }
}
