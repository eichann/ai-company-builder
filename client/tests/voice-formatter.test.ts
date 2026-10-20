import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceFormatter, type VoiceFormatterConfig } from '../electron/voice-formatter'
import { generateCodexText, CODEX_TEXT_OVERRIDES, selectVoiceModel } from '../electron/agents/codex-text'
import type { CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'

const signal = () => new AbortController().signal
const config = (authMode: VoiceFormatterConfig['authMode']): VoiceFormatterConfig => ({ authMode, apiKey: 'test-key', getCli: () => { throw new Error('Claude must not be accessed') }, cwd: '/tmp', env: {} })

test('Codex/API routing needs no Claude install; snapshot survives setting changes', async () => {
  for (const mode of ['codex', 'api-key'] as const) {
    const settings = config(mode)
    const calls: string[] = []
    const format = createVoiceFormatter(settings, {
      claude: async () => { throw new Error('Wrong provider') },
      codex: async request => { calls.push('codex'); assert.equal(JSON.parse(request.text).transcript, '原文'); return '整形済み' },
      api: async key => { calls.push('api-key'); assert.equal(key, 'test-key'); return '整形済み' },
    })
    settings.authMode = 'claude-code'; settings.apiKey = 'changed'
    assert.equal(await format('原文', signal()), '整形済み')
    assert.deepEqual(calls, [mode])
  }
})
test('Claude routing stays on Haiku adapter and provider failure never falls back', async () => {
  let claudeCalls = 0
  const adapters = { claude: async () => { claudeCalls++; return 'Claude結果' }, codex: async () => { throw new Error('login required') }, api: async () => 'api' }
  const settings = { ...config('claude-code'), getCli: () => '/fake/claude' }
  assert.equal(await createVoiceFormatter(settings, adapters)('原文', signal()), 'Claude結果')
  await assert.rejects(createVoiceFormatter(config('codex'), adapters)('原文', signal()), /login required/)
  assert.equal(claudeCalls, 1)
  await assert.rejects(createVoiceFormatter({ ...config('api-key'), apiKey: undefined }, adapters)('原文', signal()), /APIキー/)
})
test('cancelled or empty formatting results cannot reach the textbox', async () => {
  const controller = new AbortController()
  const adapters = { claude: async () => '', api: async () => '', codex: async () => { controller.abort(); return '遅い結果' } }
  await assert.rejects(createVoiceFormatter(config('codex'), adapters)('原文', controller.signal), /キャンセル/)
  await assert.rejects(createVoiceFormatter(config('api-key'), adapters)('原文', signal()), /有効な整形結果/)
})

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  replies: RpcMessage[] = []
  closed = false
  auth = 'chatgpt'
  async initialize() {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'turn/start') this.onMessage({ method: 'turn/started', params: { turn: { id: 'turn-a' } } })
    return ({
      'account/read': { account: { type: this.auth } },
      'model/list': { data: [{ model: 'gpt-5.6-luna', displayName: 'Luna', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'config/read': { config: { mcp_servers: { private: { command: 'never-run' } } } },
      'thread/start': { thread: { id: 'thread-a' } }, 'turn/start': { turn: { id: 'turn-a' } },
    } as Record<string, unknown>)[method] as T
  }
  send(message: RpcMessage) { this.replies.push(message) }
  close() { this.closed = true }
  complete(text: string) {
    this.onMessage({ method: 'item/agentMessage/delta', params: { delta: text } })
    this.onMessage({ method: 'item/completed', params: { item: { type: 'agentMessage', text, phase: 'final_answer' } } })
    this.onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const request = () => ({ env: {}, cwd: '/tmp/voice-only', system: '整形のみ', text: '{"transcript":"原文"}', signal: signal() })
test('Codex formatting uses an isolated ephemeral turn, disabled tools and no resume/history', async () => {
  const rpc = new FakeRpc()
  const pending = generateCodexText(request(), (_, overrides) => { assert.equal(overrides, CODEX_TEXT_OVERRIDES); return rpc })
  await tick()
  const start = rpc.calls.find(c => c.method === 'thread/start')!.params
  assert.equal(start.ephemeral, true)
  assert.equal(start.approvalPolicy, 'never')
  assert.equal(start.baseInstructions, '整形のみ')
  assert.deepEqual(start.config, { mcp_servers: { private: { enabled: false } } })
  assert.equal(rpc.calls.some(c => c.method === 'thread/resume'), false)
  const turn = rpc.calls.find(c => c.method === 'turn/start')!.params
  assert.equal(turn.model, 'gpt-5.6-luna'); assert.equal(turn.effort, 'low')
  assert.deepEqual(turn.input, [{ type: 'text', text: '{"transcript":"原文"}', text_elements: [] }])
  rpc.onMessage({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '前置き', phase: 'commentary' } } })
  rpc.complete('整形結果')
  assert.equal(await pending, '整形結果')
  assert.equal(rpc.closed, true)
})
test('Codex abort interrupts and closes; tool requests and API auth fail closed', async () => {
  const abort = new AbortController()
  const rpc = new FakeRpc()
  const pending = generateCodexText({ ...request(), signal: abort.signal }, () => rpc)
  await tick(); abort.abort()
  await assert.rejects(pending, /キャンセル/)
  assert.ok(rpc.replies.some(r => r.method === 'turn/interrupt')); assert.ok(rpc.closed)
  const toolRpc = new FakeRpc()
  const toolPending = generateCodexText(request(), () => toolRpc)
  await tick()
  toolRpc.onMessage({ id: 3, method: 'item/commandExecution/requestApproval', params: {} })
  await assert.rejects(toolPending, /不要な操作/)
  assert.ok(toolRpc.closed)
  const badAuth = new FakeRpc(); badAuth.auth = 'apikey'
  await assert.rejects(generateCodexText(request(), () => badAuth), /codex login/)
  assert.equal(badAuth.calls.some(c => c.method === 'thread/start'), false)
})
test('model fallback remains within the available Codex catalog', () => {
  const model = { id: 'other', label: 'Other', efforts: ['medium'], defaultEffort: 'medium', isDefault: true }
  assert.deepEqual(selectVoiceModel([model]), { model, effort: 'medium' })
  assert.throws(() => selectVoiceModel([]), /モデル/)
})

test('rate limits keep an actionable error and never return it as formatted text', async () => {
  const rpc = new FakeRpc()
  const pending = generateCodexText(request(), () => rpc)
  await tick()
  rpc.onMessage({ method: 'error', params: { error: { message: '429 Too Many Requests' }, willRetry: false } })
  await assert.rejects(pending, /利用上限.*原文は保持/)
  assert.equal(rpc.closed, true)
})
