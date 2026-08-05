export type PlaceSource = 'osm' | 'tdx'

export type PlaceCategory =
  | 'transport'
  | 'parking'
  | 'food'
  | 'shopping'
  | 'education'
  | 'medical'
  | 'government'
  | 'tourism'
  | 'recreation'
  | 'service'
  | 'other'

export interface PlaceRecord {
  id: string
  source: PlaceSource
  sourceId: string
  name: string
  aliases: string[]
  category: PlaceCategory
  position: [number, number]
  address?: string
  phone?: string
  website?: string
  openingHours?: string
  updatedAt?: string
  fetchedAt: string
  rawCategory?: string
  sourceRefs?: Array<{ source: PlaceSource; sourceId: string; id: string }>
  memberIds?: string[]
  mergedCount?: number
  priority?: number
  tier?: 'major' | 'area' | 'local' | 'detail'
  icon?: string
  hidden?: boolean
}

export interface PlaceDatabase {
  schemaVersion: number
  generatedAt: string
  places: PlaceRecord[]
}

export const CATEGORY_LABELS: Record<PlaceCategory, string> = {
  transport: '交通場站',
  parking: '停車場',
  food: '餐飲',
  shopping: '購物',
  education: '教育',
  medical: '醫療',
  government: '公家機關',
  tourism: '景點',
  recreation: '休閒',
  service: '服務',
  other: '其他',
}

/** 所有可直接點擊的全地圖 POI 圖層。 */
export const POI_LAYER_IDS = [
  'poi-major',
  'poi-area',
  'poi-local',
  'poi-detail',
] as const

const PLACE_CATEGORIES = new Set<PlaceCategory>(
  Object.keys(CATEGORY_LABELS) as PlaceCategory[],
)

/**
 * 將 MapLibre 查詢到的 POI feature 還原成導航可使用的精簡地標。
 * 詳細地址等欄位會由 PlaceSearch 已載入的 places.json 依 id 補齊。
 */
export function placeFromPoiFeature(feature: {
  id?: string | number
  properties: Record<string, unknown> | null
  geometry: { type: string; coordinates?: unknown }
}): PlaceRecord | null {
  const properties = feature.properties
  const coordinates = feature.geometry.coordinates
  if (
    !properties || feature.geometry.type !== 'Point' ||
    !Array.isArray(coordinates) || coordinates.length < 2 ||
    typeof coordinates[0] !== 'number' || !Number.isFinite(coordinates[0]) ||
    typeof coordinates[1] !== 'number' || !Number.isFinite(coordinates[1])
  ) return null

  const id = String(properties.id ?? feature.id ?? '')
  const name = typeof properties.name === 'string' ? properties.name.trim() : ''
  if (!id || !name) return null

  const rawCategory = properties.category
  const category = typeof rawCategory === 'string' && PLACE_CATEGORIES.has(rawCategory as PlaceCategory)
    ? rawCategory as PlaceCategory
    : 'other'
  const sources = String(properties.sources ?? '')
    .split('+')
    .filter((source): source is PlaceSource => source === 'osm' || source === 'tdx')
  const source = sources[0] ?? (id.includes('tdx') ? 'tdx' : 'osm')

  return {
    id,
    source,
    sourceId: id,
    name,
    aliases: [],
    category,
    position: [coordinates[0], coordinates[1]],
    fetchedAt: '',
    sourceRefs: (sources.length ? sources : [source]).map((item) => ({
      source: item,
      sourceId: id,
      id: `${item}:${id}`,
    })),
    mergedCount: typeof properties.mergedCount === 'number' ? properties.mergedCount : undefined,
    priority: typeof properties.priority === 'number' ? properties.priority : undefined,
    tier: properties.tier === 'major' || properties.tier === 'area' ||
      properties.tier === 'local' || properties.tier === 'detail'
      ? properties.tier
      : undefined,
    icon: typeof properties.icon === 'string' ? properties.icon : undefined,
  }
}

export function normalizePlaceText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hant')
    .replaceAll('臺', '台')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function placeSearchText(place: PlaceRecord): string {
  return normalizePlaceText([
    place.name,
    ...place.aliases,
    place.address ?? '',
    CATEGORY_LABELS[place.category],
    place.rawCategory ?? '',
  ].join(' '))
}

function scorePlace(place: PlaceRecord, normalizedQuery: string): number {
  const name = normalizePlaceText(place.name)
  if (name === normalizedQuery) return 0
  if (name.startsWith(normalizedQuery)) return 1
  if (name.includes(normalizedQuery)) return 2
  if (place.aliases.some((alias) => normalizePlaceText(alias).includes(normalizedQuery))) return 3
  if (normalizePlaceText(place.address ?? '').includes(normalizedQuery)) return 4
  return 5
}

export function searchPlaces(
  places: PlaceRecord[],
  query: string,
  limit = 20,
): PlaceRecord[] {
  const normalizedQuery = normalizePlaceText(query)
  if (!normalizedQuery) return []
  return places
    .filter((place) => !place.hidden && placeSearchText(place).includes(normalizedQuery))
    .sort((a, b) =>
      scorePlace(a, normalizedQuery) - scorePlace(b, normalizedQuery) ||
      a.name.localeCompare(b.name, 'zh-Hant'),
    )
    .slice(0, limit)
}
