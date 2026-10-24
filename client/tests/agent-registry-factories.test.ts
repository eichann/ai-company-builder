import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, AGENT_IDS } from '../shared/agents/registry'
import {
  AGENT_FACTORIES, CAPABILITY_FACTORIES, createAgentConnection, oneShotUnavailable, runOneShotText, writeAgentHandoff,
  type AgentHost, type OneShotTextRequest,
} from '../electron/agents/registry'

const host: AgentHost = {
  getApiKey: () => undefined,
  getShellEnv: () => ({}),
  getPermissionMode: () => 'default',
  isClaudeCodeAuthenticated: () => false,
  getClaudeCodeCliPath: () => '/nonexistent/claude',
}

test('every capability-gated factory an agent claims exists, and none it does not claim', () => {
  for (const id of AGENT_IDS) {
    for (const [capability, factory] of Object.entries(CAPABILITY_FACTORIES) as [keyof typeof CAPABILITY_FACTORIES, string][]) {
      const claimed = AGENTS[id].capabilities[capability]
      const provided = typeof (AGENT_FACTORIES[id] as unknown as Record<string, unknown>)[factory] === 'function'
      assert.equal(provided, claimed, `${id}: capabilities.${capability} = ${claimed}, factory ${factory} ${provided ? 'present' : 'absent'}`)
    }
  }
})

test('every agent gets a connection that matches its descriptor', () => {
  for (const id of AGENT_IDS) {
    const connection = createAgentConnection(id, host)
    assert.equal(connection.ownsConversation, AGENTS[id].capabilities.ownsConversation, id)
    assert.equal(typeof connection.createChatModel, 'function')
    assert.equal(typeof connection.createTitleModel, 'function')
  }
  // Ids as before (the API connection never carried the registry id).
  assert.deepEqual(AGENT_IDS.map(id => createAgentConnection(id, host).id), ['claude-code', 'codex', 'anthropic-api'])
})

test('role profiles are refused until an agent implements them; an empty one is the normal connection', () => {
  for (const id of AGENT_IDS) {
    assert.throws(() => createAgentConnection(id, host, { role: 'reader', allowedTools: [] }), /role profiles are not supported yet \(role, allowedTools\)/)
    assert.throws(() => createAgentConnection(id, host, { cwd: '/tmp' }), /cwd/)
    assert.equal(createAgentConnection(id, host, {}).ownsConversation, AGENTS[id].capabilities.ownsConversation)
    assert.equal(createAgentConnection(id, host, { role: undefined }).ownsConversation, AGENTS[id].capabilities.ownsConversation)
  }
})

test('capability-gated entry points refuse an agent without the capability', async () => {
  const request = { input: { messages: [] }, cwd: '/tmp', env: {}, signal: new AbortController().signal, save: () => {} }
  await assert.rejects(writeAgentHandoff('api-key', request, { getCli: () => '/x' }), /no hand-off memos/)
})

test('one-shot readiness: the API key needs a key; Claude Code only when the caller asks; Codex is always tried', () => {
  const base = { getCli: () => { throw new Error('not read') }, cwd: '/tmp', env: {} }
  assert.match(oneShotUnavailable('api-key', base) ?? '', /APIキー/)
  assert.equal(oneShotUnavailable('api-key', { ...base, apiKey: 'k' }), undefined)
  assert.equal(oneShotUnavailable('claude-code', base), undefined)
  assert.ok(oneShotUnavailable('claude-code', { ...base, claudeReady: () => false }))
  assert.ok(oneShotUnavailable('claude-code', { ...base, claudeReady: () => { throw new Error('broken') } }))
  assert.equal(oneShotUnavailable('claude-code', { ...base, claudeReady: () => true }), undefined)
  assert.equal(oneShotUnavailable('codex', base), undefined)
})

test('the API one-shot refuses without a key before any request', async () => {
  const request: OneShotTextRequest = {
    job: 'voice', system: 's', input: {}, signal: new AbortController().signal,
    host: { getCli: () => '/x', cwd: '/tmp', env: {} }, timeoutMs: 1000, maxOutputTokens: 10,
    cliMessages: { cancelled: '', timedOut: '', spawnFailed: '', stdinFailed: '', tooLong: '', exitFailed: '', invalid: '' },
  }
  await assert.rejects(runOneShotText('api-key', request), /APIキー/)
})
