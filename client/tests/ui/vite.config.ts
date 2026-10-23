// Renderer-only Vite config for the UI preview pages (tests/*-ui.html): the
// app's React components with the preload API mocked by each page, no
// Electron plugins. Used by the Playwright UI tests (playwright.config.ts) and
// for looking at a preview by hand:
//
//   npx vite -c tests/ui/vite.config.ts      # http://localhost:5174/tests/<name>-ui.html
//
// `vite build -c tests/ui/vite.config.ts` builds every preview page into
// node_modules/.ui-tests, which the tests serve with `vite preview`: a
// production build cannot reload itself half-way through a test, as the dev
// server's dependency pre-bundling may.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pages = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('-ui.html'))
  .sort()

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { port: 5174, strictPort: true },
  preview: { port: 4179, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: path.join(root, 'node_modules/.ui-tests'),
    emptyOutDir: true,
    // Local fixtures: chunk sizes do not matter here.
    chunkSizeWarningLimit: 100_000,
    reportCompressedSize: false,
    rollupOptions: {
      input: Object.fromEntries(pages.map(name => [name.replace(/\.html$/, ''), path.join(root, 'tests', name)])),
    },
  },
})
