import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, UIMessage, UIMessageChunk } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import {
  CHOICE_PART_TYPE, choiceAnswerText, choiceCancelMessage, claudeAnswers, codexAnswerText,
  parseChoiceQuestions, readChoiceRecord, validChoiceAnswers, type ChoiceQuestion, type ChoiceResult,
} from '../shared/choice-prompt'
import type { AgentInteractionRequest } from '../shared/agent-interaction'
import { AgentInteractions } from '../electron/agent-interactions'
import { answerAskUserQuestion, codexAskUserTool } from '../electron/agents/choice-tools'
import { createAskUser } from '../electron/chat-server'
import { createChunkInjector } from '../electron/ui-stream-limits'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import { agentInputMessages } from '../electron/agents/session'
import { restoreTextWithChoices, storedChoiceFromPart, type StoredChoicePrompt } from '../src/components/chat/choiceHistory'
import { buildChoiceAnswers, emptyDraft, toggleOption, toggleOther } from '../src/components/chat/choicePromptState'

// The input Claude Code sends to AskUserQuestion (CLI 2.1.304; the same shape Codex's ask_user takes).
const claudeInput = {
  questions: [
    { question: 'どの形式で出力しますか？', header: '出力形式', options: [{ label: 'Markdown', description: '編集しやすい' }, { label: 'PDF', description: '配布向け' }], multiSelect: false },
    { question: 'どの部署に共有しますか？', header: '共有先', options: [{ label: '営業部', description: '' }, { label: '総務', description: '' }, { label: '開発', description: '' }], multiSelect: true },
  ],
}
const questions: ChoiceQuestion[] = parseChoiceQuestions(claudeInput.questions)

test('questions are validated: count, options, duplicates (Claude keys answers by question text)', () => {
  assert.equal(questions.length, 2)
  assert.equal(questions[1].multiSelect, true)
  assert.equal(parseChoiceQuestions([{ question: 'Q?', header: 'H', options: [{ label: 'A' }] }])[0].multiSelect, false)
  assert.throws(() => parseChoiceQuestions([]), /1〜4問/)
  assert.throws(() => parseChoiceQuestions(Array(5).fill(claudeInput.questions[0])), /1〜4問/)
  assert.throws(() => parseChoiceQuestions([claudeInput.questions[0], claudeInput.questions[0]]), /重複/)
  assert.throws(() => parseChoiceQuestions([{ ...claudeInput.questions[0], options: [] }]), /選択肢は/)
  assert.throws(() => parseChoiceQuestions([{ ...claudeInput.questions[0], options: [{ label: 'A', description: '' }, { label: 'A', description: '' }] }]), /重複/)
  assert.throws(() => parseChoiceQuestions([{ ...claudeInput.questions[0], question: ' ' }]), /空/)
  assert.throws(() => parseChoiceQuestions('x'), /1〜4問/)
})

test('answers: single choice, multiSelect and 「その他」 map to the Claude contract and the Codex text', () => {
  const answers = [{ selected: [], other: '  Word形式で  ' }, { selected: ['営業部', '開発'] }]
  assert.equal(validChoiceAnswers(questions, answers), true)
  assert.deepEqual(claudeAnswers(questions, answers), { 'どの形式で出力しますか？': 'Word形式で', 'どの部署に共有しますか？': '営業部, 開発' })
  assert.equal(choiceAnswerText({ selected: ['営業部'], other: '経理も' }), '営業部, 経理も')
  const text = codexAnswerText(questions, [{ selected: ['PDF'] }, { selected: ['総務'], other: '経理' }])
  assert.match(text, /\[出力形式\] どの形式で出力しますか？\n {2}回答: PDF/)
  assert.match(text, /回答: 総務, 経理/)
  // Invalid: unknown label, two picks for a single choice, pick + 「その他」 for a single choice, empty, wrong count, too long.
  for (const bad of [
    [{ selected: ['Word'] }, { selected: ['営業部'] }],
    [{ selected: ['Markdown', 'PDF'] }, { selected: ['営業部'] }],
    [{ selected: ['Markdown'], other: 'x' }, { selected: ['営業部'] }],
    [{ selected: [] }, { selected: ['営業部'] }],
    [{ selected: [], other: '   ' }, { selected: ['営業部'] }],
    [{ selected: ['Markdown'] }],
    [{ selected: ['Markdown'] }, { selected: ['営業部', '営業部'] }],
    [{ selected: [], other: 'x'.repeat(2001) }, { selected: ['営業部'] }],
  ]) assert.equal(validChoiceAnswers(questions, bad), false, JSON.stringify(bad))
})

