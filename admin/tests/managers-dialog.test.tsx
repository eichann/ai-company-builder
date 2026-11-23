// 部署の管理役: saving replaces the whole list, so the dialog may only start
// from a loaded list (never from "nobody" while it loads or after it failed),
// and the save names the list it started from (409 MANAGERS_CHANGED).
import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import DepartmentsPage from '@/app/companies/[id]/departments/page'
import { ManagersDialog } from '@/components/departments/managers-dialog'
import type { Department } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { COMPANY_ID, members, ok } from './fixtures'
import { mockApi, pending } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}/departments`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const tanaka = { userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com' }
const suzuki = { userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com' }
const salesManagers = `GET ${base}/departments/d_sales/managers`
const putSales = `PUT ${base}/departments/d_sales/managers`

async function openSalesMenu() {
  await screen.findByRole('list', { name: '部署の一覧' })
  await userEvent.click(screen.getByRole('button', { name: '営業部 の操作' }))
  return screen.findByRole('menuitem', { name: /管理役を設定/ })
}

function option(dialog: HTMLElement, name: string) {
  return within(dialog).getByRole('option', { name: new RegExp(name) })
}

describe('部署の管理役', () => {
  it('cannot be opened while the list is loading (no form starting from nobody)', async () => {
    const { calls } = mockApi({ ...companyRoutes(), [salesManagers]: () => pending() })
    renderInCompany(<DepartmentsPage />)
    const item = await openSalesMenu()
    expect(item).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(item)
    expect(screen.queryByRole('dialog', { name: '「営業部」の管理役' })).not.toBeInTheDocument()
    expect(screen.queryByText(/人を選択中/)).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('after a failed load: the row says so (not 「管理役なし」), the menu stays closed, and 再読み込み brings it back', async () => {
    let fail = true
    mockApi({
      ...companyRoutes(),
      [salesManagers]: () => (fail ? { status: 500, body: { error: 'boom' } } : { body: ok({ managers: [tanaka] }) }),
    })
    renderInCompany(<DepartmentsPage />)
    const list = await screen.findByRole('list', { name: '部署の一覧' })
    expect((await within(list).findAllByText('管理役を読み込めませんでした')).length).toBeGreaterThan(0)
    expect(within(list).queryByText('管理役なし')).not.toBeInTheDocument()
    const item = await openSalesMenu()
    expect(item).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')

    fail = false
    const banner = screen.getByText('管理役を読み込めませんでした。').closest('div') as HTMLElement
    await userEvent.click(within(banner).getByRole('button', { name: '再読み込み' }))
    await waitFor(() => expect(within(list).getByText('田中 太郎')).toBeInTheDocument())
    await userEvent.click(await openSalesMenu())
    const dialog = await screen.findByRole('dialog', { name: '「営業部」の管理役' })
    expect(within(dialog).getByText('1人を選択中')).toBeInTheDocument()
  })

  it('saves the new list together with the list it started from', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [putSales]: { body: ok({ managers: [tanaka, suzuki] }) },
    })
    renderInCompany(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByText('田中 太郎')).toBeInTheDocument())
    await userEvent.click(await openSalesMenu())
    const dialog = await screen.findByRole('dialog', { name: '「営業部」の管理役' })
    await userEvent.click(option(dialog, '鈴木 一郎'))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ userIds: ['u_member', 'u_admin'], expectedUserIds: ['u_member'] })
  })

  it('changed by someone else meanwhile (409 MANAGERS_CHANGED): the form starts again from today\'s list', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [putSales]: {
        status: 409,
        body: { error: 'ほかの人がこの部署の管理役を変えました。', code: 'MANAGERS_CHANGED', managers: [tanaka, suzuki] },
      },
    })
    renderInCompany(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByText('田中 太郎')).toBeInTheDocument())
    await userEvent.click(await openSalesMenu())
    let dialog = await screen.findByRole('dialog', { name: '「営業部」の管理役' })
    await userEvent.click(option(dialog, '田中 太郎')) // take him off: 0 selected
    expect(within(dialog).getByText('0人を選択中')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    // Still open, now showing today's two managers; the next save names them.
    dialog = await screen.findByRole('dialog', { name: '「営業部」の管理役' })
    await waitFor(() => expect(within(dialog).getByText('2人を選択中')).toBeInTheDocument())
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toEqual({
      userIds: ['u_member', 'u_admin'],
      expectedUserIds: ['u_member', 'u_admin'],
    })
  })
})

describe('ManagersDialog without a loaded list', () => {
  const department = { id: 'd_sales', name: '営業部' } as Department

  it('while loading: says so, offers no form and no save', () => {
    render(
      <ManagersDialog open onOpenChange={() => {}} companyId={COMPANY_ID} department={department} current={undefined}
        loadError={undefined} onRetry={() => {}} members={members} onSaved={() => {}} />
    )
    const dialog = screen.getByRole('dialog', { name: '「営業部」の管理役' })
    expect(within(dialog).getByRole('status')).toHaveTextContent('いまの管理役を読み込んでいます')
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/人を選択中/)).not.toBeInTheDocument()
  })

  it('after a failure: explains and retries, still no save', async () => {
    const onRetry = vi.fn()
    render(
      <ManagersDialog open onOpenChange={() => {}} companyId={COMPANY_ID} department={department} current={undefined}
        loadError={new TypeError('Failed to fetch')} onRetry={onRetry} members={members} onSaved={() => {}} />
    )
    const dialog = screen.getByRole('dialog', { name: '「営業部」の管理役' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('いまの管理役を読み込めませんでした')
    expect(within(dialog).queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '再読み込み' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
