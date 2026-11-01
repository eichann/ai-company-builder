// Automatic 「AI の番」 (ai-turns.md), main's part: the claim before the AI starts and the settle
// after it. A fake company server keeps one minutes record with a version (compare-and-set like
// the record engine) and counts what reached it; it also keeps the execution run (S10b) the way the
// server does: one holder per record and step, a generation, finish with a failure class.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiTurnClaims, type AiTurnClaimsDeps } from '../electron/features/ai-turns/claims'
import { createRecordsApi, operationKeyOf } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'

const COMPANY = 'acme'
const RECORD = 'minutes-0a1b2c3d4e5f6071'
const MINUTES = RECORD
const INTERACTION = 'interaction-0a1b2c3d4e5f6071'
const REPLY_REQUEST = 'reply_request-0a1b2c3d4e5f6071'

function fakeServer(initial: { state: string; version: number } = { state: 'received', version: 3 }, autoRun?: unknown, RECORD = MINUTES) {
  const record = { ...initial }
  const calls: string[] = []
  const tokens: Array<{ conversationId: string; agent: string; scope: string; run?: { id: string; generation: number } }> = []
  const run = { id: 'run-1', generation: 0, holder: null as string | null, state: 'none', finished: [] as unknown[], keys: [] as Array<string | null> }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === `/api/companies/${COMPANY}/me/record-tokens` && method === 'POST') {
      tokens.push(body)
      return json(201, { data: { token: `acb_rec_${tokens.length}`, tokenId: `t${tokens.length}`, scope: body.scope } })
    }
    if (url.pathname.startsWith(`/api/companies/${COMPANY}/me/record-tokens/`)) return json(200, { data: {} })
    if (url.pathname === `/api/companies/${COMPANY}/ai-run-claims` && method === 'POST') {
      if (run.state === 'waiting_person') return json(409, { code: 'RUN_WAITING' })
      if (run.state === 'running' && run.holder !== body.deviceId) return json(409, { code: 'RUN_CLAIMED' })
      run.state = 'running'
      run.holder = body.deviceId
      run.generation += 1
      return json(run.generation === 1 ? 201 : 200, { data: { run: { id: run.id, generation: run.generation } } })
    }
    if (url.pathname === `/api/companies/${COMPANY}/ai-runs/${run.id}/finish` && method === 'POST') {
      run.finished.push(body)
      run.state = body.outcome === 'done' ? 'done' : body.failure.class === 'bad-input' ? 'waiting_person' : 'retry_later'
      // The server puts an unfinished reading back itself (the ledger names the run).
      if (body.outcome === 'failed' && record.state === 'reading') { record.state = 'received'; record.version += 1 }
      return json(200, { data: { run } })
    }
    if (url.pathname === `/api/companies/${COMPANY}/ai-runs` && method === 'GET') return json(200, { data: { runs: [{ id: run.id, recordId: RECORD }] } })
    if (url.pathname === `/api/companies/${COMPANY}/ai-runs/${run.id}/retry` && method === 'POST') {
      run.state = 'open'
      return json(200, { data: { run } })
    }
    const act = url.pathname.match(/\/api\/records-ai\/item\/([^/]+)\/actions\/([a-z_]+)$/)
    if (act && method === 'POST') {
      assert.match(String(new Headers(init?.headers).get('Authorization')), /^Bearer acb_rec_/)
      run.keys.push(new Headers(init?.headers).get('Idempotency-Key'))
      if (body.expectedVersion !== record.version) return json(409, { error: 'ほかの人が先に変えました', code: 'VERSION_CONFLICT' })
      if (act[2] !== 'start_reading' || record.state !== 'received') return json(409, { error: 'できません', code: 'BAD_STATE' })
      record.state = 'reading'
      record.version += 1
      return json(200, { data: { record } })
    }
    if (url.pathname === `/api/companies/${COMPANY}/task-settings` && method === 'GET' && autoRun) {
      return json(200, { success: true, data: { settings: { autoRun }, canEdit: false, updatedAt: null, updatedBy: null, updatedByName: null } })
    }
    if (url.pathname === `/api/companies/${COMPANY}/records/item/${RECORD}` && method === 'GET') return json(200, { data: { record } })
    if (url.pathname === `/api/companies/${COMPANY}/records/item/${RECORD}/actions/retry` && method === 'POST') {
      if (body.expectedVersion !== record.version || record.state !== 'reading') return json(409, { code: 'VERSION_CONFLICT' })
      record.state = 'received'
      record.version += 1
      return json(200, { data: { record } })
    }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { record, calls, tokens, run, fetch }
}

