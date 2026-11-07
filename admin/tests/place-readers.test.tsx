// 「見られる人」 on 「部署」 (server.md "Groups and read-restricted places", owner decision 2026-11-08):
// in a company without the shared folder, owners and admins choose who reads a department and the
// places inside it — everyone, or chosen people, departments and groups — and the page says owners
// and admins always read; a department manager sees their department's read only; a company with the
// shared folder is not offered it and the server is not asked.
import type { ReactNode } from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import DepartmentsPage from '@/app/companies/[id]/departments/page'
import { OWNERS_ALWAYS_READ, READERS_READ_ONLY_NOTE } from '@/components/departments/place-readers-dialog'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { company, managerCapabilities, ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123/departments',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const saiyo = { id: 'g_1', name: '採用チーム', memberIds: ['u_member'], usedIn: [], createdAt: '2026-11-07T00:00:00.000Z' }
const rule = (id: string, subjectType: string, subjectId: string | null, subjectLabel: string, canRead: boolean, canWrite: boolean) =>
  ({ id, subjectType, subjectId, subjectLabel, canRead, canWrite })
const scope = (id: string, path: string, rules: unknown[], extra: Record<string, unknown> = {}) => ({
  id, path, kind: path === '' ? 'company' : 'department', departmentId: null, repoId: null, inherited: rules.length === 0, rules,
  effectiveSummary: 'everyone-rw', inheritedFrom: null, ...extra,
})
const ROOT = scope('s_root', '', [rule('r0', 'everyone', null, '全員', true, true)])
// 人事部 as a new department is made: everyone reads, the people who belong write.
const HR_OPEN = scope('s_hr', '人事部', [rule('r1', 'everyone', null, '全員', true, false), rule('r2', 'department', 'd_hr', '人事部に所属する人', true, true)])
const HR_RESTRICTED = scope('s_hr', '人事部', [rule('r1', 'everyone', null, '全員', false, false), rule('r3', 'group', 'g_1', '採用チームの人', true, true), rule('r2', 'department', 'd_hr', '人事部に所属する人', true, true)], { readRestricted: true })
const HR_SAIYO = scope('s_saiyo', '人事部/採用', [rule('r4', 'everyone', null, '全員', false, false), rule('r5', 'user', 'u_member', '田中 太郎', true, false)], { kind: 'folder', readRestricted: true })

const withoutFolder = (scopes: unknown[], extra: Record<string, unknown> = {}, caps?: typeof managerCapabilities) => {
  const routes = caps ? companyRoutes(caps) : companyRoutes()
  return {
    ...routes,
    [`GET ${base}`]: { body: ok({ ...company, role: caps?.role ?? 'owner', folderKind: 'none' }) },
    [`GET ${base}/permissions`]: { body: ok({ scopes, orphanedScopes: [] }) },
    [`GET ${base}/groups`]: { body: ok({ groups: [saiyo] }) },
    [`GET ${base}/task-settings`]: { body: ok({ settings: {}, canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }) },
    ...extra,
  }
}
const saved = { body: ok({ scope: { id: 's_hr', path: '人事部', kind: 'department', inherited: false }, rules: [] }) }

async function openReaders(name: RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('dialog')
}

describe('見られる人 of a department (no shared folder)', () => {
  it('the row says who reads; an owner restricts it to a group and a person, and owners/admins are said to read always', async () => {
    const { calls } = mockApi(withoutFolder([ROOT, HR_OPEN], { [`PUT ${base}/permissions/scopes/by-path`]: saved }))
    renderInCompany(<DepartmentsPage />)
    const dialog = await openReaders(/人事部 を見られる人：全員/)
    expect(within(dialog).getByText(OWNERS_ALWAYS_READ)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '変える' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: /選んだ人だけ/ }))
    // Owners and admins are never offered (they always read).
    expect(within(dialog).queryByRole('option', { name: /鈴木 一郎/ })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('option', { name: /採用チームの人/ }))
    await userEvent.click(within(dialog).getByRole('option', { name: /田中 太郎/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({
      path: '人事部',
      rules: [
        { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
        // Who writes is kept: nobody new writes (everyone did not), the department's people still would.
        { subjectType: 'group', subjectId: 'g_1', canRead: true, canWrite: false },
        { subjectType: 'user', subjectId: 'u_member', canRead: true, canWrite: false },
      ],
    })
    expect(document.body.textContent).not.toMatch(/権限|スコープ|グループ|ルール/)
  })

  it('back to 全員: everyone reads again, the department\'s own writers stay, the group goes', async () => {
    const { calls } = mockApi(withoutFolder([ROOT, HR_RESTRICTED], { [`PUT ${base}/permissions/scopes/by-path`]: saved }))
    renderInCompany(<DepartmentsPage />)
    const dialog = await openReaders(/人事部 を見られる人：採用チームの人、人事部に所属する人/)
    await userEvent.click(within(dialog).getByRole('button', { name: '変える' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: /全員/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      path: '人事部',
      rules: [
        { subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false },
        { subjectType: 'department', subjectId: 'd_hr', canRead: true, canWrite: true },
      ],
    })
  })

  it('makes a place inside a department (人事部 › 採用) by choosing who reads it', async () => {
    const { calls } = mockApi(withoutFolder([ROOT, HR_RESTRICTED], { [`PUT ${base}/permissions/scopes/by-path`]: saved }))
    renderInCompany(<DepartmentsPage />)
    const dialog = await openReaders(/人事部 を見られる人/)
    await userEvent.type(within(dialog).getByLabelText('場所を作る'), '採用')
    await userEvent.click(within(dialog).getByRole('button', { name: /作って見られる人を選ぶ/ }))
    expect(within(dialog).getByText(/「人事部 › 採用」は、見られる人を選んで保存すると作られます/)).toBeInTheDocument()
    expect(within(dialog).getByText(/選んだ人のうち、「人事部」を見られる人だけが見られます/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('option', { name: /田中 太郎/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      path: '人事部/採用',
      rules: [
        { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
        { subjectType: 'user', subjectId: 'u_member', canRead: true, canWrite: false },
      ],
    })
  })

  it('a place inside is listed with who reads it; 部署と同じ sends no rules of its own', async () => {
    const { calls } = mockApi(withoutFolder([ROOT, HR_RESTRICTED, HR_SAIYO], { [`PUT ${base}/permissions/scopes/by-path`]: saved }))
    renderInCompany(<DepartmentsPage />)
    const dialog = await openReaders(/人事部 を見られる人/)
    const list = within(dialog).getByRole('list', { name: '部署の中の場所' })
    expect(within(list).getByText('人事部 › 採用')).toBeInTheDocument()
    expect(within(list).getByText('見られる人：田中 太郎')).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: '人事部 › 採用 を見られる人を変える' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: /部署と同じ/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ path: '人事部/採用', rules: [] })
  })

  it('a department manager sees their department read only; groups are not asked for', async () => {
    const sales = scope('s_sales', '営業部', [rule('r6', 'everyone', null, '全員', false, false), rule('r7', 'group', 'g_1', '採用チームの人', true, true)], { readRestricted: true })
    const { calls } = mockApi(withoutFolder([sales], {}, managerCapabilities))
    renderInCompany(<DepartmentsPage />)
    const dialog = await openReaders(/営業部 を見られる人：採用チームの人/)
    expect(within(dialog).getByText(READERS_READ_ONLY_NOTE)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '変える' })).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('場所を作る')).not.toBeInTheDocument()
    // Only their own department has the line.
    expect(screen.queryByRole('button', { name: /人事部 を見られる人/ })).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/groups'))).toBe(false)
  })

  it('a company with the shared folder is not offered it, and the server is not asked', async () => {
    const { calls } = mockApi({ ...companyRoutes(), [`GET ${base}/task-settings`]: { body: ok({ settings: {}, canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }) } })
    renderInCompany(<DepartmentsPage />)
    expect(await screen.findByText('人事部')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /を見られる人/ })).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/permissions') || c.url.includes('/groups'))).toBe(false)
  })
})
