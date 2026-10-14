(async () => {
  const wait = async (check) => {
    for (let i=0; i<120 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!check()) throw new Error('Navigation did not produce HUD: ' + document.body.innerText)
  }
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native status timeout')), 4000)
    function handler(e) { if (e.detail.type === 'status') {
      clearTimeout(timer); window.removeEventListener('lane-native', handler); resolve(e.detail)
    } }
    window.addEventListener('lane-native', handler)
    LaneNative.postMessage(JSON.stringify({ type: 'status' }))
  })
  const simulationButton = [...document.querySelectorAll('button')]
    .find(b => b.innerText.includes('開始模擬導航'))
  if (status.simulationEnabled && !simulationButton) throw new Error('Debug simulation entry missing')
  if (!status.simulationEnabled && simulationButton) throw new Error('Release simulation entry exposed')
  const button = [...document.querySelectorAll('button')].find(b => b.innerText.includes('開始導航'))
  button.click()
  await wait(() => document.querySelector('.banner'))
  const text = document.body.innerText
  if (/不照指引|再跑一次/.test(text)) throw new Error('Unexpected navigation control exposed')
  const settings = document.querySelector('.client-settings')
  settings.open = true
  const select = settings.querySelector('select')
  select.value = '19'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  const checkbox = settings.querySelector('input[type=checkbox]')
  if (checkbox.checked) checkbox.click()
  await wait(() => localStorage.getItem('client.zoom') === '19' && localStorage.getItem('client.voice') === 'false')
  settings.open = false
  return { text, zoom: select.value, voice: checkbox.checked, banner: document.querySelector('.banner').innerText }
})()
