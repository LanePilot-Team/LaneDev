// Enhancement Layer 紀錄體系（計畫書 B-3）
//
// 設計：append-only journal（流水帳，永不覆寫）+ fold（折疊出最新值）。
// 對齊 LanePilot 的 annotations.jsonl 精神：
//   - journal   = 歷程原文，可追溯「誰、何時、把什麼改成什麼」，可 rebase 到新版 OSM
//   - latest    = 折疊後的目前值，渲染與導航吃這份
// 匯出檔同時含兩者 + 待轉區，之後轉 LanePilot schema 只是欄位映射。
import { computeDerived, type RoadFeature } from './roads'
import { angleDelta, bearing, haversine } from './geo'
import type { Zone } from './zones'
import type { PlacedVehicle } from './vehicles'
import type { TurnBay, RightLane } from './turnbays'
import { hasStaticRoadDatabase, staticJournal, updateStaticEditor } from './staticDatabase'
import { appendJournalRecords, type EnhancementRecordDraft } from './journalBatch'

export interface EnhancementRecord {
  seq: number
  ts: string // ISO 8601
  author: string
  op: 'set' | 'delete'
  /**
   * road     key = "way/24275091"（整條 way 覆寫，舊格式）
   *          或   "way/24275091@b/123456"（區塊覆寫：way 依路口切塊後，
   *          @b/ 後為區塊第一個 node id；套用時區塊級蓋過 way 級）
   * turn_bay key = "way/W@node/N"（偏心左轉道覆寫；single_mode=capped/ignore
   *          控制單邊使用時另一端封口或完全忽略，見 路上元件擴充設計.md §1.3）
   * twin_island key = "twin/A-B"（顯式配對分隔島覆寫：w 島寬 / present 開關）
   * right_lane key = "way/W@node/N[~b]~r"（路口前右轉附加車道：present/len_m/width_m；
   *          與 turn_bay 同格式加 ~r 尾碼——foldJournal 依 key 折疊，尾碼避免鍵碰撞）
   * moto_box key = "way/W@node/N[~b]~m"（機車停等格：lanes 相容舊格式；
   *          start_lane/end_lane 為駕駛視角左→右的連續車道範圍，不可越過禁行機車車道）
   * 之後擴充：'median' | 'sign' 等（禁止左轉/迴轉見計畫書 B-11）
   */
  target: {
    type: 'road' | 'road_merge' | 'turn_bay' | 'twin_island' | 'right_lane'
      | 'moto_box' | 'new_road'
    key: string
  }
  fields?: Record<string, string | number>
}

const JOURNAL_KEY = 'navsim-journal-v1'
const AUTHOR_KEY = 'navsim-author'

export function getAuthor(): string {
  try { return localStorage.getItem(AUTHOR_KEY) ?? 'anna' }
  catch { return 'anna' }
}

export function setAuthor(name: string) {
  try { localStorage.setItem(AUTHOR_KEY, name || 'anna') }
  catch { /* 無儲存空間時仍可繼續編輯 */ }
}

export function stampAuthor(
  journal: EnhancementRecord[], author: string,
): EnhancementRecord[] {
  if (!author) return journal
  const next = journal.map((record) => record.author ? record : { ...record, author })
  queueJournalPersistence(next)
  return next
}
let pendingJournal: EnhancementRecord[] | null = null
let journalFlushQueued = false

/**
 * 一次儲存可能連續追加多筆紀錄；等本輪同步工作結束後，只持久化最後版本，
 * 避免每一筆都重新序列化完整 journal 與靜態 editor database。
 */
function queueJournalPersistence(journal: EnhancementRecord[]) {
  pendingJournal = journal
  if (journalFlushQueued) return
  journalFlushQueued = true
  queueMicrotask(() => {
    journalFlushQueued = false
    const latest = pendingJournal
    pendingJournal = null
    if (!latest) return
    if (hasStaticRoadDatabase()) updateStaticEditor({ journal: latest })
    else localStorage.setItem(JOURNAL_KEY, JSON.stringify(latest))
  })
}