let devices = 0
function claimsFor(server: ReturnType<typeof fakeServer>, over: Partial<AiTurnClaimsDeps> = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  return createAiTurnClaims({
    ...base,
    records: createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf }),
    runs,
    deviceId: `device-${++devices}`,
    renewEveryMs: 3_600_000,
    fetch: server.fetch,
    agent: () => 'claude-code',
    windowOpen: () => true,
    aiAllowed: () => true,
    log: { warn: () => {} },
    ...over,
  })
}

test('two PCs claim the same AI turn at the same version: exactly one wins, the other runs nothing', async () => {
  const server = fakeServer()
  const pcA = claimsFor(server)
  const pcB = claimsFor(server)
  const [a, b] = await Promise.all([
    pcA.claim(COMPANY, RECORD, 3, 'conversation-aaaa'),
    pcB.claim(COMPANY, RECORD, 3, 'conversation-bbbb'),
  ])
  assert.deepEqual([a, b].filter(r => r.claimed).length, 1)
  assert.deepEqual([a, b].find(r => !r.claimed), { claimed: false, reason: 'taken' })
  assert.deepEqual(server.record, { state: 'reading', version: 4 })
  // The server's run decided first: the loser never got a token. The winner's claim is the AI's
  // (an act token for that consultation, bound to the run), never the session.
  assert.deepEqual(server.tokens.map(t => [t.agent, t.scope, t.run]), [['claude-code', 'act', { id: 'run-1', generation: 1 }]])
  await pcA.settle(COMPANY, RECORD)
  await pcB.settle(COMPANY, RECORD)
})

test('a write the server already did for this run (same key) is read back, not done again: the AI sees the same answer', async () => {
  const seen: string[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname.endsWith('/me/record-tokens')) return json(201, { data: { token: 'acb_rec_x', tokenId: 't1', scope: 'act' } })
    if (url.pathname === '/api/records-ai/outbound') return json(200, { data: { replayed: true, operationKey: 'k', ref: { kind: 'outbound', id: 'outbound_message-abc123' } } })
    if (url.pathname === '/api/records-ai/outbound/outbound_message-abc123') return json(200, { data: { draft: { id: 'outbound_message-abc123' } } })
    return json(200, { data: {} })
  }) as typeof fetch
  const runs = createRunRegistry()
  runs.set(COMPANY, 'conversation-aaaa', { id: 'run-1', generation: 2 })
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, runOf: runs.runOf })
  const access = (await api.openTurn(COMPANY, { conversationId: 'conversation-aaaa', agent: 'claude-code', scope: 'act' }))!
  assert.deepEqual(await access.call('POST', '/outbound', { subject: 'お礼' }), { draft: { id: 'outbound_message-abc123' } })
  assert.deepEqual(seen.slice(1), ['POST /api/records-ai/outbound', 'GET /api/records-ai/outbound/outbound_message-abc123'])
})

test('a run-bound token sends every write with an idempotency key made from the request itself', async () => {
  const server = fakeServer()
  const pc = claimsFor(server)
  assert.deepEqual(await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: true, version: 4 })
  const body = { expectedVersion: 3 }
  assert.deepEqual(server.run.keys, [operationKeyOf('POST', `/item/${RECORD}/actions/start_reading`, body)])
  // The same request from another PC redoing the step carries the same key (the server answers what the first made).
  assert.equal(operationKeyOf('POST', '/item', { b: 1, a: [2] }), operationKeyOf('POST', '/item', { a: [2], b: 1 }))
  assert.notEqual(operationKeyOf('POST', '/item', { a: 1 }), operationKeyOf('POST', '/item', { a: 2 }))
  await pc.settle(COMPANY, RECORD)
})

