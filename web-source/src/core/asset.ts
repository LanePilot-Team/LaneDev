/** public/ 資源路徑解析。
 * Vite 把 import.meta.env.BASE_URL 設成 vite.config 的 base：
 * dev = '/'，build = '/LaneDev/'（GitHub Pages project site 子路徑）。
 * BASE_URL 結尾一定帶 '/'，所以要去掉傳入路徑開頭的 '/'。
 *
 * 凡是 runtime 才組出來的 public 資源（fetch / MapLibre source data / SVG icon）
 * 都要包這個；ES import 的資源由 Vite 自己處理，不用包。 */
export const asset = (p: string) => import.meta.env.BASE_URL + p.replace(/^\//, '')