export function loadJournal(): EnhancementRecord[] {
  if (hasStaticRoadDatabase()) return staticJournal()
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function appendRecord(
  journal: EnhancementRecord[],
  rec: EnhancementRecordDraft,
  author: string = getAuthor(), // 公開 main 預設 unknown；本機可設為 anna
): EnhancementRecord[] {
  return appendRecords(journal, [rec], author)
}

export function appendRecords(
  journal: EnhancementRecord[],
  records: EnhancementRecordDraft[],
  author: string = getAuthor(),
  now: () => Date = () => new Date(),
): EnhancementRecord[] {
  return appendJournalRecords(journal, records, author, now, queueJournalPersistence)
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
    const m = rec.target.key.match(/^(way\/-?\d+@(?:b|node)\/)(\d+)((?:~b)?(?:~r|~m)?)$/)
    if (!m) return rec
    const n = remap.get(Number(m[2]))
    if (n === undefined) return rec
    changed++
    return { ...rec, target: { ...rec.target, key: `${m[1]}${n}${m[3] ?? ''}` } }
  })
  if (changed > 0) {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(out))
    updateStaticEditor({ journal: out })
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
    // 單雙向必須最先套用：底下每一個逆向屬性（lanesBackward／turnLanesB／
    // laneMarksB／motoSepB／leftWaitAreaB…）都閘在 p.oneway === 'yes' 後面，
    // 晚一步套就會把使用者剛設的逆向車道靜默歸零。OSM 把實地雙向路標成單行的
    // 情況不少（軍校路 way/383642188），沒有這個欄位就完全改不回來。
    if (fields.oneway !== undefined) {
      p.oneway = String(fields.oneway) === 'yes' ? 'yes' : 'no'
    }
    if (fields.lanes !== undefined || fields.lanes_forward !== undefined ||
      fields.lanes_backward !== undefined) p.sharedLane = false
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
    if (fields.shared_lane !== undefined) {
      p.sharedLane = p.oneway === 'no' && Number(fields.shared_lane) > 0
    }
    if (fields.moto_forward !== undefined) {
      p.motoCountF = Math.max(0, Math.round(Number(fields.moto_forward) || 0))
      p.motoF = p.motoCountF > 0
    }
    if (fields.moto_left_f !== undefined) {
      p.motoLeftF = p.oneway === 'yes' && Number(fields.moto_left_f) > 0
    }
    if (fields.moto_backward !== undefined) {
      p.motoCountB = p.oneway === 'yes'
        ? 0 : Math.max(0, Math.round(Number(fields.moto_backward) || 0))
      p.motoB = p.motoCountB > 0
    }
    if (fields.moto_entry_icon_f !== undefined) p.motoEntryIconF = Number(fields.moto_entry_icon_f) > 0
    if (fields.moto_entry_icon_b !== undefined) p.motoEntryIconB = Number(fields.moto_entry_icon_b) > 0
    if (fields.moto_text_diamond_f !== undefined) p.motoTextDiamondF = Number(fields.moto_text_diamond_f) > 0
    if (fields.moto_text_diamond_b !== undefined) p.motoTextDiamondB = Number(fields.moto_text_diamond_b) > 0
    if (fields.stop_line_f !== undefined) p.stopLineF = Number(fields.stop_line_f) > 0
    if (fields.stop_line_b !== undefined) p.stopLineB = Number(fields.stop_line_b) > 0
    if (fields.arrow_display_f !== undefined) p.arrowDisplayF = Number(fields.arrow_display_f) > 0
    if (fields.arrow_display_b !== undefined) p.arrowDisplayB = Number(fields.arrow_display_b) > 0
    if (fields.start_arrow_display_f !== undefined) {
      p.startArrowDisplayF = Number(fields.start_arrow_display_f) > 0
    }
    if (fields.start_arrow_display_b !== undefined) {
      p.startArrowDisplayB = Number(fields.start_arrow_display_b) > 0
    }
    if (fields.left_wait_area_f !== undefined) {
      p.leftWaitAreaF = Number(fields.left_wait_area_f) > 0
    }
    if (fields.left_wait_area_b !== undefined) {
      p.leftWaitAreaB = p.oneway === 'yes' ? false : Number(fields.left_wait_area_b) > 0
    }
    if (fields.start_turn_lanes !== undefined) {
      p.startTurnLanes = String(fields.start_turn_lanes).split('|')
    }
    if (fields.start_turn_lanes_backward !== undefined) {
      p.startTurnLanesB = p.oneway === 'yes'
        ? undefined
        : String(fields.start_turn_lanes_backward).split('|')
    }
    if (fields.road_marking_mode !== undefined) {
      const mode = String(fields.road_marking_mode)
      p.roadMarkingMode = mode === 'none' ? 'none' : mode === 'center' ? 'center' : 'all'
    }
    // 快慢分隔帶寬（=0 回復機車道白線）
    if (fields.moto_sep_f !== undefined) p.motoSepF = Math.max(0, Number(fields.moto_sep_f))
    if (fields.moto_sep_b !== undefined) {
      p.motoSepB = p.oneway === 'yes' ? 0 : Math.max(0, Number(fields.moto_sep_b))
    }
    if (fields.turn_lanes !== undefined) {
      p.turnLanes = String(fields.turn_lanes).split('|')
    }
    if (fields.turn_lanes_backward !== undefined) {
      p.turnLanesB = p.oneway === 'yes' ? undefined : String(fields.turn_lanes_backward).split('|')
    }
    if (fields.moto_turn_lanes_forward !== undefined) {
      p.motoTurnLanesF = String(fields.moto_turn_lanes_forward).split('|')
    }
    if (fields.moto_turn_lanes_backward !== undefined) {
      p.motoTurnLanesB = p.oneway === 'yes'
        ? undefined : String(fields.moto_turn_lanes_backward).split('|')
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
    const readLaneMarks = (value: string | number) => {
      try {
        const parsed = JSON.parse(String(value))
        if (!Array.isArray(parsed)) return undefined
        return parsed.map((x) => x && typeof x.text === 'string'
          ? { text: x.text.slice(0, 12), color: typeof x.color === 'string' ? x.color : '#ffffff' }
          : null)
      } catch { return undefined }
    }
    if (fields.lane_marks_forward !== undefined) p.laneMarksF = readLaneMarks(fields.lane_marks_forward)
    if (fields.lane_marks_backward !== undefined) {
      p.laneMarksB = p.oneway === 'yes' ? undefined : readLaneMarks(fields.lane_marks_backward)
    }
    if (fields.center_m !== undefined) p.centerM = Math.max(0, Number(fields.center_m)) // 中央帶（偏心道/槽化/島）
    if (fields.center_kind !== undefined) p.centerKind = fields.center_kind === 'island' ? 'island' : 'hatch'
    if (fields.island_bay_mode !== undefined) {
      p.islandBayMode = Number(fields.island_bay_mode) > 0
    }
    if (fields.center_extend_start !== undefined) {
      p.centerExtendStart = Number(fields.center_extend_start) > 0
    }
    if (fields.center_extend_end !== undefined) {
      p.centerExtendEnd = Number(fields.center_extend_end) > 0
    }
    if (fields.extra_width_m !== undefined) {
      p.extraM = Math.max(-3.2, Math.min(6.4, Number(fields.extra_width_m) || 0)) // 路寬微調（路肩）
    }
    if (fields.deleted !== undefined) p.deleted = Number(fields.deleted) > 0
    // 「整段禁行機車」與「本段有機車道」互相矛盾——有機車道就代表騎士走得了，
    // 禁行的實際語意是「汽車車道禁行」。pipeline.ts 對 couplet 吸收慢車道的主線
    // 已做同樣的降級，但那在套 journal 之前跑，看不到 journal 才加上的機車道：
    // LanePilot 匯入（importFlow「全車道禁行 = 整段禁行機車」）留下 way 級
    // motorcycle=no，之後在編輯面板加機車道時只寫得到區塊級紀錄，way 級蓋不掉，
    // 於是機車在整條路上永遠無路可走（實測外環西路 way/1454602407 南向不通）。
    if (p.motorcycle === 'no' && (p.motoF || p.motoB)) {
      p.motorcycle = undefined
      p.rulesF = p.rulesF ?? ['no_moto']
      p.rulesB = p.oneway === 'yes' ? undefined : (p.rulesB ?? ['no_moto'])
    }
    computeDerived(p)
  }
  return n
}

