// The app's module boundaries, checked over the whole tree (lint only sees
// the files a pull request changes). The server's equivalent is
// server/tests/unit/layering.test.ts; the reasons are in
// .claude/rules/ipc-and-main-process.md and chat-and-agents.md.
//
//   client/shared/            pure: imports only itself and the repository's
//                             shared/ (no packages, no Node, no Electron);
//                             listed folders may use one listed package
//   electron/features|services|ipc/
//                             never import Electron (the shell injects it)
//   electron/agents/          the agents; never import the shell, features,
//                             services or sync — the host hands them what
//                             they need (AgentHostConfig)
//   agents/claude, codex*, anthropic-api
//                             one agent's implementation: reached through
//                             agents/registry.ts, except by the composition
//                             root and that agent's own hand-off module
//   agent ids ('claude-code', 'codex', 'api-key')
//                             compared only inside the agent modules; anything
//                             else asks the registry (`agentCan`, AGENTS[id]).
//                             Known exceptions are listed with their reason and
//                             must keep occurring.
//   src/features/<name>/      renderer features (.claude/rules/renderer-structure.md):
//                             never import another feature; app/ composes them.
//                             Listed exceptions only, each with its reason.
//   src/shared/               never imports src/features or src/app
//   window.electronAPI        in the renderer only through a data layer
//                             (src/features/<name>/api.ts, src/shared/ipc/);
//                             the files that still call it directly are a
//                             list that may only shrink.
//   type names                an exported type's name is defined nowhere else in
//                             client/src, client/shared or shared (listed
//                             exceptions only)
//   exhaustive-deps           disabled in client/src at most as often as today,
//                             each time with a reason
//   useEffect                 called in client/src at most as often as today
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string, { tests = false } = {}): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p, { tests })
    return /\.tsx?$/.test(name) && (tests || !/\.test\.tsx?$/.test(name)) ? [p] : []
  })
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Every module specifier a file imports or re-exports (static and dynamic). */
function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'))
  const specs = [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]
  return specs.map(m => m[1])
}

