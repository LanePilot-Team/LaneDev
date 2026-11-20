import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const web = fileURLToPath(new URL('../../web-source/', import.meta.url))
const selection = process.argv[2] ?? 'all'
if (!['all', 'simulator', 'release'].includes(selection)) {
  throw new Error('Usage: node ios/tools/build-web.mjs [all|simulator|release]')
}
const modes = selection === 'all' ? ['ios-simulator', 'ios-release'] : [`ios-${selection}`]
const run = (command, args, cwd = web) => execFileSync(command, args, { cwd, stdio: 'inherit' })

run('npm', ['ci', '--ignore-scripts'])
run('npm', ['test'])
run('node', ['tools/build-runtime.mjs'])
run('node', ['node_modules/typescript/bin/tsc', '-b'])
for (const mode of modes) {
  // Both modes are static production builds. Never inherit a caller's NODE_ENV=development.
  execFileSync('node', ['node_modules/vite/bin/vite.js', 'build', '--mode', mode], {
    cwd: web, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  })
  run('node', ['tools/package-client.mjs', mode])
  run('node', ['tools/sync-web-assets.mjs', mode], root)
}
