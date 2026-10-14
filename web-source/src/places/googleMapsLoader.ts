let placesLibraryPromise: Promise<google.maps.PlacesLibrary> | null = null

/**
 * 延遲載入 Maps JavaScript API 的 Places library。
 * 共用同一個 Promise，避免 React Strict Mode 或重複點擊造成重複載入。
 */
export function loadGooglePlacesLibrary(): Promise<google.maps.PlacesLibrary> {
  if (typeof google === 'undefined' || !google.maps?.importLibrary) {
    return Promise.reject(new Error('Google Maps JavaScript API 尚未成功載入'))
  }

  if (!placesLibraryPromise) {
    placesLibraryPromise = (
      google.maps.importLibrary('places') as Promise<google.maps.PlacesLibrary>
    ).catch((error: unknown) => {
      placesLibraryPromise = null
      throw error
    })
  }

  return placesLibraryPromise
}