export interface RoadMergeCheck {
  ok: boolean
  reason?: string
  primaryKey: string
  secondaryKey: string
  primaryAt: 'start' | 'end'
  secondaryAt: 'start' | 'end'
}

const roadBlockKey = (r: RoadFeature) =>
  `way/${r.properties.osm_id}@b/${r.properties.blockNode}`

/** 嚴格檢查兩個路口到路口區塊能否安全接成同一路段。 */
export function checkRoadMerge(primary: RoadFeature, secondary: RoadFeature): RoadMergeCheck {
  const result: RoadMergeCheck = {
    ok: false,
    primaryKey: roadBlockKey(primary),
    secondaryKey: roadBlockKey(secondary),
    primaryAt: 'end',
    secondaryAt: 'start',
  }
  if (primary === secondary || result.primaryKey === result.secondaryKey) {
    return { ...result, reason: '不可選取同一路段兩次' }
  }
  const pa = primary.properties
  const pb = secondary.properties
  const normName = (v?: string) => (v ?? '').replace(/\s+/g, '').trim()
  if (!normName(pa.name) || normName(pa.name) !== normName(pb.name)) {
    return { ...result, reason: '兩段道路名稱不同，為避免誤併已拒絕' }
  }
  if (pa.highway !== pb.highway || pa.oneway !== pb.oneway) {
    return { ...result, reason: '道路等級或單雙向設定不同' }
  }
  if (pa.lanesForward !== pb.lanesForward || pa.lanesBackward !== pb.lanesBackward
    || pa.motoF !== pb.motoF || pa.motoB !== pb.motoB) {
    return { ...result, reason: '兩段車道配置不同，請先調整一致' }
  }
  const a = primary.geometry.coordinates as [number, number][]
  const b = secondary.geometry.coordinates as [number, number][]
  if (a.length < 2 || b.length < 2) return { ...result, reason: '道路幾何點不足' }
  const pairs = [
    { primaryAt: 'start' as const, secondaryAt: 'start' as const, d: haversine(a[0], b[0]) },
    { primaryAt: 'start' as const, secondaryAt: 'end' as const, d: haversine(a[0], b[b.length - 1]) },
    { primaryAt: 'end' as const, secondaryAt: 'start' as const, d: haversine(a[a.length - 1], b[0]) },
    { primaryAt: 'end' as const, secondaryAt: 'end' as const, d: haversine(a[a.length - 1], b[b.length - 1]) },
  ].sort((x, y) => x.d - y.d)
  const join = pairs[0]
  result.primaryAt = join.primaryAt
  result.secondaryAt = join.secondaryAt
  if (join.d > 1) return { ...result, reason: `兩段端點未相接（相距 ${join.d.toFixed(1)} 公尺）` }

  const pAway = join.primaryAt === 'start' ? bearing(a[0], a[1]) : bearing(a[a.length - 1], a[a.length - 2])
  const sAway = join.secondaryAt === 'start' ? bearing(b[0], b[1]) : bearing(b[b.length - 1], b[b.length - 2])
  const straightError = Math.abs(180 - Math.abs(angleDelta(pAway, sAway)))
  if (straightError > 15) {
    return { ...result, reason: `兩段接合角度不是平順直線（偏差 ${straightError.toFixed(1)}°）` }
  }
  return { ...result, ok: true }
}

