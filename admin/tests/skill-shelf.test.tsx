// 会社の Skill (plugins.md "The Skill shelf"): a company without the shared folder lists its
// Skills, instruction texts and rule files with the version handed out, who changed it and when;
// shows the earlier versions and puts one back with the version the page saw; takes an item off
// after a confirmation; offers no change where the server says the caller may not; a company with
// the shared folder gets a note and no call. The menu shows the page only for such a company.
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import SkillsRoute from '@/app/companies/[id]/skills/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import { SHELF_WITH_FOLDER_NOTE } from '@/components/skill-shelf/skill-shelf-page'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { company, managerCapabilities, ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123/skills',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)
const quote = {
  id: 's_1', kind: 'skill', name: 'quote', department: { id: 'd_sales', name: '営業部', folder: '営業部' },
  version: V2, fileCount: 2, totalBytes: 120, changedAt: '2026-11-07T01:00:00.000Z', changedBy: { id: 'u_member', name: '田中 太郎' }, canChange: true,
}
const instructions = {
  id: 's_2', kind: 'instructions', name: 'instructions', department: null,
  version: V1, fileCount: 1, totalBytes: 40, changedAt: '2026-11-06T01:00:00.000Z', changedBy: { id: 'u_owner', name: '佐藤 花子' }, canChange: false,
}
const versions = {
  item: quote,
  versions: [
    { version: V2, fileCount: 2, totalBytes: 120, publishedAt: '2026-11-07T01:00:00.000Z', publishedBy: { id: 'u_member', name: '田中 太郎' }, current: true, autorun: false },
    { version: V1, fileCount: 1, totalBytes: 60, publishedAt: '2026-11-06T01:00:00.000Z', publishedBy: { id: 'u_owner', name: '佐藤 花子' }, current: false, autorun: true },
  ],
  history: [],
}

const withoutFolder = (extra: Record<string, unknown> = {}) => ({
  ...companyRoutes(),
  [`GET ${base}`]: { body: ok({ ...company, role: 'owner', folderKind: 'none' }) },
  [`GET ${base}/skill-shelf`]: { body: ok({ items: [quote, instructions] }) },
  [`GET ${base}/skill-shelf/s_1/versions`]: { body: ok(versions) },
  [`GET ${base}/skill-shelf/requests`]: { body: ok({ requests: [] }) },
  ...extra,
})

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const request = {
  id: 'r_1', name: 'estimate', department: { id: 'd_sales', name: '営業部', folder: '営業部' },
  requestedBy: { id: 'u_member', name: '田中 太郎' }, requestedAt: '2026-11-09T01:00:00.000Z', state: 'pending', fileCount: 2, totalBytes: 50,
  autorun: false, decidedBy: null, decidedAt: null, reason: null, publishedVersion: null, mine: false, canDecide: true, currentVersion: null,
}

