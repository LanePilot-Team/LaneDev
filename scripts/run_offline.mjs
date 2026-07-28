// 離線 harness 執行器：把 audit/probe 腳本用 rolldown（Vite 8 自帶）打包，
// 補上只有 Vite 才會注入的 import.meta.env，再交給 node 執行。
// 用法：node scripts/run_offline.mjs scripts/merge_audit.ts
import { rolldown } from 'rolldown'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const entry = process.argv[2]
if (!entry) {
  console.error('用法：node scripts/run_offline.mjs <entry.ts> [args...]')
  process.exit(2)
}
// 輸出放在 scripts/ 內：腳本用 import.meta.url 定位 public/data，打包後的
// 檔案必須待在同一層目錄，相對路徑才會一致。
const outfile = resolve('scripts/.offline-harness.mjs')
const bundle = await rolldown({
  input: resolve(entry),
  platform: 'node',
  transform: { define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false' } },
  external: (id) => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:/.test(id),
})
await bundle.write({ file: outfile, format: 'esm' })
await bundle.close()
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(3)], { stdio: 'inherit' })
rmSync(outfile, { force: true })
process.exit(run.status ?? 1)