/** Client-relative path of a relative or `@/` import ('electron/agents/claude'), or `pkg:<specifier>`. */
function target(file: string, spec: string): string {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`.replace(/\.tsx?$/, '') // tsconfig / Vite alias
  if (!spec.startsWith('.')) return `pkg:${spec}`
  return relative(CLIENT, resolve(dirname(file), spec)).replace(/\.tsx?$/, '')
}

const rel = (file: string) => relative(CLIENT, file)

function violations(files: string[], allowed: (t: string, file: string) => boolean): string[] {
  const out: string[] = []
  for (const file of files) {
    for (const spec of importsOf(file)) {
      if (!allowed(target(file, spec), file)) out.push(`${rel(file)}: ${spec}`)
    }
  }
  return out
}

/**
 * Packages a client/shared folder may import, with the reason. Each must be
 * pure JavaScript (no Node, DOM or Electron) and keep being used.
 */
const CLIENT_SHARED_PACKAGES: Record<string, { pkg: string; reason: string }> = {
  'shared/commands/': {
    pkg: 'zod',
    reason: 'command arguments are zod objects, the schema language the app\'s AI tools already take (loopback-mcp ZodRawShape)',
  },
}

const clientSharedMayImport = (t: string, file: string) =>
  t.startsWith('shared/') || t.startsWith('../shared/')
  || Object.entries(CLIENT_SHARED_PACKAGES).some(([dir, { pkg }]) => rel(file).startsWith(dir) && t === `pkg:${pkg}`)

test('client/shared imports only itself and the repository shared/', () => {
  const files = sourceFiles(join(CLIENT, 'shared'))
  assert.ok(files.length > 0)
  assert.deepEqual(violations(files, clientSharedMayImport), [])
  const stale = Object.entries(CLIENT_SHARED_PACKAGES).filter(([dir, { pkg }]) =>
    !files.some(f => rel(f).startsWith(dir) && importsOf(f).includes(pkg)))
  assert.deepEqual(stale.map(([dir]) => dir), [], 'remove package exceptions that no longer occur')
  assert.equal(clientSharedMayImport('pkg:zod', join(CLIENT, 'shared/agent.ts')), false, 'the exception is per folder (self-test)')
})

test('main-process features, services and ipc never import Electron', () => {
  const files = ['features', 'services', 'ipc'].flatMap(d => sourceFiles(join(CLIENT, 'electron', d)))
  assert.ok(files.length > 0)
  assert.deepEqual(violations(files, t => !/^pkg:electron(\/|$)/.test(t)), [])
})

const SHELL_AND_HOST = [
  /^pkg:electron(\/|$)/,
  /^electron\/(main|preload|electron-adapter|voice-input|chat-server)$/,
  /^electron\/(features|services|ipc|sync)\//,
]

test('agents never import the shell, the chat server, features, services or sync', () => {
  const files = sourceFiles(join(CLIENT, 'electron', 'agents'))
  assert.ok(files.length > 0)
  assert.deepEqual(violations(files, t => !SHELL_AND_HOST.some(re => re.test(t))), [])
})

/** One agent's implementation modules → the hand-off module that may use them directly. */
const AGENT_IMPLEMENTATION = /^electron\/agents\/(claude|codex|codex-[a-z-]+|anthropic-api)$/
const OWN_HANDOFF: Record<string, RegExp> = {
  'electron/handoff/codex.ts': /^electron\/agents\/codex(-[a-z-]+)?$/,
  'electron/handoff/claude.ts': /^electron\/agents\/claude$/,
}

test('an agent implementation is reached through the registry', () => {
  const files = sourceFiles(join(CLIENT, 'electron')).concat(sourceFiles(join(CLIENT, 'src')))
    .filter(f => !rel(f).startsWith('electron/agents/'))
  assert.deepEqual(violations(files, (t, file) => {
    if (!AGENT_IMPLEMENTATION.test(t)) return true
    const r = rel(file)
    if (r === 'electron/main.ts') return true // composition root (codex:status)
    return OWN_HANDOFF[r]?.test(t) ?? false
  }), [])
})

/**
 * Files outside the agent modules that compare an agent id on purpose.
 * Per-agent UI is the one place an added agent brings its own controls
 * (chat-ui-and-history.md); the rest are named here with the reason.
 */
const AGENT_ID_EXCEPTIONS: Record<string, string> = {
  'src/components/chat/ChatAuthSettings.tsx': 'per-agent sign-in cards',
  'src/components/chat/ChatHeader.tsx': 'per-agent model pickers',
  'src/components/chat/hooks/useAgentAuth.ts': 'restores the saved sign-in per agent',
  'shared/rate-limits.ts': 'each agent reports its usage windows in its own shape',
  'electron/chat-server.ts': 'the legacy claudeSessionId history field',
  'electron/features/chat/server-config.ts': 'the legacy claudeSessionId history field',
}

const AGENT_ID_COMPARISON = /[=!]==?\s*['"](claude-code|codex|api-key)['"]|['"](claude-code|codex|api-key)['"]\s*[=!]==?|\bcase\s+['"](claude-code|codex|api-key)['"]/

test('agent ids are compared only inside the agent modules', () => {
  const files = [...sourceFiles(join(CLIENT, 'electron')), ...sourceFiles(join(CLIENT, 'src')), ...sourceFiles(join(CLIENT, 'shared'))]
    .filter(f => !/^(electron\/agents|shared\/agents)\//.test(rel(f)))
  const found = new Set<string>()
  const unexpected: string[] = []
  for (const file of files) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (!AGENT_ID_COMPARISON.test(line)) return
      if (rel(file) in AGENT_ID_EXCEPTIONS) found.add(rel(file))
      else unexpected.push(`${rel(file)}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(unexpected, [], 'ask the registry (shared/agents/registry.ts: agentCan / AGENTS[id]) instead, or add a capability')
  const stale = Object.keys(AGENT_ID_EXCEPTIONS).filter(f => !found.has(f))
  assert.deepEqual(stale, [], 'remove exceptions that no longer occur')
})

test('the checks see real imports (self-test)', () => {
  const chatServer = join(CLIENT, 'electron', 'chat-server.ts')
  assert.ok(importsOf(chatServer).some(s => target(chatServer, s) === 'electron/agents/registry'))
})

/** The client modules `start` reaches through imports, followed to the end (themselves included). */
function reachableFrom(start: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...start]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of importsOf(join(CLIENT, file))) {
      const t = target(join(CLIENT, file), spec)
      if (t.startsWith('pkg:') || t.startsWith('../')) continue
      const found = [`${t}.ts`, `${t}.tsx`, `${t}/index.ts`].find(c => existsSync(join(CLIENT, c)))
      if (found) queue.push(found)
    }
  }
  return seen
}

