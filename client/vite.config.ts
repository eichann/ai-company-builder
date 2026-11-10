import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import { buildInfoDefine, computeBuildInfo } from './scripts/build-info'

// A preload runs in a sandboxed window (contextIsolation + sandbox: true), and a sandboxed
// preload is a classic script: Electron calls it with its own `require`, so it must be CommonJS
// — one top-level `import` and the whole preload fails, leaving its bridge missing (the Google
// Picker window showed 「この画面はアプリの中でだけ使えます。」 in release-20261109). Setting
// `rollupOptions.output.format` is not enough: vite-plugin-electron builds each entry in lib
// mode with `lib.formats` taken from package.json "type" ("module" → ['es']), and in lib mode
// Vite emits one output per lib format, overriding the output's own format. This plugin sets
// the formats to CommonJS for the preload entries (array options would be concatenated by
// mergeConfig, not replaced). Guarded by scripts/check-preloads.mjs (CI "Renderer bundle size",
// and `pnpm build` before packaging).
const commonJsPreload = (): Plugin => ({
  name: 'acb:preload-commonjs',
  config(config) {
    const lib = config.build?.lib
    if (lib) lib.formats = ['cjs']
  },
})

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
        // Google Picker's window only (google-drive.md): hands its page the config once, takes back the picked ids.
        entry: 'electron/picker-preload.ts',
        vite: {
          plugins: [commonJsPreload()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
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
          plugins: [commonJsPreload()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
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