test('a run the server holds for a person is not started; 「もう一度」 gives it back on the server', async () => {
  const server = fakeServer()
  server.run.state = 'waiting_person'
  const pc = claimsFor(server)
  assert.deepEqual(await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: false, reason: 'taken' })
  assert.ok(!server.calls.some(c => c.includes('/actions/')))
  assert.deepEqual(await pc.retry(COMPANY, RECORD), { ok: true })
  assert.equal(server.run.state, 'open')
  assert.deepEqual(await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: true, version: 4 })
  await pc.settle(COMPANY, RECORD)
})

test('after the turn the run is finished with its class: done, the AI could not (a person), unfinished (later)', async () => {
  for (const [after, expected] of [
    [{ state: 'read', version: 5 }, { outcome: 'done' }],
    [{ state: 'failed', version: 5 }, { outcome: 'failed', failure: { class: 'bad-input', code: 'AI_COULD_NOT_FINISH' } }],
    [{ state: 'reading', version: 4 }, { outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } }],
  ] as const) {
    const server = fakeServer()
    const pc = claimsFor(server)
    assert.deepEqual(await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: true, version: 4 })
    Object.assign(server.record, after)
    await pc.settle(COMPANY, RECORD)
    assert.deepEqual(server.run.finished, [{ generation: 1, ...expected }])
  }
})

test('Codex, a closed main window or the emergency stop: nothing is claimed and the server is not asked', async () => {
  for (const over of [{ agent: () => 'codex' as const }, { agent: () => 'api-key' as const }, { windowOpen: () => false }, { aiAllowed: () => false }]) {
    const server = fakeServer()
    assert.deepEqual(await claimsFor(server, over).claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: false, reason: 'not-allowed' })
    assert.deepEqual(server.calls, [])
    assert.deepEqual(server.record, { state: 'received', version: 3 })
  }
})

test('only a minutes record can be claimed (no other record kind is driven by the runner yet)', async () => {
  const server = fakeServer()
  assert.equal((await claimsFor(server).claim(COMPANY, 'task-0a1b2c3d4e5f', 3, 'conversation-aaaa')).claimed, false)
  assert.deepEqual(server.calls, [])
})

test('after the turn: a reading left unfinished goes back to 「AI の番」; a finished one is left alone', async () => {
  const unfinished = fakeServer({ state: 'reading', version: 4 })
  assert.deepEqual(await claimsFor(unfinished).settle(COMPANY, RECORD), { outcome: 'put-back' })
  assert.deepEqual(unfinished.record, { state: 'received', version: 5 })

  const finished = fakeServer({ state: 'read', version: 6 })
  assert.deepEqual(await claimsFor(finished).settle(COMPANY, RECORD), { outcome: 'done' })
  assert.ok(!finished.calls.some(c => c.endsWith('/actions/retry')))
})

test("「自動で進める」 comes from the company's task settings (S6); not readable means off, never a guess", async () => {
  const on = fakeServer(undefined, { enabled: true, dailyLimit: 12, stopAfterFailures: 2 })
  assert.deepEqual(await claimsFor(on).settings(COMPANY), { enabled: true, dailyLimit: 12, stopAfterFailures: 2 })
  const off = fakeServer(undefined, { enabled: false, dailyLimit: 30, stopAfterFailures: 3 })
  assert.equal((await claimsFor(off).settings(COMPANY)).enabled, false)
  // An older server without the settings (404), or offline: nothing runs by itself.
  assert.equal((await claimsFor(fakeServer()).settings(COMPANY)).enabled, false)
})

test('a notice older than the record (an earlier run was put back): the claim starts it at the version now and says which', async () => {
  // The notice saw version 2; two put-backs later the record is at 6. Claiming at 2 was refused forever.
  const server = fakeServer({ state: 'received', version: 6 })
  const pc = claimsFor(server)
  assert.deepEqual(await pc.claim(COMPANY, RECORD, 2, 'conversation-aaaa'), { claimed: true, version: 7 })
  assert.deepEqual(server.record, { state: 'reading', version: 7 })
  await pc.settle(COMPANY, RECORD)
})

