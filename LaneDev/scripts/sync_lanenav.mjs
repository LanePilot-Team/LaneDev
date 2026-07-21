// 同步共用程式碼到 LaneNav（發布版）：白名單「先刪後複製」鏡像，刪除也會傳播。
// LaneNav 專屬檔（App.tsx / main.tsx / package.json / vite.config / README …）
// 不在白名單內，不受影響。用法：LaneDev 下 `npm run sync-lanenav`。跑幾次結果都一樣（冪等）。
//
// 注意：不用 fs.cpSync——Node 22 在本機（路徑含中文）會直接 access violation，
// 改用 readdirSync/copyFileSync 手寫遞迴。
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const devRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const navRoot = path.resolve(devRoot, '..', 'LaneNav')

// 共用 = LaneDev 與 LaneNav 逐字相同的部分。edit/（編輯模式）刻意不在名單上。
const WHITELIST = [
  'src/core',
  'src/app',
  'src/plan',
  'src/nav',
  'src/browse',
  'src/App.css',
  'public/data',
  'public/assets/road-markings',
]

if (!existsSync(navRoot)) {
  console.error(`找不到 LaneNav 目錄：${navRoot}`)
  process.exit(1)
}

/** 遞迴複製，回傳複製的檔案數 */
function copyTree(from, to) {
  if (!statSync(from).isDirectory()) {
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
    return 1
  }
  mkdirSync(to, { recursive: true })
  let n = 0
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    n += e.isDirectory() ? copyTree(s, d) : (copyFileSync(s, d), 1)
  }
  return n
}

let total = 0
for (const rel of WHITELIST) {
  const from = path.join(devRoot, ...rel.split('/'))
  const to = path.join(navRoot, ...rel.split('/'))
  if (!existsSync(from)) {
    console.error(`白名單項目不存在：${from}`)
    process.exit(1)
  }
  rmSync(to, { recursive: true, force: true }) // 先刪後複製：LaneDev 刪掉的檔案也會從 LaneNav 消失
  const n = copyTree(from, to)
  total += n
  console.log(`✓ ${rel}（${n} 檔）`)
}
console.log(`同步完成：${WHITELIST.length} 個項目、共 ${total} 個檔案 → ${navRoot}`)
