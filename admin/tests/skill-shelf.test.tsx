// 会社の Skill (plugins.md "The Skill shelf"): a company without the shared folder lists its
// Skills, instruction texts and rule files with the version handed out, who changed it and when;
// shows the earlier versions and puts one back with the version the page saw; takes an item off
// after a confirmation; offers no change where the server says the caller may not; a company with
// the shared folder gets a note and no call. The menu shows the page only for such a company.
import type { ReactNode } from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import SkillsRoute from '@/app/companies/[id]/skills/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import { SHELF_WITH_FOLDER_NOTE } from '@/components/skill-shelf/skill-shelf-page'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { company, ok } from './fixtures'
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
  ...extra,
})

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

  it('puts an earlier version back, sending the version the page saw', async () => {
    const restored = { ...quote, version: V1 }
    const { calls } = mockApi(withoutFolder({ [`POST ${base}/skill-shelf/s_1/restore`]: { body: ok({ item: restored, changed: true }) } }))
    renderInCompany(<SkillsRoute />)
    const skills = await screen.findByRole('list', { name: 'Skill' })
    await userEvent.click(within(skills).getByRole('button', { name: 'これまでの版' }))
    const list = await screen.findByRole('list', { name: 'これまでの版' })
    expect(within(list).getByText('いま配っている版')).toBeInTheDocument()
    expect(within(list).getByText(/自動で動く部分があります/)).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: 'この版に戻す' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: V1, expectedVersion: V2 })
    expect(await screen.findByText('配っています（版 aaaaaaaa・ファイル 2 個）')).toBeInTheDocument()
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
  })
})
