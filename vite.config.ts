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
const MAX_BACKUPS = 1 // 唯一版本 + 一份上版本備份，不留多份互相搶優先權的資料集

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

/**
 * 捏合後遷移 editor。journal 是 append-only 的歷程，遷移只准改鍵、不准刪紀錄。
 *
 * 舊版會（a）丟掉任何鍵提到接點的紀錄，（b）把 primary／secondary 兩條 way 的所有
 * 區塊級 road 紀錄整批刪除、壓平成一筆 way 級紀錄。後果是掛在接點那一塊的
 * `deleted:1` 直接蒸發（使用者刪掉的路段自己復活）、次 way 的區塊設定全數遺失，
 * 而且整條路被迫吃同一組車道設定。捏合對 couplet 道路又常常是 no-op，等於白白
 * 拿真實資料去換一個沒發生的合併。
 */
export function migrateEditorForMerge(
  editor: any,
  primaryId: number,
  secondaryId: number,
  primaryBlockNode: number,
  secondaryBlockNode: number,
) {
  editor ??= {}
  const journal = Array.isArray(editor.journal) ? editor.journal : []
  // 次分段被 splice 出 segments 後，它的鍵要改掛到保留 way；同分段捏合則不必。
  const absorbed = secondaryId !== primaryId
  const primaryKey = `way/${primaryId}@b/${primaryBlockNode}`
  const secondaryKey = `way/${secondaryId}@b/${secondaryBlockNode}`

  // 被選取的兩個區塊合而為一：次段先、保留段後，欄位衝突時以首先選取的保留段為準。
  // 與 migrateEditorForInternalMerge 同一套規則。
  const mergedFields: Record<string, string | number> = {}
  for (const wantedKey of [secondaryKey, primaryKey]) {
    for (const record of journal) {
      if (record.op === 'set' && record.target?.type === 'road'
        && String(record.target?.key ?? '') === wantedKey) {
        Object.assign(mergedFields, record.fields ?? {})
      }
    }
  }

  const migrated = journal.map((record: any) => {
    const key = String(record.target?.key ?? '')
    if (!absorbed || !key.startsWith(`way/${secondaryId}@`)) return record
    return {
      ...record,
      target: { ...record.target, key: replaceWayInKey(key, secondaryId, primaryId) },
    }
  })
  // 合併結果補在最後（foldJournal 取最後值）。原始兩筆保留不動：捏合後只有一個
  // 區塊鍵會是活的，另一個變孤兒也還躺在歷程裡，之後可以重新指回去或還原。
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

  // 接點上的待轉區同樣不刪。捏合常常是 no-op（couplet 道路尤其），刪掉就是拿真實
  // 資料換一個沒發生的合併；而路口真的消失時，mapCore 載入待轉區本來就會用
  // nodeRemap ＋ 30 公尺內最近路口吸附補救，留著比刪掉安全。
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
  // 歷程保持 append-only：原始兩個區塊紀錄不可刪除。靜態幾何捏合後只有
  // primaryKey 會繼續生效，最後追加的收斂紀錄負責提供完整樣式；保留舊紀錄
  // 才能避免 deleted、自訂標線等人工資訊因捏合而永久遺失。
  const migrated = [...journal]
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
            database.editor, primaryId, secondaryId,
            Number(payload.primary?.blockNode), Number(payload.secondary?.blockNode),
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
