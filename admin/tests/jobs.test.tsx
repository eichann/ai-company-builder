// 「定期の仕事」 (jobs.md "The screens", PR 4): the form makes only the server's operation (no AI powers)
// through the shared parser; editing a name or a time keeps what the responsible person accepted; approval
// sends the version shown and says whether they must accept again — and never accepts with the same press, also for
// one's own job (its 受け取る is a press of its own); the company-wide stop asks first;
// occurrences are told in plain words; anyone but owners / admins is not offered the page.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import JobsRoute from '@/app/companies/[id]/jobs/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import { approvedText } from '@/components/jobs/job-dialogs'
import { retryConfirmText } from '@/components/jobs/job-occurrences'
import type { JobView } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { JOB_REFUSED_GENERAL, describeJobError } from '@/lib/errors'
import {
  DELIVERY_PLACE_CHOICES, JOB_FORM_CANNOT_EDIT, JOB_VERSION_HIDDEN, jobEditForm, definitionFromForm, editableDefinition, emptyJobForm, formFromDefinition, hiddenVersion, jobProblemText, needsNewerScreen,
  switchJobForm,
} from '@/lib/jobs'
import { JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES, jobConsentCanonical, type JobDefinition } from '../../shared/core/jobs'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123/jobs',
  useSearchParams: () => new URLSearchParams(),
}))

const JOB_ID = 'job.0123456789abcdef0123456789abcdef'

const def = (over: Partial<JobDefinition> = {}): JobDefinition => ({
  schema: 1, name: '週の報告', actingUser: 'u_member',
  trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
  check: { kind: 'none' },
  run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: 1 },
  placement: 'e',
  missed: { policy: 'latest_only', expiresAfterMinutes: 720 },
  grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 10, runsPerDay: 2 } },
  ...over,
})

const version = (n: number, d: JobDefinition, consent: string) => ({
  version: n, fingerprint: `sha256:v${n}`, consentFingerprint: consent, definition: d, createdBy: 'u_owner', createdAt: '2026-11-11T00:00:00.000Z',
  approvedBy: null, approvedAt: null, acceptedBy: null, acceptedAt: null,
})

const jobView = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID, name: '週の報告', state: 'active', actingUserId: 'u_member', latestVersion: 1, approvedVersion: 1, accepted: true,
  pausedReason: null, waiting: null, createdBy: 'u_owner', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
  trigger: def().trigger, placement: 'e', nextSlot: '2026-11-16T09:00', lastOccurrence: { dueSlot: '2026-11-09T09:00', state: 'done', outcomeCode: null },
  ...over,
})

describe('the form', () => {
  it('makes the server\'s operation only — a やること for the responsible person, no AI powers — and the shared parser accepts it', () => {
    const form = { ...emptyJobForm('u_member'), name: ' 週の報告 ', taskTitle: '週の報告を書く' }
    const parsed = definitionFromForm(form)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition).toMatchObject({ name: '週の報告', placement: 'e', check: { kind: 'none' }, run: { kind: 'operation', operation: 'create_task' } })
    expect(parsed.definition.grant).toMatchObject({ tools: [], routes: [], reads: { paths: [] }, writes: { area: 'none' }, outbound: 'none', creates: ['task'] })
    // An empty name is the parser's problem, not sent.
    expect(definitionFromForm({ ...form, name: '' }).ok).toBe(false)
  })

  it('editing a name or a time keeps what the responsible person accepted (no new acceptance)', () => {
    const before = def()
    const form = formFromDefinition(before)!
    const parsed = definitionFromForm({ ...form, name: '週の報告（改）', hour: '10', minute: '30' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition.trigger).toMatchObject({ at: '10:30' })
    expect(jobConsentCanonical(parsed.definition)).toBe(jobConsentCanonical(before))
  })

  it('a PC job: a Skill, a check before the AI, and a grant from plain choices — the shared parser accepts it, and it reads back the same', () => {
    const form = {
      ...emptyJobForm('u_member'), name: '面談の報告', kind: 'pc' as const, skillName: 'interview-report',
      checkKind: 'new_files' as const, checkPath: '人事部/面談', readPaths: '人事部/規程', readRecords: false, mailDrafts: true,
      writePlace: '人事部', writeFolder: 'reports', limits: { minutes: 15, runsPerDay: 1 },
    }
    const parsed = definitionFromForm(form)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition).toMatchObject({
      placement: 'a', check: { kind: 'new_files', path: '人事部/面談' },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report' } },
    })
    expect(parsed.definition.grant).toEqual({
      tools: ['records', 'files_read', 'files_write', 'outbound_draft'], creates: ['task'],
      routes: ['POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId', 'PUT /outbound/:messageId'],
      reads: { paths: ['人事部/面談', '人事部/規程'], calls: [] }, writes: { area: 'deliverable', place: '人事部', folder: 'reports' },
      outbound: 'draft_only', limits: { minutes: 15, runsPerDay: 1 },
    })
    expect(formFromDefinition(parsed.definition)).toMatchObject({ kind: 'pc', skillName: 'interview-report', checkPath: '人事部/面談', readPaths: '人事部/規程', mailDrafts: true, writeFolder: 'reports' })
  })

  it('editing a PC job keeps its read places in their order (a check place listed last stays last), new places after them', () => {
    // A schema-1 PC job made through the API with its check's place after another read place: the form puts the check's
    // place first, so without the kept order a name-only edit would change what the responsible person accepted.
    const parsed = definitionFromForm({
      ...emptyJobForm('u_member'), name: '面談の報告', kind: 'pc', skillName: 'interview-report', checkKind: 'new_files', checkPath: '人事部/面談', readPaths: '人事部/規程',
    })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
    const api: JobDefinition = { ...parsed.definition, grant: { ...parsed.definition.grant, reads: { paths: ['人事部/規程', '人事部/面談'], calls: [] } } }
    const renamed = definitionFromForm({ ...formFromDefinition(api), name: '面談の報告（改）' })
    expect(renamed.ok && renamed.definition.grant.reads.paths).toEqual(['人事部/規程', '人事部/面談'])
    expect(renamed.ok && jobConsentCanonical(renamed.definition)).toBe(jobConsentCanonical(api))
    // A place added goes after the kept ones; a place removed is gone.
    const more = definitionFromForm({ ...formFromDefinition(api), readPaths: '人事部/規程\n人事部/新しい場所' })
    expect(more.ok && more.definition.grant.reads.paths).toEqual(['人事部/規程', '人事部/面談', '人事部/新しい場所'])
    const fewer = definitionFromForm({ ...formFromDefinition(api), readPaths: '' })
    expect(fewer.ok && fewer.definition.grant.reads.paths).toEqual(['人事部/面談'])
  })

  it('a meeting check names the minutes route in the grant (what the responsible person accepts), never the check alone', () => {
    const parsed = definitionFromForm({ ...emptyJobForm('u_member'), name: '面談', kind: 'pc', shelfItem: 'item-1', checkKind: 'new_meetings', titleWords: '面談、1on1' }, 'interview-report')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition.check).toEqual({ kind: 'new_meetings', titleWords: ['面談', '1on1'] })
    expect(parsed.definition.run).toMatchObject({ procedure: { source: 'shelf_skill', item: 'item-1', skill: 'interview-report' } })
    expect(parsed.definition.grant.routes).toContain('GET /minutes/:recordId/text')
    // No Skill chosen: the parser's problem, said plainly.
    expect(definitionFromForm({ ...emptyJobForm('u_member'), name: 'x', kind: 'pc', checkKind: 'new_meetings' }).ok).toBe(false)
  })

  it('a place outside (connector + kind, never a service\'s own field): the folder is left to the responsible person; it needs the deliverable folder', () => {
    expect(DELIVERY_PLACE_CHOICES.map(c => [c.value, c.label])).toEqual([['google:drive_folder', 'Google Drive のフォルダ']])
    const form = { ...emptyJobForm('u_member'), name: '面談報告書', kind: 'pc' as const, shelfItem: 'item-1', checkKind: 'new_meetings' as const, writePlace: '人事部', writeFolder: 'reports', deliverTo: 'google:drive_folder' }
    const parsed = definitionFromForm(form, 'interview-report')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition.grant.deliverTo).toEqual({ connector: 'google', kind: 'drive_folder', ref: null })
    expect(formFromDefinition(parsed.definition).deliverTo).toBe('google:drive_folder')
    // Without a deliverable folder there is nothing to put: said plainly.
    const without = definitionFromForm({ ...form, writeFolder: '' }, 'interview-report')
    expect(without.ok).toBe(false)
    if (!without.ok) expect(jobProblemText(without.problems)).toMatch(/作ったファイルの置き場所/)
    // None chosen: no key at all (the definition is what it always was).
    const plain = definitionFromForm({ ...form, deliverTo: '' }, 'interview-report')
    expect(plain.ok && 'deliverTo' in plain.definition.grant).toBe(false)
  })
})

