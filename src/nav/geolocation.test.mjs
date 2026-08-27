import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HIGH_ACCURACY_POSITION_OPTIONS,
  geolocationErrorMessage,
  geolocationUnavailableMessage,
  isSecureContext,
  requestCurrentPosition,
} from './geolocation.ts'

test('HTTPS 與本機開發網址可使用瀏覽器定位', () => {
  assert.equal(isSecureContext(true, 'example.com'), true)
  assert.equal(isSecureContext(false, 'localhost'), true)
  assert.equal(isSecureContext(false, '127.0.0.1'), true)
  assert.equal(isSecureContext(false, '192.168.1.10'), false)
})

test('定位環境檢查會優先回報不支援，再回報不安全連線', () => {
  assert.equal(
    geolocationUnavailableMessage(false, true),
    '此瀏覽器不支援 Geolocation API',
  )
  assert.equal(
    geolocationUnavailableMessage(true, false),
    '需要 HTTPS 才能取得定位，請用 tailscale serve 或 localhost 開啟',
  )
  assert.equal(geolocationUnavailableMessage(true, true), null)
})

test('瀏覽器定位錯誤會轉成可操作的繁中訊息', () => {
  assert.equal(
    geolocationErrorMessage({ code: 1, message: 'denied' }),
    '未授權位置權限（請到瀏覽器設定打開）',
  )
  assert.equal(
    geolocationErrorMessage({ code: 2, message: 'unavailable' }),
    'GPS 訊號不可用',
  )
  assert.equal(
    geolocationErrorMessage({ code: 3, message: 'timeout' }),
    'GPS 取得逾時',
  )
  assert.equal(
    geolocationErrorMessage({ code: 99, message: '瀏覽器定位失敗' }),
    '瀏覽器定位失敗',
  )
})

test('一次性定位會使用高精度設定並回傳座標與精度', async () => {
  let receivedOptions
  const geolocation = {
    getCurrentPosition(success, _error, options) {
      receivedOptions = options
      success({
        coords: {
          longitude: 120.2758,
          latitude: 22.7327,
          accuracy: 18.5,
        },
      })
    },
  }

  const result = await requestCurrentPosition(geolocation, true)

  assert.deepEqual(result, {
    position: [120.2758, 22.7327],
    accuracyM: 18.5,
  })
  assert.deepEqual(receivedOptions, HIGH_ACCURACY_POSITION_OPTIONS)
})

test('一次性定位沿用共用的環境與錯誤處理', async () => {
  await assert.rejects(
    requestCurrentPosition(null, false),
    /此瀏覽器不支援 Geolocation API/,
  )

  const denied = {
    getCurrentPosition(_success, error) {
      error({ code: 1, message: 'denied' })
    },
  }
  await assert.rejects(
    requestCurrentPosition(denied, true),
    /未授權位置權限/,
  )
})

test('一次性定位拒絕無效座標', async () => {
  const geolocation = {
    getCurrentPosition(success) {
      success({
        coords: {
          longitude: Number.NaN,
          latitude: 22.7327,
          accuracy: 12,
        },
      })
    },
  }

  await assert.rejects(
    requestCurrentPosition(geolocation, true),
    /定位回傳的座標無效/,
  )
})
