// 產生 public/data/speed_cameras.json：下載內政部警政署「測速執法設置點」開放資料，
// 過濾出高雄市楠梓區＋左營區，正規化後寫成 App 直接讀的版本化資料檔。
//
// 為什麼不讓 App 直接打政府端點（資料指引第 4 節）：
//   1. 政府端點沒有 CORS，瀏覽器打不到；
//   2. 資料源短暫異常時不能讓導航跟著壞掉；
//   3. 要保留「最後同步時間」給畫面標示，也要能人工審閱這次匯入改了什麼。
// 所以資料進版控，更新是一次明確的 commit，不是 runtime 的意外。
//
// 用法：
//   node scripts/build_speed_cameras.mjs            # 線上抓最新
//   node scripts/build_speed_cameras.mjs --csv=x.csv # 用本機 CSV（離線／重現用）
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseDirectionHeadings, parseEnforcementType } from '../src/core/speedCameras.ts'

const SOURCE = {
  dataset: '測速執法設置點（data.gov.tw dataset 7320）',
  agency: '內政部警政署',
  license: '政府資料開放授權條款第 1 版',
  licenseUrl: 'https://data.gov.tw/license',
  url: 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/6D874102-9EB0-4C64-A64C-87A1ACE1D573/download',
}
const CITY = '高雄市'
const DISTRICTS = ['楠梓區', '左營區']
/** 楠梓＋左營的合理座標框：座標打錯（經緯度顛倒、少一位）就會落在框外，直接擋掉 */
const BBOX = { minLng: 120.2, maxLng: 120.42, minLat: 22.62, maxLat: 22.82 }

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../public/data/speed_cameras.json')

/** CSV 解析（含引號欄位）——地址欄可能含逗號，不能用 split(',') 硬拆 */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

const args = process.argv.slice(2)
const csvArg = args.find((a) => a.startsWith('--csv='))

let csvText
let fetchedAt
if (csvArg) {
  csvText = readFileSync(csvArg.slice('--csv='.length), 'utf8')
  fetchedAt = new Date().toISOString()
  console.log(`使用本機 CSV：${csvArg.slice('--csv='.length)}`)
} else {
  console.log('下載警政署測速執法設置點…')
  const res = await fetch(SOURCE.url)
  if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status}`)
  csvText = await res.text()
  fetchedAt = new Date().toISOString()
}

const rows = parseCsv(csvText.replace(/^﻿/, ''))
const header = rows[0].map((h) => h.trim())
// CSV 第 1 列是英文欄名、第 2 列是中文說明列——說明列不是資料，必須跳過（資料指引第 1 節）
const expected = ['CityName', 'RegionName', 'Address', 'DeptNm', 'BranchNm', 'Longitude', 'Latitude', 'direct', 'limit']
if (expected.some((name, i) => header[i] !== name)) {
  throw new Error(`來源欄位與預期不符，請先確認資料集格式：${header.join(',')}`)
}
if (rows[1][0] !== '設置縣市') {
  throw new Error(`第 2 列不是中文說明列（實際：${rows[1][0]}），格式可能已變更`)
}
const data = rows.slice(2).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
console.log(`全國 ${data.length} 筆，${CITY} ${data.filter((r) => r.CityName === CITY).length} 筆`)

const skipped = []
const cameras = []
for (const r of data) {
  if (r.CityName !== CITY || !DISTRICTS.includes(r.RegionName)) continue
  const lng = Number(r.Longitude), lat = Number(r.Latitude)
  const limit = Number(r.limit)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)
    || lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat) {
    skipped.push({ reason: '座標超出楠梓／左營範圍', address: r.Address, lng, lat })
    continue
  }
  if (!Number.isInteger(limit) || limit < 10 || limit > 120) {
    skipped.push({ reason: `速限不合理（${r.limit}）`, address: r.Address })
    continue
  }
  const { enforcementType, alsoRedLight } = parseEnforcementType(r.direct)
  const headings = parseDirectionHeadings(r.direct)
  if (headings.length === 0) {
    // 不擋掉，但要讓人看見：這種點會對兩個方向都提醒
    console.warn(`⚠ 方向文字解析不出行向，將不做方向過濾：「${r.direct}」@ ${r.Address}`)
  }
  const sourceKey = [SOURCE.dataset, lng, lat, r.Address, r.direct, limit].join('|')
  cameras.push({
    id: `npa:${createHash('sha1').update(sourceKey).digest('hex').slice(0, 12)}`,
    sourceDataset: 'npa:7320',
    enforcementType,
    ...(alsoRedLight ? { alsoRedLight: true } : {}),
    pos: [lng, lat],
    cityName: r.CityName,
    districtName: r.RegionName,
    address: r.Address,
    jurisdiction: [r.DeptNm, r.BranchNm].filter(Boolean).join(' / '),
    directionText: r.direct,
    headings,
    speedLimitKph: limit,
  })
}

cameras.sort((a, b) => (a.districtName + a.address).localeCompare(b.districtName + b.address, 'zh-TW'))

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: { ...SOURCE, fetchedAt },
  districts: DISTRICTS,
  cameras,
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')

console.log(`\n寫入 ${OUT}`)
console.log(`楠梓＋左營 ${cameras.length} 筆：`)
for (const c of cameras) {
  console.log(`  ${c.districtName} ${c.address}｜速限 ${c.speedLimitKph}｜${c.directionText}`
    + `｜行向 ${c.headings.length ? c.headings.join('/') + '°' : '（不過濾）'}`)
}
if (skipped.length) {
  console.log('\n略過：')
  for (const s of skipped) console.log(`  ${s.reason}：${s.address}`)
}