describe('the page', () => {
  it('creates a job: the definition the form made is what is sent', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/jobs`]: { status: 201, body: ok(jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED' })) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名前' }), '週の報告')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '責任者' }), 'u_member')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '作るやること' }), '週の報告を書く')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1))
    const sent = (calls.find((c) => c.method === 'POST')!.body as { definition: JobDefinition }).definition
    expect(sent).toMatchObject({ name: '週の報告', actingUser: 'u_member', placement: 'e', run: { title: '週の報告を書く' } })
    expect(sent.grant.tools).toEqual([])
  })

  it('approval shows the version, sends its fingerprint, and says the responsible person must accept', async () => {
    const pending = jobView({ latestVersion: 2, approvedVersion: 1, accepted: true })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: {
        body: ok({ ...pending, versions: [version(2, def({ grant: { ...def().grant, limits: { minutes: 20, runsPerDay: 2 } } }), 'c2'), version(1, def(), 'c1')] }),
      },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...pending, approvedVersion: 2, accepted: false, waiting: 'NOT_ACCEPTED' }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(within(row).getByText(/新しい版（第2版）が承認待ちです/)).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('毎週月曜 09:00')).toBeInTheDocument()
    expect(within(dialog).getByRole('note')).toHaveTextContent('田中 太郎さんが内容を確かめて「受け取る」を押すまで動きません')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ version: 2, fingerprint: 'sha256:v2' }]))
    // Not their own job: the approver does not accept for the responsible person.
    expect(calls.some((c) => c.url.includes('/me/jobs/'))).toBe(false)
  })

  it('approving one\'s own job is not accepting it: 承認する sends the approval only; 受け取る is a press of its own', async () => {
    const mine = jobView({ actingUserId: 'u_owner', approvedVersion: null, accepted: false, state: 'draft', waiting: 'NOT_APPROVED' })
    const approvedMine = { ...mine, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', you: { named: true, controls: true, mustAccept: true } }
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [mine] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...mine, versions: [version(1, def({ actingUser: 'u_owner' }), 'c1')] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok(approvedMine) },
      [`POST ${base}/me/jobs/${JOB_ID}/accept`]: { body: ok({ ...approvedMine, accepted: true, waiting: null, you: { named: true, controls: true, mustAccept: false } }) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: '週の報告' })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('note')).toHaveTextContent('あなたの権限で動かすことへの同意（「受け取る」）は、承認とは別に押します')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The approval only: nothing is accepted with the same press.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(base, ''))).toEqual([`/jobs/${JOB_ID}/approve`])
    // The list says it waits for their own 受け取る and offers it as its own button.
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(within(row).getByRole('status')).toHaveTextContent('「責任者として受け取る」を押すまで動きません')
    await userEvent.click(within(row).getByRole('button', { name: '責任者として受け取る' }))
    const accepting = await screen.findByRole('dialog')
    expect(within(accepting).getByText('責任者として、この仕事をあなたの権限で動かすことに同意します。承認とは別の操作です。')).toBeInTheDocument()
    expect(await within(accepting).findByRole('note')).toHaveTextContent('あなたの名前と権限で動きます')
    await userEvent.click(within(accepting).getByRole('button', { name: '受け取る' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url.replace(base, ''), c.body])).toEqual([
      [`/jobs/${JOB_ID}/approve`, { version: 1, fingerprint: 'sha256:v1' }],
      [`/me/jobs/${JOB_ID}/accept`, { version: 1, fingerprint: 'sha256:v1' }],
    ]))
    // Said to the server as a press of its own (it refuses the approver's acceptance without it).
    expect(calls.find((c) => c.url.includes('/accept'))!.headers['X-ACB-Job-Accept']).toBe('separate')
    expect(calls.find((c) => c.url.endsWith('/approve'))!.headers['X-ACB-Job-Accept']).toBeUndefined()
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: '週の報告' })).queryByRole('button', { name: '責任者として受け取る' })).not.toBeInTheDocument())
  })

  it('one\'s own job that puts into a place outside: approved only — the place is chosen in one\'s app when accepting', async () => {
    const placed = def({
      actingUser: 'u_owner', placement: 'a', check: { kind: 'new_meetings', titleWords: [] },
      run: { kind: 'procedure', procedure: { source: 'shelf_skill', item: 'item-1', skill: 'interview-report', fingerprint: 'f'.repeat(64) } },
      grant: {
        tools: ['records', 'files_write'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] },
        writes: { area: 'deliverable', place: '人事部', folder: 'reports' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
        deliverTo: { connector: 'google', kind: 'drive_folder', ref: null },
      },
    })
    const mine = jobView({ actingUserId: 'u_owner', approvedVersion: null, accepted: false, state: 'draft', waiting: 'NOT_APPROVED', placement: 'a' })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [mine] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...mine, versions: [version(1, placed, 'c1')] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: {
        body: ok({
          ...mine, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', you: { named: true, controls: true, mustAccept: true },
          deliverTo: { connector: 'google', kind: 'drive_folder', label: 'Google Drive のフォルダ', chosen: false, usable: false, name: null, expiresAt: null },
        }),
      },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: '週の報告' })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('note')).toHaveTextContent('アプリの「設定」→「仕事」→「定期の仕事」で選んで受け取って')
    expect(dialog).toHaveTextContent('Google Drive のフォルダ')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(base, ''))).toEqual([`/jobs/${JOB_ID}/approve`]))
    expect(calls.some((c) => c.url.includes('/me/jobs/'))).toBe(false)
    // Accepted in the app (where the place is chosen): the list says so and offers no 受け取る here.
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('アプリの「設定」→「仕事」→「定期の仕事」で置き先を選んで受け取るまで動きません'))
    expect(within(row).queryByRole('button', { name: '責任者として受け取る' })).not.toBeInTheDocument()
  })

  it('back to the accepted consent (v1 A accepted, v2 B not accepted, v3 A): the server\'s answer decides — no new acceptance asked', async () => {
    // v2 (consent B) is approved and not accepted; v3 is consent A again, which the responsible person accepted.
    const pending = jobView({ latestVersion: 3, approvedVersion: 2, accepted: false, waiting: 'NOT_ACCEPTED', latestConsentAccepted: true })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...pending, versions: [version(3, def({ name: '週の報告（3）' }), 'cA'), version(2, def(), 'cB'), version(1, def(), 'cA')] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...pending, approvedVersion: 3, accepted: true, waiting: null }) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: '週の報告' })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('note')).toHaveTextContent('すでに受け取っています')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ version: 3, fingerprint: 'sha256:v3' }]))
    expect(calls.some((c) => c.url.includes('/me/jobs/'))).toBe(false)
  })

  it('what the approval says is what the server answered will happen', () => {
    const after = (over: Record<string, unknown>) => jobView(over) as unknown as JobView
    expect(approvedText(3, after({ waiting: null }), '田中 太郎')).toBe('第3版を承認しました。いまは「動いています」です')
    expect(approvedText(3, after({ waiting: 'NOT_ACCEPTED' }), '田中 太郎')).toBe('第3版を承認しました。田中 太郎さんの受け取りを待ちます')
    expect(approvedText(3, after({ waiting: 'PAUSED', state: 'paused', pausedReason: 'ADMIN' }), '田中 太郎')).toBe('第3版を承認しました。いまは「管理者が止めました」です')
    expect(approvedText(3, after({ waiting: null, placement: 'a' }), '田中 太郎')).toContain('責任者のアプリが開いていて')
    // The approver is the responsible person: it waits for their own 受け取る, said as such.
    expect(approvedText(3, after({ waiting: 'NOT_ACCEPTED' }), null)).toBe('第3版を承認しました。まだ動きません。あなたが「受け取る」を押すと動き始めます')
  })

  it('the list names who it runs as now (the approved version\'s person) and the next version\'s person apart; a PC job says it needs the app', async () => {
    const handed = jobView({ actingUserId: 'u_member', latestVersion: 2, approved: { responsibleUserId: 'u_admin', name: '週の報告' } })
    const pc = jobView({ id: 'job.' + 'f'.repeat(32), name: 'PC の仕事', placement: 'a' })
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [handed, pc] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('責任者：鈴木 一郎')
    expect(row).toHaveTextContent('次の版では責任者が田中 太郎さんになります（未承認）')
    const pcRow = screen.getByRole('listitem', { name: 'PC の仕事' })
    expect(pcRow).toHaveTextContent('責任者のアプリが開いていて「自動で進める」が入っているときに動きます')
    expect(pcRow).toHaveTextContent('PC で動きます')
  })

  it('the company-wide stop asks first, then stops', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView()] }) },
      [`PUT ${base}/jobs-stop`]: { body: ok({ stopped: true }) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: 'すべて止める' }))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'すべて止める' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ stopped: true }]))
  })

  it('a paused job says why, and its occurrences are told in plain words', async () => {
    const paused = jobView({ state: 'paused', pausedReason: 'OWNER_LEFT', waiting: 'PAUSED' })
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [paused] }) },
      [`GET ${base}/jobs/${JOB_ID}/occurrences`]: {
        body: ok({ occurrences: [
          { id: 'occ.1', jobVersion: 1, dueSlot: '2026-11-09T09:00', timeZone: 'Asia/Tokyo', dueAt: '', expiresAt: '', state: 'skipped', outcomeCode: 'OWNER_ABSENT', ran: false, updatedAt: '' },
          { id: 'occ.2', jobVersion: 1, dueSlot: '2026-11-02T09:00', timeZone: 'Asia/Tokyo', dueAt: '', expiresAt: '', state: 'done', outcomeCode: null, ran: true, updatedAt: '' },
        ] }),
      },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(within(row).getByText('責任者が会社を離れたため止まりました。新しい責任者を決めてください')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '再開する' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '回の記録' }))
    const history = await within(row).findByRole('list', { name: '回の記録' })
    expect(history).toHaveTextContent('11月9日 09:00見送りました責任者が不在の日だったため見送りました（代わりの人は動かしません）')
    expect(history).toHaveTextContent('11月2日 09:00できました')
  })

  it('anyone but owners and admins is not offered the page and nothing is read', async () => {
    const { calls } = mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<JobsRoute />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます。')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/jobs'))).toBe(false)
    const item = NAV_ITEMS.find((i) => i.segment === 'jobs')!
    expect(item.visible!({ isAdmin: false, isManager: true, canViewAgentEvents: false })).toBe(false)
    expect(item.visible!({ isAdmin: true, isManager: false, canViewAgentEvents: true })).toBe(true)
  })
})

describe('「もう一度」 (B PR 5b)', () => {
  const occ = (id: string, over: Record<string, unknown>) => ({
    id, jobVersion: 1, dueSlot: '2026-11-12T09:00', timeZone: 'Asia/Tokyo', dueAt: '', expiresAt: '', state: 'needs_person', outcomeCode: 'RUN_FAILED',
    ran: false, updatedAt: '', retries: 0, retriedBy: null, retriedAt: null, ...over,
  })

  it('offered only where the server allows it, asked first, then sent for that occurrence; elsewhere why not, in plain words', async () => {
    const OK = 'occ.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ placement: 'a' })] }) },
      [`GET ${base}/jobs/${JOB_ID}/occurrences`]: {
        body: ok({ occurrences: [
          occ(OK, { retry: { allowed: true }, unknownOperations: [], retries: 1, retriedBy: 'u_admin', retriedAt: '2026-11-12T01:00:00.000Z', madeBefore: [{ kind: 'mail-draft', count: 1 }] }),
          occ('occ.b', { dueSlot: '2026-11-11T09:00', state: 'expired', outcomeCode: 'EXPIRED', retry: { allowed: false, why: 'NOT_LATEST' }, unknownOperations: [] }),
          occ('occ.c', { dueSlot: '2026-11-10T09:00', state: 'done', outcomeCode: null, ran: true }),
        ] }),
      },
      [`POST ${base}/jobs/${JOB_ID}/occurrences/${OK}/retry`]: { body: ok({ occurrence: occ(OK, { state: 'due', outcomeCode: null }) }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '回の記録' }))
    const history = await within(row).findByRole('list', { name: '回の記録' })
    const allowed = within(history).getByRole('listitem', { name: '11月12日 09:00の回' })
    expect(allowed).toHaveTextContent('鈴木 一郎さんが「もう一度」を押しました')
    expect(within(within(history).getByRole('listitem', { name: '11月11日 09:00の回' })).queryByRole('button', { name: 'もう一度' })).toBeNull()
    expect(history).toHaveTextContent('「もう一度」はできません：このあとの回がもう来ているため、この回は「もう一度」できません')
    expect(within(within(history).getByRole('listitem', { name: '11月10日 09:00の回' })).queryByText(/もう一度/)).toBeNull()

    await userEvent.click(within(allowed).getByRole('button', { name: 'もう一度' }))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('責任者のアプリが開いていて「自動で進める」が入っているとき')
    // What the earlier run already made is said first: pressing may make it again.
    expect(dialog).toHaveTextContent('前回すでにメールの下書きを1件作っています。もう一度すると、また作られることがあります。')
    await userEvent.click(within(dialog).getByRole('button', { name: 'もう一度' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => decodeURIComponent(c.url))).toEqual([`${base}/jobs/${JOB_ID}/occurrences/${OK}/retry`]))
  })

  it('an outside result nobody knows: the responsible person’s answer is sent first (作られていた／作られていなかった)', async () => {
    const OCC = 'occ.dddddddddddddddddddddddddddddddd'
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ placement: 'a' })] }) },
      [`GET ${base}/jobs/${JOB_ID}/occurrences`]: {
        body: ok({ occurrences: [occ(OCC, { outcomeCode: 'RESULT_UNKNOWN', retry: { allowed: false, why: 'JOB_RESULT_UNKNOWN' }, unknownOperations: [{ key: 'draft-1', kind: 'mail-draft' }] })] }),
      },
      [`POST ${base}/jobs/${JOB_ID}/occurrences/${OCC}/operations/draft-1/reconcile`]: { body: ok({ occurrenceId: OCC }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '回の記録' }))
    const history = await within(row).findByRole('list', { name: '回の記録' })
    expect(history).toHaveTextContent('メールの下書きが作られたか分かりません')
    expect(within(history).queryByRole('button', { name: 'もう一度' })).toBeNull()
    await userEvent.click(within(history).getByRole('button', { name: '作られていなかった' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'はい' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ done: false }]))
  })
})

// Stage 4-0 (jobs.md "Shapes this build does not know"): a job of a newer definition shape (event-triggered jobs, 4a)
// never crashes this console, is never edited or approved from it, and the console says what to do.
describe('a definition of a shape this console does not read', () => {
  const event = { ...def(), schema: 4, trigger: { kind: 'future', when: 'something' } } as unknown as JobDefinition

  it('every job request says which shapes this console reads', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView()] }) },
    })
    renderInCompany(<JobsRoute />)
    await screen.findByRole('listitem', { name: '週の報告' })
    const job = calls.find((c) => c.url.endsWith('/jobs'))!
    expect(job.headers['X-ACB-Job-Schemas']).toBe('1,2,3,4')
  })

  it('the list says 「画面を新しくしてください」 instead of a time, offers no edit, and a trigger of an unknown shape never crashes it', async () => {
    const newer = jobView({ trigger: undefined, placement: undefined, needsUpdate: true })
    const odd = jobView({ id: 'job.' + 'e'.repeat(32), name: '変わった仕事', trigger: event.trigger })
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [newer, odd] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('この画面では編集できません。画面を新しくしてください')
    expect(within(row).getByRole('button', { name: '直す' })).toBeDisabled()
    const oddRow = screen.getByRole('listitem', { name: '変わった仕事' })
    expect(oddRow).not.toHaveTextContent('いつ：')
  })

  it('the approval shows the sentence and approves nothing', async () => {
    const pending = jobView({ latestVersion: 2, approvedVersion: 1 })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...pending, versions: [{ ...version(2, def(), 'c2'), definition: null, needsUpdate: true }, version(1, def(), 'c1')] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('この画面では編集できません。画面を新しくしてください')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '承認する' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('editing a job whose newest version is of an unknown shape: the sentence, never an empty form that would write over it', async () => {
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView()] }) },
      // A newer server that sent the definition anyway: this console still does not read it.
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...jobView(), versions: [version(1, event, 'c1')] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('この画面では編集できません。画面を新しくしてください')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('editableDefinition: a known shape as it came; a newer one, or one the server marked, never', () => {
    expect(editableDefinition({ definition: def() })).toEqual(def())
    expect(editableDefinition({ definition: event })).toBeNull()
    expect(editableDefinition({ definition: def(), needsUpdate: true })).toBeNull()
    // A definition hidden from a non-admin is not "too new".
    expect(needsNewerScreen({ definition: null })).toBe(false)
    expect(needsNewerScreen({ definition: event })).toBe(true)
  })
})

// Stage 4a (jobs.md "Event-triggered jobs"): an event job watches one やること of the responsible person.
describe('an event job', () => {
  const START = 'task-0123456789abcdef'
  const eventDef = (over: Record<string, unknown> = {}): JobDefinition => ({
    ...def(), schema: 2,
    trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: START, followMadeTask: true, ...over },
  }) as JobDefinition

  it('the form makes schema 2 with the watched やること and reads back the same; without one it says so plainly', () => {
    const form = { ...emptyJobForm('u_member'), name: '次のやること', taskTitle: '次を書く', when: 'event' as const, startRecord: START, limits: { minutes: 5, runsPerDay: 3 } }
    const parsed = definitionFromForm(form)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition).toMatchObject({ schema: 2, placement: 'e', trigger: eventDef().trigger, grant: { limits: { runsPerDay: 3 } } })
    expect(formFromDefinition(parsed.definition)).toMatchObject({ when: 'event', startRecord: START, eventTo: 'done', followMadeTask: true, taskTitle: '次を書く' })
    const none = definitionFromForm({ ...form, startRecord: '' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(jobProblemText(none.problems)).toMatch(/見張るやることを1つ選んでください/)
    // The server's operation: never a check or an AI power (the PC's AI is schema 3, below).
    expect(parsed.definition.check).toEqual({ kind: 'none' })
  })

  it('editing keeps a source state the form does not offer: a name change never widens what it watches (Codex review)', () => {
    const before = eventDef({ from: 'review' })
    const again = definitionFromForm({ ...formFromDefinition(before), name: '名前だけ変える' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.definition.trigger).toEqual(before.trigger)
    expect(jobConsentCanonical(again.definition)).toBe(jobConsentCanonical(before))
  })

  it('creating one: the responsible person\'s open やること are offered (the server\'s reader), and what is sent watches the one chosen', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/records/query`]: { body: ok({ total: 1, records: [{ id: START, type: 'task', title: '提案書を出す' }] }) },
      [`POST ${base}/jobs`]: { status: 201, body: ok(jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED', trigger: eventDef().trigger })) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名前' }), '次のやること')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '責任者' }), 'u_member')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'いつ動くか' }), 'event')
    await userEvent.selectOptions(await within(dialog).findByRole('combobox', { name: '見張るやること' }), await within(dialog).findByRole('option', { name: '提案書を出す' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: '作るやること' }), '次を書く')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/jobs'))).toHaveLength(1))
    const query = calls.find((c) => c.url.endsWith('/records/query'))!
    expect(query.body).toMatchObject({ type: 'task', fields: { assignee: 'u_member' }, offset: 0 })
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/jobs'))!
    expect(post.headers['X-ACB-Job-Schemas']).toBe('1,2,3,4')
    expect((post.body as { definition: JobDefinition }).definition).toMatchObject({ schema: 2, trigger: { startRecord: START, to: 'done', followMadeTask: true } })
  })

  it('the start list is searched by name and paged (never only the first 50)', async () => {
    const page = (offset: number) => Array.from({ length: 50 }, (_, i) => ({ id: `task-${String(offset + i).padStart(16, '0')}`, type: 'task', title: `やること${offset + i}` }))
    // The fixture answers the page the last query asked for (the call is kept before the answer is made).
    const holder: { calls: Array<{ body: unknown }> } = { calls: [] }
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/records/query`]: () => ({ body: ok({ total: 120, records: page((holder.calls.at(-1)!.body as { offset: number }).offset) }) }),
    })
    holder.calls = calls
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'いつ動くか' }), 'event')
    expect(await within(dialog).findByText(/120件中 1〜50件/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '次へ' }))
    expect(await within(dialog).findByRole('option', { name: 'やること50' })).toBeInTheDocument()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '見張るやることを名前で探す' }), '提案')
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/records/query')).at(-1)!.body).toMatchObject({ text: '提案', offset: 0 }))
    expect(calls.filter((c) => c.url.endsWith('/records/query')).some((c) => (c.body as { offset: number }).offset === 50)).toBe(true)
  })

  it('another responsible person\'s list starts at its first page', async () => {
    const page = (offset: number) => Array.from({ length: 50 }, (_, i) => ({ id: `task-${String(offset + i).padStart(16, '0')}`, type: 'task', title: `やること${offset + i}` }))
    const holder: { calls: Array<{ body: unknown }> } = { calls: [] }
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/records/query`]: () => ({ body: ok({ total: 120, records: page((holder.calls.at(-1)!.body as { offset: number }).offset) }) }),
    })
    holder.calls = calls
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '責任者' }), 'u_member')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'いつ動くか' }), 'event')
    await userEvent.click(await within(dialog).findByRole('button', { name: '次へ' }))
    await waitFor(() => expect((calls.filter((c) => c.url.endsWith('/records/query')).at(-1)!.body as { offset: number }).offset).toBe(50))
    await userEvent.selectOptions(await within(dialog).findByRole('combobox', { name: '見張るやること' }), 'task-0000000000000050')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '責任者' }), 'u_owner')
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/records/query')).at(-1)!.body).toMatchObject({ fields: { assignee: 'u_owner' }, offset: 0 }))
    // The previous person's やること is not kept as the choice.
    expect((within(dialog).getByRole('combobox', { name: '見張るやること' }) as HTMLSelectElement).value).toBe('')
  })

  it('a stopped chain is said on the list with the server\'s words for this viewer and what to do', async () => {
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ trigger: eventDef().trigger, nextSlot: null, chainStopped: { why: '見張っていたやることの都合で止まりました' } })] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(within(row).getByRole('status')).toHaveTextContent('見張っていたやることの都合で止まりました。止まっています。次に見張るやることを選び直してください')
  })

  it('the list and the approval say what it watches in plain words (never the record\'s title), and what it never runs for', async () => {
    const pending = jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED', trigger: eventDef().trigger, nextSlot: null, lastOccurrence: null })
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...pending, versions: [version(1, eventDef(), 'c1')] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('見張っているやること（責任者が担当）が「完了」になったとき')
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/「AI の番」が変えたとき/)).toBeInTheDocument()
    expect(dialog).toHaveTextContent('上限：1日 2回まで（超えた出来事は動かさず、責任者に知らせます）')
    expect(within(dialog).getByRole('button', { name: '承認する' })).toBeEnabled()
  })
})

