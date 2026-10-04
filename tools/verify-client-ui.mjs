// Debug APK only. Forward its WebView devtools socket to localhost:9223 first.
// node tools/verify-client-ui.mjs path/to/expression.js
import { readFile } from 'node:fs/promises'
const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = pages.find(p => p.url.includes('appassets'))
if (!page) throw new Error('LaneDev WebView not found')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve,reject) => {ws.onopen=resolve;ws.onerror=reject})
let id = 0
const pending = new Map()
ws.onmessage = event => {
  const data = JSON.parse(event.data)
  if (pending.has(data.id)) { pending.get(data.id)(data);pending.delete(data.id) }
}
const expression = await readFile(process.argv[2], 'utf8')
const timer = setTimeout(() => {ws.close(); console.error('Timed out');process.exitCode=1}, 55000)
try {
  const reply = await new Promise(resolve => {
    pending.set(++id, resolve)
    ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))
  })
  if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply))
  console.log(JSON.stringify(reply.result.result.value,null,2))
} finally {clearTimeout(timer);ws.close()}
