// 「届いた案」 (jobs.md "Member proposals", PR B): owners / admins see what members proposed from the AI chat — the stored
// proposer, the server-made name, the version they sent in plain words, its state and when —, approve it through the job's
// own approval (version + fingerprint, never an acceptance), return it with a fixed reason only, and edit a proposal's job
// as schema 4 (the version it was made from sent, the responsible person not offered). Withdrawn / returned jobs are neither
// edited nor approved. A server without member proposals shows no section.
import { screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import JobsRoute from '@/app/companies/[id]/jobs/page'
import { JobFormFields } from '@/components/jobs/job-dialogs'
import { ApiError } from '@/lib/api'
import { describeJobError } from '@/lib/errors'
import { PROPOSAL_CLOSED_TEXT, RETURN_REASON_CHOICES, proposalStateText, proposalVersionText } from '@/lib/job-proposals'
import { JOB_FORM_CANNOT_EDIT, definitionFromForm, formFromDefinition, jobEditForm } from '@/lib/jobs'
import { JOB_PROPOSAL_RETURN_REASONS } from '../../shared/core/job-proposals'
import { JOB_SET_WATCH_OPENED, isSetTrigger, jobConsentCanonical, parseJobDefinition, type JobDefinition } from '../../shared/core/jobs'
import { setWatchConditionLines } from '../../shared/core/job-words'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { members as memberFixtures, ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123/jobs',
  useSearchParams: () => new URLSearchParams(),
}))

const JOB_ID = 'job.0123456789abcdef0123456789abcdef'
const PROPOSAL_ID = 'jp.' + 'a'.repeat(32)
const NAME = '議事録まとめ（毎週月曜 09:00）'

/** A member's proposal as the server builds it (schema 4), with a real pin (the form leaves it out of its comparison). */
const proposalDef = (over: Record<string, unknown> = {}): JobDefinition => {
  const parsed = parseJobDefinition({
    schema: 4, origin: 'member_proposal', name: NAME, actingUser: 'u_member',
    trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
    check: { kind: 'new_files', path: '営業部/議事録' },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: 'c'.repeat(40) } },
    placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 720 },
    grant: {
      tools: ['records', 'files_read', 'files_write'], creates: ['task'], routes: [], reads: { paths: ['営業部/週報', '営業部/議事録'], calls: [] },
      writes: { area: 'deliverable', place: '営業部', folder: 'job-0123abcd' }, outbound: 'none', limits: { minutes: 15, runsPerDay: 1 },
    },
    ...over,
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  return parsed.definition
}

/** The same content as an owner / admin's job (schema 1, no mark). */
const asSchema1 = (d: JobDefinition): JobDefinition => {
  const copy: Record<string, unknown> = { ...d, schema: 1 }
  delete copy.origin
  return copy as unknown as JobDefinition
}

const version = (n: number, d: JobDefinition) => ({
  version: n, fingerprint: `sha256:v${n}`, consentFingerprint: `c${n}`, definition: d, createdBy: n === 1 ? 'u_member' : 'u_owner', createdAt: '2026-11-22T00:00:00.000Z',
  approvedBy: null, approvedAt: null, acceptedBy: null, acceptedAt: null,
})

const summary = (over: Record<string, unknown> = {}) => ({ id: PROPOSAL_ID, proposerId: 'u_member', submittedVersion: 1, state: 'submitted', returnReason: null, ...over })

const jobView = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID, name: NAME, state: 'draft', actingUserId: 'u_member', latestVersion: 1, approvedVersion: null, accepted: false,
  pausedReason: null, waiting: 'NOT_APPROVED', createdBy: 'u_member', createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z',
  trigger: proposalDef().trigger, placement: 'a', nextSlot: null, lastOccurrence: null, proposal: summary(),
  ...over,
})

const proposalView = (over: Record<string, unknown> = {}) => ({
  id: PROPOSAL_ID, jobId: JOB_ID, proposerId: 'u_member', candidateId: 'jc.' + 'b'.repeat(32), submittedVersion: 1, submittedFingerprint: 'sha256:v1',
  state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-22T01:30:00.000Z',
  ...over,
})

