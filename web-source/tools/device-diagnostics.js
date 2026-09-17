(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const statuses = []
  const addresses = []
  function receive(e) {
    if (e.detail.type === 'status') statuses.push(e.detail)
    if (e.detail.type === 'addressResult') addresses.push(e.detail)
  }
  window.addEventListener('lane-native', receive)
  LaneNative.postMessage(JSON.stringify({ type: 'status' }))
  LaneNative.postMessage(JSON.stringify({ type: 'ttsTest' }))
  LaneNative.postMessage(JSON.stringify({ type: 'reverseGeocode', id: 'diagnostic', lng: 120.2834, lat: 22.7338 }))
  await wait(10000)
  window.removeEventListener('lane-native', receive)
  return { statuses, addresses, text: document.body.innerText,
    startup: performance.getEntriesByType('measure').filter(e => e.name.startsWith('lanedev-boot:')).map(e => ({ name: e.name, ms: Math.round(e.duration) })) }
})()
