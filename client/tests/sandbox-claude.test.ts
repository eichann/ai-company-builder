/**
 * The AI sandbox enforced through Claude Code (sandbox S3): what the CLI is
 * given, what happens when its sandbox cannot start (the company's
 * onUnavailable), what the AI is told about a refused host, and where the
 * app never enforces (Windows).
 */
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import type { claudeCode } from 'ai-sdk-provider-claude-code'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import type { TurnSandbox } from '../electron/agents/connection'
import type { WriteGuard } from '../electron/write-guard'
import { SANDBOX_MESSAGES, decideTurnSandbox, resolveSandbox, sandboxPlatform } from '../shared/agents/sandbox-policy'
import { AGENTS } from '../shared/agents/registry'

const HOME = '/Users/member'
const COMPANY = `${HOME}/Documents/AI Company Builder/acme`
const resolved = resolveSandbox({ allowedDomains: ['api.github.com'], deniedReadPaths: [] }, { home: HOME, companyRoot: COMPANY, appDataDirs: [`${HOME}/Library/Application Support/ai-company-builder`], serverHost: 'acb.example.jp' })
const enforce = (onUnavailable: TurnSandbox['onUnavailable'] = 'stop'): TurnSandbox => ({ mode: 'enforce', resolved, home: HOME, onUnavailable })

const base: ClaudeConnectionConfig = {
  getPermissionMode: () => 'bypassPermissions',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: process.env.PATH || '' }),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Options = any

/** A fake provider whose CLI is a `/bin/sh` script spawned through the connection's own wrapper. */
function fakeFactory(script: (options: Options) => string, calls: Options[]) {
  return ((modelId: string, options: Options) => {
    calls.push(options)
    return {
      specificationVersion: 'v3', provider: 'fake', modelId, supportedUrls: {},
      doGenerate: async () => { throw new Error('unused') },
      doStream: async () => {
        const child = options.spawnClaudeCodeProcess({ command: '/bin/sh', args: ['-c', script(options)], env: process.env })
        const code = await new Promise<number>(resolve => child.on('close', resolve))
        const parts = code === 0
          ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: options.sandbox ? 'ran sandboxed' : 'ran unsandboxed' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage: {} }]
          : [{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error(`Claude Code process exited with code ${code}`) }]
        let index = 0
        return { stream: new ReadableStream({ pull(c) { if (index < parts.length) c.enqueue(parts[index++]); else c.close() } }) }
      },
    }
  }) as unknown as typeof claudeCode
}

async function text(model: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { stream } = await (model as any).doStream({ prompt: [] })
  let out = ''
  for await (const part of stream) {
    if (part.type === 'text-delta') out += part.delta
    if (part.type === 'error') out += `[error ${part.error.message}]`
  }
  return out
}

// Claude Code 2.1.314's text when failIfUnavailable stops it (from the CLI's strings).
const UNAVAILABLE = `echo "sandbox unavailable detail: missing dependency. Set sandbox.failIfUnavailable=false to allow unsandboxed execution." >&2; exit 1`

test('enforce: the CLI gets the company sandbox at the --settings layer and the Read denies for its secret places', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(() => 'exit 0', calls))
  assert.equal(await text(connection.createChatModel({ appSessionId: 'e1', workingDirectory: COMPANY, sandbox: enforce() })), 'ran sandboxed')
  const options = calls[0]
  assert.equal(options.sandbox.enabled, true)
  assert.equal(options.sandbox.allowUnsandboxedCommands, false)
  assert.equal(options.sandbox.network.strictAllowlist, true)
  assert.deepEqual(options.sandbox.network.allowedDomains, ['api.github.com', 'acb.example.jp'])
  assert.ok(options.sandbox.filesystem.denyRead.includes(`${HOME}/.ssh`))
  const deny: string[] = options.settings.permissions.deny
  for (const rule of ['WebFetch', 'WebSearch', `Read(/${HOME}/.ssh/**)`, `Read(/${HOME}/Library/Application Support/ai-company-builder/**)`]) assert.ok(deny.includes(rule), rule)
})

test('observe or off: the CLI runs exactly as before (no sandbox, no extra denies)', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(() => 'exit 0', calls))
  await text(connection.createChatModel({ appSessionId: 'o1', sandbox: { ...enforce(), mode: 'observe' } }))
  await text(connection.createChatModel({ appSessionId: 'o2' }))
  for (const options of calls) {
    assert.equal(options.sandbox, undefined)
    assert.equal(options.settings, undefined)
  }
})

