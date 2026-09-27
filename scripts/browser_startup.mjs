// 瀏覽器端啟動量測（perf-lab E9 起的主要工具）：headless Chrome 經 CDP 開 dev server。
// Node harness（startup_profile.ts）只模擬幾何管線，09-27 證實它漏掉了真實載入路徑
// 的最大宗（待轉區匯入 16 秒），所以結論一律以這支的數字為準。
//   ready     navigate → `.loading` 消失且 __map 存在
//   ltSum/ltMax  ready 前 long task 總和／最長一筆
//   prefetch  ready 後，背景補算車道級幾何完成所需時間（-1 = 該版本沒有延後機制）
//   zoomIn    jumpTo zoom 16.5 → map idle
//   zoneSig   待轉區推導結果的 sha1 前 12 碼（對拍用；舊版未曝露時為 null 的雜湊）
// 用法：npm run dev 後
//   node scripts/browser_startup.mjs [url=http://localhost:5190/] [runs=3] [--profile]
//   --profile  以 CDP Profiler 取樣，印 startup 與 zoomIn 兩段的 self/inclusive 前幾名
//   SHOT=<前綴> VIEWS="lng,lat,zoom;..."  在各視角截圖（視覺回歸）
// 注意：headless 無 GPU、走軟體渲染，絕對值偏大；比較版本請交錯 A/B。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const URL_ = pos[0] ?? 'http://localhost:5190/'
const RUNS = Number(pos[1] ?? 3)
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function summarize(send, label) {
  const { result: { profile } } = await send('Profiler.stop')
  console.log(`===== ${label} =====`)
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const dt = profile.timeDeltas; const self = new Map()
    profile.samples.forEach((sid, i) => { const n = byId.get(sid); const f = n.callFrame
      const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`
      self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000) })
    // 含子呼叫的總時間（inclusive）：沿父鏈累加
    const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const incl = new Map()
    profile.samples.forEach((sid, i) => { const seen = new Set(); let id = sid
      while (id !== undefined) { const f = byId.get(id).callFrame
        const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`
        if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + (dt[i] ?? 0) / 1000) }
        id = parent.get(id) } })
    console.log('--- self top 25 ---')
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v.toFixed(0).padStart(7), k)
    console.log('--- inclusive top 40 ---')
    for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(v.toFixed(0).padStart(7), k)
  }

async function once() {
  const dir = mkdtempSync(join(tmpdir(), 'wc-'))
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--window-size=1280,800', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let targets
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break } catch {}
    await sleep(200)
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0; const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Page.enable'); await send('Runtime.enable')
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]) })
      .observe({ entryTypes: ['longtask'] });` })
  const PROFILE = process.argv.includes('--profile')
  if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start') }
  const t0 = Date.now()
  await send('Page.navigate', { url: URL_ })
  // 等 .loading 出現後再消失（避免量到還沒 render 的空頁）
  let seen = false
  for (;;) {
    const has = await evaluate(`!!document.querySelector('.loading')`)
    if (has) seen = true
    if (seen && !has && await evaluate(`!!window.__map`)) break
    if (Date.now() - t0 > 180000) throw new Error('timeout')
    await sleep(50)
  }
  const ready = Date.now() - t0
  if (PROFILE) await summarize(send, 'startup')
  const zoneSig = await evaluate(`(async () => { const t = JSON.stringify(window.__baseZones ?? null);
    const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t));
    return [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('') + ' n=' + (window.__baseZones?.zones.length ?? -1) })()`)
  const lt = await evaluate(`window.__lt`)
  const ltSum = lt.reduce((s, [, d]) => s + d, 0); const ltMax = Math.max(0, ...lt.map(([, d]) => d))
  // 背景補算（若有）：等延後的車道級幾何補完，量從 ready 起算的時間
  let prefetch = -1
  if (await evaluate(`!!window.__lanePaintDirty`)) {
    const tp = Date.now()
    while (await evaluate(`window.__lanePaintDirty.roads || window.__lanePaintDirty.bays`)) await sleep(50)
    prefetch = Date.now() - tp
  }
  await evaluate(`new Promise((res) => window.__map.loaded() ? res() : window.__map.once('idle', res))`)
  await sleep(1500) // 讓初始渲染穩定
  if (PROFILE) await send('Profiler.start')
  const ltBefore = await evaluate(`window.__lt.length`)
  const zoomIn = await evaluate(`new Promise((res) => { const m = window.__map; const t = performance.now();
    m.once('idle', () => res(performance.now() - t)); m.jumpTo({ zoom: 16.5 }) })`)
  const zlt = await evaluate(`window.__lt.slice(${ltBefore})`)
  const zoomLtMax = Math.round(Math.max(0, ...zlt.map(([, d]) => d)))
  if (process.env.SHOT) {
    // 固定視角截圖做視覺回歸：SHOT=前綴，VIEWS 為 lng,lat,zoom 以分號分隔
    const { writeFileSync } = await import('node:fs')
    const views = (process.env.VIEWS ?? '').split(';').filter(Boolean)
    for (const [k, v] of views.entries()) {
      const [lng, lat, z] = v.split(',').map(Number)
      await evaluate(`new Promise((res) => { const m = window.__map; m.once('idle', res); m.jumpTo({ center: [${lng}, ${lat}], zoom: ${z}, pitch: 0, bearing: 0 }) })`)
      await sleep(500)
      const { result } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${process.env.SHOT}_${k}.png`, Buffer.from(result.data, 'base64'))
    }
  }
  if (PROFILE) await summarize(send, 'zoomIn')
  ws.close(); proc.kill()
  await sleep(500)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  return { zoneSig, ready, ltSum: Math.round(ltSum), ltMax: Math.round(ltMax), prefetch, zoomIn: Math.round(zoomIn) }
}

const rows = []
for (let i = 0; i < RUNS; i++) { const r = await once(); rows.push(r); console.log(JSON.stringify(r)) }
const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
console.log(`median ready ${med('ready')} ms  longTask sum ${med('ltSum')} max ${med('ltMax')}  zoomIn ${med('zoomIn')} ms  prefetch ${med('prefetch')}`)
