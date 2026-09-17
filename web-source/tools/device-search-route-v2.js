(async () => {
  const wait = async check => {
    for (let i=0; i<120 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!check()) throw new Error('UI timeout: ' + document.body.innerText)
  }
  const click = text => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === text)
    if (!button) throw new Error('Missing button: ' + text)
    button.click()
  }
  const enter = value => {
    const input = document.querySelector('.place-search-form input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (document.querySelector('.sp-close')) document.querySelector('.sp-close').click()
  await wait(() => document.querySelector('.place-search-form input'))
  if (document.querySelector('.toolbar')) throw new Error('Legacy toolbar present')
  enter('高雄大學')
  await wait(() => [...document.querySelectorAll('.place-result b')].some(el => el.innerText === '國立高雄大學'))
  const result = [...document.querySelectorAll('.place-result')].find(b => b.querySelector('b').innerText === '國立高雄大學')
  if (!result.querySelector('.place-address')?.innerText.includes('高雄市')) throw new Error('Address missing')
  result.click()
  await wait(() => document.querySelector('.place-route-methods button'))
  document.querySelector('.place-route-methods button').click()
  await wait(() => document.querySelector('input[aria-label="起點"]')?.value === '我的位置')
  await wait(() => document.querySelector('.sp-summary'))
  const initial = document.querySelector('.route-search-panel').innerText
  if (/使用目前位置作起點|自訂起終點/.test(initial)) throw new Error('Old start-mode controls present')
  document.querySelector('input[aria-label="起點"]').click()
  await wait(() => document.querySelector('input[aria-label="搜尋起點地點或地址"]'))
  enter('高雄大學郵局')
  await wait(() => document.querySelector('.place-result'))
  document.querySelector('.place-result').click()
  await wait(() => document.querySelector('input[aria-label="起點"]')?.value === '高雄大學郵局')
  const customStart = document.querySelector('input[aria-label="起點"]').value
  const endBefore = document.querySelector('input[aria-label="終點"]').value
  document.querySelector('input[aria-label="終點"]').click()
  await wait(() => document.querySelector('input[aria-label="搜尋終點地點或地址"]'))
  enter('游泳池')
  await wait(() => [...document.querySelectorAll('.place-result b')].some(el => el.innerText === '國立高雄大學游泳池'))
  const pool = [...document.querySelectorAll('.place-result')].find(b => b.querySelector('b').innerText === '國立高雄大學游泳池')
  await wait(() => !pool.querySelector('.place-address').innerText.startsWith('查詢詳細地址'))
  const poolAddress = pool.querySelector('.place-address').innerText
  pool.click()
  await wait(() => document.querySelector('input[aria-label="終點"]')?.value === '國立高雄大學游泳池')
  if (document.querySelector('input[aria-label="起點"]').value !== customStart) throw new Error('Changing end overwrote start')
  click('🛵 機車')
  await wait(() => document.querySelector('.sp-vehicle .on')?.innerText.includes('機車'))
  return { initial, customStart, endBefore, endAfter: document.querySelector('input[aria-label="終點"]').value,
    poolAddress, final: document.querySelector('.route-search-panel').innerText }
})()
