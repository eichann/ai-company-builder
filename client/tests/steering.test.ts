import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, UIMessage } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createClaudeSteer, createTurnSteering, tapQuery } from '../electron/agents/steering'
import { createClaudeConnection } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import { agentInputMessages } from '../electron/agents/session'
import { createChatTurns } from '../electron/chat-turns'
import { STEER_PART_TYPE, canSteerText, MAX_STEER_LENGTH, readSteerRecord } from '../shared/steer'
import { restoreTextWithChoices, storedChoiceFromPart, storedSteerFromPart, type StoredChoicePrompt, type StoredSteer } from '../src/features/chat/choiceHistory'
import { CHOICE_PART_TYPE } from '../shared/choice-prompt'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const INIT = { type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] }

/** The Query surface steering uses: what it streamed in, and what it cancelled. */
function fakeQuery() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider options / chunks as the test reads them
  const streamed: any[] = []
  const cancelled: string[] = []
  let inputs = 0
  let inputEnded = false
  return {
    streamed, cancelled,
    get inputs() { return inputs },
    get inputEnded() { return inputEnded },
    async streamInput(stream: AsyncIterable<unknown>) {
      inputs++
      for await (const message of stream) streamed.push(message)
      inputEnded = true
    },
    async cancelAsyncMessage(uuid: string) { cancelled.push(uuid); return true },
  }
}

test('Claude: an instruction folded into the running turn is delivered (lifecycle, or the result\'s consumed list)', async () => {
  const query = fakeQuery()
  const steer = createClaudeSteer(query)
  steer.observe(INIT)
  let accepted = 0
  const first = steer.target.send('最後に要約も書いて', () => accepted++)
  const second = steer.target.send('表にして', () => accepted++)
  await tick()
  assert.equal(accepted, 2)
  // One input stream for the whole query, user messages with their own uuid.
  assert.equal(query.inputs, 1)
  assert.equal(query.streamed.length, 2)
  assert.deepEqual(query.streamed[0].message, { role: 'user', content: [{ type: 'text', text: '最後に要約も書いて' }] })
  assert.equal(query.streamed[0].parent_tool_use_id, null)
  const [a, b] = query.streamed.map(m => m.uuid as string)
  assert.ok(a && b && a !== b)
  steer.observe({ type: 'command_lifecycle', command_uuid: a, state: 'queued' })
  steer.observe({ type: 'command_lifecycle', command_uuid: a, state: 'started' })
  assert.equal(await first, 'delivered')
  steer.observe({ type: 'command_lifecycle', command_uuid: b, state: 'queued' })
  steer.observe({ type: 'result', subtype: 'success', user_message_uuids: [b] })
  assert.equal(await second, 'delivered')
  assert.deepEqual(query.cancelled, [])
  // The input stream ends only with the query (ending it earlier closes the CLI's stdin).
  assert.equal(query.inputEnded, false)
  steer.close()
  await tick()
  assert.equal(query.inputEnded, true)
})

