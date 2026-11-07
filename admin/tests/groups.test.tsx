// 見える人のまとまり (server.md "Groups", owner decisions 2026-11-07): owners and admins create a
// group, choose who is in it and change it; a group a place still uses cannot be deleted and the
// page says where it is used; anyone else is not offered the page; the メンバー page links to it.
import type { ReactNode } from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import GroupsRoute from '@/app/companies/[id]/groups/page'
import MembersPage from '@/app/companies/[id]/members/page'
import { GROUPS_WITH_FOLDER_NOTE } from '@/components/groups/groups-page'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { company, managerCapabilities, ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123/groups',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const saiyo = { id: 'g_1', name: '採用チーム', memberIds: ['u_member'], usedIn: ['人事部/採用'], createdAt: '2026-11-07T00:00:00.000Z' }

const withoutFolder = (extra: Record<string, unknown> = {}) => ({
  ...companyRoutes(),
  [`GET ${base}`]: { body: ok({ ...company, role: 'owner', folderKind: 'none' }) },
  [`GET ${base}/groups`]: { body: ok({ groups: [saiyo] }) },
  ...extra,
})

describe('見える人のまとまり', () => {
  it('lists each group with who is in it and where it is used, in plain words', async () => {
    mockApi(withoutFolder())
    renderInCompany(<GroupsRoute />)
    const list = await screen.findByRole('list', { name: '見える人のまとまり' })
    expect(within(list).getByText('採用チーム')).toBeInTheDocument()
    expect(within(list).getByText('1人：田中 太郎')).toBeInTheDocument()
    expect(within(list).getByText('使っている場所：人事部 › 採用')).toBeInTheDocument()
    expect(screen.getByText(/オーナーと管理者は、まとまりに入れなくても、いつでもすべてを見られます/)).toBeInTheDocument()
    expect(screen.queryByText(GROUPS_WITH_FOLDER_NOTE)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/権限|スコープ|グループ/)
  })

  it('creates a group with a name and the members chosen', async () => {
    const made = { id: 'g_2', name: '役員', memberIds: ['u_admin'], usedIn: [], createdAt: '2026-11-07T00:00:00.000Z' }
    const { calls } = mockApi(withoutFolder({ [`POST ${base}/groups`]: { status: 201, body: ok(made) } }))
    renderInCompany(<GroupsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: 'まとまりを作る' }))
    await userEvent.type(screen.getByLabelText('名前'), '役員')
    await userEvent.click(screen.getByRole('option', { name: /鈴木 一郎/ }))
    await userEvent.click(screen.getByRole('button', { name: '作る' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '役員', userIds: ['u_admin'] })
    expect(await screen.findByText('1人：鈴木 一郎')).toBeInTheDocument()
  })

  it('changes who is in a group (the whole set is sent)', async () => {
    const saved = { ...saiyo, memberIds: ['u_member', 'u_admin'] }
    const { calls } = mockApi(withoutFolder({ [`PUT ${base}/groups/g_1/members`]: { body: ok(saved) } }))
    renderInCompany(<GroupsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '入る人を変える' }))
    await userEvent.click(screen.getByRole('option', { name: /鈴木 一郎/ }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ userIds: ['u_member', 'u_admin'] })
    expect(await screen.findByText('2人：田中 太郎、鈴木 一郎')).toBeInTheDocument()
  })

  it('a group still in use is not deleted, and the page names where it is used', async () => {
    mockApi(withoutFolder({
      [`DELETE ${base}/groups/g_1`]: {
        status: 409,
        body: { error: 'このまとまりは見られる人の設定で使われています。先にその場所の設定から外してください。', code: 'GROUP_IN_USE', places: ['人事部/採用'] },
      },
    }))
    renderInCompany(<GroupsRoute />)
    await userEvent.click(await screen.findByRole('button', { name: '「採用チーム」を削除' }))
    await userEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(await screen.findByText(/先にその場所の設定から外してください。（人事部 › 採用）/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '見える人のまとまり' })).toHaveTextContent('採用チーム')
  })

  it('in a company with the shared folder says where groups can be used today', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/groups`]: { body: ok({ groups: [] }) } })
    renderInCompany(<GroupsRoute />)
    expect(await screen.findByText(GROUPS_WITH_FOLDER_NOTE)).toBeInTheDocument()
  })

  it('a department manager is not offered the page and the server is not asked', async () => {
    const { calls } = mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<GroupsRoute />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます。')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/groups'))).toBe(false)
  })

  it('「メンバー」 links to it for owners and admins', async () => {
    mockApi(companyRoutes())
    renderInCompany(<MembersPage />)
    expect(await screen.findByRole('link', { name: /見える人のまとまり/ })).toHaveAttribute('href', '/companies/co_123/groups')
  })
})
