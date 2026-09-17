// Start/end search interaction is covered by device-search-route-v2.js.
(async () => {
  const initial = document.querySelector('input[aria-label="起點"]')?.value
  if (!initial) throw new Error('First run device-search-route-v2.js to prepare a route')
  const button = document.querySelector('input[aria-label="起點"]')
  button.click()
  await new Promise(resolve => setTimeout(resolve, 300))
  document.querySelector('.location-suggestion').click()
  for (let i = 0; i < 120; i++) {
    if (document.querySelector('input[aria-label="起點"]')?.value === '我的位置') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const restored = document.querySelector('input[aria-label="起點"]')?.value
  if (restored !== '我的位置') throw new Error('Failed to restore GPS start')
  return { initial, restored }
})()
