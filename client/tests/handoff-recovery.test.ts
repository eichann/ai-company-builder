import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamText, type LanguageModel, type UIMessage } from 'ai'
import { recoverSessionModel, MissingAgentSession } from '../electron/agents/recovery'
import type { AgentConnection } from '../electron/agents/connection'
import { recoveryContext } from '../electron/handoff/recovery-context'
import { fingerprint, type HandoffState } from '../electron/handoff/store'
import type { ChatSession } from '../shared/chat-history'
import { createClaudeConnection } from '../electron/agents/claude'
type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
type Result = Awaited<ReturnType<Model['doStream']>>
type Part = Result['stream'] extends ReadableStream<infer T> ? T : never
const finish: Part = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } }
const success: Part[] = [{ type: 'response-metadata', id: 'new-session' }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: '継続できました' }, { type: 'text-end', id: 'text' }, finish]
function setup(first: Part[], second = success, aborted = false) {
  const calls: Array<{ resumeId?: string; prompt: unknown }> = []; const events: string[] = []
  const connection: AgentConnection = { id: 'test', ownsConversation: true, authenticationError: () => undefined, readMetadata: () => ({}), isMissingSession: e => e instanceof MissingAgentSession,
    createChatModel(request) {
      return { specificationVersion: 'v3', provider: 'test', modelId: 'test', supportedUrls: {}, doGenerate: async () => { throw new Error('unused') },
        doStream: async options => {
          calls.push({ resumeId: request.resumeId, prompt: options.prompt })
          return { stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of calls.length === 1 ? first : second) c.enqueue(p); c.close() } }) }
        } } as Model
    }, createTitleModel() { throw new Error('unused') } }
  const controller = new AbortController(); if (aborted) controller.abort()
  const model = recoverSessionModel(connection, { resumeId: 'old' }, {
    prepare: () => ({ context: '引き継ぎメモ: 予算12万円', usedMemo: true }), started: () => events.push('started'), session: id => events.push(id), finished: () => events.push('finished'), failed: () => events.push('failed'),
  })
  return { calls, events, run: async () => {
    const result = streamText({ model, prompt: '予算は？', maxRetries: 0, abortSignal: controller.signal, onError: () => {} })
    const parts = []; for await (const p of result.fullStream) parts.push(p)
    return parts
  } }
}
test('missing session retries once with memo and persists ID before finish', async () => {
  const f = setup([{ type: 'error', error: new MissingAgentSession('old') }]); const parts = await f.run()
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].resumeId, 'old'); assert.equal(f.calls[1].resumeId, undefined)
  assert.match(JSON.stringify(f.calls[1].prompt), /予算12万円/); assert.match(JSON.stringify(f.calls[1].prompt), /予算は/)
  assert.deepEqual(f.events, ['started', 'new-session', 'finished']); assert.equal(parts.some(p => p.type === 'error'), false)
  assert.equal(parts.filter(p => p.type === 'text-delta').length, 1)
})
test('auth, timeout, partial output and tool activity are never retried', async () => {
  for (const first of [
    [{ type: 'error', error: new Error('401') }], [{ type: 'error', error: new Error('timeout') }],
    [{ type: 'text-start', id: 'x' }, { type: 'error', error: new MissingAgentSession('old') }],
    [{ type: 'tool-call', toolCallId: 'x', toolName: 'Write', input: '{}', providerExecuted: true }, { type: 'error', error: new MissingAgentSession('old') }],
  ] as Part[][]) { const f = setup(first); await f.run(); assert.equal(f.calls.length, 1); assert.deepEqual(f.events, []) }
})
test('second failure stops and aborted requests do not start a replacement', async () => {
  const f = setup([{ type: 'error', error: new MissingAgentSession('old') }], [{ type: 'error', error: new MissingAgentSession('new') }]); await f.run()
  assert.equal(f.calls.length, 2); assert.deepEqual(f.events, ['started', 'failed'])
  const cancelled = setup([], success, true); await cancelled.run(); assert.equal(cancelled.calls.length, 0)
})
test('Claude missing detection requires exact native error and requested ID', () => {
  const c = createClaudeConnection({ getShellEnv: () => ({}), getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => 'unused' })
  assert.equal(c.isMissingSession!({ data: { stderr: 'No conversation found with session ID: abc\n' } }, 'abc'), true)
  assert.equal(c.isMissingSession!({ data: { stderr: 'No conversation found with session ID: xyz\n' } }, 'abc'), false)
  assert.equal(c.isMissingSession!(new Error('session not found due to timeout'), 'abc'), false)
})
function contextFixture() {
  const session: ChatSession = { companyId: 'a', id: 'a', title: '', createdAt: '', updatedAt: '', messages: [
    { id: '1', role: 'user', content: '予算は15万円', timestamp: '' }, { id: '2', role: 'assistant', content: '承知しました', timestamp: '' },
    { id: '3', role: 'user', content: '訂正、12万円', timestamp: '' }, { id: '4', role: 'assistant', content: '訂正を反映', timestamp: '' },
  ] }
  const messages: UIMessage[] = [...session.messages.map(m => ({ id: m.id, role: m.role, parts: [{ type: 'text' as const, text: m.content }] })), { id: '5', role: 'user', parts: [{ type: 'text', text: '予算はいくら？' }] }]
  const cursor = { index: 2, offset: 0 }
  const state: HandoffState = { version: 1, turns: 2, memo: { markdown: '予算15万円', cursor, hash: fingerprint(session.messages, cursor), turns: 1, provider: 'claude-code', updatedAt: '', metrics: { totalMs: 1 } } }
  return { session, state, messages }
}
test('recovery includes unsummarized corrections, excludes covered prefix and current request', () => {
  const f = contextFixture(); const result = recoveryContext(f.session, f.state, f.messages)
  assert.equal(result.usedMemo, true); assert.match(result.context, /訂正、12万円/); assert.doesNotMatch(result.context, /承知しました|予算はいくら/)
})
test('short history works without memo; long uncovered history, edits and deletion stop safely', () => {
  const f = contextFixture(); assert.equal(recoveryContext(f.session, { version: 1, turns: 0 }, f.messages).usedMemo, false)
  assert.throws(() => recoveryContext(null, f.state, f.messages), /見つからない/)
  f.messages[0].parts = [{ type: 'text', text: 'edited' }]; assert.throws(() => recoveryContext(f.session, f.state, f.messages), /履歴が変更/)
  f.messages[0].parts = [{ type: 'text', text: '予算は15万円' }]; f.messages[2].parts = [{ type: 'text', text: '大'.repeat(40000) }]
  assert.throws(() => recoveryContext(f.session, f.state, f.messages), /未整理/)
})
test('cancelling the recovery stream aborts the underlying native agent', async () => {
  let signal: AbortSignal | undefined
  const native: Model = { specificationVersion: 'v3', provider: 'test', modelId: 'test', supportedUrls: {}, doGenerate: async () => { throw new Error('unused') }, doStream: async options => {
    signal = options.abortSignal
    return { stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }) } }) }
  } }
  const connection: AgentConnection = { id: 'test', ownsConversation: true, authenticationError: () => undefined, readMetadata: () => ({}), createChatModel: () => native, createTitleModel: () => native }
  const model = recoverSessionModel(connection, { resumeId: 'old' }, { prepare: () => { throw new Error('unused') }, started: () => {}, session: () => {}, finished: () => {}, failed: () => {} }) as Model
  const result = await model.doStream({ prompt: [] }); const reader = result.stream.getReader()
  await reader.read(); await reader.cancel()
  assert.equal(signal?.aborted, true)
})
test('a partially summarized message resumes from the exact remaining offset', () => {
  const f = contextFixture(); const cursor = { index: 0, offset: 4 }
  f.state.memo = { ...f.state.memo!, cursor, hash: fingerprint(f.session.messages, cursor) }
  const data = recoveryContext(f.session, f.state, f.messages).context
  assert.match(data, /15万円/); assert.match(data, /訂正、12万円/)
  assert.doesNotMatch(data, /予算は15万円/)
})
