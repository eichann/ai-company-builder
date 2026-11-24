/**
 * What this console announces is what its form can show, edit and accept (stage 4b-0.5, owner memo 「段4b 設計メモ」 §5-1,
 * jobs.md "Shapes this build does not know"): `ADMIN_JOB_SCHEMAS`, never the shared parser's `JOB_SCHEMAS`. The shared
 * core is stood in here by one that already reads a later shape (`schema: 6`; it stood in as `schema: 3` until this console
 * announced 3 with its form, stage 4b-3, as `schema: 4` until it announced 4 with member proposals, PR B, and as `schema: 5` until the
 * core read the set watch, 4b-4 PR1): this console must still announce only its own shapes and refuse to build a form
 * from the later one.
 *
 * Guards (each mutation-checked): the header from `ADMIN_JOB_SCHEMAS`; `editableDefinition` / `needsNewerScreen` asking
 * this console's list as well as the core; every announced schema round-trips through the form.
 */
import { describe, expect, it, vi } from 'vitest'

// A core of a later build: it reads schema 6 too.
vi.mock('../../shared/core/jobs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared/core/jobs')>()
  return {
    ...real,
    JOB_SCHEMAS: [1, 2, 3, 4, 5, 6],
    knownJobDefinition: (d: unknown) => (d && typeof d === 'object' && [1, 2, 3, 4, 5, 6].includes((d as { schema?: number }).schema as number) ? d : null),
  }
})

import { jobsApi } from '@/lib/api'
import { ADMIN_JOB_SCHEMAS, definitionFromForm, editableDefinition, formFromDefinition, jobEditForm, needsNewerScreen } from '@/lib/jobs'
import { canonicalJson } from '../../shared/core/fixed-content'
import { JOB_SET_WATCH_OPENED, parseJobDefinition, type JobDefinition } from '../../shared/core/jobs'
import { ok } from './fixtures'
import { mockApi } from './mock-api'

const base = {
  name: '週の報告', actingUser: 'u-alice', missed: { policy: 'latest_only', expiresAfterMinutes: 720 },
}
const NONE_GRANT = { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } }
const OPERATION = { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: 1 }
const RECORD_ROUTES = ['GET /my-turn', 'POST /query', 'GET /item/:recordId', 'GET /item/:recordId/history']
const OUTBOUND_ROUTES = ['POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId', 'PUT /outbound/:messageId']
const EVENT_TRIGGER = { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: 'task-0123456789abcdef', followMadeTask: true }

/**
 * For each schema this console announces, the definitions its form must round-trip (one per kind the form makes). A
 * schema announced without them is one this console would show and approve without being able to say what it is.
 */
