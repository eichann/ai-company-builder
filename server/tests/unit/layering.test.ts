/**
 * The server's layers depend inward only:
 *
 *   routes (HTTP) → services (rules, authorization) → ports (interfaces)
 *                                                       ↑
 *                          adapters (SQLite, git, clock) ┘   wired in src/composition.ts
 *
 * - ports/ import nothing but each other and shared/core (types).
 * - services/ import ports, other services, shared/core and the pure lib
 *   helpers listed below — never a database, Hono, git, the file system or
 *   an adapter.
 * - adapters/ are imported only by the composition root (and tests).
 * - routes/ that have moved to services run no SQL themselves.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

const SRC = resolve(__dirname, '../../src')

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
}

/** The import resolved against src/ (e.g. 'lib/auth', 'ports/companies'), or the bare package name. */
function target(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec
  return relative(SRC, resolve(join(file, '..'), spec))
}

/** Pure lib modules a service may use (no I/O, no database). */
const PURE_LIB = new Set(['lib/client-version', 'lib/write-loss', 'lib/overview'])

describe('server layering', () => {
  it('ports import only other ports and shared/core types', () => {
    for (const file of tsFiles(join(SRC, 'ports'))) {
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${relative(SRC, file)}: ${spec}`).toMatch(/^ports\/|^\.\.\/shared\/core\//)
      }
    }
  })

  it('services import only ports, services, shared/core and pure lib helpers', () => {
    const files = tsFiles(join(SRC, 'services'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      for (const spec of importsOf(file)) {
        const t = target(file, spec)
        const allowed = t.startsWith('ports/') || t.startsWith('services/') || t.startsWith('../shared/') || PURE_LIB.has(t)
        expect(allowed, `${relative(SRC, file)}: ${spec}`).toBe(true)
      }
    }
  })

  it('only the composition root imports adapters', () => {
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file)
      if (rel === 'composition.ts' || rel.startsWith('adapters/')) continue
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${rel}: ${spec}`).not.toMatch(/^adapters\//)
      }
    }
  })

  // Grows with each route moved onto services.
  const ROUTES_WITHOUT_SQL = ['companies.ts', 'departments.ts', 'git.ts', 'invitations.ts', 'permission-rules.ts', 'permissions.ts', 'private-folders.ts', 'company-files.ts', 'folder-sizes.ts']

  for (const name of ROUTES_WITHOUT_SQL) {
    it(`routes/${name} runs no SQL and does not touch the database connection`, () => {
      const file = join(SRC, 'routes', name)
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/\.prepare\(|\.exec\(|\.transaction\(/)
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${name}: ${spec}`).not.toMatch(/^db(\/|$)|^lib\/permission-store$|^better-sqlite3$/)
      }
    })
  }
})
