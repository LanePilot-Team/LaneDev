let placesLibraryPromise: Promise<google.maps.PlacesLibrary> | null = null

/**
 * 延遲載入 Places UI Kit 所在的 Places library。
 * 共用同一個 Promise，避免 React Strict Mode 或重複點擊造成重複載入。
 */
export function loadGooglePlacesLibrary(): Promise<google.maps.PlacesLibrary> {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim()
  if (!apiKey) {
    return Promise.reject(new Error('尚未設定 Google Maps API Key'))
  }

  if (typeof google === 'undefined' || !google.maps?.importLibrary) {
    return Promise.reject(new Error('Google Maps 載入器尚未就緒'))
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
