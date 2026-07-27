import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const canonicalProjectRoot = process.cwd().endsWith('LaneNav')
  ? resolve('..', 'LaneDev')
  : resolve('.')
const databasePath = resolve(canonicalProjectRoot, 'public/data/road_database.json')
const MAX_EDITOR_BYTES = 8 * 1024 * 1024
const MAX_MERGE_BYTES = 16 * 1024

function staticRoadDatabaseWriter() {
  return {
    name: 'lanedev-static-road-database-writer',
    configureServer(server: any) {
      server.middlewares.use('/api/static-road-database/merge', (req: any, res: any) => {
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
          if (size <= MAX_MERGE_BYTES) chunks.push(Buffer.from(chunk))
        })
        req.on('end', async () => {
          try {
            if (size > MAX_MERGE_BYTES) throw new Error('Merge payload is too large')
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const primaryMatch = String(payload.primary ?? '').match(/^way\/(-?\d+)@b\/(-?\d+)$/)
            const secondaryMatch = String(payload.secondary ?? '').match(/^way\/(-?\d+)@b\/(-?\d+)$/)
            if (!primaryMatch || !secondaryMatch
              || String(payload.primary) === String(payload.secondary)) {
              throw new Error('Invalid road merge keys')
            }
            const primaryId = Number(primaryMatch[1])
            const secondaryId = Number(secondaryMatch[1])
            const sameWay = primaryId === secondaryId
            const originalText = await readFile(databasePath, 'utf8')
            const database = JSON.parse(originalText)
            const wayIdOf = (record: any) => Number(
              record?.object_identity?.source_osm?.osm_id
              ?? String(record?.object_identity?.nav_segment_key ?? '').replace(/^way\//, ''),
            )
            const primary = database.segments.find((record: any) => wayIdOf(record) === primaryId)
            const secondary = sameWay
              ? primary
              : database.segments.find((record: any) => wayIdOf(record) === secondaryId)
            if (!primary || !secondary) throw new Error('Road segment was not found')
            const a = primary.geometry?.coordinates
            if (!Array.isArray(a) || a.length < 2) throw new Error('Invalid road geometry')
            const distanceM = (x: number[], y: number[]) => {
              const lat = ((x[1] + y[1]) / 2) * Math.PI / 180
              return Math.hypot(
                (x[0] - y[0]) * 111320 * Math.cos(lat),
                (x[1] - y[1]) * 110540,
              )
            }
            const aNodes0 = Array.isArray(primary.node_refs) ? primary.node_refs : []
            const syntheticBase = -900_000_000_000 - Math.abs(primaryId) * 10_000
            if (sameWay) {
              const joinNode = Number(payload.joinNode)
              const joinIndex = aNodes0.findIndex((node: unknown) => Number(node) === joinNode)
              if (!Number.isFinite(joinNode) || joinIndex <= 0 || joinIndex >= aNodes0.length - 1) {
                throw new Error('Selected blocks do not share an internal OSM node')
              }
              primary.node_refs = aNodes0.map((node: number, index: number) =>
                index === joinIndex ? syntheticBase - index : node)
            } else {
              const b0 = secondary.geometry?.coordinates
              if (!Array.isArray(b0) || b0.length < 2) throw new Error('Invalid road geometry')
              const pairs = [
                { p: 'start', s: 'start', d: distanceM(a[0], b0[0]) },
                { p: 'start', s: 'end', d: distanceM(a[0], b0[b0.length - 1]) },
                { p: 'end', s: 'start', d: distanceM(a[a.length - 1], b0[0]) },
                { p: 'end', s: 'end', d: distanceM(a[a.length - 1], b0[b0.length - 1]) },
              ].sort((x, y) => x.d - y.d)
              const join = pairs[0]
              if (join.d > 5) throw new Error(`Road endpoints are ${join.d.toFixed(1)}m apart`)
              const bNodes0 = Array.isArray(secondary.node_refs) ? secondary.node_refs : []
              const b = join.s === 'start' ? [...b0] : [...b0].reverse()
              const bNodes = join.s === 'start' ? [...bNodes0] : [...bNodes0].reverse()
              let coordinates: number[][]
              let nodeRefs: number[]
              if (join.p === 'end') {
                coordinates = [...a, ...b.slice(1)]
                nodeRefs = [...aNodes0, ...bNodes.slice(1)]
              } else {
                coordinates = [...b.slice(1).reverse(), ...a]
                nodeRefs = [...bNodes.slice(1).reverse(), ...aNodes0]
              }
              nodeRefs = coordinates.map((_, index) => {
                if (index === 0) return Number(nodeRefs[0])
                if (index === coordinates.length - 1) return Number(nodeRefs[nodeRefs.length - 1])
                return syntheticBase - index
              })
              primary.geometry.coordinates = coordinates
              primary.node_refs = nodeRefs
              database.archived_segments ??= []
              database.archived_segments.push({
                archived_at: new Date().toISOString(),
                reason: `merged_into_way/${primaryId}`,
                segment: secondary,
              })
              database.segments = database.segments.filter(
                (record: any) => wayIdOf(record) !== secondaryId,
              )
            }

            const journal = Array.isArray(database.editor?.journal) ? database.editor.journal : []
            const masterFields: Record<string, string | number> = {}
            for (const record of journal) {
              if (record.op !== 'set' || record.target?.type !== 'road') continue
              if (record.target.key === `way/${primaryId}`
                || record.target.key === String(payload.primary)) {
                Object.assign(masterFields, record.fields ?? {})
              }
            }
            const migrated = journal.flatMap((record: any) => {
              const key = String(record.target?.key ?? '')
              if (record.target?.type === 'road_merge'
                && (key.includes(`way/${primaryId}@`) || key.includes(`way/${secondaryId}@`))) return []
              if (record.target?.type === 'road'
                && (key === `way/${primaryId}` || key.startsWith(`way/${primaryId}@b/`)
                  || key === `way/${secondaryId}` || key.startsWith(`way/${secondaryId}@b/`))) return []
              if (key.startsWith(`way/${secondaryId}@`)) {
                return [{
                  ...record,
                  target: {
                    ...record.target,
                    key: key.replace(`way/${secondaryId}@`, `way/${primaryId}@`),
                  },
                }]
              }
              return [record]
            })
            if (Object.keys(masterFields).length) {
              migrated.push({
                op: 'set',
                target: { type: 'road', key: `way/${primaryId}` },
                fields: masterFields,
                author: 'rex',
                ts: new Date().toISOString(),
              })
            }
            database.editor.journal = migrated.map((record: any, index: number) => ({
              ...record,
              seq: index + 1,
            }))
            database.editor.updated_at = new Date().toISOString()
            database.updated_at = database.editor.updated_at
            const backupPath = `${databasePath}.before-merge-${Date.now()}.bak`
            await writeFile(backupPath, originalText, 'utf8')
            const temporaryPath = `${databasePath}.tmp`
            await writeFile(temporaryPath, `${JSON.stringify(database)}\n`, 'utf8')
            await rename(temporaryPath, databasePath)
            res.statusCode = 204
            res.end()
          } catch (error) {
            console.error('Failed to merge static road segments', error)
            res.statusCode = 400
            res.end(error instanceof Error ? error.message : 'Failed to merge road segments')
          }
        })
      })
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
