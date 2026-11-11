// 「定期の仕事」 (jobs.md "The screens", PR 4): the form makes only the server's operation (no AI powers)
// through the shared parser; editing a name or a time keeps what the responsible person accepted; approval
// sends the version shown and says whether they must accept again; the company-wide stop asks first;
// occurrences are told in plain words; anyone but owners / admins is not offered the page.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import JobsRoute from '@/app/companies/[id]/jobs/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import { approvedText } from '@/components/jobs/job-dialogs'
import type { JobView } from '@/lib/api'
import { definitionFromForm, emptyJobForm, formFromDefinition } from '@/lib/jobs'
import { jobConsentCanonical, type JobDefinition } from '../../shared/core/jobs'
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

  it('a PC job (a Skill as the procedure) is not offered for editing here', () => {
    const procedure = def({ placement: 'a', check: { kind: 'new_files', path: '総務/x' }, run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'report', fingerprint: 'a'.repeat(40) } } })
    expect(formFromDefinition(procedure)).toBeNull()
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

  it('approving one\'s own job also accepts it in one\'s own name, with the version shown', async () => {
    const mine = jobView({ actingUserId: 'u_owner', approvedVersion: null, accepted: false, state: 'draft', waiting: 'NOT_APPROVED' })
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [mine] }) },
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...mine, versions: [version(1, def({ actingUser: 'u_owner' }), 'c1')] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...mine, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED' }) },
      [`POST ${base}/me/jobs/${JOB_ID}/accept`]: { body: ok({ ...mine, approvedVersion: 1, accepted: true, state: 'active', waiting: null }) },
    })
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: '週の報告' })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('note')).toHaveTextContent('あなたが責任者です')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url.replace(base, ''), c.body])).toEqual([
      [`/jobs/${JOB_ID}/approve`, { version: 1, fingerprint: 'sha256:v1' }],
      [`/me/jobs/${JOB_ID}/accept`, { version: 1, fingerprint: 'sha256:v1' }],
    ]))
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
    expect(approvedText(3, after({ waiting: null, placement: 'a' }), '田中 太郎')).toContain('まだ動きません')
  })

  it('the list names who it runs as now (the approved version\'s person) and the next version\'s person apart; a PC job is not 「動いています」', async () => {
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
    expect(pcRow).toHaveTextContent('まだ動きません')
    expect(pcRow).not.toHaveTextContent('動いています')
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
    const dialog = await screen.findByRole('dialog')
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
