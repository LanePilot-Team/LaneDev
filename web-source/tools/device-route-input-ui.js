(async () => {
  const wait = async check => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!check()) throw new Error('UI condition failed: ' + document.body.innerText)
  }
  const beforeStart = document.querySelector('input[aria-label="起點"]').value
  const beforeEnd = document.querySelector('input[aria-label="終點"]').value
  const beforeSummary = document.querySelector('.sp-summary').innerText
  document.querySelector('button[aria-label="更換終點"]').click()
  await wait(() => document.querySelector('input[aria-label="搜尋終點地點或地址"]'))
  const input = document.querySelector('input[aria-label="搜尋終點地點或地址"]')
  if (input.value !== beforeEnd) throw new Error('Existing name not prefilled')
  if (input.selectionStart !== 0 || input.selectionEnd !== input.value.length) throw new Error('Existing name not selected for replacement')
  if (input.labels?.[0]?.textContent !== '終點') throw new Error('Label disconnected from active input')
  if (!document.querySelector('.sp-summary .go').disabled) throw new Error('Navigation allowed during incomplete search')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '測試取消不變更')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('.route-stop.is-editing .stop-edit-action').click()
  await wait(() => document.querySelector('input[aria-label="終點"]'))
  if (document.querySelector('input[aria-label="終點"]').value !== beforeEnd ||
      document.querySelector('input[aria-label="起點"]').value !== beforeStart ||
      document.querySelector('.sp-summary').innerText !== beforeSummary) throw new Error('Cancel changed planned route')
  document.querySelector('button[aria-label="更換終點"]').click()
  await wait(() => document.querySelector('.route-stop.is-editing'))
  return { beforeStart, beforeEnd, prefillAndSelection: true, cancelPreservesRoute: true,
    editingHint: document.querySelector('.stop-editing-hint').innerText,
    toolbarAbsent: !document.querySelector('.toolbar') }
})()
