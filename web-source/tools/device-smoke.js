(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message) }
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native status timeout')), 4000)
    function handler(e) { if (e.detail.type === 'status') {
      clearTimeout(timer); window.removeEventListener('lane-native', handler); resolve(e.detail)
    } }
    window.addEventListener('lane-native', handler)
    LaneNative.postMessage(JSON.stringify({ type: 'status' }))
  })
  assert(!/編輯地圖|匯入地圖|Demo 路線|開始模擬|大眾運輸/.test(document.body.innerText), 'Developer controls exposed')
  const places = await (await fetch('./data/places/places.json')).json()
  assert(!places.places.some(p => p.category === 'transport'), 'Transport POI exposed')
  const blockedWrite = await fetch('/api/static-road-database/editor', { method: 'PUT', body: '{}' })
  assert(blockedWrite.status === 403, 'Write API must reject requests')
  document.querySelector('.client-settings summary').click()
  return { status, blockedWrite: blockedWrite.status, placeCount: places.places.length,
    text: document.body.innerText }
})()
