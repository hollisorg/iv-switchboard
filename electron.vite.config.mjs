import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // index: the app. scan-worker: scan passes on a worker thread.
        input: { index: resolve('src/main/index.js'), 'scan-worker': resolve('src/main/scan-worker.js') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.js') }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
