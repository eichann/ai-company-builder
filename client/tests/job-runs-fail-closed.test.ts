// Event jobs on the PC, the app's side (stage 4b-2, owner memo 「段4b 設計メモ」 §6 / §7 / §8 A1–A3, jobs.md "The app's runner"
// "Fail closed" and "Event occurrences"):
// - A1: the AI stops when its renew is not answered in time, the server cannot be reached for longer than the window,
//   or the renew answers 404 (the rollback floor froze the shape; a record the member no longer reads), 403 or 409 (a
//   condition failed) — and when a call of its token is refused for a reason that ends the run;
// - A2: a late answer (past its deadline) or an answer for an older run never extends the run held now;
// - A3: without naming the kind `event` and the check `source_record` no event occurrence comes (the list and the claim
//   name them); the server's last check right before the AI starts refused → nothing starts.
// Every guard here is mutation-checked (jobs.md "Tests").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiTurnClaims } from '../electron/features/ai-turns/claims'
import { AI_RUN_RENEW_EVERY_MS, JOB_CONFIRM_MAX_AGE_MS, JOB_RENEW_TIMEOUT_MS, jobRunGoneOnCall } from '../electron/features/ai-turns/job-runs'
import { createRecordsApi } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'
import { jobFirstMessage, parseJobTurn } from '../shared/ai-turn-steps/job'
import type { JobGrant } from '../../shared/core/jobs'

const COMPANY = 'acme'
const OCC = `occ.${'1'.repeat(32)}`
const SOURCE = 'task-0123456789abcdef'
const GRANT: JobGrant = {
  tools: ['records'], creates: ['task'], routes: ['GET /item/:recordId'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none',
  limits: { minutes: 30, runsPerDay: 5 },
}
const eventTurn = (over: Record<string, unknown> = {}) => ({
  occurrenceId: OCC, jobId: `job.${'2'.repeat(32)}`, jobVersion: 1, fingerprint: 'sha256:x', name: '面談の報告', dueSlot: '2026-11-22T10:00',
  dueAt: '2026-11-22T01:00:00.000Z', expiresAt: '2026-11-23T01:00:00.000Z', state: 'due', kind: 'event', source: { recordId: SOURCE },
  check: { kind: 'source_record', doneMark: 'none' }, checkSince: '2026-11-22T01:00:00.000Z', checkUntil: '2026-11-22T01:00:00.000Z',
  procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: 'b'.repeat(40) }, grant: GRANT, ...over,
})

type Answer = { status: number; body?: unknown; delayMs?: number } | 'hang' | 'offline'
interface FakeOpts {
  /** What the turn list answers per `kinds` asked (absent: an event turn only when `event` is named). */
  turns?: (kinds: string | null) => unknown[]
  /** The renews' answers in order (the last repeats); a function gets the request's body. */
  renews?: Answer[]
  /** What a token call answers. */
  call?: Answer
  runId?: string
  /** The turn the claim answers (default: the event turn, running). */
  claimTurn?: unknown
}

