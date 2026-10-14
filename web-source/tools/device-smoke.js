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
  const developerControls = /編輯地圖|匯入地圖|Demo 路線|大眾運輸/.test(document.body.innerText)
  assert(!developerControls, 'Forbidden developer controls exposed')
  if (!status.simulationEnabled) {
    assert(!/開始模擬導航|開發模擬|[1248]x/.test(document.body.innerText), 'Simulation controls exposed in release')
  }
  const places = await (await fetch('./data/places/places.json')).json()
  assert(!places.places.some(p => p.category === 'transport'), 'Transport POI exposed')
  const blockedWrite = await fetch('/api/static-road-database/editor', { method: 'PUT', body: '{}' })
  assert(blockedWrite.status === 403, 'Write API must reject requests')
  document.querySelector('.client-settings summary').click()
  return { status, blockedWrite: blockedWrite.status, placeCount: places.places.length,
    text: document.body.innerText }
})()
