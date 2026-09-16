(async () => {
  const click = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text).click()
  if (![...document.querySelectorAll('input')].find(i => i.type === 'text')) click('瀏覽')
  for (let i = 0; i < 50 && ![...document.querySelectorAll('input')].find(i => i.type === 'text'); i++) await new Promise(resolve => setTimeout(resolve, 100))
  const input = [...document.querySelectorAll('input')].find(i => i.type === 'text')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '高雄大學')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  for (let i = 0; i < 50 && !document.body.innerText.includes('國立高雄大學'); i++) await new Promise(resolve => setTimeout(resolve, 100))
  return { text: document.body.innerText, buttons: [...document.querySelectorAll('button')].map(b => b.innerText) }
})()
