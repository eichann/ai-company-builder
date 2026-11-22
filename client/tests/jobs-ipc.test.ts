// jobs:* (electron/features/jobs/ipc.ts, jobs.md "The screens"): the app shows the member only the jobs
// they are the responsible person of (an owner / admin's list holds every job of the company), asks for
// acceptance only of the approved version that names them, sends exactly the version and fingerprint
// shown, and never lets a renderer value change the server path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsApi } from '../electron/features/jobs/ipc'
import { jobNoticeTarget } from '../shared/jobs'

const J1 = 'job.' + '1'.repeat(32)
const J2 = 'job.' + '2'.repeat(32)
const J3 = 'job.' + '3'.repeat(32)
const FP = 'sha256:' + 'a'.repeat(64)

const def = (actingUser: string) => ({
  schema: 1, name: 'x', actingUser, trigger: { every: 'day', at: '09:00', businessDaysOnly: true }, check: { kind: 'none' },
  run: { kind: 'operation', operation: 'create_task', title: '日報', dueBusinessDays: null }, placement: 'e',
  missed: { policy: 'skip', expiresAfterMinutes: 60 },
  grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
})
const view = (id: string, you: { named: boolean; controls: boolean; mustAccept: boolean }, hidden = false) => ({
  id, name: `${id}（最新の版）`, state: 'active', actingUserId: 'x', latestVersion: 1, approvedVersion: 1, accepted: !you.mustAccept, pausedReason: null,
  waiting: you.mustAccept ? 'NOT_ACCEPTED' : null, trigger: def('me').trigger, placement: 'e', nextSlot: '2026-11-12T09:00',
  approved: { responsibleUserId: 'me', name: hidden ? '定期の仕事' : `${id}（承認された版）` }, you,
  versions: [{ version: 1, fingerprint: hidden ? null : FP, consentFingerprint: hidden ? null : FP, definition: hidden ? null : def('me') }],
})
const NOT_MINE = { named: false, controls: false, mustAccept: false }
const RUNS_IT = { named: true, controls: true, mustAccept: false }
const WAITS = { named: true, controls: true, mustAccept: true }

type ChoosePlace = NonNullable<Parameters<typeof createJobsApi>[0]['choosePlace']>
function api(jobs: Array<ReturnType<typeof view> & Record<string, unknown>>, choosePlace?: ChoosePlace) {
  const calls: Array<{ method: string; url: string; body?: string; cookie?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined, cookie: (init.headers as Record<string, string>).Cookie })
    const path = url.replace('https://acb.example/api', '')
    const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/companies/c1/jobs') return json({ stopped: false, canManage: true, jobs })
    const found = jobs.find(j => path === `/companies/c1/jobs/${j.id}`)
    if (found) return json(found)
    return json({ ok: true })
  }) as typeof globalThis.fetch
  return { calls, jobs: createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} }, ...(choosePlace ? { choosePlace } : {}) }) }
}

test('only the jobs the server says are the member\'s are shown, and only theirs waits for their 「受け取る」', async () => {
  const { calls, jobs } = api([view(J1, NOT_MINE), view(J2, WAITS), view(J3, RUNS_IT)])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.deepEqual(r.jobs.map(j => j.id), [J2, J3])
  assert.deepEqual(r.jobs.map(j => j.toAccept?.version ?? null), [1, null])
  assert.equal(r.jobs[0].toAccept?.fingerprint, FP)
  assert.deepEqual(r.jobs.map(j => j.controls), [true, true])
  // The heading is the approved version's name (the server's, under its hiding rule), not the newest draft's.
  assert.equal(r.jobs[0].name, `${J2}（承認された版）`)
  // Only what waits for them is read in detail.
  assert.deepEqual(calls.map(c => c.url.replace('https://acb.example/api/companies/c1', '')), ['/jobs', `/jobs/${J2}`])
})

test('a job whose approved definition is hidden from the member still waits for them, shown as not readable', async () => {
  const { jobs } = api([view(J1, WAITS, true)])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.equal(r.jobs.length, 1)
  assert.deepEqual(r.jobs[0].toAccept, { version: 1, fingerprint: null, definition: null, why: 'accept' })
  assert.equal(r.jobs[0].name, '定期の仕事')
  assert.equal(r.jobs[0].controls, true)
})