test('the card state: radio replaces, checkboxes toggle in option order, 「その他」 needs text', () => {
  const [single, multi] = questions
  let a = toggleOption(single, emptyDraft(), 'Markdown')
  a = toggleOption(single, a, 'PDF')
  assert.deepEqual(a.selected, ['PDF'])
  a = toggleOther(single, a)
  assert.deepEqual([a.selected, a.otherOn], [[], true])
  let b = toggleOption(multi, emptyDraft(), '開発')
  b = toggleOption(multi, b, '営業部')
  assert.deepEqual(b.selected, ['営業部', '開発'])
  b = toggleOption(multi, b, '開発')
  b = toggleOther(multi, b)
  assert.equal(buildChoiceAnswers(questions, [a, b]), undefined) // 「その他」 without text
  a = { ...a, otherText: 'Word' }
  b = { ...b, otherText: '経理' }
  assert.deepEqual(buildChoiceAnswers(questions, [a, b]), [{ selected: [], other: 'Word' }, { selected: ['営業部'], other: '経理' }])
  assert.equal(validChoiceAnswers(questions, buildChoiceAnswers(questions, [a, b])), true)
})

test('broker: choice answers are validated, timeouts and stops resolve as cancelled with a reason', async () => {
  let request!: AgentInteractionRequest
  const events: string[] = []
  const broker = new AgentInteractions((_o, event, r) => { events.push(event); request = r }, 1000, 20)
  const p = broker.request(1, 'chat-a', { kind: 'choices', agent: 'claude-code', toolCallId: 'toolu_1', questions }, new AbortController().signal)
  assert.equal(request.kind, 'choices')
  assert.equal(broker.respond(1, request.id, { answers: { x: 'y' } }), false)
  assert.equal(broker.respond(1, request.id, { choices: [{ selected: ['Word'] }, { selected: ['営業部'] }] }), false)
  assert.equal(broker.respond(2, request.id, { choices: [{ selected: ['PDF'] }, { selected: ['営業部'] }] }), false)
  assert.equal(broker.respond(1, request.id, { choices: [{ selected: ['PDF'] }, { selected: ['営業部'], other: ' 経理 ' }] }), true)
  assert.deepEqual(await p, { choices: [{ selected: ['PDF'] }, { selected: ['営業部'], other: '経理' }] })
  assert.deepEqual(events, ['request', 'closed'])
  // Choice prompts use their own (longer) timeout.
  assert.deepEqual(await broker.request(1, 'a', { kind: 'choices', agent: 'codex', questions }, new AbortController().signal), { cancelled: true, reason: 'timeout' })
  const stop = new AbortController()
  const q = broker.request(1, 'a', { kind: 'choices', agent: 'codex', questions }, stop.signal)
  stop.abort()
  assert.deepEqual(await q, { cancelled: true, reason: 'aborted' })
  const r = broker.request(1, 'a', { kind: 'choices', agent: 'codex', questions }, new AbortController().signal)
  broker.respond(1, broker.list(1)[0].id, { cancelled: true })
  assert.deepEqual(await r, { cancelled: true })
})

