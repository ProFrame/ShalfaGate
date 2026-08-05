import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// bbnovix.com serves the app from the domain root, because the first path
// segment is the company (`/shalfa/`, `/seder/`). Set VITE_BASE_PATH only when
// deploying under a sub-directory, such as proframe.github.io/bbnovix/.
const base = globalThis.process?.env?.VITE_BASE_PATH || '/'
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// GitHub Pages has no SPA rewrite. Shipping the built index.html as 404.html
// makes every deep link (/seder/app/forms) load the app instead of a 404 page,
// and the router then reads the real pathname.
const spaFallback = () => ({
  name: 'spa-fallback-404',
  closeBundle() {
    const index = resolve(projectRoot, 'dist/index.html')
    if (existsSync(index)) copyFileSync(index, resolve(projectRoot, 'dist/404.html'))
  },
})

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), spaFallback()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/[name]-[hash].js`,
        assetFileNames: `assets/[name]-[hash].[ext]`,
      },
    },
  },
})