test('an owner\'s own jobs are never dropped behind other people\'s', async () => {
  const others = Array.from({ length: 80 }, (_, i) => view('job.' + i.toString(16).padStart(32, '0'), NOT_MINE))
  const { jobs } = api([...others, view(J2, WAITS)])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.deepEqual(r.jobs.map(j => j.id), [J2])
  assert.equal(r.jobs[0].toAccept?.version, 1)
})

test('a draft naming the member, approved for someone else, is shown but asks them nothing', async () => {
  const { jobs } = api([view(J1, { named: true, controls: false, mustAccept: false })])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.equal(r.jobs[0].toAccept, null)
  assert.equal(r.jobs[0].controls, false)
})

test('accepting sends the version and fingerprint shown, with the session; renderer values never change the path', async () => {
  const { calls, jobs } = api([])
  for (const [company, id, version, fp] of [['../x', J1, 1, FP], ['c1', '../../jobs-stop', 1, FP], ['c1', J1, 0, FP], ['c1', J1, 1, 'sha256:zz'], ['c1', 'job.1', 1, FP]] as const) {
    const r = await jobs.accept(company, id, version, fp)
    assert.equal(r.success === false && r.code, 'BAD_REQUEST')
  }
  assert.equal((await jobs.pause('c1', `${J1}/../x`)).success, false)
  assert.deepEqual(calls, [])
  assert.ok((await jobs.accept('c1', J1, 2, FP)).success)
  // The job as the server answers it first (does it put into a place outside?), then the acceptance.
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body, c.cookie]), [
    ['GET', `https://acb.example/api/companies/c1/jobs/${J1}`, undefined, 's=1'],
    ['POST', `https://acb.example/api/companies/c1/me/jobs/${J1}/accept`, JSON.stringify({ version: 2, fingerprint: FP }), 's=1'],
  ])
})

const PLACE_VIEW = { connector: 'google', kind: 'drive_folder', label: 'Google Drive のフォルダ', chosen: false, usable: false, name: null, expiresAt: null }

test('a job that puts into a place outside: the member chooses it first (the server says which kind), and the acceptance carries it', async () => {
  const asked: unknown[] = []
  const { calls, jobs } = api([{ ...view(J1, WAITS), deliverTo: PLACE_VIEW }], async (_company, place) => { asked.push(place); return { ok: true, ref: 'fake-folder-proposals-0001' } })
  assert.ok((await jobs.accept('c1', J1, 1, FP)).success)
  assert.deepEqual(asked, [{ connector: 'google', kind: 'drive_folder' }])
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { version: 1, fingerprint: FP, place: { connector: 'google', kind: 'drive_folder', ref: 'fake-folder-proposals-0001' } })
  // Cancelled, or an app that cannot choose: nothing accepted.
  const cancelled = api([{ ...view(J1, WAITS), deliverTo: PLACE_VIEW }], async () => ({ ok: false, message: 'メンバーは何も選びませんでした。' }))
  const no = await cancelled.jobs.accept('c1', J1, 1, FP)
  assert.equal(no.success === false && no.error, 'メンバーは何も選びませんでした。')
  assert.equal(cancelled.calls.some(c => c.method === 'POST'), false)
  const older = api([{ ...view(J1, WAITS), deliverTo: PLACE_VIEW }])
  assert.equal((await older.jobs.accept('c1', J1, 1, FP)).success, false)
  assert.equal(older.calls.some(c => c.method === 'POST'), false)
})

test('a chosen place no longer usable asks the member to choose again; a usable one shows its name and asks nothing', async () => {
  const lost = { ...view(J1, RUNS_IT), deliverTo: { ...PLACE_VIEW, chosen: true } }
  const fine = { ...view(J2, RUNS_IT), deliverTo: { ...PLACE_VIEW, chosen: true, usable: true, name: '報告書', expiresAt: '2027-02-09T00:00:00.000Z' } }
  const { jobs } = api([lost, fine])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.deepEqual(r.jobs.map(j => j.toAccept?.why ?? null), ['place', null])
  assert.deepEqual(r.jobs[1].deliverTo, { label: 'Google Drive のフォルダ', chosen: true, usable: true, name: '報告書', expiresAt: '2027-02-09T00:00:00.000Z' })
})

test('a job\'s notice opens 「定期の仕事」 only for the acceptance ask; an occurrence notice (also to the creator) opens nothing', () => {
  assert.equal(jobNoticeTarget('job_accept_needed'), 'jobs')
  for (const kind of ['job_expired', 'job_skipped', 'job_failed', 'job_paused', 'company_restored']) assert.equal(jobNoticeTarget(kind), 'none')
  assert.equal(jobNoticeTarget('morning_summary'), null)
})

