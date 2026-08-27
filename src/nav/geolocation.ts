// 瀏覽器定位共用能力：環境檢查、錯誤文案，以及供路線起點使用的一次性定位。
// GPS 導航與地標搜尋都從這裡取得相同的安全連線判斷與錯誤體驗。

export const HIGH_ACCURACY_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 15000,
}

export interface CurrentLocation {
  position: [number, number]
  accuracyM: number | null
}

type CurrentPositionGeolocation = Pick<Geolocation, 'getCurrentPosition'>

function browserGeolocation(): CurrentPositionGeolocation | null {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return null
  return navigator.geolocation
}

/** Geolocation 需要 HTTPS；localhost 與 127.0.0.1 保留本機開發例外。 */
export function isSecureContext(
  secureContext = typeof window !== 'undefined' && window.isSecureContext,
  hostname = typeof location !== 'undefined' ? location.hostname : '',
): boolean {
  return secureContext || hostname === 'localhost' || hostname === '127.0.0.1'
}

/** 回傳目前環境不能定位的原因；null 代表可繼續要求權限。 */
export function geolocationUnavailableMessage(
  supported = typeof navigator !== 'undefined' && 'geolocation' in navigator,
  secureContext = isSecureContext(),
): string | null {
  if (!supported) return '此瀏覽器不支援 Geolocation API'
  if (!secureContext) return '需要 HTTPS 才能取得定位，請用 tailscale serve 或 localhost 開啟'
  return null
}

/** 將瀏覽器的數字錯誤碼收斂成 GPS 導航與路線規劃共用的繁中訊息。 */
export function geolocationErrorMessage(
  error: Pick<GeolocationPositionError, 'code' | 'message'>,
): string {
  if (error.code === 1) return '未授權位置權限（請到瀏覽器設定打開）'
  if (error.code === 2) return 'GPS 訊號不可用'
  if (error.code === 3) return 'GPS 取得逾時'
  return error.message || '無法取得 GPS 位置'
}

/**
 * 取得一筆高精度位置。參數可注入，讓定位流程不依賴真實瀏覽器也能測試。
 */
export function requestCurrentPosition(
  geolocation: CurrentPositionGeolocation | null = browserGeolocation(),
  secureContext = isSecureContext(),
): Promise<CurrentLocation> {
  const unavailable = geolocationUnavailableMessage(Boolean(geolocation), secureContext)
  if (unavailable) return Promise.reject(new Error(unavailable))

  return new Promise((resolve, reject) => {
    geolocation!.getCurrentPosition(
      (result) => {
        const longitude = result.coords.longitude
        const latitude = result.coords.latitude
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
          reject(new Error('定位回傳的座標無效'))
          return
        }
        const accuracy = result.coords.accuracy
        resolve({
          position: [longitude, latitude],
          accuracyM: Number.isFinite(accuracy) ? Math.max(0, accuracy) : null,
        })
      },
      (error) => reject(new Error(geolocationErrorMessage(error))),
      HIGH_ACCURACY_POSITION_OPTIONS,
    )
  })
}
