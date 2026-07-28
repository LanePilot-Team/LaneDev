import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {
  copyFile, mkdir, readFile, readdir, rename, unlink, writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

const databasePath = resolve('public/data/road_database.json')
const backupDirectory = resolve('.lanedev-backups')
const MAX_EDITOR_BYTES = 8 * 1024 * 1024
const MAX_MERGE_BYTES = 32 * 1024
const MAX_BACKUPS = 3

const isLocalWrite = (req: any) => {
  const remote = String(req.socket?.remoteAddress ?? '')
  const origin = String(req.headers?.origin ?? '')
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
    && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

const readBody = (req: any, limit: number) => new Promise<any>((resolveBody, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= limit) chunks.push(Buffer.from(chunk))
  })
  req.on('end', () => {
    if (size > limit) return reject(new Error('Payload is too large'))
    try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { reject(new Error('Invalid JSON payload')) }
  })
})

const atomicWrite = async (database: any) => {
  const temporaryPath = `${databasePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(database)}\n`, 'utf8')
  await rename(temporaryPath, databasePath)
}

async function createMergeBackup() {
  await mkdir(backupDirectory, { recursive: true })
  const name = `road_database.before-merge-${Date.now()}.json`
  await copyFile(databasePath, resolve(backupDirectory, name))
  const backups = (await readdir(backupDirectory))
    .filter((file) => file.startsWith('road_database.before-merge-') && file.endsWith('.json'))
    .sort()
  for (const file of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
    await unlink(resolve(backupDirectory, file))
  }
}

const segmentOsmId = (record: any) => Number(
  record?.object_identity?.source_osm?.osm_id
  ?? String(record?.object_identity?.nav_segment_key ?? '').match(/^way\/(-?\d+)/)?.[1],
)

const segmentIdentityMatches = (record: any, identity: any) => {
  const objectIdentity = record?.object_identity ?? {}
  return segmentOsmId(record) === Number(identity?.osmId)
    && String(objectIdentity.nav_segment_key ?? '') === String(identity?.navSegmentKey ?? '')
    && Number(objectIdentity.split_index ?? 0) === Number(identity?.splitIndex ?? 0)
    && Array.isArray(record?.node_refs)
    && record.node_refs.some((node: unknown) => Number(node) === Number(identity?.blockNode))
}

const uniqueSyntheticNode = (seed: number, existing: unknown[]) => {
  const used = new Set(existing.map((node) => Number(node)))
  let candidate = seed
  // 連續捏合時 joinNode 可能本身就是相同公式產生的負節點；必須再往下取新值，
  // 否則 API 雖成功，靜態拓撲實際完全沒變。
  while (used.has(candidate)) candidate--
  return candidate
}

const replaceWayInKey = (key: string, fromWay: number, toWay: number) =>
  key.replace(new RegExp(`^way/${fromWay}(?=@|$)`), `way/${toWay}`)

