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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
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

/** Client-relative path of a relative import ('electron/agents/claude'), or `pkg:<specifier>`. */
function target(file: string, spec: string): string {
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
