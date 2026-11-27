// A turn whose company-record tools could not be prepared (records.md "When the record tools are missing", gap
// report 2026-11-27 Bug A): the turn used to go on silently without them, and the AI told the member
// 「この会話から記録の道具につながっていません」. These tests guard: a failure that may pass is asked once more; an
// expired token mid-turn is issued again once (a consultation's only, never with the member's-turn mark); what
// is still missing reaches the AI and the screen with its reason; a company without records is told so, with no
// line on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { createRecordsApi, missingReasonOf } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { readRecordToolsMissingPart, recordToolsMissingInstructions } from '../shared/record-tools-missing'

const TYPES = coreTypeDefinitions()
const TOKEN = (n: number) => `acb_rec_co.${String(n).repeat(64).slice(0, 64)}`

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }
type Answer = { status: number; body?: unknown } | 'network'

/** A server answering each path from a queue (the last answer repeats); records what it was asked. */
function server(answers: { issue?: Answer[]; types?: Answer[]; call?: Answer[] }, opts: { run?: boolean } = {}) {
  const seen: Seen[] = []
  const queues = { issue: [...(answers.issue ?? [])], types: [...(answers.types ?? [])], call: [...(answers.call ?? [])] }
  let issued = 0
  const next = (q: Answer[], fallback: Answer) => (q.length > 1 ? q.shift()! : q[0] ?? fallback)
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const reply = (a: Answer) => {
      if (a === 'network') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status })
    }
    if (url.endsWith('/me/record-tokens')) {
      const a = next(queues.issue, { status: 201 })
      if (a !== 'network' && a.status === 201 && !a.body) {
        issued += 1
        const ask = JSON.parse(init.body as string) as { memberTurn?: boolean }
        return new Response(JSON.stringify({ data: { token: TOKEN(issued), tokenId: `tok-${issued}`, scope: 'act', expiresAt: 'x', memberTurn: ask.memberTurn === true } }), { status: 201 })
      }
      return reply(a)
    }
    if (url.includes('/me/record-tokens/')) return new Response(JSON.stringify({ data: { revoked: true } }), { status: 200 })
    if (url.endsWith('/api/records-ai/types')) return reply(next(queues.types, { status: 200, body: { data: { types: TYPES.map(definition => ({ definition })) } } }))
    if (url.endsWith('/api/records-ai/plugins')) return new Response(JSON.stringify({ data: { plugins: [] } }), { status: 200 })
    return reply(next(queues.call, { status: 200, body: { data: { ok: true } } }))
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch, retryDelayMs: 0,
    ...(opts.run ? { runOf: () => ({ id: 'run-1', generation: 1 }) } : {}),
  })
  return { api, seen, issues: () => seen.filter(s => s.url.endsWith('/me/record-tokens')) }
}

const ASK = { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' as const }

test('a token that could not be had says why, and a failure that may pass is asked once more', async () => {
  const cases: Array<[Answer[], string, number]> = [
    [['network', 'network'], 'offline', 2],
    [[{ status: 500 }, { status: 502 }], 'server-error', 2],
    [[{ status: 401 }], 'signed-out', 1],
    [[{ status: 429, body: { code: 'TOO_MANY_TOKENS' } }], 'too-many', 1],
    [[{ status: 404, body: { code: 'RECORDS_DISABLED' } }], 'disabled', 1],
    [[{ status: 404 }], 'old-server', 1],
  ]
  for (const [issue, reason, tries] of cases) {
    const s = server({ issue })
    const opened = await s.api.openTurnFor('co', ASK)
    assert.deepEqual(opened, { missing: reason }, reason)
    assert.equal(s.issues().length, tries, `${reason}: asked ${tries} time(s)`)
  }
  const signedOut = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [], fetch: (async () => { throw new Error('never') }) as never })
  assert.deepEqual(await signedOut.openTurnFor('co', ASK), { missing: 'signed-out' })
  // One blip, then the token: the turn has its tools.
  const blip = server({ issue: ['network', { status: 201 }] })
  const opened = await blip.api.openTurnFor('co', ASK)
  assert.ok('access' in opened)
  assert.equal(blip.issues().length, 2)
})

