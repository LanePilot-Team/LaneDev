(async () => {
  const wait = async (check) => {
    for (let i=0; i<100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!check()) throw new Error('UI condition timed out: ' + document.body.innerText)
  }
  const buttons = () => [...document.querySelectorAll('button')]
  buttons().find(b => b.innerText.includes('國立高雄大學\n')).click()
  await wait(() => buttons().some(b => b.innerText.includes('從我的位置出發')))
  buttons().find(b => b.innerText.includes('從我的位置出發')).click()
  await wait(() => buttons().some(b => b.innerText.includes('開始導航')))
  return { text: document.body.innerText }
})()
