import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import { buildInfoDefine, computeBuildInfo } from './scripts/build-info'

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          // Build identity (version + commit + date) the app sends to the
          // server; `vite` (dev) runs are marked -dev. See scripts/build-info.ts.
          define: buildInfoDefine(computeBuildInfo({ root: __dirname, dev: command === 'serve' })),
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['dugite'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                format: 'cjs',
              },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}))