function routes(job: ReturnType<typeof jobView>, versions: unknown[], proposals: unknown[] = [proposalView()], extra: Record<string, unknown> = {}) {
  return {
    ...companyRoutes(),
    [`GET ${base}/jobs`]: { body: ok({ stopped: false, canManage: true, jobs: [job] }) },
    [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...job, versions }) },
    [`GET ${base}/job-proposals?state=submitted`]: { body: ok({ proposals }) },
    ...extra,
  } as Parameters<typeof mockApi>[0]
}

describe('届いた案', () => {
  it('shows the stored proposer (not the responsible person), the server-made name, when, the state and the version they sent in plain words', async () => {
    // The responsible person differs here only to show the proposer is read from the proposal itself.
    const job = jobView({ actingUserId: 'u_admin', latestVersion: 2 })
    const edited = proposalDef({ name: '議事録まとめ（改）' })
    mockApi(routes(job, [version(2, edited), version(1, proposalDef())]))
    renderInCompany(<JobsRoute />)
    const card = await screen.findByRole('region', { name: '届いた案' }).catch(() => screen.findByLabelText('届いた案'))
    const row = await within(card).findByRole('listitem', { name: '田中 太郎さんからの案' })
    expect(row).toHaveTextContent(NAME)
    expect(row).toHaveTextContent('確認を待っています')
    expect(row).toHaveTextContent('2026')
    await userEvent.click(within(row).getByRole('button', { name: '中身を見る' }))
    const content = await within(row).findByLabelText('出した内容')
    // The version they sent (1), not the newest (2) an admin made after it.
    expect(content).toHaveTextContent('第1版：社員が出した版（田中 太郎さんが出した内容のままです）')
    expect(content).toHaveTextContent(NAME)
    expect(content).not.toHaveTextContent('議事録まとめ（改）')
    expect(content).toHaveTextContent('毎週月曜 09:00')
    expect(content).toHaveTextContent('このあと管理者が直した版（第2版）があります')
    // The job's row says whose proposal it is, from the stored proposer too.
    expect(screen.getByLabelText('案')).toHaveTextContent('田中 太郎さんからの案（確認を待っています）')
  })

  it('approves through the job’s own approval: the newest version with its fingerprint, never an acceptance', async () => {
    const job = jobView()
    const { calls } = mockApi(routes(job, [version(1, proposalDef())], [proposalView()], {
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...job, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) }) },
    }))
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '田中 太郎さんからの案' })
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByLabelText('版の出どころ')).toHaveTextContent('第1版：社員が出した版')
    expect(within(dialog).getByRole('note')).toHaveTextContent('田中 太郎さんが内容を確かめて「受け取る」を押すまで動きません')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url.replace(base, ''), c.body])).toEqual([
      [`/jobs/${JOB_ID}/approve`, { version: 1, fingerprint: 'sha256:v1' }],
    ]))
    expect(calls.some((c) => c.url.includes('/accept'))).toBe(false)
  })

  it('an admin’s later version is named as such in the approval', async () => {
    const job = jobView({ latestVersion: 2 })
    mockApi(routes(job, [version(2, proposalDef({ name: '議事録まとめ（改）' })), version(1, proposalDef())]))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '承認する' }))
    expect(await within(await screen.findByRole('dialog')).findByLabelText('版の出どころ'))
      .toHaveTextContent('第2版：管理者が直した版（田中 太郎さんが出したのは第1版です）')
  })

  it('returns with one of the fixed reasons only — no text box — and the job list is read again', async () => {
    const job = jobView()
    const { calls } = mockApi(routes(job, [version(1, proposalDef())], [proposalView()], {
      [`POST ${base}/job-proposals/${PROPOSAL_ID}/return`]: { body: ok({ proposal: proposalView({ state: 'returned', returnReason: 'TOO_BROAD' }) }) },
    }))
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '田中 太郎さんからの案' })
    await userEvent.click(within(row).getByRole('button', { name: '差し戻す' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('radio')).toHaveLength(JOB_PROPOSAL_RETURN_REASONS.length)
    expect(within(dialog).getByRole('button', { name: '差し戻す' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('radio', { name: '読む場所や置く場所、できることが広すぎる' }))
    const listsBefore = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/jobs')).length
    await userEvent.click(within(dialog).getByRole('button', { name: '差し戻す' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ reason: 'TOO_BROAD' }]))
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/jobs')).length).toBeGreaterThan(listsBefore))
    expect(RETURN_REASON_CHOICES.map((c) => c.value)).toEqual([...JOB_PROPOSAL_RETURN_REASONS])
  })

  it('a server without member proposals (404) shows no section, and the jobs still show', async () => {
    const job = jobView({ proposal: undefined })
    const r = routes(job, [])
    delete (r as Record<string, unknown>)[`GET ${base}/job-proposals?state=submitted`]
    mockApi(r)
    renderInCompany(<JobsRoute />)
    expect(await screen.findByRole('listitem', { name: NAME })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByLabelText('届いた案')).not.toBeInTheDocument())
  })

  it('other states by the filter, in the admin’s words', async () => {
    mockApi(routes(jobView({ state: 'retired', proposal: summary({ state: 'returned', returnReason: 'TALK_FIRST' }) }), [version(1, proposalDef())], [], {
      [`GET ${base}/job-proposals?state=returned`]: { body: ok({ proposals: [proposalView({ state: 'returned', returnReason: 'TALK_FIRST' })] }) },
    }))
    renderInCompany(<JobsRoute />)
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: '案の状態' }), 'returned')
    const row = await screen.findByRole('listitem', { name: '田中 太郎さんからの案' })
    expect(row).toHaveTextContent('差し戻しました（理由：先に話をしたい）')
    expect(within(row).queryByRole('button', { name: '承認する' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '差し戻す' })).not.toBeInTheDocument()
    expect(proposalStateText({ state: 'withdrawn', returnReason: null })).toBe('出した人が取り下げました')
    expect(proposalStateText({ state: 'approved', returnReason: null })).toBe('承認しました')
  })
})

