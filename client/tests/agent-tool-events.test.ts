// The AI action log as each agent reports it (claude.ts hooks / canUseTool,
// codex.ts approvals + items, chat-tools.ts), and the turn abort handles
// (chat-turns.ts) with the cancel APIs of approvals and choice cards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, UIMessageChunk } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import { createFileSystemTools } from '../electron/chat-tools'
import { createChatTurns } from '../electron/chat-turns'
import { createChunkInjector } from '../electron/ui-stream-limits'
import { AgentInteractions } from '../electron/agent-interactions'
import { createToolApprovals } from '../electron/features/agent-interactions/ipc'
import { createToolEventTracker, TURN_STOPPED_PART_TYPE, type AgentToolEvent } from '../shared/agent-events'
import type { WriteGuard } from '../electron/write-guard'

const ROOT = '/co'
const context = { companyId: 'company-a', companyRoot: ROOT, turnId: 'turn-a' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const brief = (e: AgentToolEvent) => [e.tool, e.decision, e.guardReason, e.outcome]

function claude(overrides: Partial<ClaudeConnectionConfig> = {}) {
  const events: AgentToolEvent[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the factory's options are inspected loosely
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const connection = createClaudeConnection({
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}),
    onToolEvent: e => events.push(e), toolEventPaths: () => ({ home: '/Users/m' }),
    ...overrides,
  }, factory)
  return { connection, events, options: () => options }
}

test('Claude: without a recorder nothing extra is installed', () => {
  const { connection, options } = claude({ onToolEvent: undefined })
  connection.createChatModel({ workingDirectory: ROOT })
  assert.equal(options().hooks.PostToolUse, undefined)
  assert.equal(options().hooks.PostToolUseFailure, undefined)
  assert.equal(options().onQueryCreated, undefined)
})

test('Claude: PreToolUse decisions, canUseTool answers and the post hooks make one event per call', async () => {
  const approvals: boolean[] = [true, false]
  const { connection, events, options } = claude({ requestToolApproval: async () => ({ approved: approvals.shift()! }) })
  const writeGuard: WriteGuard = { root: ROOT, getAccess: () => undefined, getNotDownloaded: () => ['動画'] }
  connection.createChatModel({ workingDirectory: ROOT, appSessionId: 'conv-a', modelId: 'opus', writeGuard, toolEventContext: context })
  const { PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied } = options().hooks
  const pre = PreToolUse[0].hooks[0], post = PostToolUse[0].hooks[0], failure = PostToolUseFailure[0].hooks[0], denied = PermissionDenied[0].hooks[0]
  const canUseTool = options().canUseTool

  // Left to the permission mode, then ran (with the CLI's duration).
  let r = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 't1', cwd: ROOT })
  assert.deepEqual(r, { continue: true })
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: 'x', tool_use_id: 't1', duration_ms: 42 })
  // A guard refused: same answer as before, recorded with its code.
  r = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/動画/a.md`, content: 'c' }, tool_use_id: 't2' })
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny')
  // Dangerous: the member allowed, then the member refused.
  r = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm a' }, tool_use_id: 't3' })
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow')
  await failure({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'rm a' }, tool_use_id: 't3', error: 'no such file' })
  r = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm b' }, tool_use_id: 't4' })
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny')
  // A subagent launch (forced synchronous) and a call inside the subagent.
  await pre({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'p' }, tool_use_id: 't5' })
  await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${ROOT}/a.md` }, tool_use_id: 't6', agent_type: 'general-purpose' })
  // canUseTool: read-only auto-allowed; the permission mode refused another call.
  assert.equal((await canUseTool('Read', { file_path: `${ROOT}/a.md` }, { toolUseID: 't6' })).behavior, 'allow')
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `${ROOT}/a.md` }, tool_response: 'x', tool_use_id: 't6', agent_type: 'general-purpose' })
  await pre({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com/a?k=v' }, tool_use_id: 't7' })
  await denied({ hook_event_name: 'PermissionDenied', tool_name: 'WebFetch', tool_input: {}, tool_use_id: 't7', reason: 'classifier' })
  // The query ends: the subagent launch never reported back.
  const query = { async *[Symbol.asyncIterator]() { yield { type: 'result' } } }
  options().onQueryCreated(query)
  const loop = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]() // the provider's loop
  while (!(await loop.next()).done) { /* read on */ }

  assert.deepEqual(events.map(brief), [
    ['Bash', 'policy-default', undefined, 'ok'],
    ['Write', 'guard-denied', 'not-downloaded', undefined],
    ['Bash', 'member-allowed', 'dangerous-command', 'error'],
    ['Bash', 'member-denied', 'dangerous-command', undefined],
    ['Read', 'auto-allowed', undefined, 'ok'],
    ['WebFetch', 'policy-denied', undefined, undefined],
    ['Agent', 'auto-allowed', undefined, 'unfinished'],
  ])
  assert.equal(events[0].durationMs, 42)
  assert.deepEqual(events[0].target, { kind: 'command', programs: ['git status'] })
  assert.deepEqual(events[1].target, { kind: 'file', path: '動画/a.md' })
  assert.equal(events[4].subagentType, 'general-purpose')
  assert.deepEqual(events[5].target, { kind: 'web', host: 'example.com' })
  assert.deepEqual(events[6].target, { kind: 'subagent', subagentType: 'general-purpose' })
  for (const e of events) {
    assert.equal(e.conversationId, 'conv-a'); assert.equal(e.companyId, 'company-a'); assert.equal(e.turnId, 'turn-a')
    assert.equal(e.agent, 'claude-code'); assert.equal(e.model, 'opus')
  }
})

