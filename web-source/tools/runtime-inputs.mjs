import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export async function runtimeInputHash(root) {
  const hash = createHash('sha256')
  const files = (await readdir(path.join(root, 'src/core'))).filter(n => n.endsWith('.ts'))
    .sort().map(n => 'src/core/' + n)
  files.push('public/data/road_database.json', 'public/data/nanzih_buildings_height.geojson',
    'tools/build-runtime.mjs', 'tools/compact-render-data.mjs', 'tools/runtime-inputs.mjs')
  for (const file of files) hash.update(file).update(await readFile(path.join(root, file)))
  return hash.digest('hex')
}
