(async () => {
  if (document.querySelector('.sp-close')) document.querySelector('.sp-close').click()
  await new Promise(resolve => setTimeout(resolve, 300))
  const button = [...document.querySelectorAll('button')].find(b => b.innerText === '目前位置')
  button.click()
  for (let i = 0; i < 120 && !document.querySelector('.client-location-marker'); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const marker = document.querySelector('.client-location-marker')
  if (!marker?.querySelector('.location-dot') || !marker?.querySelector('.location-beam')) throw new Error('Missing dot/beam')
  if (marker.textContent.includes('▲')) throw new Error('Legacy triangle still present')
  return { directionState: marker.dataset.heading, label: marker.getAttribute('aria-label'), transform: marker.style.transform }
})()
