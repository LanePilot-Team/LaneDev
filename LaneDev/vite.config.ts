import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const canonicalProjectRoot = process.cwd().endsWith('LaneNav')
  ? resolve('..', 'LaneDev')
  : resolve('.')
const databasePath = resolve(canonicalProjectRoot, 'public/data/road_database.json')
const MAX_EDITOR_BYTES = 8 * 1024 * 1024

function staticRoadDatabaseWriter() {
  return {
    name: 'lanedev-static-road-database-writer',
    configureServer(server: any) {
      server.middlewares.use('/api/static-road-database/editor', (req: any, res: any) => {
        const remote = String(req.socket?.remoteAddress ?? '')
        const origin = String(req.headers?.origin ?? '')
        const localRequest = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
        const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        if (req.method !== 'PUT' || !localRequest || !localOrigin) {
          res.statusCode = localRequest ? 405 : 403
          res.end('Static database writes are only allowed from this computer.')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= MAX_EDITOR_BYTES) chunks.push(Buffer.from(chunk))
        })
        req.on('end', async () => {
          try {
            if (size > MAX_EDITOR_BYTES) throw new Error('Editor payload is too large')
            const editor = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!Array.isArray(editor.journal) ||
                !Array.isArray(editor.waiting_zones) ||
                !Array.isArray(editor.deleted_waiting_zone_ids)) {
              throw new Error('Invalid editor payload')
            }
            const database = JSON.parse(await readFile(databasePath, 'utf8'))
            database.editor = editor
            database.updated_at = new Date().toISOString()
            const temporaryPath = `${databasePath}.tmp`
            await writeFile(temporaryPath, `${JSON.stringify(database)}\n`, 'utf8')
            await rename(temporaryPath, databasePath)
            res.statusCode = 204
            res.end()
          } catch (error) {
            console.error('Failed to update static road database', error)
            res.statusCode = 500
            res.end('Failed to update static road database')
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), staticRoadDatabaseWriter()],
  // LaneDev and its LaneNav mirror intentionally read the same physical data
  // directory. There is only one writable static road database.
  publicDir: resolve(canonicalProjectRoot, 'public'),
  server: {
    host: true, // 手機測試走 Tailscale
    port: 5190,
    allowedHosts: true, // 允許 Tailscale MagicDNS 主機名（不只 IP）連線
  },
})
