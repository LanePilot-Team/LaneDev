// CDP fault injection against the local debug WebView; APK files are never changed.
const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = pages.find(p => p.type === 'page' && p.url.startsWith('https://appassets.androidplatform.net/'))
if (!page) throw new Error('No LaneDev debug WebView')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen=resolve; socket.onerror=reject })
let seq=0, scriptId
const pending=new Map()
function send(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=++seq
    pending.set(id, response=>response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result))
    socket.send(JSON.stringify({id,method,params}))
  })
}
socket.onmessage = async ({data}) => {
  const message=JSON.parse(data)
  if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function state() {
  const r=await send('Runtime.evaluate',{expression:`({error:document.querySelector('.loading[role=alert]')?.innerText,
    ready:!!document.querySelector('.app')&&!document.querySelector('.loading'),
    retry:!!document.querySelector('.loading button')})`,returnByValue:true})
  return r.result?.value
}
async function until(check) {
  for(let i=0;i<120;i++){ const value=await state(); if(check(value))return value; await delay(200) }
  throw new Error('Startup state timeout: '+JSON.stringify(await state()))
}
const result=[]
try {
  await send('Page.enable')
  for(const item of [
    {mode:'navigation',text:'校驗失敗'},
    {mode:'source',text:'地圖來源載入失敗'},
  ]) {
    const hook = `(() => {
      const original = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (${JSON.stringify(item.mode)} === 'navigation' && /runtime\\/navigation\\./.test(url)) {
          return new Response('{}', {status:200,headers:{'Content-Type':'application/json'}});
        }
        const response = await original(...args);
        if (${JSON.stringify(item.mode)} === 'source' && url.includes('runtime/manifest.json')) {
          const manifest = await response.json();
          manifest.sources.dividers.file = 'dividers.' + '0'.repeat(64) + '.json';
          return new Response(JSON.stringify(manifest), {status:200,headers:{'Content-Type':'application/json'}});
        }
        return response;
      };
    })();`
    const added=await send('Page.addScriptToEvaluateOnNewDocument',{source:hook})
    scriptId=added.identifier
    await send('Page.reload',{ignoreCache:true})
    await delay(300)
    const error=await until(s=>s?.error?.includes(item.text))
    if(error.ready||!error.retry)throw new Error('Failure did not block navigation / offer retry')
    result.push(error)
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptId})
    scriptId=undefined
    await send('Page.reload',{ignoreCache:true})
    await delay(300)
    await until(s=>s?.ready)
  }
  console.log(JSON.stringify({cases:result,recovered:await state()},null,2))
} finally {
  if(scriptId) {
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptId})
    await send('Page.reload',{ignoreCache:true})
  }
  socket.close()
}