function fakeServer(opts: FakeOpts = {}) {
  const calls: Array<{ method: string; path: string; query: string; body: Record<string, unknown> }> = []
  const runId = opts.runId ?? 'run-e1'
  let renewIndex = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const answer = async (a: Answer, signal: AbortSignal | null | undefined): Promise<Response> => {
    if (a === 'offline') throw new TypeError('fetch failed')
    if (a === 'hang') {
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)) })
    }
    // A delayed answer ignores the request's deadline (as a proxy holding the reply would): the app must judge it itself.
    if (a.delayMs) await new Promise(resolve => setTimeout(resolve, a.delayMs))
    return json(a.status, a.body ?? {})
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const p = url.pathname.replace(`/api/companies/${COMPANY}`, '')
    calls.push({ method, path: p, query: url.search, body })
    if (p === '/me/job-turns') {
      const kinds = url.searchParams.get('kinds')
      return json(200, { data: { turns: opts.turns ? opts.turns(kinds) : (kinds?.split(',').includes('event') ? [eventTurn()] : []) } })
    }
    if (p === '/task-settings') return json(200, { data: { settings: { autoRun: { enabled: true } } } })
    if (p === '/me/work-switches') return json(404, { code: 'NOT_FOUND' })
    if (p === '/job-run-claims') {
      // The server's locks (jobs.md "Old apps never run it"): an event occurrence only for an app naming both.
      if (!(Array.isArray(body.kinds) && body.kinds.includes('event')) || !(Array.isArray(body.checks) && body.checks.includes('source_record'))) {
        return json(409, { code: 'JOB_KIND_NOT_SUPPORTED' })
      }
      const now = new Date().toISOString()
      return json(201, { data: { run: { id: runId, generation: 1, createdAt: now, updatedAt: now }, turn: opts.claimTurn ?? eventTurn({ state: 'running' }) } })
    }
    if (p === `/ai-runs/${runId}/renew`) {
      const list = opts.renews ?? [{ status: 200 }]
      const a = list[Math.min(renewIndex++, list.length - 1)]
      const filled = typeof a === 'object' && a.status === 200 && a.body === undefined ? { ...a, body: { data: { run: { id: runId, generation: 1 } } } } : a
      return answer(filled, init?.signal)
    }
    if (p === `/ai-runs/${runId}/finish`) return json(200, { data: {} })
    if (p === '/me/record-tokens') return json(201, { data: { token: 't', tokenId: 'tok-1', scope: 'act' } })
    if (p.startsWith('/me/record-tokens/')) return json(200, { data: {} })
    if (url.pathname.startsWith('/api/records-ai/')) return answer(opts.call ?? { status: 200, body: { data: {} } }, init?.signal)
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { calls, fetch }
}

function claimsFor(server: ReturnType<typeof fakeServer>, over: Partial<Parameters<typeof createAiTurnClaims>[0]> = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  const stopped: string[] = []
  // The records API tells the claims of a refused call (as main.ts wires it).
  const late: { claims: ReturnType<typeof createAiTurnClaims> | null } = { claims: null }
  const records = createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf, onRunRefused: (c, conv, run, status, code) => late.claims?.runRefused(c, conv, run.id, status, code) })
  const claims = createAiTurnClaims({
    ...base, records, runs, deviceId: 'device-job-1', renewEveryMs: 3_600_000, fetch: server.fetch,
    agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true, stopPolicyConfirmed: async () => true,
    log: { warn: () => {} }, readProcedure: async () => '# 面談の報告書\n',
    jobs: { readShelfSkill: async () => null, fetchMark: async () => null, checkPoint: async () => null, newFiles: async () => null, stopTurn: (c: string) => { stopped.push(c) } },
    ...over,
  })
  late.claims = claims
  return { claims, stopped, runs, records }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const renews = (server: ReturnType<typeof fakeServer>) => server.calls.filter(c => c.path.endsWith('/renew')).length

test('A3: the list and the claim name the kind `event` and the check `source_record`; without them no event occurrence comes', async () => {
  const server = fakeServer()
  const { claims } = claimsFor(server)
  const turns = await claims.jobTurns(COMPANY)
  assert.equal(server.calls.find(c => c.path === '/me/job-turns')?.query, '?kinds=time,event')
  assert.deepEqual(turns.map(t => [t.occurrenceId, t.kind, t.source?.recordId]), [[OCC, 'event', SOURCE]])
  const r = await claims.claim(COMPANY, OCC, 1, 'conv-event-0001')
  assert.ok(r.claimed)
  const claim = server.calls.find(c => c.path === '/job-run-claims')!.body
  assert.deepEqual(claim.kinds, ['time', 'event'])
  assert.deepEqual(claim.checks, ['new_files', 'new_meetings', 'source_record'])
  // The first message starts from the record the event happened to; never `nothing` (only the server's conditions decide that).
  assert.ok(r.message?.includes(SOURCE) && r.message.includes('records_get'))
  assert.equal(server.calls.some(c => c.path.endsWith('/finish')), false)
})

