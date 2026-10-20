import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, UIMessage } from 'ai'
import { createCodexConnection, getCodexStatus, type CodexTransport } from '../electron/agents/codex'
import { agentInputMessages, resumeSession } from '../electron/agents/session'
import type { RpcMessage } from '../electron/agents/codex-rpc'

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
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
    const results: Record<string, unknown> = {
      'account/read': { account: { type: this.auth } },
      'model/list': { data: [{ model: 'test-model', displayName: 'Test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'thread-a' } }, 'thread/resume': { thread: { id: 'thread-a' } }, 'turn/start': { turn: { id: 'turn-a' } },
    }
    if (method === 'turn/start') this.onMessage({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    return results[method] as T
  }
  send(message: RpcMessage) { this.replies.push(message) }
  close() { this.closed = true }
  complete() {
    this.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', itemId: 'a', delta: '回答' } })
    this.onMessage({ method: 'item/completed', params: { threadId: 'thread-a', item: { id: 'a', type: 'agentMessage', text: '回答' } } })
    this.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } })
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '質問' }] }]
function setup(rpc = new FakeRpc(), approval?: (name: string, input: Record<string, unknown>, id: string, app?: string) => Promise<{ approved: boolean }>) {
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestToolApproval: approval }, () => rpc)
  return { rpc, connection }
}

test('provider and model switches never resume stale native context', () => {
  const session = { providerId: 'claude-code' as const, id: 'claude-a', modelId: 'sonnet' }
  assert.equal(resumeSession(session, 'codex', 'test-model'), undefined)
  assert.equal(resumeSession(session, 'claude-code', 'haiku'), undefined)
  assert.equal(resumeSession(session, 'claude-code', 'sonnet'), 'claude-a')
  const messages = [ { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'previous' }, { type: 'reasoning', text: 'private' }] }, { id: 'u', role: 'user', parts: [{ type: 'text', text: 'next' }] } ] as UIMessage[]
  assert.equal(agentInputMessages(messages)[0].parts.length, 1)
  assert.deepEqual(agentInputMessages(messages, 'id').map(m => m.id), ['u'])
  assert.throws(() => agentInputMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(160001) }] }]), /長すぎ/)
})

test('ChatGPT auth, exact model/effort, resume and one-copy text output', async () => {
  const { rpc, connection } = setup()
  const model = connection.createChatModel({ resumeId: 'thread-a', modelId: 'test-model', effort: 'high' }) as Model
  const response = model.doGenerate({ prompt })
  await tick()
  assert.equal(rpc.calls.find(c => c.method === 'thread/resume')?.params.threadId, 'thread-a')
  const start = rpc.calls.find(c => c.method === 'turn/start')!
  assert.equal(start.params.effort, 'high')
  assert.equal((start.params.input as {text:string}[])[0].text, '質問')
  rpc.complete()
  const result = await response
  assert.deepEqual(result.content, [{ type: 'text', text: '回答' }])
  assert.equal(connection.readMetadata(result.providerMetadata).sessionId, 'thread-a')
  assert.ok(rpc.closed)
})

test('API-key auth and unavailable effort fail before generation', async () => {
  for (const reason of ['auth', 'effort']) {
    const { rpc, connection } = setup()
    if (reason === 'auth') rpc.auth = 'apiKey'
    const model = connection.createChatModel({ effort: reason === 'effort' ? 'ultra' : 'low' }) as Model
    await assert.rejects(model.doGenerate({ prompt }), reason === 'auth' ? /ChatGPT/ : /effort/)
    assert.ok(!rpc.calls.some(c => c.method === 'turn/start'))
    assert.ok(rpc.closed)
  }
})

test('approval is scoped and rejection is sent back; stop interrupts and disposes', async () => {
  let approvalApp: string | undefined
  const { rpc, connection } = setup(undefined, async (_name, _input, _id, app) => { approvalApp = app; return { approved: false } })
  const abort = new AbortController()
  const model = connection.createChatModel({ appSessionId: 'app-a' }) as Model
  const response = model.doGenerate({ prompt, abortSignal: abort.signal })
  await tick()
  rpc.onMessage({ id: 'approval-a', method: 'item/commandExecution/requestApproval', params: { command: 'rm file' } })
  await tick()
  assert.equal(approvalApp, 'app-a')
  assert.deepEqual(rpc.replies[0].result, { decision: 'decline' })
  abort.abort()
  await assert.rejects(response, /停止/)
  assert.ok(rpc.replies.some(r => r.method === 'turn/interrupt'))
  assert.ok(rpc.closed)
})

