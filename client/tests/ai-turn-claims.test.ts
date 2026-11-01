// Automatic 「AI の番」 (ai-turns.md), main's part: the claim before the AI starts and the settle
// after it. A fake company server keeps one minutes record with a version (compare-and-set like
// the record engine) and counts what reached it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiTurnClaims, type AiTurnClaimsDeps } from '../electron/features/ai-turns/claims'
import { createRecordsApi } from '../electron/records/api'

const COMPANY = 'acme'
const RECORD = 'minutes-0a1b2c3d4e5f6071'

function fakeServer(initial: { state: string; version: number } = { state: 'received', version: 3 }, autoRun?: unknown) {
  const record = { ...initial }
  const calls: string[] = []
  const tokens: Array<{ conversationId: string; agent: string; scope: string }> = []
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
    const act = url.pathname.match(/\/api\/records-ai\/item\/([^/]+)\/actions\/([a-z_]+)$/)
    if (act && method === 'POST') {
      assert.match(String(new Headers(init?.headers).get('Authorization')), /^Bearer acb_rec_/)
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
  return { record, calls, tokens, fetch }
}

function claimsFor(server: ReturnType<typeof fakeServer>, over: Partial<AiTurnClaimsDeps> = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  return createAiTurnClaims({
    ...base,
    records: createRecordsApi({ ...base, fetch: server.fetch }),
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
  // The claim is the AI's (an act token for that consultation), never the session.
  assert.deepEqual(server.tokens.map(t => [t.agent, t.scope]), [['claude-code', 'act'], ['claude-code', 'act']])
  assert.deepEqual(server.tokens.map(t => t.conversationId).sort(), ['conversation-aaaa', 'conversation-bbbb'])
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