test('the sandbox cannot start + company says stop: no AI, a plain sentence', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(o => (o.sandbox ? UNAVAILABLE : 'exit 0'), calls))
  assert.equal(await text(connection.createChatModel({ appSessionId: 's1', sandbox: enforce('stop') })), `[error ${SANDBOX_MESSAGES.startFailedStop}]`)
  assert.equal(calls.length, 1, 'never re-run without the sandbox')
})

test('the sandbox cannot start + company says record only: the turn re-runs without it and says so', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(o => (o.sandbox ? UNAVAILABLE : 'exit 0'), calls))
  assert.equal(await text(connection.createChatModel({ appSessionId: 'r1', sandbox: enforce('record-only') })), `※ ${SANDBOX_MESSAGES.startFailedRecordOnly}\n\nran unsandboxed`)
  assert.deepEqual(calls.map(c => !!c.sandbox), [true, false])
})

test('a re-run without the sandbox first asks the host to remove what only enclosed turns may sit next to; refused, it never runs', async () => {
  // agent-browser.md "Keeping a login on disk": a browser login kept on this PC must be gone before an unenclosed turn.
  const order: string[] = []
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(o => { order.push(o.sandbox ? 'sandboxed' : 'unsandboxed'); return o.sandbox ? UNAVAILABLE : 'exit 0' }, calls))
  const asked = { ...enforce('record-only'), beforeUnenclosed: async () => { order.push('removed') } }
  assert.equal(await text(connection.createChatModel({ appSessionId: 'k1', sandbox: asked })), `※ ${SANDBOX_MESSAGES.startFailedRecordOnly}\n\nran unsandboxed`)
  assert.deepEqual(order, ['sandboxed', 'removed', 'unsandboxed'])

  const refusedCalls: Options[] = []
  const refusing = createClaudeConnection(base, fakeFactory(o => (o.sandbox ? UNAVAILABLE : 'exit 0'), refusedCalls))
  const refused = { ...enforce('record-only'), beforeUnenclosed: async () => { throw new Error('ログインを消せませんでした') } }
  assert.equal(await text(refusing.createChatModel({ appSessionId: 'k2', sandbox: refused })), '[error ログインを消せませんでした]')
  assert.equal(refusedCalls.length, 1, 'never re-run without the sandbox')
})

test('a chat title runs with no tool and no MCP server (it runs without the company sandbox)', () => {
  const calls: Options[] = []
  createClaudeConnection(base, fakeFactory(() => 'exit 0', calls)).createTitleModel()
  assert.deepEqual(calls[0].tools, [])
  assert.deepEqual(calls[0].mcpServers, {})
  assert.equal(calls[0].strictMcpConfig, true)
})

test('other failures under the sandbox surface unchanged (never a silent unsandboxed re-run)', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(() => 'echo boom >&2; exit 1', calls))
  assert.equal(await text(connection.createChatModel({ appSessionId: 'b1', sandbox: enforce('record-only') })), '[error Claude Code process exited with code 1]')
  assert.equal(calls.length, 1)
})

test('a host the sandbox refused: the AI is told the company\'s sentence to relay', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(() => 'exit 0', calls))
  await text(connection.createChatModel({ appSessionId: 'h1', sandbox: enforce() }))
  const hook = calls[0].hooks.PostToolUseFailure[0].hooks[0]
  const out = await hook({
    hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'curl https://example.org' },
    error: 'Exit code 56\n<sandbox_violations>\ndeny network-outbound example.org:443 (host is not on the allow list)\n</sandbox_violations>',
  })
  assert.match(out.hookSpecificOutput.additionalContext, /会社の設定で、この宛先（example\.org）には接続できません。必要なら管理者に許可を依頼してください。/)
  const other = await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'y', tool_input: { command: 'ls x' }, error: 'ls: x: No such file or directory' })
  assert.equal(other.hookSpecificOutput, undefined)
})

