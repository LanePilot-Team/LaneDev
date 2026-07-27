import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const databasePath = resolve(import.meta.dirname, '../public/data/road_database.json')
const database = JSON.parse(await readFile(databasePath, 'utf8'))
const intersectionId = 256455983
const intersection = [120.285009, 22.71835]

function destination([lng, lat], bearingDeg, distanceM) {
  const angle = bearingDeg * Math.PI / 180
  return [
    lng + Math.sin(angle) * distanceM / (111320 * Math.cos(lat * Math.PI / 180)),
    lat + Math.cos(angle) * distanceM / 110540,
  ]
}

// 每個待轉區放在其進入方向停止線的前方（朝路口側），四向平均分配。
for (const zone of database.editor.waiting_zones) {
  if (Number(zone.intersectionId) !== intersectionId) continue
  const approachBearing = Number(zone.from?.bearing)
  if (!Number.isFinite(approachBearing)) continue
  zone.center = destination(intersection, approachBearing + 180, 10.5)
  zone.updatedAt = new Date().toISOString()
}

const byWay = new Map(database.segments.map((segment) => [
  Number(segment.object_identity?.source_osm?.osm_id), segment,
]))

// 德民路西南、東北兩側在路口前各加入一個 8m 控制點，
// 將進出路口切線統一為約 56.5°，保留遠端原始 OSM 幾何。
const southwest = byWay.get(23875934)
if (southwest && !southwest.node_refs.includes(-25645598301)) {
  const control = destination(intersection, 236.5, 8)
  southwest.geometry.coordinates.splice(-1, 0, control)
  southwest.node_refs.splice(-1, 0, -25645598301)
}

const northeast = byWay.get(267715881)
if (northeast && !northeast.node_refs.includes(-25645598302)) {
  const control = destination(intersection, 56.5, 8)
  northeast.geometry.coordinates.splice(1, 0, control)
  northeast.node_refs.splice(1, 0, -25645598302)
}

const now = new Date().toISOString()
database.editor.updated_at = now
database.updated_at = now
const temporaryPath = `${databasePath}.tmp`
await writeFile(temporaryPath, `${JSON.stringify(database)}\n`, 'utf8')
await rename(temporaryPath, databasePath)

console.log(JSON.stringify({
  intersectionId,
  waitingZones: database.editor.waiting_zones
    .filter((zone) => Number(zone.intersectionId) === intersectionId)
    .map(({ id, center, bearing, from }) => ({ id, center, bearing, fromBearing: from?.bearing })),
  smoothedWays: [23875934, 267715881],
}, null, 2))
