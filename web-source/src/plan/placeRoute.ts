import type { DestinationProvider } from '../places/destination.ts'

export interface Stop {
  id: number
  pos: [number, number] | null
  address?: string
  label?: string
  placeId?: string
  placePosition?: [number, number]
  placeProvider?: DestinationProvider
}

/**
 * 路線規劃的起終點吸附方式（2026-11-07）：地圖上點車道選的停靠點只有座標（沒有地點／
 * 目前位置標籤）→ 'lane'，照點的那一側車道；搜尋地點、地址、目前位置 → 'area'，
 * 附近各行向與旁邊的大路都可當候選（graph.ts snapCandidates）。
 */
export function stopSnapMode(stop: Stop | undefined): 'lane' | 'area' {
  return stop && (stop.placeId !== undefined || stop.label !== undefined) ? 'area' : 'lane'
}

export interface RouteDestination {
  address?: string
  id: string
  label: string
  position: [number, number]
  provider: DestinationProvider
}

/** 已吸附至可通行車道的起點。 */
export interface RouteStart {
  label: string
  position: [number, number]
}

/** 建立地標規劃的固定起終點，保留目的地來源供畫面與後續操作識別。 */
export function createPlaceRouteStops(
  destination: RouteDestination,
  snappedDestination: [number, number] | null,
  snappedStart: RouteStart | null = null,
): Stop[] {
  return [
    snappedStart
      ? { id: 1, pos: snappedStart.position, label: snappedStart.label }
      : { id: 1, pos: null },
    {
      id: 2,
      pos: snappedDestination,
      label: destination.label,
      ...(destination.address ? { address: destination.address } : {}),
      placeId: destination.id,
      placePosition: destination.position,
      placeProvider: destination.provider,
    },
  ]
}

/** 規劃面板下一個應等待地圖點選的位置；全部完成時回傳 null。 */
export function firstUnsetStopId(stops: Stop[]): number | null {
  return stops.find((stop) => !stop.pos)?.id ?? null
}

/** A GPS start must not retain the address or place ID of a previous searched start. */
export function withCurrentStart(stops: Stop[], position: [number, number]): Stop[] {
  return stops.map((stop, i) => i === 0 ? { id: stop.id, pos: position, label: '我的位置' } : stop)
}