// Only a person, in the 「新しいフォルダ…」 dialog, creates a private folder
// (private-folders.md): nothing the chat or an agent loads may import the API
// that creates one, however many modules lie in between.
test('the chat and the agents never reach the private-folder API, directly or through other modules', () => {
  const start = ['electron/chat-server.ts', 'electron/chat-tools.ts', ...sourceFiles(join(CLIENT, 'electron', 'agents')).map(rel)]
  const reached = reachableFrom(start)
  assert.ok(reached.has('electron/agents/registry.ts'), 'the walk follows imports (self-test)')
  assert.deepEqual([...reached].filter(f => /^electron\/private-folders-api\.ts$|^electron\/features\/private-folders\//.test(f)), [])
})

// ---- Renderer (client/src) — .claude/rules/renderer-structure.md ----

/** 'editor' for anything under src/features/editor/, else null. */
const featureOf = (clientPath: string): string | null => /^src\/features\/([^/]+)\//.exec(clientPath)?.[1] ?? null

/**
 * Feature → feature imports allowed on purpose, as 'from -> to': reason.
 * Each must keep occurring; add one only with a reason the owner would
 * accept (otherwise let app/ compose the two through props).
 */
const FEATURE_IMPORT_EXCEPTIONS: Record<string, string> = {
  'editor -> doc-review':
    'a Markdown preview tab shows the review banners, side panel, comment popover and snapshot diff, driven by the open file and the editor\'s scroll and selection',
  'files -> doc-review':
    'the tree hides review sidecars and marks documents with reviews (pure model.ts only: isReviewSidecarFile, detectReviewStatus, hasUnseenReviews)',
}

/** Feature pairs a set of (importing file, imported path) edges crosses. */
function crossFeatureImports(edges: Array<[file: string, imported: string]>): Array<[pair: string, where: string]> {
  const out: Array<[string, string]> = []
  for (const [file, imported] of edges) {
    const from = featureOf(file)
    const to = featureOf(imported)
    if (from && to && from !== to) out.push([`${from} -> ${to}`, `${file}: ${imported}`])
  }
  return out
}

test('a renderer feature never imports another feature', () => {
  const files = sourceFiles(join(CLIENT, 'src', 'features'), { tests: true })
  const edges = files.flatMap(f => importsOf(f).map(s => [rel(f), target(f, s)] as [string, string]))
  const found = new Set<string>()
  const unexpected: string[] = []
  for (const [pair, where] of crossFeatureImports(edges)) {
    if (pair in FEATURE_IMPORT_EXCEPTIONS) found.add(pair)
    else unexpected.push(`${pair} (${where})`)
  }
  assert.deepEqual(unexpected, [], 'compose the two features in src/app/ instead, or move the shared part to src/shared/')
  const stale = Object.keys(FEATURE_IMPORT_EXCEPTIONS).filter(p => !found.has(p))
  assert.deepEqual(stale, [], 'remove exceptions that no longer occur')
})

const sharedMayImport = (t: string) => !/^src\/(features|app)(\/|$)/.test(t)

test('renderer src/shared never imports src/features or src/app', () => {
  const files = sourceFiles(join(CLIENT, 'src', 'shared'), { tests: true })
  assert.deepEqual(violations(files, sharedMayImport), [])
})

/** The renderer's data layer: the only places allowed to reach window.electronAPI. */
const isDataLayer = (clientPath: string) =>
  /^src\/features\/[^/]+\/api(\.tsx?$|\/)/.test(clientPath) || /^src\/shared\/ipc\//.test(clientPath)

/** window.electronAPI, window['electronAPI'], or `const { electronAPI } = window`. */
const ELECTRON_API_USE = /\bwindow\s*(?:\?\.|\.)\s*electronAPI\b|\bwindow\s*\[\s*['"]electronAPI['"]\s*\]|\{[^}]*\belectronAPI\b[^}]*\}\s*=\s*window\b/

/**
 * No exceptions: the older direct callers (44 files on 2026-10-29) all moved
 * behind ports by 2026-10-30. A screen, hook or store reaches IPC only
 * through a feature's api.ts or src/shared/ipc/ (renderer-structure.md).
 */
test('window.electronAPI only in the data layer', () => {
  const files = sourceFiles(join(CLIENT, 'src'))
  assert.ok(files.length > 0)
  const using = files.map(rel).filter(f => ELECTRON_API_USE.test(stripComments(readFileSync(join(CLIENT, f), 'utf8'))))
  assert.ok(using.some(isDataLayer), 'the check must see the data layer\'s own calls')
  const unexpected = using.filter(f => !isDataLayer(f))
  assert.deepEqual(unexpected, [], 'call IPC from the feature\'s api.ts (or src/shared/ipc/) instead (renderer-structure.md)')
})

test('the renderer checks catch violations (self-test)', () => {
  assert.deepEqual(crossFeatureImports([
    ['src/features/editor/TabbedEditor.tsx', 'src/features/doc-review/model'],
    ['src/features/editor/hooks/useX.ts', 'src/features/editor/model'],
    ['src/app/AppShell.tsx', 'src/features/editor/TabbedEditor'],
  ]).map(([pair]) => pair), ['editor -> doc-review'])
  assert.equal(target(join(CLIENT, 'src/shared/lib/x.ts'), '@/features/chat/api'), 'src/features/chat/api')
  assert.equal(sharedMayImport(target(join(CLIENT, 'src/shared/lib/x.ts'), '../../features/chat/api')), false)
  assert.equal(sharedMayImport(target(join(CLIENT, 'src/shared/lib/x.ts'), '../../app/AppShell')), false)
  assert.equal(sharedMayImport(target(join(CLIENT, 'src/shared/lib/x.ts'), '../../stores/appStore')), true)
  for (const use of ['window.electronAPI.readFile(p)', 'window?.electronAPI', "window['electronAPI']", 'const { electronAPI } = window']) {
    assert.ok(ELECTRON_API_USE.test(use), use)
  }
  assert.ok(isDataLayer('src/features/doc-review/api.ts') && isDataLayer('src/shared/ipc/client.ts'))
  assert.ok(!isDataLayer('src/features/doc-review/hooks/useApi.ts'))
})

/**
 * Type names defined more than once on purpose (an exported definition plus
 * another of the same name anywhere in client/src, client/shared or shared),
 * as name: reason. Each must keep occurring.
 */
const TYPE_NAME_EXCEPTIONS: Record<string, string> = {
}

/** `interface X` / `type X =`, exported or not; re-exports (`export type { X } from …`) and import lists are not definitions. */
const TYPE_DEFINITION = /^[ \t]*(export[ \t]+)?(?:declare[ \t]+)?(?:interface[ \t]+([A-Za-z_$][\w$]*)|type[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:<[^\n]*?>)?[ \t]*=)/gm

/** Names defined in more than one file where at least one of the definitions is exported: name → files. */
function duplicateTypeNames(files: Array<[file: string, source: string]>): Record<string, string[]> {
  const byName = new Map<string, Map<string, boolean>>()
  for (const [file, source] of files) {
    for (const m of stripComments(source).matchAll(TYPE_DEFINITION)) {
      const name = m[2] ?? m[3]
      const where = byName.get(name) ?? new Map<string, boolean>()
      where.set(file, (where.get(file) ?? false) || !!m[1])
      byName.set(name, where)
    }
  }
  return Object.fromEntries([...byName]
    .filter(([, where]) => where.size > 1 && [...where.values()].some(Boolean))
    .map(([name, where]) => [name, [...where.keys()].sort()]))
}

const REPO = join(CLIENT, '..')

test('an exported type name is defined in one place only (client/src, client/shared, shared)', () => {
  const files = [join(CLIENT, 'src'), join(CLIENT, 'shared'), join(REPO, 'shared')]
    .flatMap(dir => sourceFiles(dir))
    .map(f => [relative(REPO, f), readFileSync(f, 'utf8')] as [string, string])
  assert.ok(files.length > 100)
  const duplicates = duplicateTypeNames(files)
  const unexpected = Object.entries(duplicates)
    .filter(([name]) => !(name in TYPE_NAME_EXCEPTIONS))
    .map(([name, where]) => `${name}: ${where.join(', ')}`)
  assert.deepEqual(unexpected, [], 'import the one definition (contract types: shared/types, client/shared/ipc-contract.ts), or name the other after its role (renderer-structure.md "Where types go")')
  const stale = Object.keys(TYPE_NAME_EXCEPTIONS).filter(name => !(name in duplicates))
  assert.deepEqual(stale, [], 'remove exceptions that no longer occur')
})

/**
 * Turning off react-hooks/exhaustive-deps hides a stale value from the linter,
 * so the count may only go down (lower this when one goes), and each says why:
 * `-- reason` on the directive, or a comment on the line above it.
 */
const MAX_EXHAUSTIVE_DEPS_DISABLES = 9

const EXHAUSTIVE_DEPS_DISABLE = /eslint-disable(?:-next-line|-line)?\s+[^\n]*react-hooks\/exhaustive-deps/

/** Disables of exhaustive-deps in one file: where, and whether a reason is given. */
function exhaustiveDepsDisables(file: string, source: string): Array<{ where: string; reasoned: boolean }> {
  const lines = source.split('\n')
  return lines.flatMap((line, i) => {
    if (!EXHAUSTIVE_DEPS_DISABLE.test(line)) return []
    const reasoned = /exhaustive-deps\s+--\s*\S/.test(line) || /^\s*\/\/(?!\s*eslint-)\s*\S/.test(lines[i - 1] ?? '')
    return [{ where: `${file}:${i + 1}`, reasoned }]
  })
}

test('exhaustive-deps is turned off no more often than today, and each time with a reason', () => {
  const disables = sourceFiles(join(CLIENT, 'src'), { tests: true })
    .flatMap(f => exhaustiveDepsDisables(rel(f), readFileSync(f, 'utf8')))
  assert.ok(disables.length <= MAX_EXHAUSTIVE_DEPS_DISABLES,
    `${disables.length} disables (at most ${MAX_EXHAUSTIVE_DEPS_DISABLES}): list the dependency, or move the value into a ref or the effect`)
  assert.deepEqual(disables.filter(d => !d.reasoned).map(d => d.where), [],
    'say why after `--` on the directive, or in a comment on the line above')
  assert.deepEqual(exhaustiveDepsDisables('x.ts', [
    'a', '  // eslint-disable-next-line react-hooks/exhaustive-deps', '}, [a])',
    '  // keeps the first value', '  // eslint-disable-next-line react-hooks/exhaustive-deps', '}, [])',
    '  // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount', '}, [])',
  ].join('\n')), [{ where: 'x.ts:2', reasoned: false }, { where: 'x.ts:5', reasoned: true }, { where: 'x.ts:7', reasoned: true }], 'self-test')
})

/**
 * An effect is for syncing with something outside React (IPC events, DOM
 * listeners, timers, observers, third-party widgets); derived state, chains
 * that react to state, data loading and resets on a prop change have other
 * homes (renderer-structure.md "Effects"). The count may only go down: lower
 * this when you remove effects, never raise it.
 */
const MAX_USE_EFFECTS = 171

/** `useEffect(` calls in one file's code (comments do not count). */
function useEffectCalls(source: string): number {
  return stripComments(source).match(/\buseEffect\s*\(/g)?.length ?? 0
}

test('useEffect is called no more often than today in client/src', () => {
  const perFile = sourceFiles(join(CLIENT, 'src'))
    .map(f => [rel(f), useEffectCalls(readFileSync(f, 'utf8'))] as const)
    .filter(([, n]) => n > 0)
  const total = perFile.reduce((sum, [, n]) => sum + n, 0)
  assert.ok(total <= MAX_USE_EFFECTS,
    `${total} useEffect calls (at most ${MAX_USE_EFFECTS}): compute derived values during render, act in the event handler, load data through the feature's data hook, reset with \`key\`; keep effects for syncing with the outside world, preferably through the shared hooks (renderer-structure.md "Effects")`)
  if (total < MAX_USE_EFFECTS) {
    console.log(`[useEffect ratchet] ${total} calls, ceiling ${MAX_USE_EFFECTS}: lower MAX_USE_EFFECTS to ${total}`)
  }
  assert.equal(useEffectCalls([
    'useEffect(() => {}, [])', 'React.useEffect (() => {})', '// useEffect(() => {})',
    '/* useEffect( */ useLayoutEffect(() => {})', 'const myuseEffect = 1',
  ].join('\n')), 2, 'self-test')
})

test('the duplicate type name check sees definitions, not re-exports or imports (self-test)', () => {
  assert.deepEqual(duplicateTypeNames([
    ['a.ts', 'export interface Company { id: string }\nexport type Pair<T> = [T, T]\ninterface Props { a: string }'],
    ['b.ts', "type Company = { id: number }\nexport type { Pair } from './a'\nimport { type Pair as P } from './a'\ninterface Props { b: string }"],
    ['c.ts', 'export type Pair<T extends string = string> = T[]\n// interface Company {}'],
  ]), { Company: ['a.ts', 'b.ts'], Pair: ['a.ts', 'c.ts'] })
})