function migrateEditorForMerge(
  editor: any,
  primaryId: number,
  secondaryId: number,
  joinNode: number,
) {
  editor ??= {}
  const journal = Array.isArray(editor.journal) ? editor.journal : []
  const primaryFields: Record<string, string | number> = {}
  for (const record of journal) {
    if (record.op === 'set' && record.target?.type === 'road'
      && (record.target.key === `way/${primaryId}`
        || record.target.key.startsWith(`way/${primaryId}@b/`))) {
      Object.assign(primaryFields, record.fields ?? {})
    }
  }

  const migrated = journal.flatMap((record: any) => {
    const key = String(record.target?.key ?? '')
    if (record.target?.type === 'road_merge'
      && (key.includes(`way/${primaryId}@`) || key.includes(`way/${secondaryId}@`))) return []
    if (key.includes(`@node/${joinNode}`) || key.includes(`@b/${joinNode}`)) return []
    if (record.target?.type === 'road'
      && (key === `way/${primaryId}` || key.startsWith(`way/${primaryId}@b/`)
        || key === `way/${secondaryId}` || key.startsWith(`way/${secondaryId}@b/`))) return []
    if (secondaryId !== primaryId && key.startsWith(`way/${secondaryId}@`)) {
      return [{
        ...record,
        target: { ...record.target, key: replaceWayInKey(key, secondaryId, primaryId) },
      }]
    }
    return [record]
  })
  if (Object.keys(primaryFields).length) {
    migrated.push({
      op: 'set',
      target: { type: 'road', key: `way/${primaryId}` },
      fields: primaryFields,
      author: 'unknown',
      ts: new Date().toISOString(),
    })
  }
  editor.journal = migrated.map((record: any, index: number) => ({ ...record, seq: index + 1 }))

  const zones = Array.isArray(editor.waiting_zones) ? editor.waiting_zones : []
  const removedZoneIds = zones
    .filter((zone: any) => Number(zone.intersectionId) === joinNode)
    .map((zone: any) => String(zone.id))
  editor.waiting_zones = zones.filter((zone: any) => Number(zone.intersectionId) !== joinNode)
  editor.deleted_waiting_zone_ids = [
    ...new Set([
      ...(Array.isArray(editor.deleted_waiting_zone_ids)
        ? editor.deleted_waiting_zone_ids.map(String) : []),
      ...removedZoneIds,
    ]),
  ]
  editor.updated_at = new Date().toISOString()
  return editor
}

/** 同一條畫面道路的兩個區塊捏合：只收斂被選取的兩筆 road 設定。
 * 不碰路口元件、待轉區或同 way 的其他區塊，避免內部節點忽略擴散成整條路覆寫。 */
function migrateEditorForInternalMerge(
  editor: any,
  wayId: number,
  primaryBlockNode: number,
  secondaryBlockNode: number,
) {
  editor ??= {}
  const journal = Array.isArray(editor.journal) ? editor.journal : []
  const primaryKey = `way/${wayId}@b/${primaryBlockNode}`
  const secondaryKey = `way/${wayId}@b/${secondaryBlockNode}`
  const mergedFields: Record<string, string | number> = {}
  // 次段先、保留段後：欄位衝突時以首先選取的保留段樣式為準。
  for (const wantedKey of [secondaryKey, primaryKey]) {
    for (const record of journal) {
      if (record.op === 'set' && record.target?.type === 'road'
        && record.target?.key === wantedKey) {
        Object.assign(mergedFields, record.fields ?? {})
      }
    }
  }
  const migrated = journal.filter((record: any) => {
    const key = String(record.target?.key ?? '')
    return !(record.target?.type === 'road' && (key === primaryKey || key === secondaryKey))
  })
  if (Object.keys(mergedFields).length) {
    migrated.push({
      op: 'set',
      target: { type: 'road', key: primaryKey },
      fields: mergedFields,
      author: 'unknown',
      ts: new Date().toISOString(),
    })
  }
  editor.journal = migrated.map((record: any, index: number) => ({ ...record, seq: index + 1 }))
  editor.updated_at = new Date().toISOString()
  return editor
}