test('a command refused writing a Skill file in the company folder: the AI is sent to Edit / Write, not told it lacks the right', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection(base, fakeFactory(() => 'exit 0', calls))
  const writeGuard = { root: COMPANY, getAccess: () => undefined } as unknown as WriteGuard
  await text(connection.createChatModel({ appSessionId: 's1', sandbox: enforce(), writeGuard }))
  await text(connection.createChatModel({ appSessionId: 's2', sandbox: enforce() }))
  const failed = (command: string, error: string, call = 0) =>
    calls[call].hooks.PostToolUseFailure[0].hooks[0]({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'w', tool_input: { command }, error, cwd: COMPANY })
  const sent = [
    ['python3 -I - .claude/skills/x/SKILL.md', 'Traceback (most recent call last):\n  File "<stdin>", line 9, in <module>\nPermissionError: [Errno 1] Operation not permitted: \'.claude/skills/x/SKILL.md\''], // the case seen
    ['cp a.html "$C/.claude/skills/x/a.html"', `cp: ${COMPANY}/.claude/skills/x/a.html: Operation not permitted`],
    ['echo x > .agents/skills/x/SKILL.md', 'bash: line 1: .agents/skills/x/SKILL.md: Operation not permitted'],
    ['cp a 営業/.claude/skills/x/a', 'cp: 営業/.claude/skills/x/a: Operation not permitted'],
  ]
  for (const [command, error] of sent) assert.match((await failed(command, error)).hookSpecificOutput.additionalContext, /use the Edit or Write tool/, command)
  const unchanged = [
    ['cp a b', 'cp: b: Operation not permitted'], // elsewhere
    ['python3 .claude/skills/x/run.py', 'Traceback (most recent call last):\n  File ".claude/skills/x/run.py", line 3\nPermissionError: [Errno 1] Operation not permitted: \'/protected/out\''], // a Skill's tool writing elsewhere
    ['cp a .claude/settings.json', 'cp: .claude/settings.json: Operation not permitted'], // agent config, not a Skill
    ['cp a ~/.claude/skills/x/a', `cp: ${HOME}/.claude/skills/x/a: Operation not permitted`], // the member's own folder
    ['cp a x', 'cp: ~/.claude/skills/x/a: Operation not permitted'], // the home folder, unexpanded
    ['cp a x', 'cp: /Users/other1/Documents/AI Company Builder/acme/.claude/skills/x/a: Operation not permitted'], // another company folder
    ['cp a .claude/skills/../../x', 'cp: .claude/skills/../../x: Operation not permitted'], // climbs out
    ['python3 m.py', "PermissionError: [Errno 1] Operation not permitted: '/protected/a' -> '.claude/skills/x/a'"], // two paths: unclear
    ['sh m.sh', 'cp: .claude/skills/x/a: Operation not permitted\ncp: .claude/settings.json: Operation not permitted'], // mixed
    ['cp a .claude/skills/x/a', 'cp: .claude/skills/x/a: No such file or directory'], // not the sandbox
  ]
  for (const [command, error] of unchanged) assert.equal((await failed(command, error)).hookSpecificOutput, undefined, command)
  assert.equal((await failed('cp a .claude/skills/x/a', 'cp: .claude/skills/x/a: Operation not permitted', 1)).hookSpecificOutput, undefined, 'no company folder known')
})

test('a Skill path that a link takes out of the company folder keeps the usual handling', async () => {
  const top = mkdtempSync(path.join(tmpdir(), 'acb-skill-link-'))
  try {
    const company = path.join(top, 'company')
    mkdirSync(path.join(company, '.claude/skills/x'), { recursive: true })
    mkdirSync(path.join(top, 'outside'))
    symlinkSync(path.join(top, 'outside'), path.join(company, '.claude/skills/x/link'))
    const calls: Options[] = []
    const connection = createClaudeConnection(base, fakeFactory(() => 'exit 0', calls))
    await text(connection.createChatModel({ appSessionId: 'l1', sandbox: enforce(), writeGuard: { root: company, getAccess: () => undefined } as unknown as WriteGuard }))
    const failed = (target: string) => calls[0].hooks.PostToolUseFailure[0].hooks[0]({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'w', tool_input: { command: `cp a ${target}` }, error: `cp: ${target}: Operation not permitted`, cwd: company,
    })
    assert.match((await failed('.claude/skills/x/SKILL.md')).hookSpecificOutput.additionalContext, /use the Edit or Write tool/)
    assert.equal((await failed('.claude/skills/x/link/settings.json')).hookSpecificOutput, undefined)
  } finally {
    rmSync(top, { recursive: true, force: true })
  }
})

test('the app enforces only where the agent can: Claude Code on macOS / Linux, never on Windows', () => {
  assert.equal(AGENTS['claude-code'].capabilities.sandbox, true)
  assert.equal(sandboxPlatform('darwin'), true)
  assert.equal(sandboxPlatform('win32'), false)
  const settings = { mode: 'enforce' as const, allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only' as const }
  const windows = decideTurnSandbox(settings, { home: 'C:/Users/m' }, AGENTS['claude-code'].capabilities.sandbox && sandboxPlatform('win32'))
  assert.ok(windows.mode === 'observe' && windows.degraded)
})