test('A3: a time slot\'s claim stays as every earlier app sent it (no `kinds`, its checks only)', async () => {
  const time = { ...eventTurn(), kind: undefined, source: undefined, check: { kind: 'new_meetings', titleWords: [] }, meetings: [{ id: 'meeting-0123456789ab', title: '面談', at: '2026-11-22T01:00:00.000Z' }], grant: { ...GRANT, routes: ['GET /minutes/:recordId/text'] } }
  const server = fakeServer({ turns: () => [time] })
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  await claims.claim(COMPANY, OCC, 1, 'conv-time-0001')
  // Byte for byte what every earlier app sent for a time slot (no `kinds`: a server before stage 4-0 refuses the key).
  assert.deepEqual(server.calls.find(c => c.path === '/job-run-claims')!.body, {
    occurrenceId: OCC, deviceId: 'device-job-1', conversationId: 'conv-time-0001', checks: ['new_files', 'new_meetings'],
  })
})

test('an event turn is parsed with its own pairing: the record check only on an event, an event only with it and its record', () => {
  assert.equal(parseJobTurn(eventTurn())?.kind, 'event')
  assert.equal(parseJobTurn(eventTurn({ source: undefined })), null)
  assert.equal(parseJobTurn(eventTurn({ source: { recordId: '../x' } })), null)
  assert.equal(parseJobTurn(eventTurn({ kind: 'later' })), null)
  // A time turn carrying the event's check, an event carrying a time check, a time turn naming a source: not runs of this app.
  assert.equal(parseJobTurn(eventTurn({ kind: undefined, source: undefined })), null)
  assert.equal(parseJobTurn(eventTurn({ check: { kind: 'new_meetings', titleWords: [] } })), null)
  assert.equal(parseJobTurn({ ...eventTurn({ kind: undefined, check: { kind: 'new_meetings', titleWords: [] }, grant: { ...GRANT, routes: ['GET /minutes/:recordId/text'] } }) }), null)
  // A time turn may say so (`kind: 'time'`, `source: null`): harmless, still a time turn; an event's pairing stays strict.
  const timeTurn = { ...eventTurn({ kind: undefined, source: undefined }), check: { kind: 'new_meetings', titleWords: [] }, grant: { ...GRANT, routes: ['GET /minutes/:recordId/text'] } }
  assert.ok(parseJobTurn(timeTurn))
  const saysTime = parseJobTurn({ ...timeTurn, kind: 'time' })
  assert.ok(saysTime && saysTime.kind === undefined)
  assert.ok(parseJobTurn({ ...timeTurn, source: null }))
  assert.equal(parseJobTurn({ ...timeTurn, source: { recordId: SOURCE } }), null)
  assert.equal(parseJobTurn(eventTurn({ source: null })), null)
  // The event's grant must create its one やること (the server's rule, schema 3).
  assert.equal(parseJobTurn(eventTurn({ grant: { ...GRANT, creates: [] } })), null)
  const message = jobFirstMessage({ name: 'x', found: { kind: 'record', recordId: SOURCE }, procedure: '# 手順', grant: { ...GRANT, tools: [], routes: [] }, deadline: '10:00' })
  assert.ok(message.includes(SOURCE) && !message.includes('records_get'), 'records_get is named only when the grant lets it read the record')
})

test('A3: the server\'s last check right before the AI starts refused (409, 404) → nothing starts; not answered → given back', async () => {
  for (const status of [409, 404, 403]) {
    const server = fakeServer({ renews: [{ status, body: { code: 'JOB_EVENT_ENDED' } }] })
    const { claims, runs } = claimsFor(server)
    await claims.jobTurns(COMPANY)
    assert.deepEqual(await claims.claim(COMPANY, OCC, 1, 'conv-event-0002'), { claimed: false, reason: 'unavailable' }, String(status))
    assert.equal(renews(server), 1)
    assert.equal(claims.jobTools('conv-event-0002', 'job-procedure'), null)
    assert.equal(runs.runOf(COMPANY, 'conv-event-0002'), null)
  }
  const down = fakeServer({ renews: [{ status: 502 }] })
  const { claims } = claimsFor(down)
  await claims.jobTurns(COMPANY)
  assert.deepEqual(await claims.claim(COMPANY, OCC, 1, 'conv-event-0003'), { claimed: false, reason: 'unavailable' })
  assert.deepEqual(down.calls.filter(c => c.path.endsWith('/finish')).map(c => c.body), [{ generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'NOT_CONFIRMED' } }])
})

