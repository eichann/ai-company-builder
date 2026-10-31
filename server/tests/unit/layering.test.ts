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
 * - adapters/ are imported only by the composition root, operator commands
 *   in cli/ (each its own root) and tests.
 * - lib/ holds helpers and git / file-system infrastructure, not storage: it
 *   does not import the database (src/db, better-sqlite3), except the modules
 *   in LIB_WITH_DATABASE, each with its reason.
 * - routes/ run no SQL and do not touch the database connection.
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
const PURE_LIB = new Set(['lib/client-version', 'lib/write-loss', 'lib/overview', 'lib/push-rejections',
  // Not pure (prints to stderr, reads the request id), but the one allowed way to log an error:
  // it never prints the error's text (paths, private-folder names), which a service's own
  // console.error would (.claude/rules/server.md "Request log"). No database, git or files.
  'lib/error-log'])

/**
 * lib/ modules that still reach the database, with the reason. A module
 * leaves this list when its storage moves behind a port (adapters/sqlite).
 */
const LIB_WITH_DATABASE: Record<string, string> = {
  'lib/auth.ts': 'Better Auth owns auth.sqlite: its one connection (authDb) is built with Better Auth here, and every route\'s sign-in check (getUserFromRequest) lives next to it',
}

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
      // cli/: operator commands run on their own (e.g. generate-broker-kek.ts), each its own composition root.
      // db/index.ts: the schema's startup seeding runs the scope store (adapters/sqlite/permission-store.ts)
      // on the connection it is migrating, before any service exists.
      if (rel === 'composition.ts' || rel === 'db/index.ts' || rel.startsWith('adapters/') || rel.startsWith('cli/')) continue
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${rel}: ${spec}`).not.toMatch(/^adapters\//)
      }
    }
  })

  // Test-only code (the fake HubSpot in tests/fakes/, fixtures, helpers) is not in the production
  // image (server/Dockerfile copies src/ and shared/ only): src importing it would break the image
  // or, worse, ship a fake upstream.
  it('nothing in src/ imports from tests/', () => {
    for (const file of tsFiles(SRC)) {
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${relative(SRC, file)}: ${spec}`).not.toMatch(/^\.\.\/tests(\/|$)/)
      }
    }
  })

  it('lib/ does not import the database (except the listed modules)', () => {
    const seen: string[] = []
    for (const file of tsFiles(join(SRC, 'lib'))) {
      const rel = relative(SRC, file)
      const touchesDb = importsOf(file).some(spec => /^db(\/|$)|^better-sqlite3$/.test(target(file, spec)))
      if (!touchesDb) continue
      seen.push(rel)
      expect(LIB_WITH_DATABASE, `${rel} imports the database: put its storage behind a port (adapters/sqlite)`).toHaveProperty([rel])
    }
    expect(seen.sort(), 'a listed module no longer imports the database: remove it from LIB_WITH_DATABASE')
      .toEqual(Object.keys(LIB_WITH_DATABASE).sort())
  })

  // Every route, git-http.ts included: its push snapshot and private-folder
  // lookups go through services (access, scopes) like everything else.
  const ROUTES_WITHOUT_SQL = readdirSync(join(SRC, 'routes')).filter(f => f.endsWith('.ts'))

  for (const name of ROUTES_WITHOUT_SQL) {
    it(`routes/${name} runs no SQL and does not touch the database connection`, () => {
      const file = join(SRC, 'routes', name)
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/\.prepare\(|\.exec\(|\.transaction\(/)
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${name}: ${spec}`).not.toMatch(/^db(\/|$)|^adapters\/|^better-sqlite3$/)
      }
    })
  }
})
