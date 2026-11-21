import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
// No editor middleware or write endpoints in the client development server.
export default defineConfig(({ command, mode }) => ({
  base: './',
  plugins: [react(), {
    name: 'client-module-audit',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (mode === 'ios') {
          return html.replace(/<script data-web-google-places>[\s\S]*?<\/script>\s*/, '')
        }
        return html
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'client-modules.json',
        source: JSON.stringify([...this.getModuleIds()].map(id => id.replaceAll('\\\\', '/'))) })
      this.emitFile({ type: 'asset', fileName: 'client-build-mode.json', source: JSON.stringify(mode) })
    },
  }],
  // dev 測試工具（src/dev/，?sim）只給 vite dev 用：build 時入口換成空殼，整個目錄不進 prod 模組圖
  resolve: command === 'build' ? {
    alias: [{ find: /^(?:\.\.?\/)+dev\/index\.ts$/, replacement: fileURLToPath(new URL('./src/devStub.ts', import.meta.url)) }],
  } : {},
  build: {
    sourcemap: false, manifest: true,
    outDir: mode === 'ios' ? '.ios-dist' : 'dist',
  },
  server: { host: '127.0.0.1', port: 5190 },
}))