test('A1: a renew answered 404 (the floor), 403 or 409 (a condition failed) stops the AI', async () => {
  for (const status of [404, 403, 409, 401]) {
    const server = fakeServer({ renews: [{ status: 200 }, { status, body: { code: status === 409 ? 'JOB_EVENT_ENDED' : 'RUN_NOT_FOUND' } }] })
    const { claims, stopped } = claimsFor(server, { renewEveryMs: 20 })
    await claims.jobTurns(COMPANY)
    assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0010')).claimed)
    await wait(80)
    assert.deepEqual(stopped, ['conv-event-0010'], String(status))
    assert.equal(claims.jobTools('conv-event-0010', 'job-procedure'), null)
  }
})

test('A1: a renew that never answers, or no server at all, stops the AI once the last confirmation is older than the window', async () => {
  for (const a of ['hang', 'offline', { status: 503 }] as Answer[]) {
    const server = fakeServer({ renews: [{ status: 200 }, a] })
    const { claims, stopped } = claimsFor(server, { renewEveryMs: 30, jobRenewTimeoutMs: 40, jobConfirmMaxAgeMs: 150 })
    await claims.jobTurns(COMPANY)
    assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0020')).claimed)
    await wait(60)
    assert.deepEqual(stopped, [], `${JSON.stringify(a)}: still within the window`)
    await wait(200)
    assert.deepEqual(stopped, ['conv-event-0020'], JSON.stringify(a))
  }
  // Renews that keep answering keep it going past the window.
  const fine = fakeServer()
  const { claims, stopped } = claimsFor(fine, { renewEveryMs: 30, jobRenewTimeoutMs: 40, jobConfirmMaxAgeMs: 150 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0021')).claimed)
  await wait(400)
  assert.deepEqual(stopped, [])
  assert.ok(claims.jobTools('conv-event-0021', 'job-procedure'))
})

test('A2: a renew answered after its deadline never extends the run: it stops at the window as if unanswered', async () => {
  const server = fakeServer({ renews: [{ status: 200 }, { status: 200, delayMs: 80 }] })
  const { claims, stopped } = claimsFor(server, { renewEveryMs: 30, jobRenewTimeoutMs: 40, jobConfirmMaxAgeMs: 150 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0030')).claimed)
  await wait(300)
  assert.deepEqual(stopped, ['conv-event-0030'])
})

test('A2: a success that names another run (or generation) confirms nothing', async () => {
  const server = fakeServer({ renews: [{ status: 200 }, { status: 200, body: { data: { run: { id: 'run-older', generation: 1 } } } }] })
  const { claims, stopped } = claimsFor(server, { renewEveryMs: 30, jobRenewTimeoutMs: 40, jobConfirmMaxAgeMs: 150 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0031')).claimed)
  await wait(300)
  assert.deepEqual(stopped, ['conv-event-0031'])
})

test('A2: an older run\'s renew answered late, after the occurrence was claimed again, neither extends nor stops the new run', async () => {
  // The first run's renew hangs for a while and then answers 200 (or 409); meanwhile that run was lost and the occurrence
  // claimed again — the same run id, a new hold. The new hold's own renews never answer, so only an old answer could
  // extend it: it must still stop at its window, and an old 409 must not stop it early.
  for (const late of [200, 409]) {
    const server = fakeServer({ renews: [{ status: 200 }, { status: late, delayMs: 120, body: late === 200 ? undefined : { code: 'RUN_SUPERSEDED' } }, { status: 200 }, 'hang'] })
    const { claims, stopped } = claimsFor(server, { renewEveryMs: 50, jobRenewTimeoutMs: 1_000, jobConfirmMaxAgeMs: 400 })
    await claims.jobTurns(COMPANY)
    assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0040')).claimed)
    await wait(60) // the first run's renew is now on its way (answers at ~170 ms)
    await claims.settle(COMPANY, OCC) // the run ends here (e.g. the turn finished unexpectedly) …
    await claims.jobTurns(COMPANY)
    assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0041')).claimed) // … and is claimed again: a new hold
    await wait(150) // the old answer has arrived
    assert.deepEqual(stopped, [], `old ${late}: the new run is not stopped by it`)
    await wait(450)
    assert.deepEqual(stopped, ['conv-event-0041'], `old ${late}: the new run still stops at its own window`)
  }
})

test('A1: a call of its token refused for a reason that ends the run stops the AI; a tool\'s own refusal does not', async () => {
  for (const [status, code, stops] of [[403, 'NOT_IN_STEP', true], [409, 'RUN_SUPERSEDED', true], [409, 'JOB_EVENT_ENDED', true], [401, 'RECORD_TOKEN_INVALID', true], [409, 'DRIVE_FILE_CHANGED_SINCE', false], [404, 'NOT_FOUND', false]] as const) {
    const server = fakeServer({ call: { status, body: { code, error: 'x' } } })
    const { claims, stopped, records } = claimsFor(server)
    await claims.jobTurns(COMPANY)
    assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0050')).claimed)
    const access = await records.openTurn(COMPANY, { conversationId: 'conv-event-0050', agent: 'claude-code', scope: 'act', requireRun: true })
    await assert.rejects(access!.call('GET', `/item/${SOURCE}`))
    assert.deepEqual(stopped, stops ? ['conv-event-0050'] : [], `${status} ${code}`)
    assert.equal(!!claims.jobTools('conv-event-0050', 'job-procedure'), !stops)
  }
  assert.equal(jobRunGoneOnCall(503, 'AI_STOPPED'), true)
  assert.equal(jobRunGoneOnCall(503, 'SERVER_ERROR'), false)
})

test('a record\'s run is unchanged: a renew\'s 404 or no answer does not lose it (only 409, as before)', async () => {
  const runs = createRunRegistry()
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).pathname.replace(`/api/companies/${COMPANY}`, '')
    if (p === '/records/item/meeting-0123456789ab') return json(200, { data: { record: { state: 'received', version: 1, type: 'meeting' } } })
    if (p === '/ai-run-claims') return json(201, { data: { run: { id: 'run-r1', generation: 1 } } })
    if (p === '/me/record-tokens') return json(201, { data: { token: 't', tokenId: 'tok-1', scope: 'act' } })
    if (p.endsWith('/renew')) return json(404, { code: 'RUN_NOT_FOUND' })
    return json(200, { data: { record: { version: 2 } } })
  }) as typeof globalThis.fetch
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const claims = createAiTurnClaims({
    ...base, records: createRecordsApi({ ...base, fetch, runOf: runs.runOf }), runs, deviceId: 'device-job-1', renewEveryMs: 20, fetch,
    agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true, stopPolicyConfirmed: async () => true, log: { warn: () => {} },
    jobConfirmMaxAgeMs: 30,
  })
  const r = await claims.claim(COMPANY, 'meeting-0123456789ab', 1, 'conv-record-001')
  assert.ok(r.claimed, JSON.stringify(r))
  await wait(120)
  assert.deepEqual(runs.runOf(COMPANY, 'conv-record-001'), { id: 'run-r1', generation: 1 })
})

test('a claim answered with a turn of another kind than the one listed (a time turn for an event) starts nothing', async () => {
  const time = { ...eventTurn({ state: 'running' }), kind: undefined, source: undefined, check: { kind: 'new_meetings', titleWords: [] }, meetings: [{ id: 'meeting-0123456789ab', title: '面談', at: '2026-11-22T01:00:00.000Z' }], grant: { ...GRANT, routes: ['GET /minutes/:recordId/text'] } }
  const server = fakeServer({ claimTurn: time })
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  assert.deepEqual(await claims.claim(COMPANY, OCC, 1, 'conv-event-0060'), { claimed: false, reason: 'unavailable' })
  assert.deepEqual(server.calls.filter(c => c.path.endsWith('/finish')).map(c => c.body), [{ generation: 1, outcome: 'failed', failure: { class: 'bad-input', code: 'TURN_NOT_READABLE' } }])
})

test('M2: a PC asleep (the monotonic clock stood still) stops the AI on waking — the wall clock\'s elapsed time counts', async () => {
  let wallOffset = 0
  const frozen = performance.now()
  const server = fakeServer()
  const { claims, stopped } = claimsFor(server, { monotonicNow: () => frozen, wallNow: () => Date.now() + wallOffset, jobConfirmMaxAgeMs: 10_000, jobWatchTickMs: 30 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0070')).claimed)
  await wait(80)
  assert.deepEqual(stopped, [], 'awake: within the window')
  wallOffset = 60 * 60_000 // an hour asleep: performance.now did not move
  await wait(150)
  assert.deepEqual(stopped, ['conv-event-0070'], 'read again within a tick of waking, and stopped')
})

test('M2: a wall clock set back never extends the run (the monotonic time still counts)', async () => {
  let wallOffset = 0
  const server = fakeServer({ renews: [{ status: 200 }, 'hang'] })
  const { claims, stopped } = claimsFor(server, { wallNow: () => Date.now() + wallOffset, renewEveryMs: 30, jobRenewTimeoutMs: 40, jobConfirmMaxAgeMs: 150, jobWatchTickMs: 30 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0071')).claimed)
  wallOffset = -60 * 60_000
  await wait(300)
  assert.deepEqual(stopped, ['conv-event-0071'])
})

test('L1: an older claim never counts a newer claim\'s hold of the same run as its own: only one starts', async () => {
  const server = fakeServer()
  let first = true
  let release!: () => void
  const slow = new Promise<string>(resolve => { release = () => resolve('# 手順\n') })
  const { claims } = claimsFor(server, { readProcedure: () => { if (first) { first = false; return slow } return Promise.resolve('# 手順\n') } })
  await claims.jobTurns(COMPANY)
  const older = claims.claim(COMPANY, OCC, 1, 'conv-event-0080') // waits on its procedure
  await wait(30)
  await claims.jobTurns(COMPANY)
  const newer = await claims.claim(COMPANY, OCC, 1, 'conv-event-0081') // the same run, held again
  assert.ok(newer.claimed)
  release()
  assert.deepEqual(await older, { claimed: false, reason: 'unavailable' })
  // The newer one is untouched: still its ceiling, nothing finished on its behalf.
  assert.ok(claims.jobTools('conv-event-0081', 'job-procedure'))
  assert.equal(claims.jobTools('conv-event-0080', 'job-procedure'), null)
  assert.equal(server.calls.some(c => c.path.endsWith('/finish')), false)
})

test('L1: an older claim that gives up (its procedure not here) never finishes the newer claim\'s hold of the same run', async () => {
  const server = fakeServer()
  let first = true
  let release!: () => void
  const missing = new Promise<string | null>(resolve => { release = () => resolve(null) })
  const { claims } = claimsFor(server, { readProcedure: () => { if (first) { first = false; return missing } return Promise.resolve('# 手順\n') } })
  await claims.jobTurns(COMPANY)
  const older = claims.claim(COMPANY, OCC, 1, 'conv-event-0090')
  await wait(30)
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0091')).claimed)
  release()
  assert.deepEqual(await older, { claimed: false, reason: 'unavailable' })
  assert.equal(server.calls.some(c => c.path.endsWith('/finish')), false, 'the newer run is not given back on the older claim\'s behalf')
  assert.ok(claims.jobTools('conv-event-0091', 'job-procedure'))
})

test('the renew deadline (30 s, owner decision) ends before the next renew is due, and the window holds two renews', () => {
  assert.equal(JOB_RENEW_TIMEOUT_MS, 30_000)
  assert.ok(JOB_RENEW_TIMEOUT_MS < AI_RUN_RENEW_EVERY_MS, 'one renew is over before the next one is sent')
  assert.ok(2 * AI_RUN_RENEW_EVERY_MS + JOB_RENEW_TIMEOUT_MS <= JOB_CONFIRM_MAX_AGE_MS, 'two renews may fail before the AI is stopped')
})

test('a hold never sends a second timed renew while its first is still out (no two answers racing on one hold)', async () => {
  // The answer takes 200 ms (ignoring the request's abort); the timer ticks every 20 ms.
  const server = fakeServer({ renews: [{ status: 200 }, { status: 200, delayMs: 200 }] })
  const { claims } = claimsFor(server, { renewEveryMs: 20, jobRenewTimeoutMs: 1_000, jobConfirmMaxAgeMs: 5_000 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-event-0100')).claimed)
  const before = renews(server)
  await wait(150)
  const sent = renews(server) - before
  await claims.settle(COMPANY, OCC) // release the hold (its timer) before asserting
  assert.equal(sent, 1)
})
