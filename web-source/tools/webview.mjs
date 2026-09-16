// Test/debug helper for the app's debug-only WebView (adb forward tcp:9223 ...).
import { readFile } from 'node:fs/promises'
const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = pages.find(p => p.type === 'page' && p.url.startsWith('https://appassets.androidplatform.net/'))
if (!page) throw new Error('No LaneDev WebView is connected')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let seq = 0
const waiting = new Map()
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (message.id) { waiting.get(message.id)?.(message); waiting.delete(message.id) }
}
const expression = process.argv[2] ? await readFile(process.argv[2], 'utf8') : `JSON.stringify({
  text: document.body.innerText,
  inputs: [...document.querySelectorAll('input')].map(i => ({ type:i.type, placeholder:i.placeholder })),
  buttons: [...document.querySelectorAll('button, summary')].map(i => ({ text:i.innerText, disabled:i.disabled })),
  native: typeof window.LaneNative,
})`
const id = ++seq
const timer = setTimeout(() => { console.error('WebView evaluation timed out'); socket.close(); process.exitCode = 1 }, 25000)
const result = await new Promise(resolve => {
  waiting.set(id, resolve)
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})
clearTimeout(timer)
console.log(JSON.stringify(result, null, 2))
socket.close()
if (result.error || result.result?.exceptionDetails) process.exitCode = 1