test('a record another PC already finished: nothing is claimed and the notices are read again at once', async () => {
  const server = fakeServer({ state: 'read', version: 5 })
  const moved: string[] = []
  const pc = claimsFor(server, { recordMovedOn: companyId => moved.push(companyId) })
  assert.deepEqual(await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa'), { claimed: false, reason: 'taken' })
  assert.ok(!server.calls.some(c => c.endsWith('/ai-run-claims') || c.includes('/actions/')))
  assert.deepEqual(moved, [COMPANY])
})

test('an unfinished run is put back by finishing it on the server, never as the member\'s own retry', async () => {
  const server = fakeServer()
  const pc = claimsFor(server)
  assert.equal((await pc.claim(COMPANY, RECORD, 3, 'conversation-aaaa')).claimed, true)
  assert.deepEqual(await pc.settle(COMPANY, RECORD), { outcome: 'put-back' })
  assert.deepEqual(server.record, { state: 'received', version: 5 })
  assert.ok(!server.calls.some(c => c.endsWith('/records/item/' + RECORD + '/actions/retry')))
})

test('a kind without a start mark (an incoming message in 届いた): the server\'s run alone is the claim, no record action; left in 届いた it is given back', async () => {
  const server = fakeServer({ state: 'received', version: 2 }, undefined, INTERACTION)
  const pcA = claimsFor(server)
  const pcB = claimsFor(server)
  const [a, b] = await Promise.all([pcA.claim(COMPANY, INTERACTION, 2, 'conversation-aaaa'), pcB.claim(COMPANY, INTERACTION, 2, 'conversation-bbbb')])
  const won = [a, b].filter(r => r.claimed)
  // One PC; the version the claim read is what the AI judges at (nothing moved it).
  assert.deepEqual(won, [{ claimed: true, version: 2 }])
  assert.equal(server.calls.filter(c => c.includes('/api/records-ai/item/')).length, 0)
  assert.deepEqual(server.record, { state: 'received', version: 2 })
  // The AI stopped without judging: the run is finished as temporary and the record is back in 「AI の番」.
  const winner = a.claimed ? pcA : pcB
  assert.deepEqual(await winner.settle(COMPANY, INTERACTION), { outcome: 'put-back' })
  assert.deepEqual(server.run.finished.at(-1), { generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } })
  // Judged (handled): done.
  const again = fakeServer({ state: 'received', version: 2 }, undefined, INTERACTION)
  const pc = claimsFor(again)
  assert.equal((await pc.claim(COMPANY, INTERACTION, 2, 'conversation-cccc')).claimed, true)
  again.record.state = 'handled'
  assert.deepEqual(await pc.settle(COMPANY, INTERACTION), { outcome: 'done' })
})

test('a 返事のお願い is claimed from 準備中 or 確かめ中 (no start mark); finished elsewhere, nothing is claimed', async () => {
  for (const state of ['preparing', 'checking']) {
    const server = fakeServer({ state, version: 4 }, undefined, REPLY_REQUEST)
    const pc = claimsFor(server)
    assert.deepEqual(await pc.claim(COMPANY, REPLY_REQUEST, 4, 'conversation-aaaa'), { claimed: true, version: 4 })
    // Stopped without a move: given back; handed to the person (open): done.
    assert.deepEqual(await pc.settle(COMPANY, REPLY_REQUEST), { outcome: 'put-back' })
    assert.equal((await pc.claim(COMPANY, REPLY_REQUEST, 4, 'conversation-bbbb')).claimed, true)
    server.record.state = 'open'
    assert.deepEqual(await pc.settle(COMPANY, REPLY_REQUEST), { outcome: 'done' })
  }
  const waitingReply = fakeServer({ state: 'waiting_reply', version: 4 }, undefined, REPLY_REQUEST)
  assert.deepEqual(await claimsFor(waitingReply).claim(COMPANY, REPLY_REQUEST, 4, 'conversation-cccc'), { claimed: false, reason: 'taken' })
  assert.equal(waitingReply.calls.filter(c => c.endsWith('/ai-run-claims')).length, 0)
})
