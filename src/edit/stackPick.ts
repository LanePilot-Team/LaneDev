// 疊合路段的點選消歧（LaneDev 專屬）。
//
// 問題：高楠公路這類主線＋側車道（hw=service）在 OSM 裡是兩條中心線完全重合的 way，
// 疊合稽核實測中位距 0.0m。queryRenderedFeatures 會兩條都回傳，但編輯器只取 hit[0]，
// 所以下層那條永遠點不到——不論點哪裡、放多大都一樣。
//
// 解法：把命中「整疊」收下來，交給呼叫端輪選（同一點再按一下換下一條）或用面板直選。
import type { Map as MLMap, MapGeoJSONFeature, Point } from 'maplibre-gl'
import type { RoadFeature } from '../core/roads'
// 副檔名是刻意的：這支要能被 node --test 直接載入（strip-types 不做無副檔名解析），
// 而 geo 只相依 maplibre 的型別，跟著進來不會有副作用。
import { haversine } from '../core/geo.ts'

/** 命中點外擴幾像素也算同一疊：完全重合的路仍可能因反鋸齒差一兩個像素 */
const NEAR_PX = 4
/** 兩次點擊視為「同一處」的容差（像素）——之內才輪選下一條 */
export const CYCLE_PX = 8

const PICK_LAYERS = ['road-surface', 'roads-simple']

export interface StackPick {
  key: string
  osmId: number
  blockNode: number
  /** 主標（路名） */
  name: string
  /** 副標：道路分級·車道·長度，用來分辨同名的主線與側車道 */
  detail: string
}

export const stackKeyOf = (osmId: number, blockNode: number) => `way/${osmId}@b/${blockNode}`

/** 上一次點擊的位置與整疊組成（判斷「同一處再點一下」用） */
export interface StackCursor {
  x: number
  y: number
  /** 整疊的鍵串起來——組成一變就是點到別處，索引要歸零 */
  keys: string
  index: number
}

export const EMPTY_CURSOR: StackCursor = { x: -1e9, y: -1e9, keys: '', index: 0 }

/**
 * 決定這一下要選整疊中的哪一條。
 * 同一處連點 = 往下輪一條；換地方點 = 回到最上面那條（＝原本 hit[0] 的行為）。
 * Ctrl（捏合）不輪選：先用普通點擊選到想要的那條，再按住 Ctrl 點它，
 * 否則按 Ctrl 的當下就跳走，被壓在下面的路段永遠捏不到。
 */
export function nextStackIndex(
  prev: StackCursor, x: number, y: number, keys: string, count: number, ctrl: boolean,
): number {
  if (count <= 0) return 0
  const samePlace = keys === prev.keys
    && Math.abs(x - prev.x) <= CYCLE_PX && Math.abs(y - prev.y) <= CYCLE_PX
  if (!samePlace) return 0
  return ctrl ? Math.min(prev.index, count - 1) : (prev.index + 1) % count
}

const HIGHWAY_LABEL: Record<string, string> = {
  motorway: '高速', trunk: '快速', primary: '主要', secondary: '次要', tertiary: '聯絡',
  unclassified: '未分級', residential: '住宅', living_street: '生活', service: '服務／側車道',
  pedestrian: '行人', track: '產業', footway: '人行', cycleway: '自行車', busway: '公車',
}

export function highwayLabel(highway: string): string {
  const base = highway.replace(/_link$/, '')
  const zh = HIGHWAY_LABEL[base] ?? base
  return highway.endsWith('_link') ? `${zh}匝道` : zh
}

export function describeStackRoad(road: RoadFeature): StackPick {
  const p = road.properties
  const cs = road.geometry.coordinates as [number, number][]
  const lenM = cs.slice(1).reduce((sum, c, i) => sum + haversine(cs[i], c), 0)
  const lanes = p.oneway === 'yes'
    ? `${p.lanesForward}車道單行`
    : `${p.lanesForward}+${p.lanesBackward}車道`
  return {
    key: stackKeyOf(p.osm_id, p.blockNode),
    osmId: p.osm_id,
    blockNode: p.blockNode,
    name: p.name ?? '（未命名道路）',
    detail: `${highwayLabel(p.highway)}·${lanes}·${Math.round(lenM)}m`,
  }
}

/**
 * 收集點擊處的所有道路區塊，由上而下（渲染順序）排列。
 * 先取正中命中，再補 NEAR_PX 方框內的其他區塊——完全疊合的兩條路兩次都會進來，
 * 但先後順序仍是使用者看到的疊序，所以第一下點到的還是原本那條（行為不變）。
 */
export function collectStackedRoads(
  map: MLMap, point: Point, roads: RoadFeature[],
): RoadFeature[] {
  const byKey = new Map<string, RoadFeature>()
  for (const r of roads) byKey.set(stackKeyOf(r.properties.osm_id, r.properties.blockNode), r)
  const layers = PICK_LAYERS.filter((id) => map.getLayer(id))
  if (layers.length === 0) return []

  const out: RoadFeature[] = []
  const seen = new Set<string>()
  const take = (hits: MapGeoJSONFeature[]) => {
    for (const f of hits) {
      const key = stackKeyOf(Number(f.properties.osm_id), Number(f.properties.blockNode))
      if (seen.has(key)) continue
      const road = byKey.get(key)
      if (!road) continue
      seen.add(key)
      out.push(road)
    }
  }
  take(map.queryRenderedFeatures(point, { layers }))
  take(map.queryRenderedFeatures(
    [[point.x - NEAR_PX, point.y - NEAR_PX], [point.x + NEAR_PX, point.y + NEAR_PX]],
    { layers },
  ))
  return out
}