const SAMPLES: Record<number, unknown[]> = {
  1: [
    { ...base, schema: 1, trigger: { every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 1 }, check: { kind: 'none' }, run: OPERATION, placement: 'e', grant: NONE_GRANT },
    {
      ...base, schema: 1, name: '面談報告書の下書き', trigger: { every: 'day', at: '08:30', businessDaysOnly: true }, check: { kind: 'new_files', path: '人事部' },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: '0'.repeat(40) } }, placement: 'a',
      grant: {
        tools: ['records', 'files_read'], creates: ['task'], routes: ['GET /my-turn', 'POST /query', 'GET /item/:recordId', 'GET /item/:recordId/history'],
        reads: { paths: ['人事部'], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
      },
    },
  ],
  2: [
    {
      ...base, schema: 2, trigger: EVENT_TRIGGER,
      check: { kind: 'none' }, run: OPERATION, placement: 'e', grant: { ...NONE_GRANT, limits: { minutes: 5, runsPerDay: 3 } },
    },
  ],
  // Stage 4b-3: an event run by the responsible person's PC AI — the smallest grant (records, its one やること), and one
  // with every choice the form offers (reads, a deliverable folder and a place outside, mail drafts; the done mark; a
  // source state the form keeps but does not offer; the wait of one day).
  3: [
    {
      ...base, schema: 3, name: '面談報告書', trigger: EVENT_TRIGGER, missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
      check: { kind: 'source_record', doneMark: 'none' },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: '0'.repeat(40) } }, placement: 'a',
      grant: { tools: ['records'], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 15, runsPerDay: 1 } },
    },
    {
      ...base, schema: 3, name: '面談報告書', trigger: { ...EVENT_TRIGGER, from: 'review', followMadeTask: false }, missed: { policy: 'latest_only', expiresAfterMinutes: 4320 },
      check: { kind: 'source_record', doneMark: 'file_linked' },
      run: { kind: 'procedure', procedure: { source: 'shelf_skill', item: 'item_interview', skill: 'interview-report', fingerprint: '0'.repeat(64) } }, placement: 'a',
      grant: {
        tools: ['records', 'files_read', 'files_write', 'outbound_draft'], creates: ['task'], routes: [...RECORD_ROUTES, ...OUTBOUND_ROUTES],
        reads: { paths: ['人事部', '人事部/面談'], calls: [] }, writes: { area: 'deliverable', place: '人事部', folder: 'interview-reports' }, outbound: 'draft_only',
        limits: { minutes: 30, runsPerDay: 5 }, deliverTo: { connector: 'google', kind: 'drive_folder', ref: null },
      },
    },
  ],
  // PR B: a member's proposal (schema 4) as the server builds it (`proposalDefinition`) — the smallest (a meeting check, no
  // title words, nothing written) and one with every choice (reads listed before the check's place, which is also among
  // them; the server-made deliverable folder; mail drafts; the record reads; a shelf Skill; a time off the 5-minute choices'
  // defaults).
  4: [
    {
      ...base, schema: 4, name: '議事録まとめ（毎週月曜 09:00）', origin: 'member_proposal', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
      check: { kind: 'new_meetings', titleWords: [] },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: '0'.repeat(40) } }, placement: 'a',
      grant: { tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 15, runsPerDay: 1 } },
    },
    {
      ...base, schema: 4, name: '週報（毎月 末日 08:30）', origin: 'member_proposal', missed: { policy: 'skip', expiresAfterMinutes: 90 },
      trigger: { every: 'month', day: 'last', at: '08:30', ifHoliday: 'after' },
      check: { kind: 'new_files', path: '営業部/議事録' },
      run: { kind: 'procedure', procedure: { source: 'shelf_skill', item: 'item_weekly', skill: 'weekly-report', fingerprint: '0'.repeat(64) } }, placement: 'a',
      grant: {
        tools: ['records', 'files_read', 'files_write', 'outbound_draft'], creates: ['task'], routes: [...RECORD_ROUTES, ...OUTBOUND_ROUTES],
        reads: { paths: ['営業部/週報', '営業部/議事録'], calls: [] }, writes: { area: 'deliverable', place: '営業部', folder: 'job-0123abcd' }, outbound: 'draft_only',
        limits: { minutes: 7, runsPerDay: 1 },
      },
    },
  ],
  // 4b-4 PR7: a set watch (schema 5) — the smallest (the opened combination, a department Skill, the minutes route and its
  // one やること only) and one with every choice (reads, Skills of its own and another department, a Japanese deliverable
  // folder, other limits and wait). The reasons and the trees are the server's (read when the version is made): stood in here.
  5: [
    {
      ...base, schema: 5, name: '提案書のたたき台', trigger: JOB_SET_WATCH_OPENED[0], missed: { policy: 'skip', expiresAfterMinutes: 1440 },
      check: { kind: 'matched_record' },
      run: { kind: 'procedure', procedure: { source: 'department_skill', place: '営業部', skill: 'proposal-auto', fingerprint: 'a'.repeat(40) } }, placement: 'a',
      grant: { tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 } },
      decision: { reasons: [{ code: 'internal', label: '社内の会議' }] },
    },
    {
      ...base, schema: 5, name: '提案書のたたき台', trigger: JOB_SET_WATCH_OPENED[0], missed: { policy: 'latest_only', expiresAfterMinutes: 4320 },
      check: { kind: 'matched_record' },
      run: { kind: 'procedure', procedure: { source: 'department_skill', place: '営業部', skill: 'proposal-auto', fingerprint: 'a'.repeat(40) } }, placement: 'a',
      grant: {
        tools: ['records', 'files_read', 'files_write'], creates: ['task'], routes: ['GET /minutes/:recordId/text'],
        reads: { paths: ['営業部/提案書', '営業部/資料'], calls: [], skills: [{ place: '営業部', skill: 'proposal', fingerprint: 'b'.repeat(40) }, { place: '経営企画', skill: 'pricing', fingerprint: 'c'.repeat(40) }] },
        writes: { area: 'deliverable', place: '営業部', folder: '提案書' }, outbound: 'none', limits: { minutes: 60, runsPerDay: 5 },
      },
      decision: { reasons: [{ code: 'internal', label: '社内の会議' }, { code: 'asked', label: '提案を求められた' }] },
    },
  ],
}

