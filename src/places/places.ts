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
    .filter((place) => placeSearchText(place).includes(normalizedQuery))
    .sort((a, b) =>
      scorePlace(a, normalizedQuery) - scorePlace(b, normalizedQuery) ||
      a.name.localeCompare(b.name, 'zh-Hant'),
    )
    .slice(0, limit)
}
