// やることの一覧の設定 (stage 2 S6): who sees the page, that a department
// manager never loads (or changes) the company settings and may change
// membership only where the server says so, and what a save sends.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import TaskListSettingsPage from '@/app/companies/[id]/task-list/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { AbsenceCreated, Capabilities, DepartmentMembersView, MemberAbsencesView, TaskSettingsView } from '@/lib/api'
import { defaultTaskSettings } from '../../shared/core/task-settings'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { departments, managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/task-list`,
  useSearchParams: () => new URLSearchParams(),
}))

const view: TaskSettingsView = { settings: defaultTaskSettings(), canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, membership: (id: string) => DepartmentMembersView, extra: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const memberRoutes = Object.fromEntries(departments.map((d) => [`GET ${base}/departments/${d.id}/members`, { body: ok(membership(d.id)) }]))
  const routes = { ...companyRoutes(caps), ...memberRoutes, [`GET ${base}/task-settings`]: { body: ok(view) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    const method = init?.method ?? 'GET'
    const call: Call = { method, url, headers: {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = routes[`${method} ${url}`]
    const reply = !route ? { status: 404, body: { error: `no fixture for ${method} ${url}` } } : typeof route === 'function' ? route(call) : route
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

describe('やることの一覧の設定', () => {
  it('is in the menu for owners, admins and department managers only', () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'task-list')!
    expect(item.visible?.({ isAdmin: false, isManager: false, canViewAgentEvents: true })).toBe(false)
    expect(item.visible?.({ isAdmin: false, isManager: true, canViewAgentEvents: false })).toBe(true)
    expect(item.visible?.({ isAdmin: true, isManager: false, canViewAgentEvents: false })).toBe(true)
  })

  it('a manager sees no company settings and may change only the departments the server allows', async () => {
    const calls = stubApi(managerCapabilities, (id) => ({ members: [], canEdit: id === 'd_sales' }))
    renderInCompany(<TaskListSettingsPage />)
    const list = await screen.findByRole('list', { name: '部署に所属する人' })
    await waitFor(() => expect(within(list).getAllByRole('button', { name: '所属する人を変える' })).toHaveLength(1))
    expect(within(list).getByText('営業部').closest('li')).toContainElement(within(list).getByRole('button', { name: '所属する人を変える' }))
    expect(screen.queryByText('届いた連絡に締め切りが書いていないとき、いつまでに返しますか？')).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/task-settings'))).toBe(false)
  })

  it('an owner’s save sends the whole document with the answers chosen', async () => {
    const calls = stubApi(ownerCapabilities, () => ({ members: [], canEdit: true }), {
      [`PUT ${base}/task-settings`]: (call) => ({ body: ok({ ...view, settings: call.body, updatedAt: '2026-11-01T00:00:00.000Z' }) }),
    })
    renderInCompany(<TaskListSettingsPage />)
    await userEvent.click(await screen.findByRole('radio', { name: /その日のうち/ }))
    const cutoff = screen.getByLabelText(/この時刻より後に届いたものは/)
    await userEvent.clear(cutoff)
    await userEvent.type(cutoff, '16:30')
    await userEvent.click(screen.getByRole('radio', { name: /選んだ部署だけ/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: '営業部' }))
    await userEvent.type(screen.getByLabelText('日付'), '2026-12-29')
    await userEvent.type(screen.getByLabelText(/名前/), '年末')
    await userEvent.click(screen.getByRole('button', { name: '休みに足す' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      ...defaultTaskSettings(),
      taskListDepartmentIds: ['d_sales'],
      reply: { rule: 'same-day', sameDayCutoff: '16:30' },
      companyHolidays: [{ date: '2026-12-29', name: '年末' }],
    })
  })

  it('a daily limit outside the allowed range cannot be saved', async () => {
    const calls = stubApi(ownerCapabilities, () => ({ members: [], canEdit: true }))
    renderInCompany(<TaskListSettingsPage />)
    await userEvent.click(await screen.findByRole('radio', { name: /進めさせる/ }))
    const limit = screen.getByLabelText('1人につき、1日に何回まで進めますか？')
    await userEvent.clear(limit)
    await userEvent.type(limit, '0')
    expect(screen.getByText('入力を直してから保存してください')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('不在・代わりの人: only where the server allows, for that member, and the delegate’s blind spots are told', async () => {
    const tanaka = { userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com' }
    const suzuki = { userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com' }
    const absences: MemberAbsencesView = { userId: 'u_member', absences: [], canEdit: true, covering: [], today: '2026-11-02' }
    const created: AbsenceCreated = {
      absence: { id: 'ab1', userId: 'u_member', from: '2026-11-02', until: '2026-11-06', delegateId: 'u_owner', delegateName: '佐藤 花子', active: true, setBy: 'u_member', setAt: '2026-11-01T00:00:00.000Z' },
      delegateCannotRead: 2,
    }
    const calls = stubApi(managerCapabilities, (id) => ({ members: id === 'd_sales' ? [tanaka] : [suzuki], canEdit: id === 'd_sales' }), {
      [`GET ${base}/absences?userId=u_member`]: { body: ok(absences) },
      [`POST ${base}/absences`]: { status: 201, body: ok(created) },
    })
    renderInCompany(<TaskListSettingsPage />)
    const list = await screen.findByRole('list', { name: '部署に所属する人' })
    await waitFor(() => expect(within(list).getAllByRole('button', { name: /不在・代わりの人/ })).toHaveLength(1))
    expect(within(list).queryByRole('button', { name: '鈴木 一郎さんの不在・代わりの人' })).not.toBeInTheDocument()

    await userEvent.click(within(list).getByRole('button', { name: '田中 太郎さんの不在・代わりの人' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('これからの不在は、まだありません。')
    expect(within(dialog).queryByRole('option', { name: '田中 太郎' })).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('終わりの日'), '2026-11-06')
    await userEvent.selectOptions(within(dialog).getByLabelText('代わりの人'), 'u_owner')
    await userEvent.click(within(dialog).getByRole('button', { name: '追加' }))

    expect(await within(dialog).findByText('代わりの人が見られないものが 2 件あります。部署の管理役に知らせました。')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ userId: 'u_member', from: '2026-11-02', until: '2026-11-06', delegateId: 'u_owner' })
  })
})
