import type { PlaceRecord } from './places.ts'

export type DestinationProvider = 'local' | 'google-ui-kit'

export type DestinationSelection =
  | {
      provider: 'local'
      id: string
      position: [number, number]
      place: PlaceRecord
    }
  | {
      provider: 'google-ui-kit'
      id: string
      position: [number, number]
      /** 使用者自己提交的查詢文字，不是從 Google 結果擷取的名稱。 */
      queryLabel: string
    }

export function localDestination(place: PlaceRecord): DestinationSelection {
  return {
    provider: 'local',
    id: place.id,
    position: place.position,
    place,
  }
}

/**
 * Places UI Kit 僅保留導航需要的 Place ID 與座標；其他 Google 內容交由元件顯示。
 */
export function googleDestination(
  place: google.maps.places.Place,
  submittedQuery: string,
): DestinationSelection | null {
  const location = place.location
  return location ? googleCoordinateDestination(place.id, location.lng(), location.lat(), submittedQuery) : null
}

export function googleCoordinateDestination(
  placeId: unknown, lng: unknown, lat: unknown, submittedQuery: string,
): DestinationSelection | null {
  const id = typeof placeId === 'string' ? placeId.trim() : ''
  const queryLabel = submittedQuery.trim()
  if (!id || !queryLabel || typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180
    || typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null

  return {
    provider: 'google-ui-kit',
    id,
    position: [lng, lat],
    queryLabel,
  }
}

export function destinationLabel(destination: DestinationSelection): string {
  return destination.provider === 'local'
    ? destination.place.name
    : `Google：${destination.queryLabel}`
}