test('Claude: an instruction that came too late for the turn is withdrawn and reported not delivered', async () => {
  const query = fakeQuery()
  const steer = createClaudeSteer(query)
  steer.observe(INIT)
  const late = steer.target.send('やっぱり英語で', () => {})
  await tick()
  const uuid = query.streamed[0].uuid
  steer.observe({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' })
  steer.observe({ type: 'result', subtype: 'success' })
  assert.equal(await late, 'not-delivered')
  assert.deepEqual(query.cancelled, [uuid])
  // The CLI took it as its own next turn before the cancel landed: that unseen
  // turn is interrupted at once (once), and the outcome stays not delivered.
  let interrupts = 0
  Object.assign(query, { async interrupt() { interrupts++ } })
  steer.observe({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  steer.observe({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  assert.equal(interrupts, 1)
  // Stopped turn: whatever is still waiting is not delivered; later sends neither.
  const stopped = createClaudeSteer(fakeQuery())
  const waiting = stopped.target.send('a', () => {})
  stopped.close()
  assert.equal(await waiting, 'not-delivered')
  let accepted = false
  assert.equal(await stopped.target.send('b', () => { accepted = true }), 'not-delivered')
  assert.equal(accepted, false)
})

test('Claude: a CLI without lifecycle frames cannot tell, so the instruction counts as delivered', async () => {
  const query = fakeQuery()
  const steer = createClaudeSteer(query)
  steer.observe({ type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1'] })
  const sent = steer.target.send('続けて', () => {})
  steer.observe({ type: 'result', subtype: 'success' })
  assert.equal(await sent, 'delivered')
  assert.deepEqual(query.cancelled, [])
})

test('tapQuery: sees every message the provider reads, also through the second iterator; ends once', async () => {
  const seen: unknown[] = []
  let ended = 0
  const query = { async *[Symbol.asyncIterator]() { yield 1; yield 2; yield 3 } }
  tapQuery(query, message => seen.push(message), () => ended++)
  const iterator = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  assert.equal(iterator, (query as AsyncIterable<unknown>)[Symbol.asyncIterator]())
  assert.deepEqual(await iterator.next(), { done: false, value: 1 })
  // The provider's post-result drain takes the iterator again and returns it.
  const drain = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  assert.deepEqual(await drain.next(), { done: false, value: 2 })
  await drain.return!()
  await drain.return!()
  assert.deepEqual(seen, [1, 2])
  assert.equal(ended, 1)
  // A failing observer never breaks the provider's reading.
  const other = { async *[Symbol.asyncIterator]() { yield 'x' } }
  tapQuery(other, () => { throw new Error('observer') }, () => {})
  const values: unknown[] = []
  for await (const value of other as AsyncIterable<unknown>) values.push(value)
  assert.deepEqual(values, ['x'])
})

test('Claude connection: the running query is attached for steering and detached when it ends', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider options as the test reads them
  let options: any
  const factory = ((_model: string, value: unknown) => { options = value; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const connection = createClaudeConnection({ getPermissionMode: () => 'bypassPermissions', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}) }, factory)
  const steering = createTurnSteering()
  connection.createChatModel({ appSessionId: 'chat-a', steering })
  // Streaming input stays on (choice prompts and hooks need it) and suggestions are not requested.
  assert.equal(options.streamingInput, 'always')
  assert.equal(options.promptSuggestions, undefined)
  assert.equal(await steering.send('x', () => {}), 'unavailable')
  const query = Object.assign(fakeQuery(), { async *[Symbol.asyncIterator]() { yield INIT; await new Promise(resolve => setTimeout(resolve, 5)); yield { type: 'result', subtype: 'success', user_message_uuids: [] } } })
  options.onQueryCreated(query)
  const reading = (async () => { for await (const message of query as unknown as AsyncIterable<unknown>) void message })()
  await tick()
  const sent = steering.send('途中の指示', () => {})
  await tick()
  await reading
  // Result came without consuming it → withdrawn; the query is over → nothing attached.
  assert.equal(await sent, 'not-delivered')
  assert.equal(query.cancelled.length, 1)
  assert.equal(await steering.send('後から', () => {}), 'unavailable')
})

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  steerError: Error | undefined
  async initialize() {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'turn/steer' && this.steerError) throw this.steerError
    const results: Record<string, unknown> = {
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'test-model', displayName: 'Test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'thread-a' } }, 'turn/start': { turn: { id: 'turn-a' } }, 'turn/steer': { turnId: 'turn-a' },
    }
    return results[method] as T
  }
  send() {}
  close() {}
}
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '質問' }] }]

test('Codex: turn/steer into the active turn; a refusal is not delivered; nothing after the turn ends', async () => {
  const rpc = new FakeRpc()
  const steering = createTurnSteering()
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => rpc)
  assert.equal(await steering.send('早すぎる', () => {}), 'unavailable')
  const response = (connection.createChatModel({ appSessionId: 'chat-a', steering }) as Model).doGenerate({ prompt })
  for (let i = 0; i < 5; i++) await tick()
  let accepted = 0
  assert.equal(await steering.send('表にして', () => accepted++), 'delivered')
  assert.equal(accepted, 1)
  assert.deepEqual(rpc.calls.find(c => c.method === 'turn/steer')?.params, { threadId: 'thread-a', expectedTurnId: 'turn-a', input: [{ type: 'text', text: '表にして', text_elements: [] }] })
  rpc.steerError = new Error('no active turn')
  assert.equal(await steering.send('遅い', () => accepted++), 'not-delivered')
  assert.equal(accepted, 1)
  rpc.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } })
  await response
  assert.equal(await steering.send('終わった後', () => {}), 'unavailable')
  // Titles never steer.
  const title = createTurnSteering()
  void (connection.createTitleModel() as Model)
  assert.equal(await title.send('x', () => {}), 'unavailable')
})