test('an expired token mid-turn is issued again once, without the member\'s-turn mark; the new one ends with the turn', async () => {
  const s = server({ call: [{ status: 401, body: { error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' } }, { status: 200, body: { data: { ok: 1 } } }] })
  const opened = await s.api.openTurnFor('co', { ...ASK, memberTurn: true })
  assert.ok('access' in opened)
  assert.deepEqual(await opened.access.call('GET', '/my-turn'), { ok: 1 })
  const issues = s.issues()
  assert.equal(issues.length, 2)
  assert.equal(JSON.parse(issues[0].body!).memberTurn, true)
  assert.equal(JSON.parse(issues[1].body!).memberTurn, undefined, 'the re-issued token never carries the member\'s-turn mark')
  const retried = s.seen.filter(x => x.url.endsWith('/my-turn'))
  assert.equal(retried.at(-1)!.headers.Authorization, `Bearer ${TOKEN(2)}`)
  await opened.access.close()
  assert.ok(s.seen.some(x => x.method === 'DELETE' && x.url.endsWith('/me/record-tokens/tok-2')), 'the token in use is the one ended')

  // Only once per turn: a second expiry is said in the member's words.
  const again = server({ call: [{ status: 401, body: { error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' } }] })
  const turn = await again.api.openTurnFor('co', ASK)
  assert.ok('access' in turn)
  await assert.rejects(turn.access.call('GET', '/my-turn'), (e: Error & { code?: string }) => e.code === 'RECORD_TOKEN_INVALID' && /期限が切れました/.test(e.message))
  assert.equal(again.issues().length, 2)

  // A run's token ends with its run: never issued again.
  const run = server({ call: [{ status: 401, body: { error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' } }] }, { run: true })
  const bound = await run.api.openTurnFor('co', ASK)
  assert.ok('access' in bound)
  await assert.rejects(bound.access.call('GET', '/my-turn'), (e: Error & { code?: string }) => e.code === 'RECORD_TOKEN_INVALID')
  assert.equal(run.issues().length, 1)
})

test('the type definitions are read once more after a blip; still unread, the token is ended and the reason is the read\'s', async () => {
  const blip = server({ types: [{ status: 500 }, { status: 200, body: { data: { types: TYPES.map(definition => ({ definition })) } } }] })
  const opened = await blip.api.openTurnFor('co', ASK)
  assert.ok('access' in opened)
  const tools = await createRecordTools(opened.access)
  assert.ok(tools.specs.some(s => s.name === 'records_create'))

  const down = server({ types: ['network'] })
  const turn = await down.api.openTurnFor('co', ASK)
  assert.ok('access' in turn)
  const error = await createRecordTools(turn.access).then(() => null, (e: unknown) => e)
  assert.equal(missingReasonOf(error), 'offline')
  assert.equal(down.seen.filter(x => x.url.endsWith('/api/records-ai/types')).length, 2)
  assert.ok(down.seen.some(x => x.method === 'DELETE' && x.url.endsWith('/me/record-tokens/tok-1')))
})

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

async function turnWith(createRecordTools: () => Promise<unknown>) {
  const { startChatServer } = await import('../electron/chat-server')
  let system = ''
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    createRecordTools,
    createConnection: () => ({
      id: 'claude-code', ownsConversation: true, authenticationError: () => undefined, readMetadata: () => ({}),
      createTitleModel: () => { throw new Error('no title') },
      createChatModel: () => new MockLanguageModelV3({
        doStream: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
          system = options.prompt.filter(m => m.role === 'system').map(m => String(m.content)).join('\n')
          return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }] as never }) }
        },
      }),
    }),
  } as never)
  let stream = ''
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'やることの件名を直して' }] }], companyId: 'co', companyRootPath: os.tmpdir(), workingDirectory: os.tmpdir(), appSessionId: 'conv-missing-01' }),
    })
    stream = await res.text()
  } finally { server.server.close() }
  return { system, stream }
}

test('tools still missing: the AI is told why with the turn, and the reply starts with one line saying so', async () => {
  const offline = await turnWith(async () => ({ unavailable: 'offline' }))
  assert.ok(offline.system.includes(recordToolsMissingInstructions('offline')))
  assert.match(offline.system, /「つながっていません」とだけ言わず/)
  assert.match(offline.stream, /"type":"data-record-tools-missing"[^\n]*"reason":"offline"/)
  // A hook that failed outright counts as missing too, never as silence.
  const thrown = await turnWith(async () => { throw new Error('boom') })
  assert.match(thrown.system, /用意できませんでした/)
  assert.match(thrown.stream, /data-record-tools-missing/)
  // A company that does not use records: the AI is told, the screen says nothing.
  const off = await turnWith(async () => ({ unavailable: 'disabled' }))
  assert.match(off.system, /記録の機能を使っていません/)
  assert.doesNotMatch(off.stream, /data-record-tools-missing/)
  // With the tools, neither.
  const fine = await turnWith(async () => ({ specs: [{ name: 'records_get' }], instructions: '', close: async () => {}, execute: async () => '', readTask: async () => null }))
  assert.doesNotMatch(fine.system, /用意できませんでした/)
  assert.doesNotMatch(fine.stream, /data-record-tools-missing/)
})

test('the screen line is drawn only for a known failure, never for a company without records', () => {
  assert.deepEqual(readRecordToolsMissingPart({ reason: 'offline' }), { reason: 'offline' })
  assert.equal(readRecordToolsMissingPart({ reason: 'disabled' }), null)
  assert.equal(readRecordToolsMissingPart({ reason: '<script>' }), null)
})