describe('a withdrawn or returned proposal’s job', () => {
  it('the list offers neither 承認する nor 直す (retired) and says its state', async () => {
    mockApi(routes(jobView({ state: 'retired', proposal: summary({ state: 'withdrawn' }) }), [version(1, proposalDef())], []))
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: NAME })
    expect(within(row).getByLabelText('案')).toHaveTextContent('出した人が取り下げました')
    expect(within(row).queryByRole('button', { name: '承認する' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '直す' })).toBeDisabled()
  })

  it('its approval and its form say so and send nothing, also when the list still showed it as waiting', async () => {
    // The list was read before the withdrawal; the dialogs read the job again.
    const listed = jobView()
    const now = { ...listed, state: 'draft', proposal: summary({ state: 'withdrawn' }) }
    const { calls } = mockApi({
      ...routes(listed, [], []),
      [`GET ${base}/jobs/${JOB_ID}`]: { body: ok({ ...now, versions: [version(1, proposalDef())] }) },
    })
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: NAME })
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    let dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(PROPOSAL_CLOSED_TEXT)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '承認する' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await userEvent.click(within(row).getByRole('button', { name: '直す' }))
    dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(PROPOSAL_CLOSED_TEXT)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
  })
})

describe('editing a proposal’s job (schema 4)', () => {
  it('keeps schema 4 and its mark, offers no responsible person, 「いつ動くか」 or 「すること」, and sends the version it was made from', async () => {
    const job = jobView({ latestVersion: 2, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) })
    const { calls } = mockApi(routes(job, [version(2, proposalDef({ name: '議事録まとめ（改）' })), version(1, proposalDef())], [], {
      [`PUT ${base}/jobs/${JOB_ID}`]: { body: ok({ ...job, latestVersion: 3, changed: true }) },
    }))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    const name = await within(dialog).findByRole('textbox', { name: '名前' })
    expect(within(dialog).queryByRole('combobox', { name: '責任者' })).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('責任者')).toHaveTextContent('田中 太郎（案を出した人のままです。変えられません）')
    expect(within(dialog).queryByRole('combobox', { name: 'いつ動くか' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox', { name: 'すること' })).not.toBeInTheDocument()
    await userEvent.clear(name)
    await userEvent.type(name, '議事録まとめ（第3版）')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1))
    const body = calls.find((c) => c.method === 'PUT')!.body as { definition: JobDefinition; baseVersion: number }
    expect(body.baseVersion).toBe(2)
    expect(body.definition).toMatchObject({ schema: 4, origin: 'member_proposal', actingUser: 'u_member', name: '議事録まとめ（第3版）', placement: 'a' })
    // A name change leaves what the member sent and the responsible person accepted as it was (the reads' order included;
    // the Skill's pin is the server's, filled again when the version is made).
    const unpinned = (d: JobDefinition) => jobConsentCanonical({ ...d, run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: '0'.repeat(40) } } } as JobDefinition)
    expect(unpinned(body.definition)).toBe(unpinned(proposalDef()))
  })

  it('a job that is not a proposal’s sends { definition } only (a server before member proposals takes nothing else)', async () => {
    const schema1 = asSchema1(proposalDef())
    const job = jobView({ proposal: null, approvedVersion: 1, state: 'active', waiting: null })
    const { calls } = mockApi(routes(job, [version(1, schema1)], [], {
      [`PUT ${base}/jobs/${JOB_ID}`]: { body: ok({ ...job, latestVersion: 2, changed: true }) },
    }))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('combobox', { name: '責任者' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1))
    expect(Object.keys(calls.find((c) => c.method === 'PUT')!.body as object)).toEqual(['definition'])
  })

  it('a version the form would widen (one record route instead of the four) is not given the form', async () => {
    const narrow = proposalDef({ grant: { ...proposalDef().grant, routes: ['GET /my-turn'] } })
    expect(jobEditForm(narrow)).toBeNull()
    mockApi(routes(jobView({ proposal: summary({ state: 'approved' }), approvedVersion: 1, state: 'active', waiting: null }), [version(1, narrow)], []))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(JOB_FORM_CANNOT_EDIT)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('the form keeps a proposal a time job run by the PC whatever its 「いつ動くか」 / 「すること」 hold', () => {
    const form = jobEditForm(proposalDef())!
    expect(form).not.toBeNull()
    expect(form.proposal).toBe(true)
    const back = definitionFromForm({ ...form, when: 'event', kind: 'task' })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.definition).toMatchObject({ schema: 4, origin: 'member_proposal', placement: 'a', run: { kind: 'procedure' } })
    // A job that is not a proposal never becomes schema 4 from the form.
    const one = definitionFromForm(formFromDefinition(asSchema1(proposalDef())))
    expect(one.ok && one.definition.schema).toBe(1)
    expect(one.ok && 'origin' in one.definition).toBe(false)
  })
})