test('title is ephemeral and never inherits a conversation session', async () => {
  const { rpc, connection } = setup()
  const response = (connection.createTitleModel() as Model).doGenerate({ prompt })
  await tick()
  const start = rpc.calls.find(c => c.method === 'thread/start')!
  assert.equal(start.params.ephemeral, true)
  assert.equal(start.params.approvalPolicy, 'never')
  rpc.complete()
  await response
})

test('Windows reports unsupported without starting Codex', async () => {
  const status = await getCodexStatus({}, 'win32')
  assert.equal(status.unsupported, true)
  assert.equal(status.available, false)
  assert.equal(status.authenticated, false)
  assert.deepEqual(status.models, [])
  assert.match(status.error!, /Windows版ACB/)
  assert.doesNotMatch(status.error!, /codex login/)
})

test('Codex questions map answers by id and permissions grant only the exact request for one turn', async () => {
  const rpc = new FakeRpc()
  const requests: { kind: string; app: string }[] = []
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestInteraction: async (request, app) => {
    requests.push({ kind: request.kind, app })
    return request.kind === 'questions' ? { answers: { format: 'Markdown' } } : { approved: true }
  } }, () => rpc)
  const response = (connection.createChatModel({ appSessionId: 'chat-a' }) as Model).doGenerate({ prompt })
  await tick()
  rpc.onMessage({ id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'format', header: '形式', question: '保存形式は？', options: null, isOther: false, isSecret: false }] } })
  await tick()
  assert.deepEqual(rpc.replies.find(r => r.id === 'q')?.result, { answers: { format: { answers: ['Markdown'] } } })
  const permissions = { network: null, fileSystem: { read: null, write: ['/tmp/export'] } }
  rpc.onMessage({ id: 'p', method: 'item/permissions/requestApproval', params: { permissions, reason: '保存', cwd: '/tmp' } })
  await tick()
  assert.deepEqual(rpc.replies.find(r => r.id === 'p')?.result, { permissions: { fileSystem: permissions.fileSystem }, scope: 'turn' })
  assert.deepEqual(requests, [{ kind: 'questions', app: 'chat-a' }, { kind: 'permissions', app: 'chat-a' }])
  rpc.complete(); await response
})
test('stopping a turn cancels outstanding interaction and never sends a late answer', async () => {
  const rpc = new FakeRpc()
  let settle!: (answer: { approved: boolean }) => void
  let interactionSignal!: AbortSignal
  const abort = new AbortController()
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestInteraction: (_r, _app, signal) => {
    interactionSignal = signal; return new Promise(resolve => { settle = resolve })
  } }, () => rpc)
  const response = (connection.createChatModel({ appSessionId: 'chat-a' }) as Model).doGenerate({ prompt, abortSignal: abort.signal })
  await tick()
  rpc.onMessage({ id: 'p', method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } })
  await tick(); abort.abort()
  await assert.rejects(response, /停止/)
  assert.equal(interactionSignal.aborted, true)
  settle({ approved: true }); await tick()
  assert.equal(rpc.replies.some(r => r.id === 'p'), false)
})

test('server-resolved prompts disappear without replying late or interrupting the ongoing turn', async () => {
  const rpc = new FakeRpc()
  let signal!: AbortSignal
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestInteraction: (_r, _app, s) => {
    signal = s
    return new Promise(resolve => s.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }))
  } }, () => rpc)
  const response = (connection.createChatModel({ appSessionId: 'chat-a' }) as Model).doGenerate({ prompt })
  await tick()
  rpc.onMessage({ id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', header: '質問', question: '続けますか', options: null, isOther: false, isSecret: false }] } })
  await tick()
  rpc.onMessage({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 'q' } })
  await tick()
  assert.equal(signal.aborted, true)
  assert.equal(rpc.replies.some(r => r.id === 'q' || r.method === 'turn/interrupt'), false)
  rpc.complete(); await response
})
