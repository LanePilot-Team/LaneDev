import type { PlaceRecord } from './places'

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
  const id = place.id?.trim()
  const location = place.location
  const queryLabel = submittedQuery.trim()
  if (!id || !location || !queryLabel) return null

  const lng = location.lng()
  const lat = location.lat()
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null

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