test('Claude AskUserQuestion: allow with answers keyed by question text; cancel/timeout/invalid/unavailable deny', async () => {
  const signal = new AbortController().signal
  const seen: unknown[] = []
  const answered = await answerAskUserQuestion(async (qs, id, s) => { seen.push(qs, id, s); return { answers: [{ selected: ['Markdown'] }, { selected: ['総務', '開発'], other: 'あと経理' }] } }, claudeInput, 'toolu_1', signal)
  assert.deepEqual(answered, { behavior: 'allow', updatedInput: { ...claudeInput, answers: { 'どの形式で出力しますか？': 'Markdown', 'どの部署に共有しますか？': '総務, 開発, あと経理' } } })
  assert.equal(seen[1], 'toolu_1')
  assert.equal(seen[2], signal)
  for (const reason of ['cancelled', 'timeout', 'aborted'] as const) {
    assert.deepEqual(await answerAskUserQuestion(async () => ({ cancelled: reason }), claudeInput, 'toolu_1', signal), { behavior: 'deny', message: choiceCancelMessage(reason) })
  }
  assert.match(choiceCancelMessage('timeout'), /10分/)
  const invalid = await answerAskUserQuestion(async () => { throw new Error('not asked') }, { questions: [] }, 'toolu_1', signal)
  assert.equal(invalid.behavior, 'deny')
  assert.deepEqual(await answerAskUserQuestion(undefined, claudeInput, 'toolu_1', signal), { behavior: 'deny', message: choiceCancelMessage('unavailable') })
})

const claudeConfig: ClaudeConnectionConfig = { getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}) }
function captureClaude(overrides: Partial<ClaudeConnectionConfig>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  return { connection: createClaudeConnection({ ...claudeConfig, ...overrides }, factory), options: () => options }
}

test('Claude: AskUserQuestion reaches the card in every permission mode; bypass still refuses other asks', async () => {
  for (const mode of ['auto', 'default', 'bypassPermissions'] as const) {
    let approvals = 0
    const { connection, options } = captureClaude({ getPermissionMode: () => mode, requestToolApproval: async () => { approvals++; return { approved: true } } })
    connection.createChatModel({ appSessionId: 'chat', askUser: async () => ({ answers: [{ selected: ['PDF'] }, { selected: ['営業部'] }] }) })
    const canUseTool = options().canUseTool
    assert.equal(typeof canUseTool, 'function', mode)
    const result = await canUseTool('AskUserQuestion', claudeInput, { toolUseID: 'toolu_1', signal: new AbortController().signal })
    assert.equal(result.behavior, 'allow', mode)
    assert.deepEqual(result.updatedInput.answers, { 'どの形式で出力しますか？': 'PDF', 'どの部署に共有しますか？': '営業部' })
    const other = await canUseTool('Write', {}, { toolUseID: 'w' })
    assert.equal(other.behavior, mode === 'bypassPermissions' ? 'deny' : 'allow', mode)
    assert.equal(approvals, mode === 'bypassPermissions' ? 0 : 1, mode)
    // The PreToolUse hook leaves AskUserQuestion to canUseTool (an allow there would skip nothing, but must not deny).
    const hook = options().hooks.PreToolUse[0].hooks[0]
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: claudeInput, tool_use_id: 'toolu_1' }), { continue: true })
  }
  // Without a way to ask (no conversation), bypass keeps its old shape: no canUseTool at all.
  const { connection, options } = captureClaude({ getPermissionMode: () => 'bypassPermissions' })
  connection.createChatModel({})
  assert.equal(options().canUseTool, undefined)
})

