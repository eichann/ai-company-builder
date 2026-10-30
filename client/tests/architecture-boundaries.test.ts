// The app's module boundaries, checked over the whole tree (lint only sees
// the files a pull request changes). The server's equivalent is
// server/tests/unit/layering.test.ts; the reasons are in
// .claude/rules/ipc-and-main-process.md and chat-and-agents.md.
//
//   client/shared/            pure: imports only itself and the repository's
//                             shared/ (no packages, no Node, no Electron)
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

test('client/shared imports only itself and the repository shared/', () => {
  const files = sourceFiles(join(CLIENT, 'shared'))
  assert.ok(files.length > 0)
  assert.deepEqual(violations(files, t => t.startsWith('shared/') || t.startsWith('../shared/')), [])
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

// ---- Renderer (client/src) — .claude/rules/renderer-structure.md ----

/** 'editor' for anything under src/features/editor/, else null. */
const featureOf = (clientPath: string): string | null => /^src\/features\/([^/]+)\//.exec(clientPath)?.[1] ?? null

/**
 * Feature → feature imports allowed on purpose, as 'from -> to': reason.
 * Each must keep occurring; add one only with a reason the owner would
 * accept (otherwise let app/ compose the two through props).
 */
const FEATURE_IMPORT_EXCEPTIONS: Record<string, string> = {}

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

/**
 * Renderer files that still call window.electronAPI directly (2026-10-29:
 * 44; 43 with doc-review's api.ts, 39 with skills' api.ts, 36 with
 * settings' api.ts, 32 with voice's api.ts, 25 with chat's api.ts for
 * history and hand-off, 20 with the rest of chat's, 15 with history's,
 * search's and sync's api.ts and shared/ipc/diffs.ts, 10 with files' api.ts
 * and the shared ports for write access, departments and download choices). Never add one: new IPC calls go
 * into the feature's api.ts or src/shared/ipc/. Remove a file here when it stops calling it; a move-only
 * PR renames its entry. The count may only go down.
 */
const DIRECT_IPC_FILES: readonly string[] = [
  'src/App.tsx',
  'src/components/auth/CompanySelector.tsx',
  'src/components/auth/LoginScreen.tsx',
  'src/components/auth/ServerSetupScreen.tsx',
  'src/components/skill-ui/FileTreePanel.tsx',
  'src/components/skill-ui/SkillCentricLayout.tsx',
  'src/components/skill-ui/TabbedEditorPanel.tsx',
  'src/lib/fileEvents.ts',
  'src/stores/appStore.ts',
  'src/stores/authStore.ts',
]
const DIRECT_IPC_CEILING = 10

/** The renderer's data layer: the only new places allowed to reach window.electronAPI. */
const isDataLayer = (clientPath: string) =>
  /^src\/features\/[^/]+\/api(\.tsx?$|\/)/.test(clientPath) || /^src\/shared\/ipc\//.test(clientPath)

/** window.electronAPI, window['electronAPI'], or `const { electronAPI } = window`. */
const ELECTRON_API_USE = /\bwindow\s*(?:\?\.|\.)\s*electronAPI\b|\bwindow\s*\[\s*['"]electronAPI['"]\s*\]|\{[^}]*\belectronAPI\b[^}]*\}\s*=\s*window\b/

test('window.electronAPI only in the data layer and the shrinking list of older files', () => {
  assert.ok(DIRECT_IPC_FILES.length <= DIRECT_IPC_CEILING, 'the list of direct window.electronAPI callers may only shrink')
  const files = sourceFiles(join(CLIENT, 'src'))
  assert.ok(files.length > 0)
  const using = files.map(rel).filter(f => ELECTRON_API_USE.test(stripComments(readFileSync(join(CLIENT, f), 'utf8'))))
  const unexpected = using.filter(f => !isDataLayer(f) && !DIRECT_IPC_FILES.includes(f))
  assert.deepEqual(unexpected, [], 'call IPC from the feature\'s api.ts (or src/shared/ipc/) instead (renderer-structure.md)')
  const stale = DIRECT_IPC_FILES.filter(f => !using.includes(f))
  assert.deepEqual(stale, [], 'remove files that no longer call window.electronAPI (and lower DIRECT_IPC_CEILING)')
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
