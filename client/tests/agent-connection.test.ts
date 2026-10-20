import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createApiConnection } from '../electron/agents/anthropic-api'
import { claudeCode } from 'ai-sdk-provider-claude-code'

const config: ClaudeConnectionConfig = {
  getPermissionMode: () => 'default',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: '/test' }),
}

function capture(overrides: Partial<ClaudeConnectionConfig> = {}) {
  let captured: { model: string; options: any }
  const factory = ((model: string, options: unknown) => {
    captured = { model, options }
    return {} as ReturnType<typeof claudeCode>
  }) as typeof claudeCode
  const connection = createClaudeConnection({ ...config, ...overrides }, factory)
  return { connection, read: () => captured! }
}

test('resume, effort and spawn are confined to Claude connection; title has no resume', () => {
  const { connection, read } = capture()
  connection.createChatModel({ resumeId: 'session-a', modelId: 'sonnet', effort: 'xhigh', workingDirectory: '/project' })
  const chat = read()
  assert.equal(chat.model, 'sonnet')
  assert.equal(chat.options.resume, 'session-a')
  assert.equal(chat.options.sdkOptions.effort, 'high')
  assert.equal(chat.options.cwd, '/project')
  assert.equal(chat.options.streamingInput, 'always')
  connection.createTitleModel()
  assert.equal(read().model, 'haiku')
  assert.equal(read().options.resume, undefined)
  assert.equal(read().options.spawnClaudeCodeProcess, chat.options.spawnClaudeCodeProcess)
})

test('dangerous commands require scoped approval even with bypassPermissions', async () => {
  const requests: unknown[][] = []
  const { connection, read } = capture({
    getPermissionMode: () => 'bypassPermissions',
    requestToolApproval: async (...args) => { requests.push(args); return { approved: false } },
  })
  connection.createChatModel({ appSessionId: 'conversation-a' })
  const hook = read().options.hooks.PreToolUse[0].hooks[0]
  const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm file' }, tool_use_id: 'tool-a' })
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(requests[0][3], 'conversation-a')
  const agent = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'work', run_in_background: true } })
  assert.deepEqual(agent.hookSpecificOutput.updatedInput, { prompt: 'work', run_in_background: false })
})

test('read-only tools bypass approval; writes preserve denial', async () => {
  let calls = 0
  const { connection, read } = capture({ requestToolApproval: async () => { calls++; return { approved: false } } })
  connection.createChatModel({})
  const check = read().options.canUseTool
  assert.equal((await check('Read', {}, {})).behavior, 'allow')
  assert.equal(calls, 0)
  assert.equal((await check('Write', {}, { toolUseID: 'write-a' })).behavior, 'deny')
  assert.equal(calls, 1)
})

test('normalizes native metadata without retaining provider payload', () => {
  const connection = createClaudeConnection(config)
  assert.deepEqual(connection.readMetadata(undefined), { sessionId: undefined, contextUsage: undefined })
  assert.deepEqual(connection.readMetadata({ 'claude-code': { sessionId: 's', modelUsage: {
    a: { inputTokens: 10, outputTokens: 3, contextWindow: 200000 }, b: { inputTokens: 4, outputTokens: 2 },
  } } }), { sessionId: 's', contextUsage: { inputTokens: 14, outputTokens: 5, contextWindow: 200000 } })
  const api = createApiConnection({ getApiKey: () => undefined })
  assert.equal(api.ownsConversation, false)
  assert.ok(api.authenticationError())
  assert.deepEqual(api.readMetadata({ 'claude-code': { sessionId: 'wrong-provider' } }), {})
})

test('dangerous gate denies without a handler and honors explicit approval', async () => {
  for (const approved of [undefined, true]) {
    const { connection, read } = capture({
      requestToolApproval: approved === undefined ? undefined : async () => ({ approved }),
    })
    connection.createChatModel({})
    const hook = read().options.hooks.PreToolUse[0].hooks[0]
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } })
    assert.equal(result.hookSpecificOutput.permissionDecision, approved ? 'allow' : 'deny')
  }
})