test('chat server: the outcome is shown in the conversation and recorded as a data part', async () => {
  const injected: UIMessageChunk[] = []
  const requests: unknown[] = []
  let response: Parameters<NonNullable<ClaudeConnectionConfig['requestInteraction']>>[0] | undefined
  const ask = createAskUser(async (request, appSessionId) => { requests.push([request, appSessionId]); response = request; return { choices: [{ selected: ['PDF'] }, { selected: [], other: '全社' }] } }, 'chat-a', 'claude-code', { push: c => injected.push(c) })!
  assert.deepEqual(await ask(questions, 'toolu_1', new AbortController().signal), { answers: [{ selected: ['PDF'] }, { selected: [], other: '全社' }] })
  assert.deepEqual(response, { kind: 'choices', agent: 'claude-code', toolCallId: 'toolu_1', questions })
  assert.deepEqual(injected, [{ type: CHOICE_PART_TYPE, id: 'choice-toolu_1', data: { id: 'toolu_1', questions, answers: [{ selected: ['PDF'] }, { selected: [], other: '全社' }] } }])
  const timedOut = createAskUser(async () => ({ cancelled: true, reason: 'timeout' }), 'chat-a', 'codex', { push: c => injected.push(c) })!
  assert.deepEqual(await timedOut(questions, undefined, new AbortController().signal), { cancelled: 'timeout' })
  assert.equal((injected[1] as { data: { cancelled: string } }).data.cancelled, 'timeout')
  const member = createAskUser(async () => ({ cancelled: true }), 'chat-a', 'codex', { push: () => {} })!
  assert.deepEqual(await member(questions, undefined, new AbortController().signal), { cancelled: 'cancelled' })
  const broken = createAskUser(async () => { throw new Error('ipc') }, 'chat-a', 'codex', { push: () => {} })!
  assert.deepEqual(await broken(questions, undefined, new AbortController().signal), { cancelled: 'unavailable' })
  assert.equal(createAskUser(undefined, 'chat-a', 'codex', { push: () => {} }), undefined)
  assert.equal(createAskUser(async () => ({ cancelled: true }), undefined, 'codex', { push: () => {} }), undefined)
})

test('chunk injector: queued until the stream starts, live while it runs, dropped after it ends', async () => {
  const injector = createChunkInjector()
  const data = (id: string) => ({ type: 'data-choice-prompt', id, data: {} }) as UIMessageChunk
  injector.push(data('early'))
  const source = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      controller.enqueue({ type: 'start' })
      await new Promise(r => setTimeout(r, 5))
      injector.push(data('live'))
      controller.enqueue({ type: 'finish' })
      controller.close()
    },
  })
  const out: string[] = []
  const reader = source.pipeThrough(injector.transform).getReader()
  for (;;) { const next = await reader.read(); if (next.done) break; out.push(next.value.type === 'data-choice-prompt' ? `data:${(next.value as { id: string }).id}` : next.value.type) }
  injector.push(data('late'))
  assert.deepEqual(out, ['start', 'data:early', 'data:live', 'finish'])
})

test('chat history keeps each prompt where it was asked and restores the answered card', () => {
  const record = { id: 'toolu_1', questions, answers: [{ selected: ['PDF'] }, { selected: ['総務'] }] }
  const parts = [
    { type: 'text', text: '確認させてください。' },
    { type: 'dynamic-tool' },
    { type: CHOICE_PART_TYPE, data: record },
    { type: CHOICE_PART_TYPE, data: record }, // duplicates are ignored
    { type: CHOICE_PART_TYPE, data: { id: 'bad', questions: [] } },
    { type: 'text', text: 'PDFで作成しました。' },
  ]
  let content = ''
  const stored: StoredChoicePrompt[] = []
  for (const part of parts) {
    const choice = storedChoiceFromPart(part, content.length, stored)
    if (choice) { stored.push(choice); continue }
    if (part.type === 'text') content += part.text
    if (part.type === 'dynamic-tool') content += '\n[Tool: AskUserQuestion]'
  }
  assert.equal(stored.length, 1)
  const saved = JSON.parse(JSON.stringify(stored))
  assert.deepEqual(restoreTextWithChoices(content, saved), [
    { type: 'text', text: '確認させてください。\n[Tool: AskUserQuestion]' },
    { type: CHOICE_PART_TYPE, id: 'choice-toolu_1', data: record },
    { type: 'text', text: 'PDFで作成しました。' },
  ])
  assert.deepEqual(restoreTextWithChoices('x', undefined), [{ type: 'text', text: 'x' }])
  // Missing / out-of-range offsets fall back to the end; invalid records are dropped.
  assert.deepEqual(restoreTextWithChoices('abc', [{ ...record, at: 99 }, { id: 'z' }]).map(p => p.type), ['text', CHOICE_PART_TYPE])
  assert.deepEqual(readChoiceRecord({ id: 'c', questions, cancelled: 'timeout' }), { id: 'c', questions, cancelled: 'timeout' })
  assert.equal(readChoiceRecord({ id: 'c', questions, cancelled: 'nope' }), undefined)
  assert.equal(readChoiceRecord({ id: 'c', questions, answers: [{ selected: ['x'] }] }), undefined)
})

