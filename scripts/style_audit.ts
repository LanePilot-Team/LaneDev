// 地圖樣式稽核（node scripts/run_offline.mjs scripts/style_audit.ts）
//
// buildStyle() 的圖層規格只有在瀏覽器實際載入時才會被驗證，而 MapLibre 在
// Browser pane 沒有顯示時根本不會 load style（所有 getLayer 都回 undefined），
// 改圖層等於沒有回饋。這支用 MapLibre 自己的 style-spec 驗證器離線把關。
//
//   --layer=<id 前綴>  只列出符合前綴的圖層（預設列全部的 id/type/source）
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { buildStyle } from '../src/core/mapStyle'

const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const PREFIX = arg('layer', '')

const style = buildStyle()
const errors = validateStyleMin(style as never)
for (const e of errors) console.error(`✗ ${e.message}`)

const layers = style.layers.filter((l) => l.id.startsWith(PREFIX))
console.log(`圖層 ${layers.length}${PREFIX ? `（前綴 ${PREFIX}）` : ''}／全部 ${style.layers.length}：`)
for (const l of layers) {
  const src = 'source' in l ? l.source : '—'
  const zoom = [l.minzoom ?? '', l.maxzoom ?? ''].join('–')
  console.log(`  ${l.id.padEnd(28)} ${String(l.type).padEnd(8)} ${String(src).padEnd(14)} zoom ${zoom}`)
}
console.log(`\n樣式錯誤：${errors.length}`)
process.exit(errors.length ? 1 : 0)
