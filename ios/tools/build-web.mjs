import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const web = fileURLToPath(new URL('../../web-source/', import.meta.url))
if (process.argv.length !== 2) throw new Error('Usage: node ios/tools/build-web.mjs')
const run = (command, args, cwd = web) => execFileSync(command, args, { cwd, stdio: 'inherit' })

run('npm', ['ci', '--ignore-scripts'])
run('npm', ['test'])
run('node', ['tools/build-runtime.mjs'])
run('node', ['node_modules/typescript/bin/tsc', '-b'])
// All native build targets consume the same static production assets.
execFileSync('node', ['node_modules/vite/bin/vite.js', 'build', '--mode', 'ios'], {
  cwd: web, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
})
run('node', ['tools/package-client.mjs', 'ios'])
run('node', ['tools/sync-web-assets.mjs', 'ios'], root)
