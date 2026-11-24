// What this app announces is what its 「定期の仕事」 can show and accept (stage 4b-0.5, owner memo 「段4b 設計メモ」 §5-1,
// jobs.md "Shapes this build does not know"): `APP_JOB_SCHEMAS`, never the shared parser's `JOB_SCHEMAS`. Each announced
// schema has definitions whose acceptance words the screen can say; a definition of another shape (a server that
// ignored the header) is shown as one this app cannot show — the server refuses its 受け取る too.
//
// Guards (each mutation-checked): the header from `APP_JOB_SCHEMAS`; the 受け取る's definition only of an announced
// shape; every announced schema has its words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsApi } from '../electron/features/jobs/ipc'
import { APP_JOB_SCHEMAS, appReadsJobDefinition } from '../shared/jobs'
import { jobCheckText, jobGrantLines, jobMissedText, jobPlacementText, jobRunText, jobTriggerText } from '../../shared/core/job-words'
import { JOB_SET_WATCH_OPENED, parseJobDefinition, type JobDefinition } from '../../shared/core/jobs'
import { proposalDefinition, setWatchProposalDefinition } from '../../shared/core/job-proposals'

const J1 = 'job.' + '1'.repeat(32)
const FP = 'sha256:' + 'a'.repeat(64)
const NONE_GRANT = { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } }
const OPERATION = { kind: 'operation', operation: 'create_task', title: '日報', dueBusinessDays: null }
const base = { name: 'x', actingUser: 'me', missed: { policy: 'skip', expiresAfterMinutes: 60 }, check: { kind: 'none' }, run: OPERATION, placement: 'e', grant: NONE_GRANT }

/** For each schema this app announces, definitions its 受け取る shows. One announced without them fails. */
const SAMPLES: Record<number, unknown[]> = {
  1: [{ ...base, schema: 1, trigger: { every: 'day', at: '09:00', businessDaysOnly: true } }],
  2: [{ ...base, schema: 2, trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: 'task-0123456789abcdef', followMadeTask: true } }],
  // Stage 4b-2: an event run by the responsible person's PC AI (the done mark both ways).
  3: ['none', 'file_linked'].map(doneMark => ({
    ...base, schema: 3, placement: 'a', check: { kind: 'source_record', doneMark },
    trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: 'task-0123456789abcdef', followMadeTask: true },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: 'b'.repeat(40) } },
    grant: { ...NONE_GRANT, tools: ['records'], routes: ['GET /item/:recordId'], limits: { minutes: 30, runsPerDay: 3 } },
  })),
  // Member proposals (PR C): a proposal as the server builds it — the smallest and one with every choice, a shelf Skill.
  4: [
    proposalDefinition(
      { skill: 'minutes-summary', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 }, check: { kind: 'new_meetings' }, reads: [], deliverable: null, readRecords: false, mailDrafts: false, minutes: 15, missed: { policy: 'skip', expiresAfterMinutes: 60 } },
      { actingUser: 'me', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: 'b'.repeat(40) }, skillName: 'minutes-summary', candidateId: 'jc.' + 'c'.repeat(32) },
    ),
    proposalDefinition(
      { skill: 'item1', trigger: { every: 'month', day: 'last', at: '17:30', ifHoliday: 'before' }, check: { kind: 'new_files', path: '営業/議事録' }, reads: ['営業/資料'], deliverable: '営業/週報', readRecords: true, mailDrafts: true, minutes: 30, missed: { policy: 'latest_only', expiresAfterMinutes: 1440 } },
      { actingUser: 'me', procedure: { source: 'shelf_skill', item: 'item1', skill: 'weekly-report', fingerprint: 'd'.repeat(64) }, skillName: 'weekly-report', candidateId: 'jc.' + 'e'.repeat(32) },
    ),
  ],
  // The set watch (4b-4 PR5 runs it, PR6b adds it from the app): as the server builds a member's, without and with Skills read.
  5: [[], [{ place: '法人ソリューション', skill: 'sales-proposal-v1' }]].map(readSkills => {
    const d = setWatchProposalDefinition({ trigger: JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0])), skill: { place: '法人ソリューション', skill: 'sales-proposal-auto' }, readSkills }, 'me')
    return { ...d, decision: { reasons: [{ code: 'requested', label: '提案を求められた' }] } }
  }),
}

