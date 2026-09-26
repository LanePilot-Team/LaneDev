import { asset } from './asset'
import { runtimeReviver, RUNTIME_FORMAT } from './runtimeCodec'
import type { buildClientRuntime } from './buildRuntime'

export type RuntimeNavigation = Awaited<ReturnType<typeof buildClientRuntime>>['navigation']
export interface RuntimeManifest {
  format: string
  inputHash: string
  navigation: { file: string; sha256: string }
  sources: Record<string, { file: string; sha256: string }>
}

export function runtimeAsset(file: string): string {
  if (!/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\.json$/.test(file)) throw new Error('路網資源路徑無效')
  return asset('/data/runtime/' + file)
}

export async function loadRuntimeData(signal: AbortSignal) {
  const response = await fetch(asset('/data/runtime/manifest.json'), { signal })
  if (!response.ok) throw new Error('找不到預計算路網，請重新安裝完整版本')
  const manifest = await response.json() as RuntimeManifest
  if (manifest.format !== RUNTIME_FORMAT || !manifest.sources?.zones || !manifest.sources.buildings) {
    throw new Error('預計算路網版本不相容')
  }
  for (const id of ['roads', 'roadSurfaces', 'dividers', 'turnbays', 'medians', 'roadtext', 'roadlabels']) {
    if (!manifest.sources[id]) throw new Error('地圖資料缺少：' + id)
  }
  const navResponse = await fetch(runtimeAsset(manifest.navigation.file), { signal })
  if (!navResponse.ok) throw new Error('無法讀取導航資料')
  const bytes = await navResponse.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
  if (hash !== manifest.navigation.sha256) throw new Error('導航資料校驗失敗，請重新安裝')
  const navigation = JSON.parse(new TextDecoder().decode(bytes), runtimeReviver) as RuntimeNavigation
  if (!navigation.roads?.length || !(navigation.laneBaseIndex.approachByKey instanceof Map)) {
    throw new Error('導航資料不完整')
  }
  return { manifest, navigation }
}
