(async () => {
  const settings = document.querySelector('.client-settings')
  settings.open = true
  const voice = settings.querySelector('input[type=checkbox]')
  if (!voice.checked) voice.click()
  settings.open = false
  const statuses = []
  const receive = event => { if (event.detail.type === 'status') statuses.push(event.detail) }
  window.addEventListener('lane-native', receive)
  const start = [...document.querySelectorAll('button')].find(b => b.innerText === '開始導航')
  if (!start || start.disabled) throw new Error('Navigation not ready')
  start.click()
  const completed = () => {
    const queued = statuses.findIndex(s => s.speech?.includes('已送出語音'))
    return queued >= 0 && statuses.slice(queued + 1).some(s => s.speech?.includes('已完成播放'))
  }
  for (let i = 0; i < 200 && !completed(); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  window.removeEventListener('lane-native', receive)
  const banner = document.querySelector('.banner')?.innerText
  if (!banner) throw new Error('No GPS guidance')
  if (!completed()) throw new Error('No completed navigation speech: ' + JSON.stringify(statuses))
  const result = { banner, statuses }
  const end = [...document.querySelectorAll('button')].find(b => b.innerText.includes('結束'))
  end.click()
  return result
})()