test('an older server that does not say who the member is to a job is reported as such, never as 「ありません」', async () => {
  const old = { ...view(J1, WAITS) } as Record<string, unknown>
  delete old.you
  const { jobs } = api([old as ReturnType<typeof view>])
  const r = await jobs.mine('c1')
  assert.equal(r.success === false && r.code, 'SERVER_TOO_OLD')
  assert.match(r.success === false ? r.error : '', /サーバーの更新が必要です/)
})

// Stage 4a ① (jobs.md "Event-triggered jobs"): the next watched やること of a stopped event job is one of the member's
// own open ones (by the server's reader), and 「これを見張る」 sends exactly the version shown and the record chosen.
test('a stopped chain: the member\'s own open やること are offered by name, and the choice goes to the job\'s watch', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body as string) : undefined })
    const data = url.endsWith('/api/me') ? { id: 'u-me' }
      : url.endsWith('/records/query') ? { total: 1, records: [{ id: 'task-0123456789abcdef', title: '次の一歩' }, { id: '../x', title: 'bad' }] }
        : { ok: true }
    return new Response(JSON.stringify({ success: true, data }), { status: 200 })
  }) as typeof globalThis.fetch
  const jobs = createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } })
  const r = await jobs.watchChoices('c1', ' 一歩 ')
  assert.deepEqual(r, { success: true, total: 1, choices: [{ id: 'task-0123456789abcdef', title: '次の一歩' }] })
  assert.deepEqual(calls[1].body, { type: 'task', state: ['todo', 'in_progress', 'review', 'waiting', 'awaiting_acceptance', 'declined'], fields: { assignee: 'u-me' }, limit: 50, text: '一歩' })
  assert.ok((await jobs.rewatch('c1', J1, 2, 'task-0123456789abcdef')).success)
  assert.deepEqual(calls.at(-1), { method: 'POST', url: `https://acb.example/api/companies/c1/me/jobs/${J1}/watch`, body: { version: 2, recordId: 'task-0123456789abcdef' } })
  // Renderer values never reach the path or the server unchecked.
  assert.equal((await jobs.rewatch('c1', J1, 2, '../../x')).success, false)
  assert.equal((await jobs.rewatch('c1', '../job', 2, 'task-0123456789abcdef')).success, false)
  assert.equal(calls.length, 3)
})

// Stage 4a (jobs.md "Event-triggered jobs"): the app shows event jobs, so it says it reads schema 2 on every job call —
// a server answers an app that does not say so without the definition (and refuses its 受け取る: 「アプリを新しく」).
test('every job call says which definition shapes this app shows (1, 2, 3 since stage 4b-2, 4 since member proposals)', async () => {
  const headers: Array<Record<string, string>> = []
  const fetch = (async (_url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>)
    return new Response(JSON.stringify({ success: true, data: { stopped: false, canManage: false, jobs: [] } }), { status: 200 })
  }) as typeof globalThis.fetch
  const jobs = createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } })
  await jobs.mine('c1')
  await jobs.pause('c1', J1)
  assert.ok(headers.length === 2 && headers.every(h => h['X-ACB-Job-Schemas'] === '1,2,3,4'))
  // The app's 受け取る is always a press of its own (owner decision 2026-11-18): said on every job call, so the server
  // never takes it for an approval's (it refuses the approver's acceptance without it).
  assert.ok(headers.every(h => h['X-ACB-Job-Accept'] === 'separate'))
})

// Stage 4b-2 (D11): 「AI が動いた回」 — the event occurrences this PC's AI ran for the member, as the server answers them; a
// renderer value never changes the path; an older server (404) has none, said as nothing to show.
const O1 = 'occ.' + 'a'.repeat(32)
function occurrencesApi(answer: { status: number; data?: unknown }) {
  const calls: Array<{ method: string; url: string; body?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url: url.replace('https://acb.example/api/companies/c1', ''), body: init.body as string | undefined })
    const isList = url.endsWith('/me/job-occurrences')
    const body = isList ? (answer.status === 200 ? { success: true, data: answer.data } : { error: 'x' }) : { success: true, data: { ok: true } }
    return new Response(JSON.stringify(body), { status: isList ? answer.status : 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, jobs: createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } }) }
}
const occurrence = (over: Record<string, unknown> = {}) => ({
  id: O1, jobId: J1, name: '面談の報告', jobVersion: 1, dueSlot: '2026-11-22T10:00', timeZone: 'Asia/Tokyo', dueAt: 'x', expiresAt: 'x',
  state: 'needs_person', outcomeCode: 'RESULT_UNKNOWN', ran: false, updatedAt: 'x', kind: 'event',
  retry: { allowed: false, why: 'JOB_RESULT_UNKNOWN' }, unknownOperations: [{ key: 'acb-0123', kind: 'drive-put' }], madeBefore: [], ...over,
})