test('switching agents keeps what the member chose as text', () => {
  const messages = [
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'どれにしますか' }, { type: CHOICE_PART_TYPE, data: { id: 't', questions, answers: [{ selected: ['PDF'] }, { selected: ['開発'] }] } }] },
    { id: 'u', role: 'user', parts: [{ type: 'text', text: '続けて' }] },
  ] as UIMessage[]
  const portable = agentInputMessages(messages)
  assert.match((portable[0].parts[1] as { text: string }).text, /どの形式で出力しますか？ → PDF/)
})

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  async initialize() {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    const results: Record<string, unknown> = {
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'm', displayName: 'M', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'thread-a' } }, 'turn/start': { turn: { id: 'turn-a' } },
    }
    return results[method] as T
  }
  send() {}
  close() {}
}

test('Codex: ask_user over the loopback MCP helper blocks for the member, links the tool row, and returns the answer', async () => {
  const rpc = new FakeRpc()
  const asked: unknown[][] = []
  let answer!: (result: ChoiceResult) => void
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => rpc)
  const model = connection.createChatModel({ appSessionId: 'chat', workingDirectory: '/tmp', askUser: (qs, id) => { asked.push([qs, id]); return new Promise(r => { answer = r }) } }) as Extract<LanguageModel, { specificationVersion: 'v3' }>
  const { stream } = await model.doStream({ prompt: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  const reader = stream.getReader()
  const parts: { type: string; toolName?: string; toolCallId?: string; result?: unknown }[] = []
  void (async () => { for (;;) { const next = await reader.read(); if (next.done) break; parts.push(next.value as never) } })()
  for (let i = 0; i < 100 && !rpc.calls.some(c => c.method === 'turn/start'); i++) await new Promise(r => setTimeout(r, 10))
  const start = rpc.calls.find(c => c.method === 'thread/start')!.params as { developerInstructions: string; config: { mcp_servers: Record<string, { url: string; http_headers: Record<string, string>; tool_timeout_sec: number }> } }
  assert.match(start.developerInstructions, /ask_user/)
  const server = start.config.mcp_servers.acb_ask
  assert.ok(server.tool_timeout_sec >= 600)

  rpc.onMessage({ method: 'item/started', params: { threadId: 'thread-a', item: { id: 'item-1', type: 'mcpToolCall', server: 'acb_ask', tool: 'ask_user', arguments: claudeInput } } })
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.http_headers } }))
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(t => t.name), ['ask_user'])
  const call = client.callTool({ name: 'ask_user', arguments: claudeInput })
  for (let i = 0; i < 100 && asked.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(asked[0], [questions, 'item-1'])
  answer({ answers: [{ selected: [], other: 'Excel' }, { selected: ['営業部', '総務'] }] })
  const result = await call as { content: { text: string }[] }
  assert.match(result.content[0].text, /回答: Excel/)
  assert.match(result.content[0].text, /回答: 営業部, 総務/)
  await client.close()
  rpc.onMessage({ method: 'item/completed', params: { threadId: 'thread-a', item: { id: 'item-1', type: 'mcpToolCall', server: 'acb_ask', tool: 'ask_user', arguments: claudeInput, result: result, status: 'completed' } } })
  rpc.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(parts.find(p => p.type === 'tool-call')?.toolName, 'mcp__acb_ask__ask_user')
  assert.equal(parts.find(p => p.type === 'tool-call')?.toolCallId, 'item-1')
})

test('Codex ask_user: cancellation and invalid input come back as text the model can act on', async () => {
  const tool = codexAskUserTool(async () => ({ cancelled: 'cancelled' }), () => undefined, new AbortController().signal)
  assert.equal(await tool.execute(claudeInput), choiceCancelMessage('cancelled'))
  assert.match(await tool.execute({ questions: [] }), /1〜4問/)
})
