// The emergency stop in the app (monitoring M2, .claude/rules/agent-stop.md):
// the push channel's client (only a policy refetch can come of an event; the
// session stays in a header; https only; reconnects with jitter; the 60 s
// check), the policy store (never received → nothing stops; the last stop is
// kept across a restart, per account), and the stop itself (a new turn is
// refused, running turns stop, each agent refuses a stopped kind of tool and
// logs it `stopped`, sync's commit message falls back to the fixed text).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModel } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createSseParser, pushChannelUrl, stoppedKind, type AgentStopPolicy } from '../shared/agent-stop'
import { createAgentPushChannel, reconnectDelay, PUSH_POLL_MS, PUSH_IDLE_TIMEOUT_MS } from '../electron/services/agent-push-channel'
import { createAgentPolicyStore } from '../electron/services/agent-policy-store'
import { createAgentStop } from '../electron/services/agent-stop'
import { withStop } from '../electron/services/commit-messages'
import { createChatTurns } from '../electron/chat-turns'
import { createClaudeConnection } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import { createFileSystemTools } from '../electron/chat-tools'
import { createToolEventTracker, type AgentToolEvent } from '../shared/agent-events'

const V1 = 'a'.repeat(32)
const V2 = 'b'.repeat(32)
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const quiet = { log: () => {}, warn: () => {} }

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

test('push events: only an exact { kind: policy, version } counts; anything else is dropped', () => {
  const parser = createSseParser()
  const items = parser.push([
    `event: policy\ndata: {"kind":"policy","version":"${V1}"}\n\n`,
    ':\n\n',
    // An extra field (content must never ride along) → dropped.
    `event: policy\ndata: {"kind":"policy","version":"${V1}","reason":"経理/給与"}\n\n`,
    // An unknown kind, a kind that would mean "do something", a name that does not match.
    `event: open\ndata: {"kind":"open","version":"${V1}"}\n\n`,
    `event: run\ndata: {"kind":"run","command":"rm -rf ~"}\n\n`,
    `event: message\ndata: {"kind":"policy","version":"${V1}"}\n\n`,
    'event: policy\ndata: {"kind":"policy","version":"not hex"}\n\n',
    'data: not json\n\n',
  ].join(''))
  assert.deepEqual(items.map(i => i.type), ['event', 'heartbeat', 'dropped', 'dropped', 'dropped', 'dropped', 'dropped', 'dropped'])
  assert.deepEqual(items[0], { type: 'event', event: { kind: 'policy', version: V1 } })
  assert.equal(parser.overflow, false)
  // A line far beyond anything legitimate ends the connection.
  parser.push('data: ' + 'x'.repeat(5000))
  assert.equal(parser.overflow, true)
})

test('push channel address: https on the signed-in server only, no credentials in the URL', () => {
  assert.equal(pushChannelUrl('https://acb.example.jp', 'co 1'), 'https://acb.example.jp/api/companies/co%201/me/events')
  assert.equal(pushChannelUrl('http://localhost:3001', 'co'), 'http://localhost:3001/api/companies/co/me/events')
  assert.equal(pushChannelUrl('http://acb.example.jp', 'co'), null)
  assert.equal(pushChannelUrl('https://user:pw@acb.example.jp', 'co'), null)
  assert.equal(pushChannelUrl('ftp://acb.example.jp', 'co'), null)
})

test('a stop covers the four kinds, and everything when the whole AI is stopped', () => {
  const tools: AgentStopPolicy = { all: false, tools: ['command', 'web'] }
  assert.equal(stoppedKind(tools, 'command'), 'command')
  assert.equal(stoppedKind(tools, 'web'), 'web')
  assert.equal(stoppedKind(tools, 'write'), null)
  assert.equal(stoppedKind(tools, 'read'), null)
  assert.equal(stoppedKind({ all: true, tools: [] }, 'read'), 'all')
  assert.equal(stoppedKind(undefined, 'command'), null)
})

// ---------------------------------------------------------------------------
// The push channel client
// ---------------------------------------------------------------------------

