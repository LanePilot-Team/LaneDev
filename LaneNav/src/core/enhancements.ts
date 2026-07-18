// Enhancement Layer 紀錄體系（計畫書 B-3）
//
// 設計：append-only journal（流水帳，永不覆寫）+ fold（折疊出最新值）。
// 對齊 LanePilot 的 annotations.jsonl 精神：
//   - journal   = 歷程原文，可追溯「誰、何時、把什麼改成什麼」，可 rebase 到新版 OSM
//   - latest    = 折疊後的目前值，渲染與導航吃這份
// 匯出檔同時含兩者 + 待轉區，之後轉 LanePilot schema 只是欄位映射。
import { computeDerived, type RoadFeature } from './roads'
import type { Zone } from './zones'
import type { PlacedVehicle } from './vehicles'
import type { TurnBay, RightLane } from './turnbays'

export interface EnhancementRecord {
  seq: number
  ts: string // ISO 8601
  author: string
  op: 'set' | 'delete'
  /**
   * road     key = "way/24275091"（整條 way 覆寫，舊格式）
   *          或   "way/24275091@b/123456"（區塊覆寫：way 依路口切塊後，
   *          @b/ 後為區塊第一個 node id；套用時區塊級蓋過 way 級）
   * turn_bay key = "way/W@node/N"（偏心左轉道覆寫，見 路上元件擴充設計.md §1.3）
   * twin_island key = "twin/A-B"（顯式配對分隔島覆寫：w 島寬 / present 開關）
   * right_lane key = "way/W@node/N[~b]~r"（路口前右轉附加車道：present/len_m/width_m；
   *          與 turn_bay 同格式加 ~r 尾碼——foldJournal 依 key 折疊，尾碼避免鍵碰撞）
   * 之後擴充：'median' | 'sign' 等（禁止左轉/迴轉見計畫書 B-11）
   */
  target: { type: 'road' | 'turn_bay' | 'twin_island' | 'right_lane'; key: string }
  fields?: Record<string, string | number>
}

const JOURNAL_KEY = 'navsim-journal-v1'
export const AUTHOR = 'rex' // TODO: 多人協作時做成設定

export function loadJournal(): EnhancementRecord[] {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function appendRecord(
  journal: EnhancementRecord[],
  rec: Omit<EnhancementRecord, 'seq' | 'ts' | 'author'>,
  author: string = AUTHOR, // 匯入 LanePilot 標註時標記來源
): EnhancementRecord[] {
  const next = [...journal, {
    ...rec,
    seq: (journal[journal.length - 1]?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    author,
  }]
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(next))
  return next
}

/**
 * couplet 合併的 node id 重映射套用到 journal 鍵（way/W@b/N、way/W@node/N~b）。
 * 新增合併範圍時，既有標註引用的路口 node 可能被併到 keep 側 id——
 * 載入時跑一次遷移，有變動就回存 localStorage。冪等（遷移後的鍵不再命中）。
 */
export function remapJournalNodes(
  journal: EnhancementRecord[], remap: Map<number, number>,
): EnhancementRecord[] {
  if (remap.size === 0) return journal
  let changed = 0
  const out = journal.map((rec) => {
    const m = rec.target.key.match(/^(way\/-?\d+@(?:b|node)\/)(\d+)((?:~b)?(?:~r)?)$/)
    if (!m) return rec
    const n = remap.get(Number(m[2]))
    if (n === undefined) return rec
    changed++
    return { ...rec, target: { ...rec.target, key: `${m[1]}${n}${m[3] ?? ''}` } }
  })
  if (changed > 0) {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(out))
    console.info(`journal 遷移：${changed} 筆鍵值隨 couplet 合併重映射`)
  }
  return out
}

/** 折疊 journal → 每個 target 的最新欄位值 */
export function foldJournal(journal: EnhancementRecord[]): Map<string, Record<string, string | number>> {
  const out = new Map<string, Record<string, string | number>>()
  for (const rec of journal) {
    if (rec.op === 'delete') {
      out.delete(rec.target.key)
    } else {
      out.set(rec.target.key, { ...out.get(rec.target.key), ...rec.fields })
    }
  }
  return out
}