/**
 * 重播既有捏合紀錄時的「幾何可行性」檢查。
 *
 * 與 checkRoadMerge 的差別是**刻意不再審查名稱／等級／車道配置**。捏合當下已經
 * 由人工確認過，重播時再審一次會造成致命後果：使用者一旦編輯合併後的路段，覆寫
 * 只寫進保留段的區塊鍵，次段仍留著舊值 → 兩段配置不同 → 下次 F5 時捏合被靜默
 * 略過、路段裂回去。實測 2026-07-29 就是這樣讓同一組捏合被重做三次。
 *
 * 人工紀錄擁有最高優先權：只要兩段端點真的相接，就照著重播。
 */
export function replayRoadMerge(primary: RoadFeature, secondary: RoadFeature): RoadMergeCheck {
  const result: RoadMergeCheck = {
    ok: false,
    primaryKey: roadBlockKey(primary),
    secondaryKey: roadBlockKey(secondary),
    primaryAt: 'end',
    secondaryAt: 'start',
  }
  if (primary === secondary) return { ...result, reason: '兩段已是同一個區塊' }
  const a = primary.geometry.coordinates as [number, number][]
  const b = secondary.geometry.coordinates as [number, number][]
  if (a.length < 2 || b.length < 2) return { ...result, reason: '道路幾何點不足' }
  const pairs = [
    { primaryAt: 'start' as const, secondaryAt: 'start' as const, d: haversine(a[0], b[0]) },
    { primaryAt: 'start' as const, secondaryAt: 'end' as const, d: haversine(a[0], b[b.length - 1]) },
    { primaryAt: 'end' as const, secondaryAt: 'start' as const, d: haversine(a[a.length - 1], b[0]) },
    { primaryAt: 'end' as const, secondaryAt: 'end' as const, d: haversine(a[a.length - 1], b[b.length - 1]) },
  ].sort((x, y) => x.d - y.d)
  const join = pairs[0]
  result.primaryAt = join.primaryAt
  result.secondaryAt = join.secondaryAt
  // 只擋「根本沒相接」的情況，避免把不相干的兩段接成亂七八糟的幾何
  if (join.d > 5) return { ...result, reason: `兩段端點未相接（相距 ${join.d.toFixed(1)} 公尺）` }
  return { ...result, ok: true }
}

