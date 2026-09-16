(async () => {
  const result = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    p => resolve({ longitude: p.coords.longitude, latitude: p.coords.latitude, accuracy: p.coords.accuracy }),
    e => reject(new Error(e.message)), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }))
  document.querySelector('.client-settings').open = false
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === '規劃路線')
  button.click()
  await new Promise(resolve => setTimeout(resolve, 2000))
  return { location: result, text: document.body.innerText }
})()
