/**
 * The server's layers depend inward only:
 *
 *   routes (HTTP) → services (rules, authorization) → ports (interfaces)
 *                                                       ↑
 *                          adapters (SQLite, git, clock) ┘   wired in src/composition.ts (+ composition/*.ts)
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
  // sha256 of fixed content (node crypto, no I/O): the one hashing helper (approvals.md).
  'lib/content-hash',
  // Not pure (prints to stderr, reads the request id), but the one allowed way to log an error:
  // it never prints the error's text (paths, private-folder names), which a service's own
  // console.error would (.claude/rules/server.md "Request log"). No database, git or files.
  'lib/error-log', 'lib/mail-message'])

/**
 * lib/ modules that still reach the database, with the reason. A module
 * leaves this list when its storage moves behind a port (adapters/sqlite).
 */
const LIB_WITH_DATABASE: Record<string, string> = {
  'lib/auth.ts': 'Better Auth owns auth.sqlite: its one connection (authDb) is built with Better Auth here, and every route\'s sign-in check (getUserFromRequest) lives next to it',
}

/**
 * The adapters db/index.ts runs while it migrates the schema at startup, on the
 * connection it is migrating, before any service exists — each with what it does.
 * Exactly these (a new one fails, and one no longer imported must leave the list).
 */
const DB_INDEX_ADAPTERS: Record<string, string> = {
  'adapters/sqlite/permission-store': 'seedPermissionScopes: the scope store seeds every company\'s scopes',
  'adapters/sqlite/record-contents': 'migrateCompanyContents: rows written before the content store move into it (records.md "The content store")',
  'adapters/sqlite/records': 'the per-company record migrations (core interface links, outside times, まとまり parts, task and decision versions)',
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
      // composition/*.ts: the lanes' parts of the composition root (server.md "Lane markers").
      // cli/: operator commands run on their own (e.g. generate-broker-kek.ts), each its own composition root.
      // db/index.ts: only the adapters in DB_INDEX_ADAPTERS (next test).
      if (rel === 'composition.ts' || /^composition\/[^/]+\.ts$/.test(rel) || rel === 'db/index.ts' || rel.startsWith('adapters/') || rel.startsWith('cli/')) continue
      for (const spec of importsOf(file)) {
        expect(target(file, spec), `${rel}: ${spec}`).not.toMatch(/^adapters\//)
      }
    }
  })

  it('db/index.ts imports only the adapters its startup migrations run (listed with the reason)', () => {
    const file = join(SRC, 'db', 'index.ts')
    const imported = [...new Set(importsOf(file).map(spec => target(file, spec)).filter(t => /^adapters\//.test(t)))].sort()
    expect(imported, 'db/index.ts imports another adapter: run it from the composition root, or list it in DB_INDEX_ADAPTERS with the reason')
      .toEqual(Object.keys(DB_INDEX_ADAPTERS).sort())
  })

  // Test-only code (the fake HubSpot and Google in tests/fakes/, fixtures, helpers) is not in the production
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

// ---- Folder-level import cycles ----

/** Imports that name a value (static, side-effect, dynamic); `import type` and all-`type` lists are erased at build. */
function valueImportsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const typeOnly = (clause: string) => /^\s*type\s/.test(clause)
    || (/^\s*\{[^}]*\}\s*$/.test(clause) && clause.replace(/[{}]/g, '').split(',').map(n => n.trim()).filter(Boolean).every(n => /^type\s/.test(n)))
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\b([^'"]*?)from\s+['"]([^'"]+)['"]/g)].filter(m => !typeOnly(m[1])).map(m => m[2]),
    ...[...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
  ]
}

/**
 * The folder a src/ file counts under: its first folder (services, adapters, …).
 * A file directly in src/ is its own unit; composition.ts and composition/ are
 * one (the composition root and its lane parts).
 */
const folderOf = (srcPath: string) => srcPath.replace(/\.ts$/, '').split('/')[0]

/** Strongly connected groups of more than one node (Tarjan), each sorted, as 'a ⇄ b ⇄ c'. */
function cyclesIn(edges: Array<[from: string, to: string]>): string[] {
  const next = new Map<string, Set<string>>()
  for (const [a, b] of edges) if (a !== b) next.set(a, (next.get(a) ?? new Set()).add(b))
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[] = []
  const visit = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++
    stack.push(v); onStack.add(v)
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) !== index.get(v)) return
    const group: string[] = []
    let w: string
    do { w = stack.pop()!; onStack.delete(w); group.push(w) } while (w !== v)
    if (group.length > 1) out.push(group.sort().join(' ⇄ '))
  }
  for (const v of next.keys()) if (!index.has(v)) visit(v)
  return out.sort()
}

/**
 * Folder-level cycles that exist today (2026-11-09 assessment): why, and how to
 * untangle it later. No new cycle may appear (a folder joining a listed one is a
 * new cycle too); when one disappears, remove it, so the list only gets shorter.
 */
const KNOWN_FOLDER_CYCLES: Record<string, string> = {
  'adapters ⇄ db':
    'db/index.ts runs the sqlite adapters in DB_INDEX_ADAPTERS while it migrates at startup, and adapters use db/index.ts\'s '
    + 'connection. To untangle later: run those per-company migrations from the composition root right after initDatabase().',
}

describe('folder-level import cycles', () => {
  it('no new cycle between src/ folders (listed ones only shrink)', () => {
    const files = tsFiles(SRC)
    const inTree = new Set(files.map(f => relative(SRC, f)))
    const resolveFile = (t: string) => [`${t}.ts`, `${t}/index.ts`, t].find(c => inTree.has(c))
    const edges: Array<[string, string]> = []
    for (const file of files) {
      for (const spec of valueImportsOf(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue
        const to = resolveFile(target(file, spec))
        if (to) edges.push([folderOf(relative(SRC, file)), folderOf(to)])
      }
    }
    expect(edges.length, 'the check sees the imports (self-test)').toBeGreaterThan(500)
    const cycles = cyclesIn(edges)
    expect(cycles.filter(c => !(c in KNOWN_FOLDER_CYCLES)),
      'a folder now imports, directly or through others, a folder that imports it: point the dependency one way (routes → services → ports ← adapters)')
      .toEqual([])
    expect(Object.keys(KNOWN_FOLDER_CYCLES).filter(c => !cycles.includes(c)),
      'a listed cycle is gone or changed: remove it from KNOWN_FOLDER_CYCLES')
      .toEqual([])
  })

  it('finds cycles through several folders and skips type-only imports (self-test)', () => {
    expect(cyclesIn([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['e', 'f'], ['f', 'e']])).toEqual(['a ⇄ b ⇄ c', 'e ⇄ f'])
    expect(cyclesIn([['a', 'b'], ['b', 'c'], ['a', 'c']])).toEqual([])
    expect(valueImportsOf("import type { A } from './a'\nimport { type B } from './b'\nimport { type C, d } from './c'\nconst e = await import('./e')"))
      .toEqual(['./c', './e'])
    expect(folderOf('adapters/sqlite/records.ts')).toBe('adapters')
    expect(folderOf('composition.ts')).toBe('composition')
  })
})