/**
 * 依區塊鍵找回區塊。找不到精確鍵時退而求其次：找「含有那個 blockNode」的同 way
 * 區塊。區塊鍵的 N 是區塊第一個節點，只要區塊邊界移動（底圖重建、相鄰路段增刪）
 * 就會換人做，精確比對會讓捏合紀錄整筆失效。
 */
function findMergeBlock(roads: RoadFeature[], key: string): RoadFeature | undefined {
  const exact = roads.find((r) => roadBlockKey(r) === key)
  if (exact) return exact
  const m = key.match(/^way\/(-?\d+)@b\/(-?\d+)$/)
  if (!m) return undefined
  const wayId = Number(m[1])
  const blockNode = Number(m[2])
  return roads.find((r) => r.properties.osm_id === wayId
    && r.properties.nodes.includes(blockNode))
}

/**
 * 套用已確認的合併紀錄。原始靜態 OSM 不會被改；
 * 每次載入時才在記憶體內接合，並重建道路與導航圖。
 */
/** 破碎短段的判定：長度上限、視為「疊在裡面」的橫向距離、取樣點命中比例 */
const STUB_MAX_LEN_M = 25
const STUB_INSIDE_M = 12
const STUB_INSIDE_RATIO = 0.9

const polylineLengthM = (cs: [number, number][]) =>
  cs.slice(1).reduce((s, c, i) => s + haversine(cs[i], c), 0)