// Stage 4b-3 (jobs.md "Event jobs on the PC" "The admin console"): an event run by the responsible person's PC AI
// (schema 3) is made, read back, approved and its occurrences pressed from here; a version hidden from this viewer is
// said as such; refusals are plain Japanese.
describe('an event run by the responsible person’s PC AI (schema 3)', () => {
  const START = 'task-0123456789abcdef'
  const OCC = 'occ.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const trigger = { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: START, followMadeTask: true } as const
  const pcDef = (over: Record<string, unknown> = {}): JobDefinition => ({
    ...def(), schema: 3, name: '面談報告書', trigger, check: { kind: 'source_record', doneMark: 'file_linked' },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: '0'.repeat(40) } }, placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: ['records'], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 15, runsPerDay: 1 } },
    ...over,
  }) as JobDefinition
  const pcForm = () => switchJobForm(switchJobForm({ ...emptyJobForm('u_member'), name: '面談報告書', startRecord: START, skillName: 'interview-report' }, { when: 'event' }, true), { kind: 'pc' }, true)

  it('the form makes schema 3: checked on the watched やること with the done mark chosen, its one やること granted by construction', () => {
    const parsed = definitionFromForm({ ...pcForm(), doneMark: 'file_linked' })
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition).toMatchObject({ schema: 3, placement: 'a', trigger, check: { kind: 'source_record', doneMark: 'file_linked' }, run: { kind: 'procedure' } })
    // `grant.creates.EVENT_NEEDS_TASK`: the form always grants the one やること (and `records`, which creating needs).
    expect(parsed.definition.grant).toMatchObject({ creates: ['task'], tools: ['records'] })
    expect(formFromDefinition(parsed.definition)).toMatchObject({ when: 'event', kind: 'pc', doneMark: 'file_linked', startRecord: START, skillName: 'interview-report' })
    // Without a watched やること: said plainly, nothing sent.
    const none = definitionFromForm({ ...pcForm(), startRecord: '' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(jobProblemText(none.problems)).toMatch(/見張るやることを1つ選んでください/)
  })

  it('a check left on the form from a time job grants nothing to an event run (no place, no minutes)', () => {
    for (const leftover of [{ checkKind: 'new_files' as const, checkPath: '人事部/面談' }, { checkKind: 'new_meetings' as const, titleWords: '面談' }]) {
      const parsed = definitionFromForm({ ...pcForm(), ...leftover })
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
      if (!parsed.ok) return
      expect(parsed.definition.grant.reads.paths).toEqual([])
      expect(parsed.definition.grant.routes).not.toContain('GET /minutes/:recordId/text')
      expect(parsed.definition.grant.tools).toEqual(['records'])
    }
  })

  it('a new job becoming an event run by the PC waits one day for the app by default (owner D6); editing never changes a version’s own wait', () => {
    expect(JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES).toBe(1440)
    const fresh = emptyJobForm('u_member')
    expect(fresh.expiresAfterMinutes).not.toBe(1440)
    expect(switchJobForm(switchJobForm(fresh, { when: 'event' }, true), { kind: 'pc' }, true).expiresAfterMinutes).toBe(1440)
    expect(switchJobForm(switchJobForm(fresh, { kind: 'pc' }, true), { when: 'event' }, true).expiresAfterMinutes).toBe(1440)
    // The server's event operation and a time PC job keep theirs.
    expect(switchJobForm(fresh, { when: 'event' }, true).expiresAfterMinutes).toBe(fresh.expiresAfterMinutes)
    expect(switchJobForm(fresh, { kind: 'pc' }, true).expiresAfterMinutes).toBe(fresh.expiresAfterMinutes)
    // Editing one that waits 3 days: switching すること away and back keeps it (independent review).
    const editing = formFromDefinition(pcDef({ missed: { policy: 'latest_only', expiresAfterMinutes: 4320 } }))
    const away = switchJobForm(editing, { kind: 'task' }, false)
    expect(switchJobForm(away, { kind: 'pc' }, false).expiresAfterMinutes).toBe(4320)
    expect(switchJobForm(switchJobForm(editing, { when: 'time' }, false), { when: 'event' }, false).expiresAfterMinutes).toBe(4320)
  })

  it('a schema-3 grant the form cannot say (one record route, not the four) is never given the edit form: it would widen it', async () => {
    const narrow = pcDef({ grant: { ...pcDef().grant, routes: ['GET /item/:recordId'] } })
    expect(jobEditForm(narrow)).toBeNull()
    // What the form makes is given it, also with the server's own fingerprint and a shelf Skill's name.
    expect(jobEditForm(pcDef({ run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: 'a'.repeat(40) } } }))).not.toBeNull()
    expect(jobEditForm(pcDef({ run: { kind: 'procedure', procedure: { source: 'shelf_skill', item: 'item-1', skill: 'interview-report', fingerprint: 'b'.repeat(64) } } }))).not.toBeNull()
    // Schemas 1 and 2 keep their behaviour.
    expect(jobEditForm(def({ grant: { ...def().grant, limits: { minutes: 7, runsPerDay: 2 } } }))).not.toBeNull()
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ trigger, placement: 'a', nextSlot: null })] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...jobView({ trigger, placement: 'a' }), versions: [version(1, narrow, 'c1')] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(JOB_FORM_CANNOT_EDIT)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('creating one on the page: the watched やること by name, the Skill, the done mark — schema 3 is sent, announced 1,2,3,4', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/records/query`]: { body: ok({ total: 1, records: [{ id: START, type: 'task', title: '面談の準備' }] }) },
      [`POST ${base}/jobs`]: { status: 201, body: ok(jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED', trigger, placement: 'a' })) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名前' }), '面談報告書')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '責任者' }), 'u_member')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'いつ動くか' }), 'event')
    await userEvent.selectOptions(await within(dialog).findByRole('combobox', { name: '見張るやること' }), await within(dialog).findByRole('option', { name: '面談の準備' }))
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'すること' }), 'pc')
    expect((within(dialog).getByRole('combobox', { name: '期限切れまで' }) as HTMLSelectElement).value).toBe('1440')
    // The sentence the approval and the app will say, with the name of the やること chosen from this viewer's own list.
    expect(within(dialog).getByRole('note', { name: 'きっかけの文' })).toHaveTextContent(
      '最初は「面談の準備」を見張ります。責任者の PC の AI が動くのは、見張っているやること（責任者が担当）が「完了」になったとき（そのあとは、この仕事が作ったやることを見張ります）です。')
    // No check of a time job here: the server checks the watched やること.
    expect(within(dialog).queryByRole('combobox', { name: '確かめること' })).toBeNull()
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Skill' }), 'interview-report')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '済みの印' }), 'file_linked')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/jobs'))).toHaveLength(1))
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/jobs'))!
    expect(post.headers['X-ACB-Job-Schemas']).toBe('1,2,3,4')
    expect((post.body as { definition: JobDefinition }).definition).toMatchObject({
      schema: 3, placement: 'a', trigger: { startRecord: START, to: 'done' }, check: { kind: 'source_record', doneMark: 'file_linked' },
      missed: { expiresAfterMinutes: 1440 }, grant: { creates: ['task'] },
    })
  })

  it('the approval says what it watches, the check on the watched やること, and the minutes per run; it sends the fingerprint', async () => {
    const pending = jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED', trigger, placement: 'a', nextSlot: null, lastOccurrence: null })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...pending, versions: [version(1, pcDef(), 'c1')] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...pending, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED' }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('次の回：承認すると決まります')
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/見張っているやることが今もその状態で、担当が責任者のままのときだけ、AI が動きます/)).toBeInTheDocument()
    expect(dialog).toHaveTextContent('ファイルがもうつながっていれば、AI は動きません')
    expect(dialog).toHaveTextContent('上限：1回 15分・1日 1回まで（超えた出来事は動かさず、責任者に知らせます）')
    expect(dialog).toHaveTextContent('出来事のあと1日のうちに動けなかったときは見送ります')
    expect(dialog).not.toHaveTextContent(START)
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ version: 1, fingerprint: 'sha256:v1' }]))
  })

  it('an approved event job says when its next occurrence comes (no slot)', async () => {
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ trigger, placement: 'a', nextSlot: null, lastOccurrence: null })] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('次の回：見張っているやることが、きっかけの状態になったとき')
  })

  it('a version hidden from this viewer (a やること they cannot read): said as such — no words, no form over it, no approval', async () => {
    const hidden = { ...version(1, pcDef(), 'c1'), definition: null, fingerprint: null, consentFingerprint: null }
    expect(hiddenVersion(hidden)).toBe(true)
    expect(hiddenVersion({ ...hidden, needsUpdate: true })).toBe(false)
    expect(hiddenVersion(version(1, pcDef(), 'c1'))).toBe(false)
    const pending = jobView({ approvedVersion: null, state: 'draft', waiting: 'NOT_APPROVED', trigger: undefined, placement: undefined, nextSlot: null, lastOccurrence: null })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [pending] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...pending, versions: [hidden] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent(JOB_VERSION_HIDDEN)
    await userEvent.click(within(row).getByRole('button', { name: '直す' }))
    let dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(JOB_VERSION_HIDDEN)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '保存' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: /close|閉じる/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(JOB_VERSION_HIDDEN)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '承認する' })).toBeDisabled()
    expect(calls.some((c) => c.method !== 'GET' && !c.url.endsWith('/records/query'))).toBe(false)
  })

  it('refusals in plain Japanese: a definition by its problem codes, a job code by the server’s sentence, 「もう一度」 by its code', async () => {
    const refused = (status: number, body: Record<string, unknown>) => new ApiError(status, String(body.error ?? ''), body)
    // The rollback floor does not know schema 3 yet.
    expect(describeJobError(refused(400, { error: '定期の仕事の内容に正しくないところがあります。', code: 'BAD_JOB_DEFINITION', problems: ['schema.UNKNOWN'] }))).toMatch(/サーバーの更新が必要です/)
    expect(describeJobError(refused(400, { error: 'x', code: 'BAD_JOB_DEFINITION', problems: ['grant.creates.EVENT_NEEDS_TASK'] }))).toMatch(/やることを1つ作ります/)
    expect(describeJobError(refused(409, { error: '画面に出ていた内容と違います。読み直してから、もう一度ためしてください。', code: 'JOB_VERSION_FINGERPRINT' }))).toBe('画面に出ていた内容と違います。読み直してから、もう一度ためしてください。')
    expect(describeJobError(refused(409, { error: 'x', code: 'SOURCE_CHANGED' }))).toMatch(/きっかけのやることが変わったため/)
    // A code it does not know: the general words, never the server's text.
    expect(describeJobError(refused(409, { error: 'Something internal', code: 'SOMETHING_ELSE' }))).toBe('ほかの変更と競合しました。ページを再読み込みしてからやり直してください。')
    // Whatever the status (independent review): a 400 / 422 / 429 with a code it does not know, or none, never shows the text.
    for (const status of [400, 422, 429]) {
      expect(describeJobError(refused(status, { error: 'Body must be { definition }', code: 'BAD_REQUEST' }))).toBe(JOB_REFUSED_GENERAL)
      expect(describeJobError(new ApiError(status, 'Too many requests', null))).toBe(JOB_REFUSED_GENERAL)
    }

    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [] }) },
      [`POST ${base}/records/query`]: { body: ok({ total: 1, records: [{ id: START, type: 'task', title: '面談の準備' }] }) },
      [`POST ${base}/jobs`]: { status: 400, body: { error: '定期の仕事の内容に正しくないところがあります。', code: 'BAD_JOB_DEFINITION', problems: ['schema.UNKNOWN'] } },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '定期の仕事を作る' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名前' }), '面談報告書')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'いつ動くか' }), 'event')
    await userEvent.selectOptions(await within(dialog).findByRole('combobox', { name: '見張るやること' }), await within(dialog).findByRole('option', { name: '面談の準備' }))
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'すること' }), 'pc')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Skill' }), 'interview-report')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この種類の定期の仕事は、いまのサーバーではまだ作れません（サーバーの更新が必要です）。')
  })

  it('an event occurrence: marked as such, 「もう一度」 says the watched やること must still ask for it, pressed on the occurrence route only', async () => {
    const occ = (id: string, over: Record<string, unknown>) => ({
      id, jobVersion: 1, dueSlot: '2026-11-21T14:05', timeZone: 'Asia/Tokyo', dueAt: '', expiresAt: '', state: 'expired', outcomeCode: 'EXPIRED',
      ran: false, updatedAt: '', kind: 'event', retries: 0, retriedBy: null, retriedAt: null, unknownOperations: [], madeBefore: [], ...over,
    })
    const OTHER = 'occ.ffffffffffffffffffffffffffffffff'
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ trigger, placement: 'a', nextSlot: null })] }) },
      [`GET ${base}/jobs/${JOB_ID}/occurrences`]: {
        body: ok({ occurrences: [
          occ(OCC, { retry: { allowed: true } }),
          occ(OTHER, { dueSlot: '2026-11-20T10:00', state: 'needs_person', outcomeCode: 'MADE_THEN_STOPPED', retry: { allowed: false, why: 'SOURCE_CHANGED' } }),
        ] }),
      },
      [`POST ${base}/jobs/${JOB_ID}/occurrences/${OCC}/retry`]: { body: ok({ occurrence: occ(OCC, { state: 'due', outcomeCode: null }) }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    await userEvent.click(within(row).getByRole('button', { name: '回の記録' }))
    const history = await within(row).findByRole('list', { name: '回の記録' })
    const first = within(history).getByRole('listitem', { name: '11月21日 14:05の回' })
    expect(first).toHaveTextContent('出来事')
    expect(history).toHaveTextContent('「もう一度」はできません：きっかけのやることが変わったため')
    await userEvent.click(within(first).getByRole('button', { name: 'もう一度' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('きっかけのやることが今もその状態で、担当が責任者のままのときだけ動きます')
    await userEvent.click(within(dialog).getByRole('button', { name: 'もう一度' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => decodeURIComponent(c.url))).toEqual([`${base}/jobs/${JOB_ID}/occurrences/${OCC}/retry`]))
    expect(calls.some((c) => c.url.includes('/ai-runs'))).toBe(false)
  })

  it('a hidden approved event job: its next occurrence and the 「もう一度」 words say nothing of where it runs', async () => {
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [jobView({ trigger: undefined, placement: undefined, nextSlot: null, lastOccurrence: null })] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '週の報告' })
    expect(row).toHaveTextContent('次の回：表示できません')
    const neutral = retryConfirmText(undefined)
    expect(neutral).not.toMatch(/数分のうちに|PC/)
    expect(neutral).toMatch(/もう一度動かします/)
    expect(retryConfirmText('e')).toMatch(/数分のうちに/)
  })
})