test('Claude: a recorder that throws changes no answer', async () => {
  const { connection, options } = claude({ onToolEvent: () => { throw new Error('down') } })
  connection.createChatModel({ workingDirectory: ROOT, toolEventContext: context })
  const result = await options().hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, tool_use_id: 'x' })
  assert.equal(result.hookSpecificOutput.permissionDecisionReason, 'Blocked: dangerous pattern detected')
})

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  replies: RpcMessage[] = []
  async initialize() {}
  async request<T>(method: string): Promise<T> {
    const results: Record<string, unknown> = {
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'gpt-x', displayName: 'X', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'th' } }, 'turn/start': { turn: { id: 'tu' } },
    }
    return results[method] as T
  }
  send(message: RpcMessage) { this.replies.push(message) }
  close() {}
}

test('Codex: approvals carry the member\'s answer, items the outcome; Codex\'s own policy otherwise', async () => {
  const rpc = new FakeRpc()
  const events: AgentToolEvent[] = []
  const answers = [true, false]
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestToolApproval: async () => ({ approved: answers.shift()! }), onToolEvent: e => events.push(e) }, () => rpc)
  const response = (connection.createChatModel({ workingDirectory: ROOT, appSessionId: 'conv-c', toolEventContext: context }) as Model)
    .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  await tick()
  const item = (method: string, value: Record<string, unknown>) => rpc.onMessage({ method, params: { threadId: 'th', item: value } })
  item('item/started', { id: 'c1', type: 'commandExecution', command: "/bin/zsh -lc 'npm install left-pad'", cwd: ROOT })
  rpc.onMessage({ id: 'a1', method: 'item/commandExecution/requestApproval', params: { itemId: 'c1', command: 'npm install left-pad' } })
  await tick()
  item('item/completed', { id: 'c1', type: 'commandExecution', command: 'npm install left-pad', status: 'completed' })
  rpc.onMessage({ id: 'a2', method: 'item/fileChange/requestApproval', params: { itemId: 'f1' } })
  await tick()
  item('item/completed', { id: 'f1', type: 'fileChange', changes: [{ path: `${ROOT}/a.md` }], status: 'declined' })
  item('item/started', { id: 'f2', type: 'fileChange', changes: [{ path: `${ROOT}/b.md` }] })
  item('item/completed', { id: 'f2', type: 'fileChange', changes: [{ path: `${ROOT}/b.md` }], status: 'failed' })
  item('item/started', { id: 'm1', type: 'mcpToolCall', server: 'acb_company_files', tool: 'company_search' })
  item('item/started', { id: 'w1', type: 'webSearch', query: '社外秘' })
  rpc.onMessage({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } })
  await response
  assert.deepEqual(events.map(brief), [
    ['Bash', 'member-allowed', undefined, 'ok'],
    ['Write', 'member-denied', undefined, undefined],
    ['Write', 'policy-default', undefined, 'error'],
    ['mcp__acb_company_files__company_search', 'policy-default', undefined, 'unfinished'],
    ['WebSearch', 'policy-default', undefined, 'unfinished'],
  ])
  assert.deepEqual(events[0].target, { kind: 'command', programs: ['npm install'] })
  assert.deepEqual(events[2].target, { kind: 'files', files: [{ kind: 'file', path: 'b.md' }] })
  assert.equal(events[3].category, 'app-tool')
  assert.equal(events[0].agent, 'codex')
})

