/**
 * shared/core is the one copy of the rules the server, the desktop app and
 * the admin console share. It must stay dependency-free so every one of them
 * (Node + tsx, the push checker, Electron main, the renderer, Next.js) can
 * import it: modules there import only each other — no Node built-ins,
 * packages, Electron, React, Hono, database or git — and use no Node globals.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const CORE = resolve(__dirname, '../../../shared/core')

describe('shared/core purity', () => {
  const files = readdirSync(CORE).filter(f => f.endsWith('.ts'))

  it('has modules', () => {
    expect(files).toContain('index.ts')
    expect(files.length).toBeGreaterThan(3)
  })

  for (const file of files) {
    it(`${file} imports only sibling core modules and uses no Node globals`, () => {
      const source = readFileSync(join(CORE, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
      const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
      for (const s of specifiers) expect(s, `${file}: ${s}`).toMatch(/^\.\/[\w-]+$/)
      expect(source, `${file}: dynamic import / require`).not.toMatch(/\brequire\(|\bimport\(/)
      expect(source, `${file}: Node globals`).not.toMatch(/\b(Buffer|process|__dirname|__filename)\b/)
    })
  }
})