test('chat server: steering shows the instruction once the agent took it; no turn / slash commands wait instead', async () => {
  const turns = createChatTurns(10)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider options / chunks as the test reads them
  const pushed: any[] = []
  assert.deepEqual(await turns.steer('chat-a', 'x'), { status: 'unavailable' })
  const turn = turns.open('chat-a', { push: chunk => pushed.push(chunk) }, { suggestions: false })
  assert.equal((await turns.steer('chat-a', 'x')).status, 'unavailable')
  let resolve!: (value: 'delivered') => void
  turn.steering.attach({ send: (_text, accepted) => { accepted(); return new Promise(r => { resolve = r }) } })
  const pending = turns.steer('chat-a', '  表にして  ')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].type, STEER_PART_TYPE)
  assert.equal(pushed[0].data.text, '表にして')
  assert.equal(pushed[0].id, `steer-${pushed[0].data.id}`)
  resolve('delivered')
  assert.deepEqual(await pending, { status: 'delivered', id: pushed[0].data.id })
  assert.equal((await turns.steer('chat-a', '/review')).status, 'unavailable')
  assert.equal((await turns.steer('chat-a', '   ')).status, 'unavailable')
  turn.end('finished')
  assert.equal((await turns.steer('chat-a', 'after')).status, 'unavailable')
  assert.equal(canSteerText('x'.repeat(MAX_STEER_LENGTH + 1)), false)
  assert.equal(readSteerRecord({ id: 'a', text: '' }), undefined)
})

test('history and agent switches keep the instruction where it was sent', () => {
  const steer = { id: 's1', text: '表にして' }
  const choice = { id: 'c1', questions: [{ question: '形式は？', header: '形式', options: [{ label: 'PDF', description: '' }, { label: 'Word', description: '' }], multiSelect: false }], answers: [{ selected: ['PDF'] }] }
  const parts = [
    { type: 'text', text: '作業します。' },
    { type: STEER_PART_TYPE, id: 'steer-s1', data: steer },
    { type: STEER_PART_TYPE, id: 'steer-s1', data: steer },
    { type: 'text', text: '表にしました。' },
    { type: CHOICE_PART_TYPE, data: choice },
  ]
  let content = ''
  const steers: StoredSteer[] = []
  const choices: StoredChoicePrompt[] = []
  for (const part of parts) {
    const c = storedChoiceFromPart(part, content.length, choices)
    if (c) { choices.push(c); continue }
    const s = storedSteerFromPart(part, content.length, steers)
    if (s) { steers.push(s); continue }
    if (part.type === 'text') content += (part as { text: string }).text
  }
  assert.deepEqual(steers, [{ ...steer, at: '作業します。'.length }])
  assert.deepEqual(restoreTextWithChoices(content, JSON.parse(JSON.stringify(choices)), JSON.parse(JSON.stringify(steers))), [
    { type: 'text', text: '作業します。' },
    { type: STEER_PART_TYPE, id: 'steer-s1', data: steer },
    { type: 'text', text: '表にしました。' },
    { type: CHOICE_PART_TYPE, id: 'choice-c1', data: choice },
  ])
  // Another agent (or a fresh session) reads it as text.
  const messages = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: '作業します。' }, { type: STEER_PART_TYPE, data: steer }] }] as UIMessage[]
  const portable = agentInputMessages(messages)
  assert.deepEqual(portable[0].parts.map(p => (p as { text: string }).text), ['作業します。', '\n[作業中に追加した指示]\n表にして\n'])
})
