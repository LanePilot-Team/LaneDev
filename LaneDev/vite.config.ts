import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 手機測試走 Tailscale
    port: 5190,
    allowedHosts: true, // 允許 Tailscale MagicDNS 主機名（不只 IP）連線
  },
})