function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; id: number; done?: boolean }> = []
  let next = 1
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, id: next++ }; timers.push(t); return t.id },
    clearTimeout: (id: unknown) => { const t = timers.find(x => x.id === id); if (t) t.done = true },
    /** Run the pending timers with this delay. */
    fire(ms: number) { for (const t of timers.filter(x => !x.done && x.ms === ms)) { t.done = true; t.fn() } },
    pending: () => timers.filter(t => !t.done).map(t => t.ms),
  }
}

function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  }
}

test('push channel: the session goes in a header, and an event can only cause a policy refetch', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const stream = sseResponse()
  const refreshed: Array<[string, string | undefined]> = []
  const timers = fakeTimers()
  const channel = createAgentPushChannel({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['better-auth.session_token=SECRET.sig'],
    refresh: (companyId, version) => refreshed.push([companyId, version]),
    fetch: (async (url: string, init: RequestInit) => { requests.push({ url, init }); return stream.response }) as unknown as typeof fetch,
    log: quiet, random: () => 0.5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  })
  channel.watch('co')
  await tick()
  stream.send(`event: policy\ndata: {"kind":"policy","version":"${V1}"}\n\n`)
  stream.send(`event: open\ndata: {"kind":"open","url":"file:///etc/passwd"}\n\n`)
  stream.send(`event: policy\ndata: {"kind":"policy","version":"${V2}","command":"open -a Calculator"}\n\n`)
  stream.send(`event: exec\ndata: {"kind":"exec","version":"${V2}"}\n\n`)
  await tick(); await tick()

  assert.deepEqual(refreshed, [['co', V1]])
  // One request, to the events address only; the session in the Cookie header, never in the URL.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://acb.example.jp/api/companies/co/me/events')
  assert.ok(!requests[0].url.includes('SECRET'))
  const headers = requests[0].init.headers as Record<string, string>
  assert.equal(headers.Cookie, 'better-auth.session_token=SECRET.sig')
  assert.equal(headers['X-ACB-Agent-Stop'], '1')
  assert.equal(requests[0].init.redirect, 'error')
  channel.stopAll()
})

test('push channel: no https → no connection, but the 60 s check still runs', async () => {
  let fetched = 0
  const refreshed: string[] = []
  const timers = fakeTimers()
  const channel = createAgentPushChannel({
    baseUrl: () => 'http://acb.example.jp', cookies: () => ['s=1'], refresh: id => refreshed.push(id),
    fetch: (async () => { fetched++; return new Response('') }) as unknown as typeof fetch,
    log: quiet, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  })
  channel.watch('co')
  await tick()
  assert.equal(fetched, 0)
  timers.fire(PUSH_POLL_MS)
  timers.fire(PUSH_POLL_MS)
  assert.deepEqual(refreshed, ['co', 'co'])
  channel.stopAll()
})

test('push channel: reconnects back off with jitter, a silent connection is dropped, a 404 stops watching', async () => {
  // Jitter: ×0.5–1.5 around 1 s doubling to 60 s.
  assert.equal(reconnectDelay(0, () => 0), 500)
  assert.equal(reconnectDelay(0, () => 1), 1500)
  assert.equal(reconnectDelay(3, () => 0.5), 8000)
  assert.equal(reconnectDelay(20, () => 0.5), 60_000)
  assert.notEqual(reconnectDelay(2, () => 0.1), reconnectDelay(2, () => 0.9))

  const timers = fakeTimers()
  const statuses = [503, 503]
  let calls = 0
  const stream = sseResponse()
  let lastSignal: AbortSignal | undefined
  const channel = createAgentPushChannel({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], refresh: () => {},
    fetch: (async (_url: string, init: RequestInit) => {
      calls++
      lastSignal = init.signal ?? undefined
      const status = statuses.shift()
      return status ? new Response('', { status }) : stream.response
    }) as unknown as typeof fetch,
    log: quiet, random: () => 0.5, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  })
  channel.watch('co')
  await tick(); await tick()
  assert.ok(timers.pending().includes(1000))
  timers.fire(1000)
  await tick(); await tick()
  assert.ok(timers.pending().includes(2000), 'the second failure waits longer')
  timers.fire(2000)
  await tick(); await tick()
  assert.equal(calls, 3)
  // Connected, then silence: dropped after the idle timeout.
  assert.ok(timers.pending().includes(PUSH_IDLE_TIMEOUT_MS))
  timers.fire(PUSH_IDLE_TIMEOUT_MS)
  assert.equal(lastSignal?.aborted, true)
  channel.stopAll()

  const gone = createAgentPushChannel({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], refresh: () => {},
    fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    log: quiet, setTimeout: fakeTimers().setTimeout, clearTimeout: () => {},
  })
  gone.watch('co')
  await tick(); await tick()
  assert.deepEqual(gone.watched(), [])
})

