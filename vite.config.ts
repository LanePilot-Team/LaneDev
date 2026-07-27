import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// build 時走 /LaneDev/（GitHub Pages project site 子路徑）；dev 維持 /。
// preview 沿用 build 的 base，本地驗證要開 http://localhost:4173/LaneDev/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/LaneDev/' : '/',
  plugins: [react()],
  server: {
    host: true, // 手機測試走 Tailscale
    port: 5190,
    allowedHosts: true, // 允許 Tailscale MagicDNS 主機名（不只 IP）連線
  },
}))