describe('a set watch a member proposed from the app (schema 5, 4b-4 PR6b)', () => {
  const SET_NAME = 'proposal-auto（会議のあと）'
  /**
   * The shape PR6b's server makes (`setWatchProposalDefinition` in `shared/core/job-proposals.ts`, then pinned): the opened
   * combination, the member's department Skill, the Skills it reads, the minutes route alone, its one やること, writing only in
   * `.personal/提案書/` of that department, 30 minutes, 10 a day, one day's wait — and no origin mark (schema 5 takes none).
   */
  const setProposalDef = (over: Record<string, unknown> = {}): JobDefinition => {
    const parsed = parseJobDefinition({
      schema: 5, name: SET_NAME, actingUser: 'u_member', trigger: JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0])),
      check: { kind: 'matched_record' },
      run: { kind: 'procedure', procedure: { source: 'department_skill', place: '営業部', skill: 'proposal-auto', fingerprint: 'a'.repeat(40) } },
      placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
      grant: {
        tools: ['records', 'files_write'], creates: ['task'], routes: ['GET /minutes/:recordId/text'],
        reads: { paths: [], calls: [], skills: [{ place: '営業部', skill: 'proposal', fingerprint: 'b'.repeat(40) }, { place: '経営企画', skill: 'pricing', fingerprint: 'c'.repeat(40) }] },
        writes: { area: 'deliverable', place: '営業部', folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
      },
      decision: { reasons: [{ code: 'internal', label: '社内の会議' }] },
      ...over,
    })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
    return parsed.definition
  }
  const setJob = (over: Record<string, unknown> = {}) => jobView({ name: SET_NAME, trigger: setProposalDef().trigger, ...over })

  it('the card and the approval show the whole consent and the version the member sent; approving sends the fingerprint, never an acceptance', async () => {
    const job = setJob()
    const { calls } = mockApi(routes(job, [version(1, setProposalDef())], [proposalView()], {
      [`GET ${base}/plugins`]: { body: ok({ plugins: [] }) },
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...job, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) }) },
    }))
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: '田中 太郎さんからの案' })
    await userEvent.click(within(row).getByRole('button', { name: '中身を見る' }))
    const content = await within(row).findByLabelText('出した内容')
    expect(content).toHaveTextContent('第1版：社員が出した版')
    expect(content).toHaveTextContent('「営業部」の Skill「proposal-auto」')
    await userEvent.click(within(row).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByLabelText('版の出どころ')).toHaveTextContent('第1版：社員が出した版')
    const trigger = setProposalDef().trigger
    if (!isSetTrigger(trigger)) throw new Error('not a set watch')
    await userEvent.click(within(dialog).getByRole('button', { name: 'くわしく' }))
    const conditions = within(dialog).getByLabelText('動く条件')
    for (const line of setWatchConditionLines(trigger)) expect(conditions).toHaveTextContent(line)
    expect(dialog).toHaveTextContent('「営業部」の Skill「proposal」・「経営企画」の Skill「pricing」')
    expect(within(dialog).getByLabelText('判断の理由')).toHaveTextContent('社内の会議')
    expect(dialog).toHaveTextContent('田中 太郎さんが内容を確かめて「受け取る」を押すまで動きません')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url.replace(base, ''), c.body])).toEqual([
      [`/jobs/${JOB_ID}/approve`, { version: 1, fingerprint: 'sha256:v1' }],
    ]))
    expect(calls.some((c) => c.url.includes('/accept'))).toBe(false)
  })

  it('editing keeps it a set watch run as its proposer: no 責任者 or 「いつ動くか」 offered, schema 5 and the version it was made from sent', async () => {
    const job = setJob({ approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) })
    const { calls } = mockApi(routes(job, [version(1, setProposalDef())], [], {
      [`PUT ${base}/jobs/${JOB_ID}`]: { body: ok({ ...job, latestVersion: 2, changed: true }) },
    }))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: SET_NAME })).getByRole('button', { name: '直す' }))
    const dialog = await screen.findByRole('dialog')
    const name = await within(dialog).findByRole('textbox', { name: '名前' })
    expect(within(dialog).queryByRole('combobox', { name: '責任者' })).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('責任者')).toHaveTextContent('田中 太郎（案を出した人のままです。変えられません）')
    expect(within(dialog).queryByRole('combobox', { name: 'いつ動くか' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox', { name: 'すること' })).not.toBeInTheDocument()
    await userEvent.clear(name)
    await userEvent.type(name, '提案書（会議のあと）')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1))
    const body = calls.find((c) => c.method === 'PUT')!.body as { definition: JobDefinition; baseVersion: number }
    expect(body.baseVersion).toBe(1)
    expect(body.definition).toMatchObject({ schema: 5, actingUser: 'u_member', name: '提案書（会議のあと）' })
    expect('origin' in body.definition).toBe(false)
    // What the member sent and accepts is unchanged (the trees and reasons are the server's, filled again when the version is made).
    const unpinned = (d: JobDefinition) => {
      const copy = JSON.parse(JSON.stringify(d)) as JobDefinition & { decision?: unknown }
      if (copy.run.kind === 'procedure') copy.run.procedure.fingerprint = ''
      for (const p of copy.grant.reads.skills ?? []) p.fingerprint = ''
      delete copy.decision
      return jobConsentCanonical(copy)
    }
    expect(unpinned(body.definition)).toBe(unpinned(setProposalDef()))
  })

  it('the shape the app proposes round-trips through the form exactly (never a schema-4 proposal form)', () => {
    const d = setProposalDef()
    const form = jobEditForm(d)
    expect(form).not.toBeNull()
    expect(form!.proposal).toBe(false)
    const back = definitionFromForm(form!)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.definition).toMatchObject({ schema: 5, grant: { tools: ['records', 'files_write'], reads: { paths: [] }, writes: { place: '営業部', folder: '提案書' } } })
  })
})