function staticRoadDatabaseWriter() {
  return {
    name: 'lanedev-static-road-database-writer',
    configureServer(server: any) {
      server.middlewares.use('/api/static-road-database/merge', async (req: any, res: any) => {
        if (req.method !== 'PUT' || !isLocalWrite(req)) {
          res.statusCode = isLocalWrite(req) ? 405 : 403
          res.end('Static database writes are only allowed from this computer.')
          return
        }
        try {
          const payload = await readBody(req, MAX_MERGE_BYTES)
          const joinNode = Number(payload.joinNode)
          if (!Number.isFinite(joinNode)) throw new Error('Invalid join node')
          const originalText = await readFile(databasePath, 'utf8')
          const database = JSON.parse(originalText)
          const internalCarrierIndex = payload.internalCarrier?.internalOnly
            ? database.segments.findIndex(
              (record: any) => segmentIdentityMatches(record, payload.internalCarrier),
            )
            : -1
          if (payload.internalCarrier?.internalOnly) {
            if (internalCarrierIndex < 0) {
              throw new Error('找不到承載中間路口的原始靜態道路分段，請重新載入後再捏合')
            }
            const carrier = database.segments[internalCarrierIndex]
            const joinIndex = carrier.node_refs.findIndex(
              (node: unknown) => Number(node) === joinNode,
            )
            if (joinIndex <= 0 || joinIndex >= carrier.node_refs.length - 1) {
              throw new Error('選取區塊沒有共用可忽略的內部 OSM 節點')
            }
            const logicalPrimaryId = Number(payload.primary?.osmId)
            const logicalSecondaryId = Number(payload.secondary?.osmId)
            carrier.lane_nav_tags ??= {}
            const restricted = new Set<number>(
              (carrier.lane_nav_tags.one_side_entry_nodes ?? []).map(Number),
            )
            restricted.add(joinNode)
            carrier.lane_nav_tags.one_side_entry_nodes = [...restricted]
            database.editor = migrateEditorForInternalMerge(
              database.editor,
              logicalPrimaryId,
              Number(payload.primary?.blockNode),
              Number(payload.secondary?.blockNode),
            )
            database.updated_at = new Date().toISOString()
            await createMergeBackup()
            await atomicWrite(database)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              ok: true,
              operation: 'ignore_internal_junction',
              carrier: payload.internalCarrier,
            }))
            return
          }
          const primaryIndex = database.segments.findIndex(
            (record: any) => segmentIdentityMatches(record, payload.primary),
          )
          const secondaryIndex = database.segments.findIndex(
            (record: any) => segmentIdentityMatches(record, payload.secondary),
          )
          if (primaryIndex < 0 || secondaryIndex < 0) {
            throw new Error('找不到精確的靜態道路分段，請重新載入後再捏合')
          }
          const primary = database.segments[primaryIndex]
          const secondary = database.segments[secondaryIndex]
          const primaryId = segmentOsmId(primary)
          const secondaryId = segmentOsmId(secondary)
          const sameSegment = primaryIndex === secondaryIndex
          primary.lane_nav_tags ??= {}
          const restricted = new Set<number>(
            (primary.lane_nav_tags.one_side_entry_nodes ?? []).map(Number),
          )
          restricted.add(joinNode)
          primary.lane_nav_tags.one_side_entry_nodes = [...restricted]

          if (sameSegment) {
            const joinIndex = primary.node_refs.findIndex(
              (node: unknown) => Number(node) === joinNode,
            )
            if (joinIndex <= 0 || joinIndex >= primary.node_refs.length - 1) {
              throw new Error('選取區塊沒有共用可忽略的內部 OSM 節點')
            }
            // 保留實際交會節點；樣式連續由合併後的單一 segment 負責，
            // 導航則以 one_side_entry_nodes 限制對向左轉。
          } else {
            const a = primary.geometry?.coordinates
            const b0 = secondary.geometry?.coordinates
            const aNodes = [...(primary.node_refs ?? [])]
            const bNodes0 = [...(secondary.node_refs ?? [])]
            if (!Array.isArray(a) || !Array.isArray(b0)
              || a.length < 2 || b0.length < 2
              || a.length !== aNodes.length || b0.length !== bNodes0.length) {
              throw new Error('道路幾何與節點資料不完整')
            }
            const distanceM = (x: number[], y: number[]) => {
              const lat = ((x[1] + y[1]) / 2) * Math.PI / 180
              return Math.hypot(
                (x[0] - y[0]) * 111320 * Math.cos(lat),
                (x[1] - y[1]) * 110540,
              )
            }
            const joins = [
              { p: 'start', s: 'start', d: distanceM(a[0], b0[0]) },
              { p: 'start', s: 'end', d: distanceM(a[0], b0.at(-1)) },
              { p: 'end', s: 'start', d: distanceM(a.at(-1), b0[0]) },
              { p: 'end', s: 'end', d: distanceM(a.at(-1), b0.at(-1)) },
            ].sort((x, y) => x.d - y.d)
            const join = joins[0]
            if (join.d > 5) throw new Error(`道路端點相距 ${join.d.toFixed(1)}m，無法安全捏合`)
            const b = join.s === 'start' ? [...b0] : [...b0].reverse()
            const bNodes = join.s === 'start' ? bNodes0 : bNodes0.reverse()
            let coordinates: number[][]
            let nodeRefs: number[]
            if (join.p === 'end') {
              coordinates = [...a, ...b.slice(1)]
              nodeRefs = [...aNodes, ...bNodes.slice(1)]
              nodeRefs[aNodes.length - 1] = joinNode
            } else {
              coordinates = [...b.slice(1).reverse(), ...a]
              nodeRefs = [...bNodes.slice(1).reverse(), ...aNodes]
              nodeRefs[bNodes.length - 1] = joinNode
            }
            primary.geometry.coordinates = coordinates
            primary.node_refs = nodeRefs
            database.segments.splice(secondaryIndex, 1)
          }

          database.editor = migrateEditorForMerge(
            database.editor, primaryId, secondaryId, joinNode,
          )
          if (secondaryId !== primaryId && Array.isArray(database.annotations)) {
            database.annotations = database.annotations.flatMap((annotation: any) => {
              const identity = annotation?.object_identity ?? {}
              const key = String(identity.nav_segment_key ?? '')
              const context = String(identity.context_scope ?? '')
              if (key === `way/${secondaryId}`) {
                return [{
                  ...annotation,
                  object_identity: {
                    ...identity,
                    nav_segment_key: `way/${primaryId}`,
                  },
                }]
              }
              return [annotation]
            })
          }
          database.updated_at = database.editor.updated_at
          await createMergeBackup()
          await atomicWrite(database)
          res.statusCode = 204
          res.end()
        } catch (error) {
          console.error('Failed to merge static road segments', error)
          res.statusCode = 400
          res.end(error instanceof Error ? error.message : 'Failed to merge road segments')
        }
      })

      server.middlewares.use('/api/static-road-database/editor', async (req: any, res: any) => {
        if (req.method !== 'PUT' || !isLocalWrite(req)) {
          res.statusCode = isLocalWrite(req) ? 405 : 403
          res.end('Static database writes are only allowed from this computer.')
          return
        }
        try {
          const payload = await readBody(req, MAX_EDITOR_BYTES)
          const editor = payload?.editor
          const baseUpdatedAt = String(payload?.base_updated_at ?? '')
          if (!Array.isArray(editor.journal)
            || !Array.isArray(editor.waiting_zones)
            || !Array.isArray(editor.deleted_waiting_zone_ids)) {
            throw new Error('Invalid editor payload')
          }
          const database = JSON.parse(await readFile(databasePath, 'utf8'))
          const currentUpdatedAt = String(database.editor?.updated_at ?? '')
          if (baseUpdatedAt !== currentUpdatedAt) {
            res.statusCode = 409
            res.end('儲存衝突：靜態資料庫已被捏合或其他頁籤更新，請重新整理後再編輯')
            return
          }
          database.editor = editor
          database.updated_at = new Date().toISOString()
          await atomicWrite(database)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, updated_at: editor.updated_at }))
        } catch (error) {
          console.error('Failed to update static road database', error)
          res.statusCode = 500
          res.end('Failed to update static road database')
        }
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/LaneDev/' : '/',
  plugins: [react(), staticRoadDatabaseWriter()],
  server: {
    host: true,
    port: 5190,
    allowedHosts: true,
  },
}))
