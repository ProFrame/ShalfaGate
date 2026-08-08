import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative asset URLs work from both the custom-domain root and the
// proframe.github.io/bbnovix/ fallback while DNS is being configured.
const base = globalThis.process?.env?.VITE_BASE_PATH || '/'
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// GitHub Pages has no SPA rewrite. Shipping the built index.html as 404.html
// makes every deep link (/seder/app/forms) load the app instead of a 404 page,
// and the router then reads the real pathname.
const spaFallback = () => ({
  name: 'spa-fallback-404',
  closeBundle() {
    const index = resolve(projectRoot, 'dist/index.html')
    if (!existsSync(index)) return

    copyFileSync(index, resolve(projectRoot, 'dist/404.html'))

    // GitHub Pages serves a directory index with HTTP 200, while its 404.html
    // fallback keeps the body but still returns 404. Materialise the public
    // entry points so links such as /portal and /signup work in browsers,
    // crawlers and uptime checks alike. Dynamic tenant routes continue through
    // 404.html and are handled by the client router.
    for (const route of ['portal', 'signup', 'support', 'verify']) {
      const directory = resolve(projectRoot, 'dist', route)
      mkdirSync(directory, { recursive: true })
      copyFileSync(index, resolve(directory, 'index.html'))
    }
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
    // Production artifacts are minified and never contain source maps. This
    // reduces accidental source disclosure; authorization still lives on the
    // server because browser code can never be made impossible to inspect.
    minify: 'oxc',
    sourcemap: false,
    // The icon set and the five-language dictionaries are large and almost
    // never change; the application code changes constantly. Splitting them
    // apart means a deploy re-downloads the code and keeps the rest from cache,
    // and the browser fetches them in parallel instead of parsing one bundle.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/[name]-[hash].js`,
        assetFileNames: `assets/[name]-[hash].[ext]`,
        manualChunks(id) {
          if (id.includes('/src/i18n/')) return 'i18n';
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('write-excel-file') || id.includes('read-excel-file')) return 'spreadsheet';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react';
          return 'vendor';
        },
      },
    },
  },
})