// ---------------------------------------------------------------------------
// The policy store and the stop
// ---------------------------------------------------------------------------

function policyFetch(answers: Array<unknown | Error>) {
  const headers: Array<Record<string, string>> = []
  const f = (async (_url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>)
    const next = answers.shift()
    if (next instanceof Error || next === undefined) throw next ?? new Error('offline')
    return new Response(JSON.stringify({ success: true, data: next }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, headers }
}
const sandbox = { mode: 'off', allowedDomains: ['api.github.com'], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }

test('never received → nothing is stopped; once received, the last stop is kept across a restart, per account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-stop-'))
  try {
    // Offline from the start: unknown → the turn runs.
    const offline = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], userId: () => 'u1', dir: () => dir, fetch: policyFetch([new Error('offline')]).f, log: quiet })
    const first = createAgentStop({ policy: offline, watch: () => {}, turns: () => null, log: quiet })
    assert.equal((await first.prepareTurn('co')).refused, undefined)

    // Received a stop: refused, and the app says it follows the stop.
    const online = policyFetch([{ version: V1, sandbox, stop: { all: true, tools: [] } }])
    const store = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], userId: () => 'u1', dir: () => dir, fetch: online.f, log: quiet })
    const stop = createAgentStop({ policy: store, watch: () => {}, turns: () => null, log: quiet })
    assert.match((await stop.prepareTurn('co')).refused ?? '', /管理者が AI の利用を一時停止しています/)
    assert.equal(online.headers[0]['X-ACB-Agent-Stop'], '1')
    assert.equal(stop.oneShotAiAllowed(), false)
    const file = path.join(dir, 'u1', 'co.json')
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)

    // Restarted offline: the last state still stops; another account on this PC is not affected.
    const restarted = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], userId: () => 'u1', dir: () => dir, fetch: policyFetch([]).f, log: quiet })
    const again = createAgentStop({ policy: restarted, watch: () => {}, turns: () => null, log: quiet })
    assert.equal(again.oneShotAiAllowed(), false, 'kept stops count before any conversation')
    assert.ok((await again.prepareTurn('co')).refused)
    const other = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], userId: () => 'u2', dir: () => dir, fetch: policyFetch([]).f, log: quiet })
    assert.equal((await createAgentStop({ policy: other, watch: () => {}, turns: () => null, log: quiet }).prepareTurn('co')).refused, undefined)

    // Released: the kept state says so, the turn runs.
    const released = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], userId: () => 'u1', dir: () => dir, fetch: policyFetch([{ version: V2, sandbox, stop: { all: false, tools: [] } }]).f, log: quiet })
    assert.equal((await createAgentStop({ policy: released, watch: () => {}, turns: () => null, log: quiet }).prepareTurn('co')).refused, undefined)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stop.all, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a received stop of the whole AI stops that company\'s running turns, not another company\'s', async () => {
  const answers: unknown[] = [{ version: V1, sandbox, stop: { all: false, tools: [] } }, { version: V2, sandbox, stop: { all: true, tools: [] } }]
  const store = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch: policyFetch(answers).f, log: quiet })
  const cancelled: string[] = []
  const turns = createChatTurns(1, { cancelInteractions: id => cancelled.push(id) })
  const watched: string[] = []
  const stop = createAgentStop({ policy: store, watch: id => watched.push(id), turns: () => turns, log: quiet })
  const prepared = await stop.prepareTurn('co-a')
  assert.equal(prepared.refused, undefined)
  assert.deepEqual(watched, ['co-a'])
  const a = turns.track({ appSessionId: 'conv-a', companyId: 'co-a' }, new AbortController().signal)
  const b = turns.track({ appSessionId: 'conv-b', companyId: 'co-b' }, new AbortController().signal)
  // The push channel announced a new version → refetch → the stop arrives.
  await store.refresh('co-a')
  assert.equal(a.signal.aborted, true)
  assert.equal(a.signal.reason, 'stopped-by-admin')
  assert.equal(b.signal.aborted, false)
  assert.deepEqual(cancelled, ['conv-a'])
  // The running turn's tool checks see it at once.
  assert.equal(prepared.toolStopped('read'), 'all')
  a.end(); b.end()
})

