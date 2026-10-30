/**
 * The AI sandbox policy (client/shared/agents/sandbox-policy.ts,
 * shared/core/agent-sandbox.ts) and the Codex version floor
 * (client/shared/agents/cli-version.ts, electron/agents/codex-version.ts).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import {
  claudeSandboxOptions, codexSandboxConfig, resolveSandbox, isSameOrInside, CODEX_SANDBOX_PROFILE, SECRET_READ_PATHS,
} from '../shared/agents/sandbox-policy'
import {
  DEFAULT_SANDBOX_ALLOWED_DOMAINS, normalizeDeniedReadPath, normalizeSandboxDomain, parseAgentSandboxSettings, sandboxAllowsHost,
} from '../../shared/core/agent-sandbox'
import { checkCodexVersion } from '../shared/agents/cli-version'
import { AGENTS } from '../shared/agents/registry'
import { createCodexConnection, getCodexStatus, type CodexTransport } from '../electron/agents/codex'

const HOME = '/Users/member'
const COMPANY = '/Users/member/Documents/AI Company Builder/acme'
const USER_DATA = '/Users/member/Library/Application Support/ai-company-builder'
const host = { home: HOME, companyRoot: COMPANY, appDataDirs: [USER_DATA], toolDirs: ['/Users/member/.nvm/versions/node/v22/bin', '/opt/homebrew/bin'], serverHost: 'acb.example.jp' }
const settings = { allowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS], deniedReadPaths: [] as string[] }

test('enforce: Claude Code runs every command in the sandbox and the company repository cannot loosen it', () => {
  const { sandbox } = claudeSandboxOptions(resolveSandbox(settings, host))
  // These four are what makes project .claude/settings.json unable to switch
  // the sandbox off, add hosts or re-open paths (verified on CLI 2.1.304).
  assert.equal(sandbox.enabled, true)
  assert.equal(sandbox.allowUnsandboxedCommands, false)
  assert.equal(sandbox.network.strictAllowlist, true)
  assert.equal(sandbox.failIfUnavailable, true)
  assert.equal(sandbox.autoAllowBashIfSandboxed, true)
})

test('enforce: secret places are unreadable for commands and for the Read tool (Claude) and for Codex', () => {
  const resolved = resolveSandbox(settings, host)
  const { sandbox, permissionsDeny } = claudeSandboxOptions(resolved)
  const codex = codexSandboxConfig(resolved) as { permissions: Record<string, { filesystem: Record<string, string> }> }
  const codexFs = codex.permissions[CODEX_SANDBOX_PROFILE].filesystem
  for (const place of [`${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/Library/Keychains`, '/Library/Keychains', `${HOME}/Library/Application Support/Google/Chrome`, USER_DATA]) {
    assert.ok(sandbox.filesystem.denyRead.includes(place), `sandbox denyRead ${place}`)
    assert.ok(permissionsDeny.includes(`Read(/${place}/**)`), `Read deny ${place}`)
    assert.equal(codexFs[place], 'deny', `codex ${place}`)
  }
  // Every entry is absolute: a `~` the CLI might not expand is never handed over.
  for (const place of sandbox.filesystem.denyRead) assert.ok(place.startsWith('/'), place)
  // The company's own extra places are added.
  const extra = resolveSandbox({ ...settings, deniedReadPaths: ['~/顧客データ', '/Volumes/Share'] }, host)
  assert.ok(extra.denyRead.includes(`${HOME}/顧客データ`))
  assert.ok(extra.denyRead.includes('/Volumes/Share'))
  // Claude's built-in web tools bypass the host list: denied under enforce.
  assert.ok(permissionsDeny.includes('WebFetch') && permissionsDeny.includes('WebSearch'))
})

test('enforce: the company folder and the member\'s tools stay readable, without re-opening a secret place', () => {
  const resolved = resolveSandbox(settings, host)
  for (const root of [COMPANY, ...host.toolDirs]) {
    const covered = resolved.denyRead.filter(denied => isSameOrInside(root, denied))
    assert.ok(covered.length === 0 || resolved.allowRead.includes(root), `${root} is readable`)
  }
  // A company that denies a whole parent folder: the company folder is re-allowed for Claude,
  // and Codex (where a deny wins over everything) does not get that deny at all.
  const wide = resolveSandbox({ ...settings, deniedReadPaths: ['~/Documents'] }, host)
  assert.ok(wide.allowRead.includes(COMPANY))
  const codexFs = (codexSandboxConfig(wide) as { permissions: Record<string, { filesystem: Record<string, string> }> }).permissions[CODEX_SANDBOX_PROFILE].filesystem
  assert.equal(codexFs[`${HOME}/Documents`], undefined)
  assert.equal(codexFs[`${HOME}/.ssh`], 'deny')
  // Never re-allowed (allowRead beats denyRead): a folder that contains a secret
  // place, or one inside a secret place, even when the company denies around it.
  const home = resolveSandbox({ ...settings, deniedReadPaths: ['/Users'] }, { ...host, companyRoot: HOME, toolDirs: [`${HOME}/.ssh/bin`] })
  assert.deepEqual(home.allowRead, [])
  for (const secret of SECRET_READ_PATHS) assert.ok(home.denyRead.includes(secret.replace('~', HOME)), secret)
  // Caches are writable, but never one inside a denied place.
  assert.ok(resolved.allowWrite.includes(`${HOME}/.npm`))
  for (const path of resolved.allowWrite) assert.ok(!resolved.denyRead.some(denied => isSameOrInside(path, denied)), path)
})

test('enforce: commands reach exactly the company list plus the ACB server, for both agents', () => {
  const resolved = resolveSandbox({ ...settings, allowedDomains: ['API.GitHub.com', 'api.github.com', '*.r2.cloudflarestorage.com'] }, host)
  assert.deepEqual(resolved.allowedDomains, ['api.github.com', '*.r2.cloudflarestorage.com', 'acb.example.jp'])
  assert.deepEqual(claudeSandboxOptions(resolved).sandbox.network.allowedDomains, resolved.allowedDomains)
  const codex = codexSandboxConfig(resolved) as { default_permissions: string; features: Record<string, unknown>; permissions: Record<string, { extends: string; network: { enabled: boolean; domains: Record<string, string> } }> }
  // Codex: the app's profile is the one in force, its proxy decides per host, nothing else is open.
  assert.equal(codex.default_permissions, CODEX_SANDBOX_PROFILE)
  assert.equal(codex.features.network_proxy, true)
  assert.equal(codex.permissions[CODEX_SANDBOX_PROFILE].extends, ':workspace')
  assert.deepEqual(Object.keys(codex.permissions[CODEX_SANDBOX_PROFILE].network.domains).sort(), [...resolved.allowedDomains].sort())
  assert.ok(Object.values(codex.permissions[CODEX_SANDBOX_PROFILE].network.domains).every(value => value === 'allow'))
  // Default list: the skills' Gemini host is reachable, an unknown host is not.
  const defaults = resolveSandbox(settings, host).allowedDomains
  assert.ok(sandboxAllowsHost(defaults, 'generativelanguage.googleapis.com'))
  assert.ok(sandboxAllowsHost(defaults, 'acme.r2.cloudflarestorage.com'))
  assert.ok(!sandboxAllowsHost(defaults, 'r2.cloudflarestorage.com'))
  assert.ok(!sandboxAllowsHost(defaults, 'example.org'))
})

test('the setting refuses entries that would open everything or point at this computer', () => {
  for (const bad of ['*', '*.com', 'localhost', 'a.localhost', '127.0.0.1', '10.0.0.1', 'https://example.com', 'example.com/path', 'example.com:443', 'user@example.com', 'example', '', 'ex ample.com']) {
    assert.equal(normalizeSandboxDomain(bad), undefined, bad)
  }
  assert.equal(normalizeSandboxDomain(' Example.COM. '), 'example.com')
  assert.equal(normalizeSandboxDomain('*.Example.com'), '*.example.com')
  for (const bad of ['~', '~/', '/', 'relative/path', '~/../etc', '/a/./b', '/a/*', '~/x?', '/a\\b', '/a\nb', '~user/x']) {
    assert.equal(normalizeDeniedReadPath(bad), undefined, JSON.stringify(bad))
  }
  assert.equal(normalizeDeniedReadPath('~/顧客/'), '~/顧客')
  assert.ok('error' in parseAgentSandboxSettings({ mode: 'enforce', allowedDomains: ['*'], deniedReadPaths: [], onUnavailable: 'stop' }))
  assert.ok('error' in parseAgentSandboxSettings({ mode: 'on', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'stop' }))
  assert.ok('error' in parseAgentSandboxSettings({ mode: 'enforce', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'ignore' }))
  const ok = parseAgentSandboxSettings({ mode: 'observe', allowedDomains: ['A.com', 'a.com'], deniedReadPaths: ['~/x'], onUnavailable: 'record-only' })
  assert.deepEqual(ok, { value: { mode: 'observe', allowedDomains: ['a.com'], deniedReadPaths: ['~/x'], onUnavailable: 'record-only' } })
})

test('a Codex older than the floor is refused with a plain-Japanese update notice', () => {
  const floor = AGENTS.codex.minCliVersion!
  assert.ok(floor)
  const old = checkCodexVersion('codex-cli 0.150.9', floor)
  assert.equal(old.ok, false)
  assert.match(!old.ok ? old.message : '', /古いため.*npm install -g @openai\/codex@latest/)
  assert.equal(checkCodexVersion('codex-cli 0.9.0', '0.10.0').ok, false)
  assert.equal(checkCodexVersion(`codex-cli ${floor}`, floor).ok, true)
  assert.equal(checkCodexVersion('codex-cli 1.0.0', floor).ok, true)
  // No version in the output: the app cannot tell what it would start.
  assert.equal(checkCodexVersion('', floor).ok, false)
})

test('a too-old Codex never starts: the chat shows the notice and the settings check reports it', async () => {
  let started = false
  const refuse = async () => ({ ok: false as const, message: 'お使いの Codex（0.1.0）は古いため、このアプリでは使えません。' })
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => { started = true; return {} as CodexTransport }, refuse)
  const model = connection.createChatModel({ modelId: 'm' }) as Extract<LanguageModel, { specificationVersion: 'v3' }>
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  const parts: { type: string; error?: unknown }[] = []
  const reader = stream.getReader()
  for (;;) { const next = await reader.read(); if (next.done) break; parts.push(next.value) }
  const error = parts.find(part => part.type === 'error')?.error
  assert.match(error instanceof Error ? error.message : '', /古いため/)
  assert.equal(started, false)
  const status = await getCodexStatus({}, 'darwin', refuse)
  assert.equal(status.available, false)
  assert.match(status.error ?? '', /古いため/)
})
