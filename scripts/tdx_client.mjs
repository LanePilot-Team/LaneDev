// TDX（運輸資料流通服務）認證與請求。**只給 Node 用**——build script 與探路腳本。
//
// 為什麼不能讓瀏覽器直接打：TDX 走 OAuth2 client_credentials，要帶 client_secret。
// 這個專案是純靜態 SPA，Vite 會把 import.meta.env.VITE_* 直接內嵌進 bundle，
// 丟上 GitHub Pages 後任何人都撿得走。所以憑證只從 .env.local 讀（已被 .gitignore 擋掉），
// 且**永遠不帶 VITE_ 前綴**——帶了就會被 Vite 收進前端。
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
export const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v2'
/**
 * token 快取：有效期 86400 秒，不要每次跑腳本都重抓（官方文件明講要做快取）。
 *
 * **刻意放在專案外的系統暫存目錄**，不是 node_modules/.cache。
 * 那個 token 是一把可以直接打 API 的鑰匙，放在專案資料夾裡的話，
 * 只要有人把整個資料夾壓縮傳出去（組員之間很常這樣傳），就等於送出一把
 * 24 小時內有效的鑰匙——而且 .gitignore 擋不到這種傳法。
 * 放系統暫存目錄就沒有這個問題：壓縮專案永遠帶不到它。
 */
const TOKEN_CACHE = join(tmpdir(), 'lanedev-tdx-token.json')

/** 極簡 .env 解析（不引 dotenv：這個專案沒有這個相依，為了兩個變數不值得加） */
function loadEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

export function tdxCredentials() {
  // 環境變數優先（CI 用 secrets 注入），其次 .env.local
  const env = { ...loadEnvFile(resolve(ROOT, '.env.local')), ...process.env }
  const clientId = env.TDX_CLIENT_ID
  const clientSecret = env.TDX_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      '找不到 TDX 憑證。請在專案根目錄建立 .env.local（已被 .gitignore 擋掉，不會進版控）：\n'
      + '  TDX_CLIENT_ID=你的 Client Id\n'
      + '  TDX_CLIENT_SECRET=你的 Client Secret\n'
      + '憑證在 TDX 會員中心取得。注意不要加 VITE_ 前綴，那會被 Vite 編進前端 bundle。',
    )
  }
  return { clientId, clientSecret }
}

async function fetchToken() {
  const { clientId, clientSecret } = tdxCredentials()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`TDX 認證失敗：HTTP ${res.status}${detail ? `\n${detail.slice(0, 300)}` : ''}`)
  }
  const body = await res.json()
  if (!body.access_token) throw new Error('TDX 認證回應沒有 access_token')
  return {
    token: body.access_token,
    // 提早 5 分鐘過期，避免長時間的 build 跑到一半 token 剛好失效
    expiresAt: Date.now() + (Number(body.expires_in ?? 86400) - 300) * 1000,
  }
}

let memoToken = null

export async function tdxToken() {
  if (memoToken && memoToken.expiresAt > Date.now()) return memoToken.token
  if (existsSync(TOKEN_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'))
      if (cached.expiresAt > Date.now()) {
        memoToken = cached
        return cached.token
      }
    } catch { /* 快取壞了就重抓，不是錯誤 */ }
  }
  memoToken = await fetchToken()
  mkdirSync(dirname(TOKEN_CACHE), { recursive: true })
  writeFileSync(TOKEN_CACHE, JSON.stringify(memoToken), 'utf8')
  return memoToken.token
}

/**
 * 節流。官方文件寫「每來源 IP 每秒 50 次」，但**實測用金鑰打大約 8 req/s 就會被
 * 429 API rate limit exceeded 擋掉**（2026-08-11 探路實測），所以真正生效的是
 * 比文件嚴格得多的每金鑰限制。這裡壓到約 1 req/s——抓靜態資料本來就不趕時間，
 * 被限流重試反而更慢。
 */
const MIN_INTERVAL_MS = 1100
/** 單次請求的伺服器端筆數上限：$top 給 20000 實際只回 1500（探路實測），超過要靠 $skip 翻頁 */
export const TDX_PAGE_LIMIT = 1500
let lastCall = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 打一支 TDX API。
 * @param path  例如 '/Bus/Stop/City/Kaohsiung'（TDX_BASE 之後的部分）
 * @param query OData 參數物件，例如 { $top: 1, $filter: "..." }（$format 自動補 JSON）
 */
export async function tdxGet(path, query = {}, opts = {}) {
  const url = new URL(TDX_BASE + path)
  for (const [k, v] of Object.entries({ $format: 'JSON', ...query })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const token = await tdxToken()

  // 重試耗盡時要能講出「最後一次到底是什麼錯」——只回 status 0 等於把診斷資訊丟掉，
  // 分不出是被限流（429）、伺服器掛了（5xx）還是連線層失敗
  let lastStatus = 0
  let lastDetail = ''
  const retries = opts.retries ?? 4
  for (let attempt = 0; attempt < retries; attempt++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall)
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    let res
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    } catch (cause) {
      lastDetail = `連線失敗：${cause instanceof Error ? cause.message : String(cause)}`
      await sleep(800 * (attempt + 1))
      continue
    }
    if (res.ok) return { ok: true, status: res.status, data: await res.json(), url: url.toString() }
    lastStatus = res.status
    lastDetail = (await res.text().catch(() => '')).slice(0, 300)
    // 429/5xx 退避重試；其他 4xx（路徑錯、參數錯）直接回報，重試沒有意義
    if (res.status !== 429 && res.status < 500) {
      return { ok: false, status: res.status, url: url.toString(), detail: lastDetail }
    }
    // 429 給比較長的冷卻——被限流時搶著重試只會繼續被擋。
    // 伺服器有講 Retry-After 就聽它的，別自己猜。
    const retryAfter = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : (res.status === 429 ? 5000 : 800) * (attempt + 1))
  }
  return {
    ok: false, status: lastStatus, url: url.toString(),
    detail: `重試 ${retries} 次仍失敗（最後：HTTP ${lastStatus} ${lastDetail}）`,
  }
}

/** 回應可能是陣列，也可能包成 { Stops: [...], UpdateTime } 之類的物件——統一取出陣列 */
export function rowsOf(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v
  }
  return []
}

/**
 * 取完整資料集：伺服器單次最多回 TDX_PAGE_LIMIT 筆，超過要靠 $skip 翻頁。
 * 沒有這層的話「全市公車站牌」會安靜地只拿到前 1500 筆——比報錯還糟，
 * 因為結果看起來完全正常，只是少了一半的站。
 */
export async function tdxGetAll(path, query = {}, opts = {}) {
  const pageSize = opts.pageSize ?? 1000 // 留餘裕，不貼著 1500 上限
  const maxPages = opts.maxPages ?? 40
  const out = []
  for (let page = 0; page < maxPages; page++) {
    const res = await tdxGet(path, { ...query, $top: pageSize, $skip: page * pageSize }, opts)
    if (!res.ok) return { ok: false, status: res.status, detail: res.detail, rows: out, url: res.url }
    const rows = rowsOf(res.data)
    out.push(...rows)
    if (rows.length < pageSize) return { ok: true, status: 200, complete: true, rows: out }
    if (opts.onPage) opts.onPage(out.length)
  }
  // 翻到上限還沒翻完：回報出來，不要假裝資料是完整的
  return { ok: true, status: 200, complete: false, rows: out }
}
