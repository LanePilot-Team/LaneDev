import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// No editor middleware or write endpoints in the client development server.
export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'client-module-audit',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'client-modules.json',
        source: JSON.stringify([...this.getModuleIds()].map(id => id.replaceAll('\\\\', '/'))) })
    },
  }],
  build: { sourcemap: false, manifest: true },
  server: { host: '127.0.0.1', port: 5190 },
})
