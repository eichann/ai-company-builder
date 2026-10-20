import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeConnection, PERMISSION_FALLBACK_NOTICE, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { normalizePermissionMode } from '../shared/permission-mode'
import type { claudeCode } from 'ai-sdk-provider-claude-code'

const base: ClaudeConnectionConfig = {
  getPermissionMode: () => 'auto',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: process.env.PATH || '' }),
  requestToolApproval: async () => ({ approved: false }),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Options = any

/**
 * A fake provider model whose CLI is a real `/bin/sh` script, spawned through the
 * connection's own spawn wrapper. With `hookMode`, the PreToolUse hook reports that
 * effective permission mode just before part number `hookAt` is delivered.
 */
function fakeFactory(script: (mode: string) => string, calls: Options[], hookMode?: string, hookAt = 1) {
  return ((modelId: string, options: Options) => {
    calls.push(options)
    return {
      specificationVersion: 'v3', provider: 'fake', modelId, supportedUrls: {},
      doGenerate: async () => { throw new Error('unused') },
      doStream: async () => {
        const child = options.spawnClaudeCodeProcess({ command: '/bin/sh', args: ['-c', script(options.permissionMode)], env: process.env })
        const code = await new Promise<number>(resolve => child.on('close', resolve))
        const parts = code === 0
          ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: `ran in ${options.permissionMode}` }, { type: 'text-delta', id: 't', delta: '' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage: {} }]
          : [{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error(`Claude Code process exited with code ${code}`) }]
        let index = 0
        return { stream: new ReadableStream({ async pull(c) {
          // Paced like a real CLI, so the consumer keeps up and the hook lands mid-block.
          await new Promise(resolve => setTimeout(resolve, 10))
          if (hookMode && index === hookAt) await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, permission_mode: hookMode })
          if (index < parts.length) c.enqueue(parts[index++]); else c.close()
        } }) }
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

const REJECT = `echo "error: option '--permission-mode <mode>' argument 'auto' is invalid. Allowed choices are acceptEdits, bypassPermissions, default, plan." >&2; exit 1`

test('unset or unknown mode means auto; explicit choices are kept', () => {
  assert.equal(normalizePermissionMode(undefined), 'auto')
  assert.equal(normalizePermissionMode('nonsense'), 'auto')
  assert.equal(normalizePermissionMode('bypassPermissions'), 'bypassPermissions')
  assert.equal(normalizePermissionMode('default'), 'default')
})

test('auto and default wire the approval UI; bypass does not', () => {
  for (const [mode, wired] of [['auto', true], ['default', true], ['bypassPermissions', false]] as const) {
    const calls: Options[] = []
    createClaudeConnection({ ...base, getPermissionMode: () => mode }, fakeFactory(() => 'exit 0', calls)).createChatModel({})
    assert.equal(calls[0].permissionMode, mode)
    assert.equal(typeof calls[0].canUseTool === 'function', wired, mode)
  }
})

test('the hook leaves ordinary tools to the permission mode instead of allowing them', async () => {
  const calls: Options[] = []
  createClaudeConnection(base, fakeFactory(() => 'exit 0', calls)).createChatModel({})
  const hook = calls[0].hooks.PreToolUse[0].hooks[0]
  for (const [tool_name, tool_input] of [['Write', { file_path: '.claude/settings.json' }], ['Bash', { command: 'echo hi > a.txt' }]] as const) {
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input })
    assert.equal(result.hookSpecificOutput?.permissionDecision, undefined, tool_name)
  }
  const dangerous = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } })
  assert.equal(dangerous.hookSpecificOutput.permissionDecision, 'deny')
})

test('a CLI that rejects auto re-runs the turn in default, says so once, and is remembered', async () => {
  const calls: Options[] = []
  const config = { ...base, getClaudeCodeCliPath: () => '/old/claude' }
  const connection = createClaudeConnection(config, fakeFactory(mode => (mode === 'auto' ? REJECT : 'exit 0'), calls))
  const first = await text(connection.createChatModel({ appSessionId: 'old-a' }))
  assert.deepEqual(calls.map(c => c.permissionMode), ['auto', 'default'])
  assert.equal(typeof calls[1].canUseTool, 'function')
  assert.equal(first, `※ ${PERMISSION_FALLBACK_NOTICE.cli}\n\nran in default`)
  // Same conversation: no repeat notice, and no second attempt with auto.
  assert.equal(await text(connection.createChatModel({ appSessionId: 'old-a' })), 'ran in default')
  assert.deepEqual(calls.map(c => c.permissionMode), ['auto', 'default', 'default'])
  // A new conversation is told once.
  assert.equal(await text(connection.createChatModel({ appSessionId: 'old-b' })), `※ ${PERMISSION_FALLBACK_NOTICE.cli}\n\nran in default`)
})

test('an account where auto is unavailable gets a notice; a working auto session does not', async () => {
  const unavailable = createClaudeConnection({ ...base, getClaudeCodeCliPath: () => '/plan/claude' }, fakeFactory(() => 'exit 0', [], 'default'))
  assert.equal(await text(unavailable.createChatModel({ appSessionId: 'plan-a' })), `※ ${PERMISSION_FALLBACK_NOTICE.account}\n\nran in auto`)
  const working = createClaudeConnection({ ...base, getClaudeCodeCliPath: () => '/new/claude' }, fakeFactory(() => 'exit 0', [], 'auto'))
  assert.equal(await text(working.createChatModel({ appSessionId: 'new-a' })), 'ran in auto')
})

test('the notice never splits an open text block', async () => {
  // The hook reports 'default' while the text block (parts 1-3) is still open.
  const connection = createClaudeConnection({ ...base, getClaudeCodeCliPath: () => '/plan/claude' }, fakeFactory(() => 'exit 0', [], 'default', 3))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { stream } = await (connection.createChatModel({ appSessionId: 'plan-b' }) as any).doStream({ prompt: [] })
  let open: string | undefined
  let notices = 0
  const deltas: string[] = []
  for await (const part of stream) {
    if (part.type === 'text-start') { assert.equal(open, undefined, 'a text block started inside another'); open = part.id }
    if (part.type === 'text-delta') { assert.equal(part.id, open); deltas.push(part.delta); if (part.delta.startsWith('※')) notices++ }
    if (part.type === 'text-end') { assert.equal(part.id, open); open = undefined }
  }
  assert.equal(notices, 1)
  assert.equal(deltas[0], 'ran in auto')
})

test('other auto failures surface unchanged', async () => {
  const calls: Options[] = []
  const connection = createClaudeConnection({ ...base, getClaudeCodeCliPath: () => '/broken/claude' }, fakeFactory(() => 'echo boom >&2; exit 1', calls))
  assert.equal(await text(connection.createChatModel({ appSessionId: 'broken-a' })), '[error Claude Code process exited with code 1]')
  assert.deepEqual(calls.map(c => c.permissionMode), ['auto'])
})