test('API key: the five tools report decisions and outcomes', async () => {
  const events: AgentToolEvent[] = []
  const tracker = createToolEventTracker({ agent: 'api-key', companyRoot: ROOT, cwd: ROOT }, e => events.push(e))
  const writeGuard: WriteGuard = { root: ROOT, getAccess: () => undefined, getNotDownloaded: () => ['動画'] }
  const tools = createFileSystemTools(ROOT, async () => ({ approved: false }), writeGuard, tracker)
  const run = (name: keyof typeof tools, input: Record<string, unknown>) =>
    (tools[name].execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'x', messages: [] })
  await assert.rejects(run('writeFile', { path: '動画/a.md', content: 'c' }))
  await assert.rejects(run('writeFile', { path: 'a.md', content: 'c' }), /拒否/)
  await assert.rejects(run('readFile', { path: '../outside.md' }))
  await assert.rejects(run('executeCommand', { command: 'sudo ls' }), /拒否/)
  assert.deepEqual(events.map(brief), [
    ['writeFile', 'guard-denied', 'not-downloaded', undefined],
    ['writeFile', 'member-denied', undefined, undefined],
    ['readFile', 'auto-allowed', undefined, 'error'],
    ['executeCommand', 'member-denied', undefined, undefined],
  ])
  assert.deepEqual(events[0].target, { kind: 'file', path: '動画/a.md' })
  assert.deepEqual(events[2].target, { kind: 'outside' })
})

test('turn abort: stops matching turns with a reason the stream ends with, and cancels their questions', async () => {
  const cancelled: string[] = []
  const turns = createChatTurns(10, { cancelInteractions: id => cancelled.push(id) })
  const request = new AbortController()
  const injector = createChunkInjector()
  const a = turns.track({ appSessionId: 'conv-a', companyId: 'co-1' }, request.signal, injector)
  const b = turns.track({ appSessionId: 'conv-b', companyId: 'co-2' }, new AbortController().signal)
  assert.equal(turns.runningCount(), 2)

  // The response stream: the injector after the model's chunks.
  const chunks: UIMessageChunk[] = []
  const writer = injector.transform.writable.getWriter()
  const reading = (async () => {
    const reader = injector.transform.readable.getReader()
    for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value) }
  })()
  await writer.write({ type: 'start' })
  a.signal.addEventListener('abort', () => {
    // What streamText does on abort: an `abort` chunk with the signal's reason, then the end.
    void writer.write({ type: 'abort', reason: String(a.signal.reason) }).then(() => writer.close())
  })

  assert.equal(turns.abort(info => info.companyId === 'co-1'), 1)
  await reading
  assert.equal(a.signal.aborted, true)
  assert.equal(a.signal.reason, 'stopped-by-admin')
  assert.equal(b.signal.aborted, false)
  assert.deepEqual(cancelled, ['conv-a'])
  assert.deepEqual(chunks, [
    { type: 'start' },
    { type: TURN_STOPPED_PART_TYPE, data: { reason: 'stopped-by-admin' }, transient: true },
    { type: 'abort', reason: 'stopped-by-admin' },
  ])
  // Already stopped: not counted again.
  assert.equal(turns.abortAll(), 1)
  assert.equal(b.signal.reason, 'stopped-by-admin')
  a.end(); b.end()
  assert.equal(turns.runningCount(), 0)
  assert.equal(turns.abortAll(), 0)
})

test('turn abort: the renderer\'s stop still flows through, with no stop part and nothing cancelled', () => {
  const cancelled: string[] = []
  const turns = createChatTurns(10, { cancelInteractions: id => cancelled.push(id) })
  const request = new AbortController()
  const pushed: unknown[] = []
  const handle = turns.track({ appSessionId: 'conv-a' }, request.signal, { push: chunk => pushed.push(chunk) })
  request.abort()
  assert.equal(handle.signal.aborted, true)
  assert.deepEqual(pushed, [])
  assert.deepEqual(cancelled, [])
  const late = turns.track({}, request.signal)
  assert.equal(late.signal.aborted, true)
})

test('cancel APIs: a stopped conversation\'s approvals are denied and its choice cards cancelled, others untouched', async () => {
  const approvals = createToolApprovals(() => {})
  const a = approvals.request('Bash', {}, 'u1', 'conv-a')
  const b = approvals.request('Bash', {}, 'u2', 'conv-b')
  approvals.cancel('conv-a')
  assert.deepEqual(await a, { approved: false })
  approvals.respond('u2', true)
  assert.deepEqual(await b, { approved: true })

  const closed: string[] = []
  const broker = new AgentInteractions((_owner, event) => closed.push(event))
  const question = { kind: 'choices' as const, agent: 'claude-code' as const, questions: [{ question: 'q', header: 'h', options: [{ label: 'x', description: '' }, { label: 'y', description: '' }], multiSelect: false }] }
  const p = broker.request(1, 'conv-a', question, new AbortController().signal)
  const q = broker.request(1, 'conv-b', question, new AbortController().signal)
  broker.cancelConversation('conv-a')
  assert.deepEqual(await p, { cancelled: true, reason: 'aborted' })
  assert.equal(broker.list(1).length, 1)
  broker.closeOwner(1)
  await q
})