test('sync\'s commit message: the fixed text while the AI is stopped, the AI otherwise', async () => {
  let asked = 0
  let allowed = false
  const generate = withStop(() => allowed, async () => { asked++; return 'AI message' })
  assert.equal(await generate('/co'), null)
  assert.equal(asked, 0)
  allowed = true
  assert.equal(await generate('/co'), 'AI message')
})

// ---------------------------------------------------------------------------
// Each agent refuses a stopped kind of tool and logs it `stopped`
// ---------------------------------------------------------------------------

test('Claude: a stopped kind is refused in PreToolUse (also after an approval) and logged stopped', async () => {
  const events: AgentToolEvent[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_m: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  let stop: AgentStopPolicy = { all: false, tools: ['command'] }
  let approve: () => void = () => {}
  const connection = createClaudeConnection({
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}),
    onToolEvent: e => events.push(e), toolEventPaths: () => ({}),
    requestToolApproval: () => new Promise(resolve => { approve = () => resolve({ approved: true }) }),
  }, factory)
  connection.createChatModel({ workingDirectory: '/co', toolEventContext: { companyId: 'co' }, toolStop: category => stoppedKind(stop, category) })
  const pre = options.hooks.PreToolUse[0].hooks[0]
  const bash = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b1' })
  assert.equal(bash.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(bash.hookSpecificOutput.permissionDecisionReason, /コマンドの実行/)
  // Another kind still runs.
  assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/co/a.md' }, tool_use_id: 'r1' }), { continue: true })
  // The member approves a dangerous command while the whole AI gets stopped: refused after all.
  stop = { all: false, tools: [] }
  const pending = pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_use_id: 'b2' })
  await tick()
  stop = { all: true, tools: [] }
  approve()
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny')
  // canUseTool too.
  const answer = await options.canUseTool('Write', { file_path: '/co/a.md' }, { toolUseID: 'w1' })
  assert.equal(answer.behavior, 'deny')
  assert.deepEqual(events.filter(e => e.decision === 'stopped').map(e => e.callId), ['b1', 'b2', 'w1'])
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

test('Codex: a stopped kind\'s approval is declined without asking; one that starts anyway ends the turn', async () => {
  const rpc = new FakeRpc()
  const events: AgentToolEvent[] = []
  let asked = 0
  const stop: AgentStopPolicy = { all: false, tools: ['command'] }
  const connection = createCodexConnection({ getShellEnv: () => ({}), requestToolApproval: async () => { asked++; return { approved: true } }, onToolEvent: e => events.push(e) }, () => rpc)
  const response = (connection.createChatModel({ workingDirectory: '/co', appSessionId: 'conv', toolEventContext: { companyId: 'co' }, toolStop: category => stoppedKind(stop, category) }) as Model)
    .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
  await tick()
  rpc.onMessage({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'tu' } } })
  rpc.onMessage({ id: 'a1', method: 'item/commandExecution/requestApproval', params: { itemId: 'c1', command: 'npm test', availableDecisions: ['accept', 'decline'] } })
  await tick()
  assert.equal(asked, 0)
  assert.deepEqual(rpc.replies.find(r => r.id === 'a1')?.result, { decision: 'decline' })
  rpc.onMessage({ method: 'item/started', params: { threadId: 'th', item: { id: 'c2', type: 'commandExecution', command: 'ls' } } })
  const result = await response
  assert.ok(rpc.replies.some(r => r.method === 'turn/interrupt'))
  assert.match(JSON.stringify(result.content), /コマンドの実行/)
  assert.deepEqual(events.filter(e => e.decision === 'stopped').map(e => e.callId), ['c1', 'c2'])
})

