import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // React 17+ JSX transform, so test files and components need no React import.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
