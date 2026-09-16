(async () => {
  const wait = async check => {
    for (let i = 0; i < 120 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!check()) throw new Error('Start mode did not update: ' + document.body.innerText)
  }
  const click = text => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.includes(text))
    if (!button) throw new Error('Missing button: ' + text)
    button.click()
  }
  if (document.querySelector('.banner')) click('結束')
  await wait(() => [...document.querySelectorAll('button')].some(b => b.innerText === '規劃路線'))
  click('規劃路線')
  await wait(() => document.querySelector('.sp-stop')?.innerText.includes('我的位置'))
  const currentStart = document.querySelector('.sp-stop').innerText
  click('自訂起終點')
  await wait(() => document.querySelector('.sp-stop')?.innerText.includes('點擊地圖設定'))
  await new Promise(resolve => setTimeout(resolve, 1200))
  const stops = [...document.querySelectorAll('.sp-pos')].map(el => el.innerText)
  if (stops.length !== 2 || !stops[0].includes('點擊地圖設定') || stops[1] !== '未設定') {
    throw new Error('Custom selection was overwritten by GPS: ' + stops.join('; '))
  }
  document.querySelector('.sp-close').click()
  const settings = document.querySelector('.client-settings')
  settings.open = true
  const select = settings.querySelector('select')
  select.value = '20'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  const checkbox = settings.querySelector('input[type=checkbox]')
  if (!checkbox.checked) checkbox.click()
  settings.open = false
  return { currentStart, customStartAndEnd: stops, restoredZoom: 20, restoredVoice: true }
})()