/** What the server fills when a version is made (the pinned trees, a set watch's reasons) is left out of the comparison. */
function formed(d: JobDefinition): string {
  const run = d.run.kind === 'procedure' && d.run.procedure.source === 'department_skill' ? { ...d.run, procedure: { ...d.run.procedure, fingerprint: '' } } : d.run
  const skills = d.grant.reads.skills?.map((p) => ({ ...p, fingerprint: '' }))
  const { decision: _decision, ...rest } = d
  return canonicalJson({ ...rest, run, grant: skills ? { ...d.grant, reads: { ...d.grant.reads, skills } } : d.grant })
}

describe('this console announces only the shapes its form round-trips', () => {
  it('every announced schema has its definitions, and each comes back from the form exactly as it went in', () => {
    expect(ADMIN_JOB_SCHEMAS.length).toBeGreaterThan(0)
    for (const schema of ADMIN_JOB_SCHEMAS) {
      const samples = SAMPLES[schema] ?? []
      expect(samples.length, `schema ${schema} is announced but this test has no definition of it the form round-trips`).toBeGreaterThan(0)
      for (const sample of samples) {
        const parsed = parseJobDefinition(sample)
        expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
        const d = (parsed as { definition: JobDefinition }).definition
        // A shelf Skill's name is the server's (filled when the version is made): the form sends the shelf's name for it.
        const shelfName = d.run.kind === 'procedure' && d.run.procedure.source === 'shelf_skill' ? d.run.procedure.skill : undefined
        const back = definitionFromForm(formFromDefinition(d), shelfName)
        expect(back.ok, JSON.stringify(back)).toBe(true)
        expect(formed((back as { definition: JobDefinition }).definition)).toBe(formed(d))
        // And so it is given the edit form (`jobEditForm` refuses only what would not come back).
        expect(jobEditForm(d)).not.toBeNull()
      }
    }
  })

  it('with a core that reads a later shape, the requests still announce this console’s shapes only', async () => {
    const { calls } = mockApi({ 'GET /api/companies/c1/jobs': { body: ok({ stopped: false, canManage: true, jobs: [] }) } })
    await jobsApi.list('c1')
    expect(calls.map((c) => c.headers['X-ACB-Job-Schemas'])).toEqual(['1,2,3,4,5'])
    expect(ADMIN_JOB_SCHEMAS.join(',')).toBe('1,2,3,4,5')
  })

  it('a definition of that later shape is never made into a form, whatever the core reads', () => {
    const later = { ...(SAMPLES[3][0] as object), schema: 6, trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', ai: true } } as unknown as JobDefinition
    expect(editableDefinition({ definition: later })).toBeNull()
    expect(needsNewerScreen({ definition: later })).toBe(true)
    // Its own shapes still are.
    const own = parseJobDefinition(SAMPLES[3][0]) as { definition: JobDefinition }
    expect(editableDefinition({ definition: own.definition })).toEqual(own.definition)
    expect(needsNewerScreen({ definition: own.definition })).toBe(false)
  })
})