describe('会社の Skill', () => {
  it('lists each item by kind with its place, version, who and when, in plain words', async () => {
    mockApi(withoutFolder())
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    expect(within(skills).getByText('quote')).toBeInTheDocument()
    expect(within(skills).getByText('営業部')).toBeInTheDocument()
    expect(within(skills).getByText('配っています（版 bbbbbbbb・ファイル 2 個）')).toBeInTheDocument()
    expect(within(skills).getByText(/田中 太郎さんが .* に変えました/)).toBeInTheDocument()
    const inst = screen.getByRole('list', { name: 'AI への指示' })
    expect(within(inst).getByText('会社全体の指示')).toBeInTheDocument()
    // The server says this caller may not change it: no button to take it off.
    expect(within(inst).queryByRole('button', { name: '配るのをやめる' })).not.toBeInTheDocument()
    expect(screen.getByText('まだ AI への決まりはありません。')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/コミット|リポジトリ|プッシュ|ブランチ/)
  })

  it('puts an earlier version back after a confirmation, sending the version the page saw', async () => {
    const restored = { ...quote, version: V1 }
    const { calls } = mockApi(withoutFolder({ [`POST ${base}/skill-shelf/s_1/restore`]: { body: ok({ item: restored, changed: true }) } }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: 'これまでの版' }))
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    expect(within(list).getByText('いま配っている版')).toBeInTheDocument()
    expect(within(list).getByText(/自動で動く部分があります/)).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: 'この版に戻す' }))
    // Nothing is sent until the member confirms; the words say the current version stays.
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(screen.getByText(/いま配っている版も残るので/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'この版に戻す' }).at(-1)!)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: V1, expectedVersion: V2 })
    expect(await screen.findByText('配っています（版 aaaaaaaa・ファイル 2 個）')).toBeInTheDocument()
  })

  it('on an item taken off, putting a version back says it starts handing it out again (no version is current)', async () => {
    const off = { ...quote, version: null }
    const offVersions = { ...versions, item: off, versions: versions.versions.map((v) => ({ ...v, current: false })) }
    const { calls } = mockApi(withoutFolder({
      [`GET ${base}/skill-shelf`]: { body: ok({ items: [off, instructions] }) },
      [`GET ${base}/skill-shelf/s_1/versions`]: { body: ok(offVersions) },
      [`POST ${base}/skill-shelf/s_1/restore`]: { body: ok({ item: { ...quote, version: V1 }, changed: true }) },
    }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: 'これまでの版' }))
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    await userEvent.click(within(list).getAllByRole('button', { name: 'この版に戻す' })[1])
    expect(screen.getByText('配るのを再開し、この版がみんなのアプリに届きます。')).toBeInTheDocument()
    expect(screen.queryByText(/いま配っている版も残る/)).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'この版に戻す' }).at(-1)!)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: V1, expectedVersion: null })
  })

  it('takes an item off after a confirmation, with the version the page saw', async () => {
    const off = { ...quote, version: null }
    const { calls } = mockApi(withoutFolder({ [`POST ${base}/skill-shelf/s_1/unpublish`]: { body: ok({ item: off, changed: true }) } }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: '配るのをやめる' }))
    expect(screen.getByText(/これまでの版は残るので/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '配るのをやめる' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ expectedVersion: V2 })
    expect(await screen.findByText('配るのをやめています')).toBeInTheDocument()
  })

  it('an owner removes an old version after a confirmation (never offered on the current one)', async () => {
    const after = { ...versions, versions: [versions.versions[0]], history: [] }
    const { calls } = mockApi(withoutFolder({ [`DELETE ${base}/skill-shelf/s_1/versions/${V1}`]: { body: ok(after) } }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: 'これまでの版' }))
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    // One button: the old version's (the current one has none).
    await userEvent.click(within(list).getByRole('button', { name: 'この版を消す' }))
    expect(screen.getByText(/この版には戻せなくなります/)).toBeInTheDocument()
    const confirm = screen.getAllByRole('button', { name: 'この版を消す' }).at(-1)!
    await userEvent.click(confirm)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/skill-shelf/s_1/versions/${V1}`))).toBe(true)
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'これまでの版' })).queryByText('版 aaaaaaaa')).not.toBeInTheDocument())
    expect(within(screen.getByRole('list', { name: 'これまでの版' })).getByText('版 bbbbbbbb')).toBeInTheDocument()
  })

  it('an owner removes an item that is taken off; a manager is offered neither removal', async () => {
    const off = { ...quote, version: null }
    const { calls } = mockApi(withoutFolder({
      [`GET ${base}/skill-shelf`]: { body: ok({ items: [off] }) },
      [`DELETE ${base}/skill-shelf/s_1`]: { body: ok({ removed: true }) },
    }))
    const { unmount } = renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: '消す' }))
    expect(screen.getByText(/これまでの版もすべて消え/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: '消す' }).at(-1)!)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/skill-shelf/s_1'))).toBe(true)
    expect(await screen.findByText('まだ何もありません')).toBeInTheDocument()
    unmount()

    mockApi({
      ...companyRoutes(managerCapabilities),
      [`GET ${base}`]: { body: ok({ ...company, role: 'member', folderKind: 'none' }) },
      [`GET ${base}/skill-shelf`]: { body: ok({ items: [off, { ...quote, id: 's_3' }] }) },
      [`GET ${base}/skill-shelf/s_3/versions`]: { body: ok({ ...versions, item: { ...quote, id: 's_3' } }) },
    })
    renderInCompany(<SkillsRoute />)
    const managed = await screen.findByRole('list', { name: 'Skill' })
    expect(within(managed).queryByRole('button', { name: '消す' })).not.toBeInTheDocument()
    await userEvent.click(within(managed).getAllByRole('button', { name: 'これまでの版' })[1])
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    expect(within(list).getByRole('button', { name: 'この版に戻す' })).toBeInTheDocument()
    expect(within(list).queryByRole('button', { name: 'この版を消す' })).not.toBeInTheDocument()
  })

  it('公開のお願い: a publisher sees the pending requests, looks at the files, and publishes after a confirmation', async () => {
    const replacing = { ...request, id: 'r_2', name: 'quote', currentVersion: V2 }
    const { calls } = mockApi(withoutFolder({
      [`GET ${base}/skill-shelf/requests`]: { body: ok({ requests: [request, replacing, { ...request, id: 'r_mine', name: 'own', mine: true, canDecide: false }, { ...request, id: 'r_done', name: 'done', state: 'published' }] }) },
      [`GET ${base}/skill-shelf/requests/r_1/files`]: { body: ok({ id: 'r_1', name: 'estimate', version: V1, files: [{ path: 'notes/a.bin', base64: b64('\u0000\u0001') }, { path: 'SKILL.md', base64: b64('# 見積の作り方\n') }] }) },
      [`POST ${base}/skill-shelf/requests/r_2/publish`]: { body: ok({ request: { ...replacing, state: 'published' } }) },
    }))
    renderInCompany(<SkillsRoute />)
    const list = await screen.findByRole('list', { name: '公開のお願い' })
    // Only what the caller may decide and that still waits.
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getAllByText(/田中 太郎さんから .*・ファイル 2 個/)).toHaveLength(2)
    expect(within(list).queryByText('own')).toBeNull()
    expect(within(list).queryByText('done')).toBeNull()

    const first = within(list).getAllByRole('listitem')[0]
    await userEvent.click(within(first).getByRole('button', { name: '中身を見る' }))
    const files = await screen.findByRole('list', { name: 'ファイル' })
    expect(within(files).getByText('# 見積の作り方')).toBeInTheDocument()
    expect(within(files).getByText(/文字ではないファイルです/)).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    const second = within(list).getAllByRole('listitem')[1]
    await userEvent.click(within(second).getByRole('button', { name: '公開する' }))
    expect(screen.getByText(/いま配っている同じ名前の Skill を置き換えます/)).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    await userEvent.click(screen.getAllByRole('button', { name: '公開する' }).at(-1)!)
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: expect.stringContaining('/skill-shelf/requests/r_2/publish'), body: { expectedVersion: V2 } })
    await waitFor(() => expect(within(screen.getByRole('list', { name: '公開のお願い' })).getAllByRole('listitem')).toHaveLength(1))
  })

  it('公開のお願い: 見送る takes an optional short reason; a too long one cannot be sent', async () => {
    const { calls } = mockApi(withoutFolder({
      [`GET ${base}/skill-shelf/requests`]: { body: ok({ requests: [request] }) },
      [`POST ${base}/skill-shelf/requests/r_1/decline`]: { body: ok({ request: { ...request, state: 'declined' } }) },
    }))
    renderInCompany(<SkillsRoute />)
    const list = await screen.findByRole('list', { name: '公開のお願い' })
    await userEvent.click(within(list).getByRole('button', { name: '見送る' }))
    const box = screen.getByLabelText('理由（なくてもかまいません）')
    await userEvent.type(box, 'あ'.repeat(201))
    expect(screen.getAllByRole('button', { name: '見送る' }).at(-1)).toBeDisabled()
    await userEvent.clear(box)
    await userEvent.type(box, '  いまは使わないため  ')
    await userEvent.click(screen.getAllByRole('button', { name: '見送る' }).at(-1)!)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ reason: 'いまは使わないため' })
    await waitFor(() => expect(screen.queryByRole('list', { name: '公開のお願い' })).not.toBeInTheDocument())
  })

  it('a version published from a request says whose request it was', async () => {
    mockApi(withoutFolder({
      [`GET ${base}/skill-shelf/s_1/versions`]: { body: ok({ ...versions, history: [{ action: 'publish', version: V2, at: '2026-11-07T01:00:00.000Z', by: { id: 'u_owner', name: '佐藤 花子' }, requestedBy: { id: 'u_bob', name: '鈴木 一郎' } }] }) },
    }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: 'これまでの版' }))
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    expect(within(list).getByText('鈴木 一郎さんのお願いで公開しました')).toBeInTheDocument()
  })

  it('a company with the shared folder gets a note and the server is not asked', async () => {
    const { calls } = mockApi(companyRoutes())
    renderInCompany(<SkillsRoute />)
    expect(await screen.findByText(SHELF_WITH_FOLDER_NOTE)).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/skill-shelf'))).toBe(false)
  })

  it('the menu offers it only in a company without the shared folder, to owners, admins and managers', () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'skills')!
    const ctx = { isAdmin: true, isManager: false, canViewAgentEvents: true }
    expect(item.visible!({ ...ctx, hasCompanyFolder: false })).toBe(true)
    expect(item.visible!({ ...ctx, isAdmin: false, isManager: true, hasCompanyFolder: false })).toBe(true)
    expect(item.visible!({ ...ctx, isAdmin: false, hasCompanyFolder: false })).toBe(false)
    expect(item.visible!({ ...ctx, hasCompanyFolder: true })).toBe(false)
    expect(item.visible!(ctx)).toBe(false)
    // 「Skill を直せる人」 decide requests there too.
    expect(item.visible!({ ...ctx, isAdmin: false, isSkillEditor: true, hasCompanyFolder: false })).toBe(true)
    expect(item.visible!({ ...ctx, isAdmin: false, isSkillEditor: true, hasCompanyFolder: true })).toBe(false)
  })

  it('見える人のまとまり is in the menu for owners and admins', () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'groups')!
    const ctx = { isAdmin: true, isManager: false, canViewAgentEvents: true }
    expect(item.label).toBe('見える人のまとまり')
    expect(item.visible!(ctx)).toBe(true)
    expect(item.visible!({ ...ctx, isAdmin: false, isManager: true })).toBe(false)
  })
})