/**
 * 捏合完成後，隱藏同一條 way 上「幾乎整段疊在合併路段裡」的破碎短段。
 *
 * OSM 常在路口附近留下幾公尺長的重複小段。它們各自存在時樣式一致，看不太出來；
 * 但一旦把區塊捏合起來、再統一改樣式，改動只寫進保留段的區塊鍵，這些小段仍維持
 * 舊樣式疊在上面，畫面就出現交叉白線與雙重黃線。
 *
 * 只在捏合的路上做，未捏合的道路完全不掃——這是使用者實際遇到的範圍，也避免對
 * 全圖一萬多個區塊做距離運算。純記憶體隱藏、不寫 journal：取消捏合就自然復原。
 * 使用者自己在那個區塊設過覆寫的一律不動，那是人工資料而不是 OSM 殘留。
 */
function suppressOverlappedStubs(
  roads: RoadFeature[], merged: RoadFeature,
  folded: Map<string, Record<string, string | number>>,
): number {
  const mc = merged.geometry.coordinates as [number, number][]
  let hidden = 0
  for (const r of roads) {
    if (r === merged || r.properties.deleted) continue
    if (r.properties.osm_id !== merged.properties.osm_id) continue
    if (folded.has(roadBlockKey(r))) continue // 人工設定過，尊重它
    const cs = r.geometry.coordinates as [number, number][]
    if (cs.length < 2 || polylineLengthM(cs) > STUB_MAX_LEN_M) continue
    let inside = 0
    for (const p of cs) {
      let best = Infinity
      for (const q of mc) best = Math.min(best, haversine(p, q))
      if (best < STUB_INSIDE_M) inside++
    }
    if (inside / cs.length < STUB_INSIDE_RATIO) continue
    r.properties.deleted = true
    hidden++
  }
  return hidden
}

export function applyRoadMerges(roads: RoadFeature[], journal: EnhancementRecord[]): number {
  let merged = 0
  let hiddenStubs = 0
  const folded0 = foldJournal(journal)
  for (const [key, fields] of foldJournal(journal)) {
    if (!key.startsWith('merge/')) continue
    const primary = findMergeBlock(roads, String(fields.primary ?? ''))
    const secondary = findMergeBlock(roads, String(fields.secondary ?? ''))
    // 人工紀錄不得靜默失效：找不到區塊一定要出聲，否則使用者只會看到捏合莫名消失
    if (!primary || !secondary) {
      console.warn(`捏合紀錄 ${key} 找不到區塊`
        + `（保留段 ${primary ? 'ok' : String(fields.primary)}`
        + `／次段 ${secondary ? 'ok' : String(fields.secondary)}）——請重新捏合一次`)
      continue
    }
    if (primary === secondary) continue // 兩鍵指到同一塊 = 已經合併過，不重複套用
    const check = replayRoadMerge(primary, secondary)
    if (!check.ok) {
      console.warn(`略過無法重播的路段合併 ${key}：${check.reason}`)
      continue
    }
    const a = primary.geometry.coordinates as [number, number][]
    const b0 = secondary.geometry.coordinates as [number, number][]
    const b = check.secondaryAt === 'start' ? b0 : [...b0].reverse()
    const bNodes = check.secondaryAt === 'start'
      ? [...secondary.properties.nodes]
      : [...secondary.properties.nodes].reverse()
    // 接點不是「完全不連接路口」——RoadGraph 仍會在共用節點切邊，側街照樣接得上。
    // 改成單向進入：主路正向可右轉進入側街，對向不得跨線左轉，要繞到正向才行。
    // 必須在改寫 nodes 之前取，接合後接點就變成內部節點了。
    const joinNode = check.primaryAt === 'end'
      ? primary.properties.nodes[primary.properties.nodes.length - 1]
      : primary.properties.nodes[0]
    if (check.primaryAt === 'end') {
      primary.geometry.coordinates = [...a, ...b.slice(1)]
      primary.properties.nodes = [...primary.properties.nodes, ...bNodes.slice(1)]
    } else {
      primary.geometry.coordinates = [...b.slice(1).reverse(), ...a]
      primary.properties.nodes = [...bNodes.slice(1).reverse(), ...primary.properties.nodes]
    }
    const restricted = new Set(primary.properties.oneSideEntryNodes ?? [])
    restricted.add(joinNode)
    // 次段自己的限制也一併帶過來（連續捏合時前一次的接點不能掉）
    for (const node of secondary.properties.oneSideEntryNodes ?? []) restricted.add(node)
    primary.properties.oneSideEntryNodes = [...restricted]
    const secondaryIndex = roads.indexOf(secondary)
    if (secondaryIndex >= 0) roads.splice(secondaryIndex, 1)
    merged++
    // 接合後才做：要拿合併完的完整幾何去比對，才涵蓋得到次段那一側的破碎小段
    hiddenStubs += suppressOverlappedStubs(roads, primary, folded0)
  }
  if (hiddenStubs > 0) {
    console.info(`捏合路段上隱藏了 ${hiddenStubs} 個與之重疊的 OSM 破碎小段`)
  }
  return merged
}

