(async () => {
  const wait = ms => new Promise(r => setTimeout(r,ms))
  const assert = (ok,msg) => {if(!ok) throw new Error(msg)}
  const until = async (fn, msg) => {for(let i=0;i<100;i++){if(fn())return;await wait(100)}throw new Error(msg)}
  const input = (el,text) => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))}
  await until(()=>!document.querySelector('.loading'),'map load')
  const places = (await (await fetch('./data/places/places.json')).json()).places
  const destination = places.find(p=>p.name==='國立高雄大學')
  assert(destination,'fixture destination missing')
  input(document.querySelector('.place-search-form input'),'高雄大學')
  await until(()=>document.querySelectorAll('.place-result').length,'search results')
  const rows = [...document.querySelectorAll('.place-result')]
  assert(rows.every(row=>!row.querySelector('b,.place-pin,.place-source') && row.textContent===row.querySelector('.place-address').textContent),'address-only rows')
  assert(rows.every(row=>!row.textContent.includes('座標')),'candidate rows must not show coordinates or lookup annotations')
  const result = rows.find(row=>row.dataset.placeId===destination.id)
  assert(result,'fixture candidate absent'); result.click()
  await until(()=>document.querySelector('.place-route-methods button'),'route choice')
  document.querySelector('.place-route-methods button').click()
  await until(()=>document.querySelector('.sp-summary .go:not(:disabled)'),'route calculation')
  const panel = document.querySelector('.route-search-panel')
  const panelStyle = getComputedStyle(panel)
  const contentWidth = panel.clientWidth-parseFloat(panelStyle.paddingLeft)-parseFloat(panelStyle.paddingRight)
  document.querySelector('button[aria-label="更換終點"]').click()
  await wait(200)
  const form = document.querySelector('.stop-place-search .place-search-form')
  const searchWidth = form.getBoundingClientRect().width
  assert(Math.abs(searchWidth-contentWidth)<2,'search must fill panel content width')
  assert(panel.scrollWidth<=panel.clientWidth+1,'panel horizontal overflow')
  assert(document.querySelector('.sp-summary .go').disabled,'route cannot start with unconfirmed search')
  ;[...document.querySelectorAll('.stop-edit-action')].find(b=>b.textContent==='取消').click()
  await wait(200)
  const summary = document.querySelector('.sp-summary').textContent
  document.querySelector('.sp-summary .go').click()
  await until(()=>document.querySelector('.trip')?.textContent.includes('抵達'),'navigation ETA')
  const eta = document.querySelector('.trip').textContent
  assert(/約 [1-9]\d* 分鐘/.test(eta),'ETA must have remaining minutes')
  let fiber = document.querySelector('.app')[Object.keys(document.querySelector('.app')).find(k=>k.startsWith('__reactFiber$'))]
  let core
  for(;fiber;fiber=fiber.return) for(let h=fiber.memoizedState;h;h=h.next){if(h.memoizedState?.current?.mapRef)core=h.memoizedState.current}
  assert(core,'map reference unavailable')
  core.mapRef.current.fire('dragstart',{originalEvent:{}})
  await until(()=>document.querySelector('.recenter-btn'),'recenter after gesture')
  const settings = document.querySelector('.client-settings')
  const toggle = settings.querySelector('summary')
  const gap = () => settings.getBoundingClientRect().top-document.querySelector('.recenter-btn').getBoundingClientRect().bottom
  assert(gap()>=9,'closed controls overlap')
  const closedGap = gap()
  toggle.click(); await wait(100)
  assert(settings.open && getComputedStyle(settings.querySelector('.settings-collapse')).display!=='none','settings expanded state')
  assert(gap()>=9,'open controls overlap')
  const openGap = gap()
  toggle.click(); await wait(100)
  assert(!settings.open && getComputedStyle(settings.querySelector('.settings-expand')).display!=='none','repeat click closes settings')
  assert(getComputedStyle(toggle).backgroundColor!=='rgb(255, 255, 255)','settings button contrast')
  return {addressOnlyRows:rows.length,contentWidth,searchWidth,routeSummary:summary,eta,closedGap,openGap,viewport:[innerWidth,innerHeight]}
})()