test('API key: a stopped kind is refused inside the tool and logged stopped', async () => {
  const events: AgentToolEvent[] = []
  const tracker = createToolEventTracker({ agent: 'api-key', companyRoot: '/co', cwd: '/co' }, e => events.push(e))
  const tools = createFileSystemTools('/co', undefined, undefined, tracker, undefined, category => stoppedKind({ all: false, tools: ['write'] }, category))
  const run = (name: keyof typeof tools, input: Record<string, unknown>) =>
    (tools[name].execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'x', messages: [] })
  await assert.rejects(run('writeFile', { path: 'a.md', content: 'c' }), /ファイルの書き込み/)
  assert.deepEqual(events.map(e => [e.tool, e.decision]), [['writeFile', 'stopped']])
})

test('the chat server refuses a new turn while the AI is stopped, before any agent starts', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  let started = 0
  const server = await startChatServer({
    getAuthMode: () => 'api-key', getApiKey: () => { started++; return 'k' }, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude',
    prepareAgentStop: async () => ({ refused: '管理者が AI の利用を一時停止しています。再開されるまでお待ちください。', toolStopped: () => 'all' }),
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', appSessionId: 'conv' }),
    })
    assert.equal(res.status, 403)
    assert.match((await res.json() as { error: string }).error, /管理者が AI の利用を一時停止しています/)
    assert.equal(started, 0)
    assert.equal(server.turns.runningCount(), 0)
  } finally {
    server.server.close()
  }
})

// ---------------------------------------------------------------------------
// AI outside conversations stops too (owner decision 2026-10-31): no AI call,
// a quiet fallback.
// ---------------------------------------------------------------------------

test('titles: no AI is asked while the AI is stopped (the renderer keeps its own title)', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  let asked = 0
  let allowed = false
  const server = await startChatServer({
    getAuthMode: () => 'api-key', getApiKey: () => { asked++; return undefined }, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude',
    oneShotAiAllowed: () => allowed,
  })
  const title = () => fetch(`http://127.0.0.1:${server.port}/api/generate-title`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }] }),
  })
  try {
    assert.equal((await title()).status, 503)
    assert.equal(asked, 0)
    allowed = true
    await title()
    assert.ok(asked > 0, 'with the AI allowed the agent is asked again')
  } finally {
    server.server.close()
  }
})

test('voice formatting: the transcript is used as is while the AI is stopped', async () => {
  const { createVoiceFormatter } = await import('../electron/voice-formatter')
  let asked = 0
  let allowed = false
  const format = createVoiceFormatter(
    { authMode: 'api-key', apiKey: 'k', getCli: () => '/test/claude', cwd: '/tmp', env: {}, aiAllowed: () => allowed },
    async () => { asked++; return '整えた文' },
  )
  assert.equal(await format('えーと会議は明日です', new AbortController().signal), 'えーと会議は明日です')
  assert.equal(asked, 0)
  allowed = true
  assert.equal(await format('えーと会議は明日です', new AbortController().signal), '整えた文')
  assert.equal(asked, 1)
})

test('hand-off memos: no memo is written while the AI is stopped, and no error is shown', async t => {
  const { ChatHistoryStore } = await import('../electron/chat-history-store')
  const { HandoffStore } = await import('../electron/handoff/store')
  const { HandoffService } = await import('../electron/handoff/service')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-stop-handoff-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const history = new ChatHistoryStore(path.join(dir, 'history'))
  const store = new HandoffStore(path.join(dir, 'memos'), history)
  history.save('company', {
    companyId: 'company', id: 'chat', title: 'chat', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    messages: [{ id: 'u1', role: 'user', content: '質問', timestamp: '2026-01-01' }, { id: 'a1', role: 'assistant', content: '回答', timestamp: '2026-01-01' }],
  })
  let written = 0
  const service = new HandoffService(history, store, async () => { written++; throw new Error('must not run') }, () => {}, { idleMs: 1, turns: 1, aiAllowed: () => false })
  t.after(() => service.dispose())
  service.complete('company', 'chat', { messageId: 'a1', content: '回答', provider: 'codex' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(written, 0)
  assert.equal(store.read('company', 'chat').error, undefined)
})
