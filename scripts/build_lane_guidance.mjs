import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

function numericId(value, prefix) {
  const normalized = String(value ?? '').replace(new RegExp(`^${prefix}/`), '')
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function recordKey(record) {
  const node = record.intersectionNodeId === undefined
    ? ''
    : `@node/${record.intersectionNodeId}`
  return `${record.scope}:way/${record.wayId}${node}/${record.direction}`
}

export function extractLaneGuidance(text) {
  const output = []
  const keys = new Set()

  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const source = JSON.parse(raw)
    const identity = source.object_identity ?? {}
    if (!String(identity.object_type ?? '').includes('annotation')) continue

    const wayId = numericId(
      identity.source_osm?.osm_id ?? identity.nav_segment_key,
      'way',
    )
    if (wayId === undefined) {
      throw new Error(`invalid way identity at line ${lineIndex + 1}`)
    }

    const scope = identity.context_scope === 'intersection_approach'
      ? 'intersection_approach'
      : identity.context_scope === 'segment_direction'
        ? 'segment_direction'
        : 'legacy'
    const profiles = source.lane_nav_tags?.lane_detail_tags?.lane_profiles ?? []

    for (const profile of profiles) {
      const direction = profile.direction ?? identity.approach_direction
      if (direction !== 'forward' && direction !== 'backward') continue
      if (!Array.isArray(profile.lane_movements)) continue

      const laneCountValue = Number(profile.lane_count)
      const record = {
        wayId,
        direction,
        scope,
        ...(Number.isSafeInteger(laneCountValue) && laneCountValue > 0
          ? { laneCount: laneCountValue }
          : {}),
        laneMovements: profile.lane_movements.map(String),
      }

      if (scope === 'intersection_approach') {
        const intersectionNodeId = numericId(
          identity.applies_to_intersection_key,
          'node',
        )
        if (intersectionNodeId === undefined) {
          throw new Error(
            `intersection node missing for way/${wayId} at line ${lineIndex + 1}`,
          )
        }
        record.intersectionNodeId = intersectionNodeId
      }

      const key = recordKey(record)
      if (keys.has(key)) {
        throw new Error(`duplicate lane-guidance record ${key}`)
      }
      keys.add(key)
      output.push(record)
    }
  }

  return output.sort((a, b) =>
    a.wayId - b.wayId ||
    (a.intersectionNodeId ?? -1) - (b.intersectionNodeId ?? -1) ||
    a.direction.localeCompare(b.direction) ||
    a.scope.localeCompare(b.scope))
}

export function writeLaneGuidance({ inputPath, outputPath }) {
  const records = extractLaneGuidance(readFileSync(inputPath, 'utf8'))
  const body = `${JSON.stringify(records)}\n`
  writeFileSync(outputPath, body)
  return { records: records.length, bytes: Buffer.byteLength(body) }
}

const isCli = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isCli) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const inputPath = path.join(
    projectRoot,
    'public',
    'data',
    'lanepilot',
    'annotations.jsonl',
  )
  const outputPath = path.join(
    projectRoot,
    'public',
    'data',
    'lanepilot',
    'lane-guidance.json',
  )
  const result = writeLaneGuidance({ inputPath, outputPath })
  console.log(`lane-guidance.json：${result.records} 筆，${result.bytes} bytes`)
}