test('every schema this app announces has definitions it shows in words', () => {
  assert.ok(APP_JOB_SCHEMAS.length > 0)
  for (const schema of APP_JOB_SCHEMAS) {
    const samples = SAMPLES[schema] ?? []
    assert.ok(samples.length > 0, `schema ${schema} is announced but has no definition this app shows`)
    for (const sample of samples) {
      const parsed = parseJobDefinition(sample)
      assert.ok(parsed.ok, JSON.stringify(parsed))
      const d = appReadsJobDefinition((parsed as { definition: JobDefinition }).definition)
      assert.ok(d, `schema ${schema} is announced but not shown`)
      // What JobsSection says before 受け取る: none of it may be empty.
      for (const line of [jobTriggerText(d.trigger), jobRunText(d.run), jobPlacementText(d.placement), jobMissedText(d.missed, d.trigger), ...jobGrantLines(d.grant, d.trigger)]) {
        assert.ok(typeof line === 'string' && line.length > 0)
      }
      assert.ok(jobCheckText(d.check) === null || jobCheckText(d.check)!.length > 0)
    }
  }
})

function api(definition: unknown, headers: Array<Record<string, string>> = []) {
  const job = {
    id: J1, name: 'x', state: 'active', actingUserId: 'me', latestVersion: 1, approvedVersion: 1, accepted: false, pausedReason: null, waiting: 'NOT_ACCEPTED',
    trigger: null, placement: 'e', nextSlot: null, approved: { responsibleUserId: 'me', name: 'x' }, you: { named: true, controls: true, mustAccept: true },
    versions: [{ version: 1, fingerprint: FP, consentFingerprint: FP, definition }],
  }
  const fetch = (async (url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>)
    const path = url.replace('https://acb.example/api', '')
    const data = path === '/companies/c1/jobs' ? { stopped: false, canManage: false, jobs: [job] } : job
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } })
}

test('a definition of a shape this app does not announce is shown as one it cannot show, also when the server sends it', async () => {
  const later = { ...(SAMPLES[2][0] as object), schema: 6, trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', ai: true } }
  const r = await api(later).mine('c1')
  assert.ok(r.success)
  assert.equal(r.jobs[0].toAccept?.definition, null)
  // Its own shapes still are.
  const own = (parseJobDefinition(SAMPLES[2][0]) as { definition: JobDefinition }).definition
  const shown = await api(own).mine('c1')
  assert.ok(shown.success)
  assert.deepEqual(shown.jobs[0].toAccept?.definition, own)
  // A shape the core reads but this app no longer announces (as when a later core reads more than this app shows): hidden.
  const list = APP_JOB_SCHEMAS as number[]
  const at = list.indexOf(2)
  list.splice(at, 1)
  try {
    assert.equal(appReadsJobDefinition(own), null)
    const hidden = await api(own).mine('c1')
    assert.ok(hidden.success)
    assert.equal(hidden.jobs[0].toAccept?.definition, null)
  } finally {
    list.splice(at, 0, 2)
  }
})

test('every job call announces exactly this app’s shapes (whatever the shared parser reads)', async () => {
  const headers: Array<Record<string, string>> = []
  await api(null, headers).mine('c1')
  assert.ok(headers.length > 0 && headers.every(h => h['X-ACB-Job-Schemas'] === '1,2,3,4,5'))
  // Taken from this app's own list, not the core's: a schema added to the list (as a later app will) is what is sent.
  const list = APP_JOB_SCHEMAS as number[]
  list.push(9)
  try {
    const later: Array<Record<string, string>> = []
    await api(null, later).mine('c1')
    assert.ok(later.every(h => h['X-ACB-Job-Schemas'] === '1,2,3,4,5,9'))
  } finally {
    list.pop()
  }
})