/**
 * 合併後的路口元件仍可能使用次路段的 way id。建立僅供計算使用的 journal 視圖，
 * 將偏心道、右轉附加道、機車停等格鍵值改掛到主路段；原始歷程保持不變。
 */
export function journalForMergedRoads(journal: EnhancementRecord[]): EnhancementRecord[] {
  const aliases: {
    fromWay: string
    toWay: string
    nodes: Set<number> | null
  }[] = []
  for (const [key, fields] of foldJournal(journal)) {
    if (!key.startsWith('merge/')) continue
    const pm = String(fields.primary ?? '').match(/^way\/(-?\d+)@b\/-?\d+$/)
    const sm = String(fields.secondary ?? '').match(/^way\/(-?\d+)@b\/-?\d+$/)
    if (!pm || !sm) continue
    let nodes: Set<number> | null = null
    if (fields.secondary_nodes !== undefined) {
      try {
        const values = JSON.parse(String(fields.secondary_nodes))
        if (Array.isArray(values)) nodes = new Set(values.map(Number).filter(Number.isFinite))
      } catch { /* 舊紀錄沒有 node 清單，退回整個次 way 的元件鍵遷移 */ }
    }
    aliases.push({ fromWay: sm[1], toWay: pm[1], nodes })
  }
  if (!aliases.length) return journal
  return journal.map((record) => {
    if (!['turn_bay', 'right_lane', 'moto_box'].includes(record.target.type)) return record
    const m = record.target.key.match(/^way\/(-?\d+)@node\/(-?\d+)((?:~b)?(?:~r|~m)?)$/)
    if (!m) return record
    const alias = aliases.find((a) =>
      a.fromWay === m[1] && (!a.nodes || a.nodes.has(Number(m[2]))))
    if (!alias) return record
    return {
      ...record,
      target: {
        ...record.target,
        key: `way/${alias.toWay}@node/${m[2]}${m[3] ?? ''}`,
      },
    }
  })
}

/** 匯出整包 Enhancement：journal 歷程 + 折疊最新值 + 待轉區 + 車輛模型
 * + 偏心左轉道 + 右轉附加車道 */
export function exportEnhancements(
  journal: EnhancementRecord[], zones: Zone[], vehicles: PlacedVehicle[] = [],
  bays: TurnBay[] = [], rightLanes: RightLane[] = [],
  author: string = getAuthor(),
) {
  const payload = {
    format: 'navsim-enhancement-v0.5',
    exported_at: new Date().toISOString(),
    author,
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