describe('the proposer’s 受け取る is in the app', () => {
  it('an owner / admin who proposed it is not offered 「責任者として受け取る」 here; the row and the approval say to accept in the app', async () => {
    const mine = jobView({ actingUserId: 'u_owner', approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ proposerId: 'u_owner', state: 'approved' }),
      you: { named: true, controls: true, mustAccept: true } })
    mockApi(routes(mine, [version(1, proposalDef({ actingUser: 'u_owner' }))], []))
    renderInCompany(<JobsRoute />)
    const row = await screen.findByRole('listitem', { name: NAME })
    expect(within(row).getByRole('status')).toHaveTextContent('あなたのアプリの「設定」→「仕事」→「定期の仕事」で受け取るまで動きません')
    expect(within(row).queryByRole('button', { name: '責任者として受け取る' })).not.toBeInTheDocument()
  })

  it('the approval of one’s own proposal says the acceptance is in the app, and approves only', async () => {
    const mine = jobView({ actingUserId: 'u_owner', proposal: summary({ proposerId: 'u_owner' }) })
    const { calls } = mockApi(routes(mine, [version(1, proposalDef({ actingUser: 'u_owner' }))], [], {
      [`POST ${base}/jobs/${JOB_ID}/approve`]: { body: ok({ ...mine, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED' }) },
    }))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('note')).toHaveTextContent('あなたのアプリの「設定」→「仕事」→「定期の仕事」で受け取ってください')
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(base, ''))).toEqual([`/jobs/${JOB_ID}/approve`]))
  })
})

