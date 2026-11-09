import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
// No editor middleware or write endpoints in the client development server.
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), {
    name: 'client-module-audit',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'client-modules.json',
        source: JSON.stringify([...this.getModuleIds()].map(id => id.replaceAll('\\\\', '/'))) })
    },
  }],
  // dev 測試工具（src/dev/，?sim）只給 vite dev 用：build 時入口換成空殼，整個目錄不進 prod 模組圖
  resolve: command === 'build' ? {
    alias: [{ find: /^(?:\.\.?\/)+dev\/index\.ts$/, replacement: fileURLToPath(new URL('./src/devStub.ts', import.meta.url)) }],
  } : {},
  build: { sourcemap: false, manifest: true },
  server: { host: '127.0.0.1', port: 5190 },
}))