test('「AI が動いた回」: the server\'s list as answered; only what reaches a path is strict — a later server\'s words never hide 「後始末」', async () => {
  const ops = Array.from({ length: 60 }, (_, i) => ({ key: `acb-${i}`, kind: 'drive-put' }))
  const { jobs } = occurrencesApi({ status: 200, data: { occurrences: [
    occurrence(),
    occurrence({ id: 'task-0123456789' }), // not an occurrence id: left out (it goes into the path)
    occurrence({ id: 'occ.' + 'b'.repeat(32), state: 'later_state', outcomeCode: 'later code', retry: { allowed: false, why: 'LATER_REASON' }, unknownOperations: [{ key: '../x', kind: 'drive-put' }, { key: 'acb-9', kind: '??' }] }),
    occurrence({ id: 'occ.' + 'c'.repeat(32), retry: { allowed: 'yes' }, unknownOperations: ops }),
  ] } })
  const r = await jobs.occurrences('c1')
  assert.ok(r.success && r.supported)
  assert.deepEqual(r.occurrences.map(o => o.id), [O1, 'occ.' + 'b'.repeat(32), 'occ.' + 'c'.repeat(32)])
  assert.deepEqual([r.occurrences[0].retry, r.occurrences[0].unknownOperations], [{ allowed: false, why: 'JOB_RESULT_UNKNOWN' }, [{ key: 'acb-0123', kind: 'drive-put' }]])
  // Unknown state, code and reason: kept, shown as not readable / blocked; the bad key alone left out, the good one kept.
  assert.deepEqual([r.occurrences[1].state, r.occurrences[1].outcomeCode, r.occurrences[1].retry, r.occurrences[1].unknownOperations],
    [null, null, { allowed: false, why: 'UNKNOWN' }, [{ key: 'acb-9', kind: 'other' }]])
  // A malformed retry is no button; a long list is cut, never the occurrence.
  assert.deepEqual([r.occurrences[2].retry, r.occurrences[2].unknownOperations.length], [null, 50])
  // Fields the server left out (rights it does not give) stay out: nothing to press.
  const plain = await occurrencesApi({ status: 200, data: { occurrences: [occurrence({ retry: undefined, unknownOperations: undefined })] } }).jobs.occurrences('c1')
  assert.ok(plain.success)
  assert.deepEqual([plain.occurrences[0].retry, plain.occurrences[0].unknownOperations], [null, []])
  const old = await occurrencesApi({ status: 404 }).jobs.occurrences('c1')
  assert.deepEqual(old, { success: true, supported: false, occurrences: [] })
})

test('「もう一度」 and 「後始末」 go to the occurrence\'s own route; a renderer value never changes the path', async () => {
  const { calls, jobs } = occurrencesApi({ status: 200, data: { occurrences: [] } })
  assert.ok((await jobs.retryOccurrence('c1', J1, O1)).success)
  assert.ok((await jobs.reconcileOccurrence('c1', J1, O1, 'acb-0123', false)).success)
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body]), [
    ['POST', `/jobs/${J1}/occurrences/${O1}/retry`, undefined],
    ['POST', `/jobs/${J1}/occurrences/${O1}/operations/acb-0123/reconcile`, JSON.stringify({ done: false })],
  ])
  for (const [jobId, occ, key, done] of [[J1, '../x', 'acb-1', true], [J1, O1, '../x', true], [J1, O1, 'acb-1', 'yes'], ['job/../x', O1, 'acb-1', true]] as const) {
    assert.equal((await jobs.reconcileOccurrence('c1', jobId, occ, key, done)).success, false)
  }
  assert.equal((await jobs.retryOccurrence('c1', J1, 'occ.../x')).success, false)
  assert.equal(calls.length, 2)
})