/** 把折疊後的覆寫值套到 Base Layer 道路上，回傳套用筆數 */
export function applyToRoads(
  roads: RoadFeature[],
  folded: Map<string, Record<string, string | number>>,
): number {
  let n = 0
  for (const r of roads) {
    // way 級（舊格式，整條套用）先鋪底，區塊級（way/W@b/N）覆蓋
    const wayFields = folded.get(`way/${r.properties.osm_id}`)
    const blockFields = folded.get(`way/${r.properties.osm_id}@b/${r.properties.blockNode}`)
    if (!wayFields && !blockFields) continue
    const fields = { ...wayFields, ...blockFields }
    n++
    const p = r.properties
    // 0 = 該向純機車道（無汽車車道），編輯面板保證 0 時必有機車道
    if (fields.lanes_forward !== undefined) p.lanesForward = Math.max(0, Number(fields.lanes_forward))
    if (fields.lanes_backward !== undefined) {
      p.lanesBackward = p.oneway === 'yes' ? 0 : Math.max(0, Number(fields.lanes_backward))
    }
    // 舊格式相容：只給總數時對半拆
    if (fields.lanes !== undefined && fields.lanes_forward === undefined) {
      const lanes = Number(fields.lanes)
      p.lanesForward = p.oneway === 'yes' ? lanes : Math.ceil(lanes / 2)
      p.lanesBackward = p.oneway === 'yes' ? 0 : Math.max(1, lanes - p.lanesForward)
    }
    if (fields.moto_forward !== undefined) p.motoF = Number(fields.moto_forward) > 0
    if (fields.moto_backward !== undefined) p.motoB = p.oneway === 'yes' ? false : Number(fields.moto_backward) > 0
    if (fields.turn_lanes !== undefined) {
      p.turnLanes = String(fields.turn_lanes).split('|')
    }
    if (fields.turn_lanes_backward !== undefined) {
      p.turnLanesB = p.oneway === 'yes' ? undefined : String(fields.turn_lanes_backward).split('|')
    }
    if (fields.motorcycle !== undefined) p.motorcycle = String(fields.motorcycle) // 'no' = 禁行機車
    if (fields.rules_forward !== undefined) {
      const v = String(fields.rules_forward)
      p.rulesF = v ? v.split('|').filter(Boolean) : []
    }
    if (fields.rules_backward !== undefined) {
      const v = String(fields.rules_backward)
      p.rulesB = p.oneway === 'yes' ? undefined : (v ? v.split('|').filter(Boolean) : [])
    }
    if (fields.center_m !== undefined) p.centerM = Math.max(0, Number(fields.center_m)) // 中央帶（偏心道/槽化/島）
    if (fields.center_kind !== undefined) p.centerKind = fields.center_kind === 'island' ? 'island' : 'hatch'
    if (fields.extra_width_m !== undefined) {
      p.extraM = Math.max(-3.2, Math.min(6.4, Number(fields.extra_width_m) || 0)) // 路寬微調（路肩）
    }
    computeDerived(p)
  }
  return n
}

/** 匯出整包 Enhancement：journal 歷程 + 折疊最新值 + 待轉區 + 車輛模型
 * + 偏心左轉道 + 右轉附加車道 */
export function exportEnhancements(
  journal: EnhancementRecord[], zones: Zone[], vehicles: PlacedVehicle[] = [],
  bays: TurnBay[] = [], rightLanes: RightLane[] = [],
) {
  const payload = {
    format: 'navsim-enhancement-v0.5',
    exported_at: new Date().toISOString(),
    author: AUTHOR,
    journal,
    latest: Object.fromEntries(foldJournal(journal)),
    waiting_zones: zones.map((z) => ({
      id: z.id,
      intersection_osm_node: z.intersectionId,
      // 觸發條件：從 approach 行向進入該路口的左轉
      approach: { road: z.from.name ?? null, bearing_deg: Math.round(z.from.bearing) },
      exit: { road: z.to.name ?? null, bearing_deg: Math.round(z.to.bearing) },
      center: { lng: z.center[0], lat: z.center[1] }, // 由路口幾何自動推算
      bearing_deg: Math.round(z.bearing * 10) / 10,
      width_m: z.w,
      depth_m: z.d,
      source: 'manual',
    })),
    vehicles,
    // 折疊後的偏心左轉道（含 default 生成且未被否決者）——下游不用重跑預設規則
    turn_bays: bays.map((b) => ({
      key: b.key,
      way: `way/${b.wayId}`,
      intersection_osm_node: b.nodeId,
      approach_bearing_deg: Math.round(b.approachBearing),
      bay_len_m: b.bayLenM,
      taper_len_m: b.taperLenM,
      width_m: b.widthM,
      turns: b.turns,
      source: b.source,
    })),
    // 右轉附加車道（純人工開啟，折疊後現況）
    right_lanes: rightLanes.map((r) => ({
      key: r.key,
      way: `way/${r.wayId}`,
      intersection_osm_node: r.nodeId,
      approach_bearing_deg: Math.round(r.approachBearing),
      len_m: r.lenM,
      taper_len_m: r.taperLenM,
      width_m: r.widthM,
      source: 'manual',
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'nanzi_enhancements.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