describe('the card follows what happened elsewhere (review L1 / Codex P2)', () => {
  /** The card's list: waiting until `decided` is set, then empty (as the server answers once it was decided). */
  function proposalsRoute() {
    const state = { decided: false, reads: 0 }
    const reply = () => { state.reads += 1; return { body: ok({ proposals: state.decided ? [] : [proposalView()] }) } }
    return { state, reply }
  }

  it('after approving from the card, it no longer shows the proposal as waiting', async () => {
    const job = jobView()
    const list = proposalsRoute()
    mockApi(routes(job, [version(1, proposalDef())], [], {
      [`GET ${base}/job-proposals?state=submitted`]: list.reply,
      [`POST ${base}/jobs/${JOB_ID}/approve`]: () => { list.state.decided = true; return { body: ok({ ...job, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) }) } },
    }))
    renderInCompany(<JobsRoute />)
    const card = await screen.findByLabelText('届いた案')
    await userEvent.click(within(await within(card).findByRole('listitem', { name: '田中 太郎さんからの案' })).getByRole('button', { name: '承認する' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: '田中 太郎さんからの案' })).not.toBeInTheDocument())
    expect(within(card).getByText('確認を待っている案はありません。')).toBeInTheDocument()
  })

  it('after approving from the job’s row, the card is read again too', async () => {
    const job = jobView()
    const list = proposalsRoute()
    mockApi(routes(job, [version(1, proposalDef())], [], {
      [`GET ${base}/job-proposals?state=submitted`]: list.reply,
      [`POST ${base}/jobs/${JOB_ID}/approve`]: () => { list.state.decided = true; return { body: ok({ ...job, approvedVersion: 1, state: 'active', waiting: 'NOT_ACCEPTED', proposal: summary({ state: 'approved' }) }) } },
    }))
    renderInCompany(<JobsRoute />)
    const card = await screen.findByLabelText('届いた案')
    await within(card).findByRole('listitem', { name: '田中 太郎さんからの案' })
    await userEvent.click(within(screen.getByRole('listitem', { name: NAME })).getByRole('button', { name: '承認する' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: '田中 太郎さんからの案' })).not.toBeInTheDocument())
  })

  it('an approval refused because the proposal was withdrawn meanwhile reads the card and the jobs again', async () => {
    const job = jobView()
    const list = proposalsRoute()
    const { calls } = mockApi(routes(job, [version(1, proposalDef())], [], {
      [`GET ${base}/job-proposals?state=submitted`]: list.reply,
      [`POST ${base}/jobs/${JOB_ID}/approve`]: () => {
        list.state.decided = true
        return { status: 409, body: { success: false, error: 'この案は取り下げられたか差し戻されたため、直したり承認したりできません。', code: 'JOB_PROPOSAL_CLOSED' } }
      },
    }))
    renderInCompany(<JobsRoute />)
    const card = await screen.findByLabelText('届いた案')
    await userEvent.click(within(await within(card).findByRole('listitem', { name: '田中 太郎さんからの案' })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    const jobReads = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/jobs')).length
    await userEvent.click(within(dialog).getByRole('button', { name: '承認する' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('取り下げられたか差し戻された')
    await waitFor(() => expect(list.state.reads).toBe(2))
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/jobs')).length).toBeGreaterThan(jobReads))
    // With the dialog closed (an open dialog hides the page from the queries), the card no longer offers it.
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: '田中 太郎さんからの案' })).not.toBeInTheDocument())
  })

  it('a return refused because the proposal was decided meanwhile reads the card again', async () => {
    const job = jobView()
    const list = proposalsRoute()
    mockApi(routes(job, [version(1, proposalDef())], [], {
      [`GET ${base}/job-proposals?state=submitted`]: list.reply,
      [`POST ${base}/job-proposals/${PROPOSAL_ID}/return`]: () => {
        list.state.decided = true
        return { status: 409, body: { success: false, error: 'この案はもう承認されました。', code: 'JOB_PROPOSAL_DECIDED', state: 'approved' } }
      },
    }))
    renderInCompany(<JobsRoute />)
    const card = await screen.findByLabelText('届いた案')
    await userEvent.click(within(await within(card).findByRole('listitem', { name: '田中 太郎さんからの案' })).getByRole('button', { name: '差し戻す' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('radio', { name: '先に話をしたい' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '差し戻す' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この案はもう承認されました。')
    await waitFor(() => expect(list.state.reads).toBe(2))
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(within(card).queryByRole('listitem', { name: '田中 太郎さんからの案' })).not.toBeInTheDocument())
  })
})

describe('the edit’s base version is the one the form was built from (review L2)', () => {
  it('a later version read while the form is open is never sent as its base', async () => {
    const sent: Array<number | undefined> = []
    function Harness() {
      const [v, setV] = useState(2)
      return (
        <>
          <button type="button" onClick={() => setV(3)}>読み直す</button>
          <JobFormFields initial={formFromDefinition(proposalDef())} baseVersion={v} newJob={false} members={memberFixtures}
            onCancel={() => {}} onSubmit={async (_d, b) => { sent.push(b) }} />
        </>
      )
    }
    mockApi(companyRoutes())
    renderInCompany(<Harness />)
    await userEvent.click(await screen.findByRole('button', { name: '読み直す' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(sent).toEqual([2]))
  })
})

describe('a version line with nothing to say (review L3)', () => {
  it('is not shown at all — never a bare 「第N版：」', async () => {
    // The newest version before the submitted one (not a state the server makes): the words are null.
    expect(proposalVersionText(1, { proposerId: 'u', submittedVersion: 2, state: 'submitted', returnReason: null }, '田中')).toBeNull()
    const job = jobView({ proposal: summary({ submittedVersion: 2 }) })
    mockApi(routes(job, [version(1, proposalDef())], []))
    renderInCompany(<JobsRoute />)
    await userEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '承認する' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('毎週月曜 09:00')
    expect(within(dialog).queryByLabelText('版の出どころ')).not.toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('第1版：')
  })
})

describe('refusals in plain Japanese', () => {
  it('the new codes show the server’s fixed sentence', () => {
    for (const code of ['JOB_PROPOSAL_ONLY', 'JOB_PROPOSAL_SCHEMA', 'JOB_PROPOSAL_CLOSED', 'JOB_PROPOSAL_RESPONSIBLE_FIXED', 'JOB_VERSION_NOT_LATEST', 'JOB_PROPOSAL_NOT_FOUND', 'JOB_PROPOSAL_DECIDED']) {
      const status = code === 'JOB_PROPOSAL_NOT_FOUND' ? 404 : 409
      expect(describeJobError(new ApiError(status, `文 ${code}`, { code, error: `文 ${code}` }))).toBe(`文 ${code}`)
    }
    // A return's malformed body is never shown as the server's text.
    expect(describeJobError(new ApiError(400, 'Body must be { reason } (a fixed reason code)', { code: 'BAD_REQUEST' }))).not.toContain('Body')
  })

  it('a version label never names anything but the proposer and the version', () => {
    expect(proposalVersionText(1, { proposerId: 'u', submittedVersion: 1, state: 'approved', returnReason: null }, '田中')).toBe('社員が出した版（田中さんが出した内容のままです）')
    expect(proposalVersionText(3, { proposerId: 'u', submittedVersion: 1, state: 'approved', returnReason: null }, '田中')).toBe('管理者が直した版（田中さんが出したのは第1版です）')
  })
})
