import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import DepartmentsPage from '@/app/companies/[id]/departments/page'
import MembersPage from '@/app/companies/[id]/members/page'
import OverviewPage from '@/app/companies/[id]/page'
import SecurityAlertsPage from '@/app/companies/[id]/alerts/page'
import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { ErrorState } from '@/components/app/states'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { COMPANY_ID, busyOverview, departments, homeOf, managerCapabilities, ok, quietOverview } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))


describe('shared states', () => {
  it('error state explains and retries', async () => {
    const onRetry = vi.fn()
    render(<ErrorState error={new TypeError('Failed to fetch')} onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('サーバーに接続できません')
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('type-to-confirm stays disabled until the exact name is typed', async () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <ConfirmByTypingDialog
        open
        onOpenChange={() => {}}
        title="部署を削除"
        confirmText="営業部"
        confirmLabel="削除する"
        onConfirm={onConfirm}
      />
    )
    const button = screen.getByRole('button', { name: '削除する' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), '営業')
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), '部')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

describe('ホーム', () => {
  it('shows the empty state when nothing needs attention, and the steps folded once all are done', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/home`]: { body: ok(homeOf(quietOverview)) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
    expect(screen.getByText('最初にやることは全部終わりました')).toBeInTheDocument()
    expect(screen.getByText('3人')).toBeInTheDocument()
  })

  it('lists 「最初にやること」: done ones struck, the next with 「始める」, Google as the operator\'s work', async () => {
    const home = homeOf(quietOverview)
    const setup = { ...home.setup!, done: 3, steps: home.setup!.steps.map((s, i) => ({ ...s, done: i < 3 })) }
    mockApi({ ...companyRoutes(), [`GET ${base}/home`]: { body: ok({ ...home, setup }) } })
    renderInCompany(<OverviewPage />)
    const list = await screen.findByRole('list', { name: '最初にやること' })
    expect(screen.getByText('3 / 6')).toBeInTheDocument()
    const google = within(list).getByText(/Google をつなぐ/).closest('li')!
    expect(within(google).getByText('運用担当者に頼む')).toBeInTheDocument()
    // The next step is the operator's: no 「始める」 there, it opens つなぎ先.
    expect(within(google).getByRole('link', { name: '開く' })).toHaveAttribute('href', `/companies/${COMPANY_ID}/integrations`)
    const holidays = within(list).getByText(/会社の休みを確かめる/).closest('li')!
    expect(within(holidays).getByRole('link', { name: '開く' })).toHaveAttribute('href', `/companies/${COMPANY_ID}/advanced/calendar`)
    expect(within(list).getAllByLabelText('終わった')).toHaveLength(3)
  })

  it('gathers what was elsewhere: the same meeting\'s duplicates and plugins that stopped', async () => {
    const home = homeOf(quietOverview)
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/home`]: { body: ok({ ...home, attention: { ...home.attention, meetingDuplicates: 2, stoppedPlugins: [{ id: 'sales', label: '法人営業', problem: 'no-key' }] } }) },
    })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('同じ会議から重複して作られた記録')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /まとめる/ })).toHaveAttribute('href', `/companies/${COMPANY_ID}/duplicates`)
    expect(screen.getByText('法人営業')).toBeInTheDocument()
  })

  it('shows 「気になる動き」 with what to do, and leads to the full list; nothing when there is none', async () => {
    const home = homeOf(quietOverview)
    const alert = {
      id: 'al1', kind: 'sign_in_failures', title: '佐藤さんのアカウントで、パスワードの間違いが続きました',
      detail: '15分の間に12回…', action: '本人に心当たりがあるか聞いてください。', userId: 'u1', name: '佐藤', createdAt: '2026-11-05T03:00:00.000Z',
    }
    mockApi({ ...companyRoutes(), [`GET ${base}/home`]: { body: ok({ ...home, attention: { ...home.attention, securityAlerts: [alert] } }) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('気になる動き')).toBeInTheDocument()
    expect(screen.getByText(alert.title)).toBeInTheDocument()
    expect(screen.getByText(alert.action)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /気になる動きをすべて見る/ })).toHaveAttribute('href', `/companies/${COMPANY_ID}/alerts`)
  })

  it('the 「気になる動き」 page saves the Slack choice (off at first)', async () => {
    const api = mockApi({
      ...companyRoutes(),
      [`GET ${base}/security-alerts`]: { body: ok({ items: [], settings: { slackDm: false, updatedAt: null } }) },
      [`PUT ${base}/security-alerts/settings`]: { body: ok({ slackDm: true, updatedAt: '2026-11-05T03:00:00.000Z' }) },
    })
    renderInCompany(<SecurityAlertsPage />)
    expect(await screen.findByText('気になる動きはありません')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /管理画面だけ/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('radio', { name: /Slack でも知らせる/ }))
    await waitFor(() => expect(api.calls.filter(c => c.method === 'PUT').map(c => c.body)).toEqual([{ slackDm: true }]))
    await waitFor(() => expect(screen.getByRole('radio', { name: /Slack でも知らせる/ })).toHaveAttribute('aria-checked', 'true'))
  })

  it('lists rejections in plain Japanese and shows unknown markers raw', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/home`]: { body: ok(homeOf(busyOverview)) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('管理者だけが変更できる設定ファイルが含まれていた')).toBeInTheDocument()
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument()
    expect(screen.getByText('ほか1件')).toBeInTheDocument()
    expect(screen.getByText('アプリの更新が必要です')).toBeInTheDocument()
    expect(screen.getByText('アプリのバージョンがわかりません')).toBeInTheDocument()
  })

  it('offers a retry when the home fails', async () => {
    let fail = true
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/home`]: () => (fail ? { status: 500, body: { error: 'boom' } } : { body: ok(homeOf(quietOverview)) }),
    })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('サーバーでエラーが発生しました')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
  })

  it('a malformed answer shows the error state, not an empty "nothing to do"', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/home`]: { body: ok({ view: 'admin', attention: null }) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('応答を正しく読み取れなかった')
    expect(screen.queryByText('対応が必要なことはありません')).not.toBeInTheDocument()
  })

  it('a department manager: no steps, their departments named', async () => {
    const home = homeOf(quietOverview, { view: 'manager', setup: null, departments: [{ id: 'd_sales', name: '営業部' }] })
    mockApi({ ...companyRoutes(managerCapabilities), [`GET ${base}/home`]: { body: ok(home) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText(/営業部の部署の管理役として開いています/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '最初にやること' })).not.toBeInTheDocument()
    expect(screen.queryByText('最初にやることは全部終わりました')).not.toBeInTheDocument()
  })

  it('a member sees their own role and never asks for the home', async () => {
    const { calls } = mockApi(companyRoutes({ role: 'member', managedDepartmentIds: [], canViewAgentEvents: false }))
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('あなたの役割: メンバー')).toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/home'))).toBe(false)
  })
})

describe('メンバー', () => {
  it('shows roles, managed departments and build badges for admins', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: { body: ok(busyOverview) } })
    renderInCompany(<MembersPage />)
    const row = (await screen.findByText('田中 太郎')).closest('tr')!
    await waitFor(() => expect(within(row).getByText('営業部')).toBeInTheDocument())
    expect(within(row).getByText('不明')).toBeInTheDocument()
    const adminRow = screen.getByText('鈴木 一郎').closest('tr')!
    expect(within(adminRow).getByText('古い')).toBeInTheDocument()
    const ownerRow = screen.getByText('佐藤 花子').closest('tr')!
    expect(within(ownerRow).getByText('最新')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'メンバーを招待' })).toBeInTheDocument()
    expect(await screen.findByText('メンバーとして招待')).toBeInTheDocument()
  })

  it('filters by search text', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: { body: ok(quietOverview) } })
    renderInCompany(<MembersPage />)
    await screen.findByText('田中 太郎')
    await userEvent.type(screen.getByRole('searchbox', { name: 'メンバーを検索' }), 'suzuki')
    expect(screen.queryByText('田中 太郎')).not.toBeInTheDocument()
    expect(screen.getByText('鈴木 一郎')).toBeInTheDocument()
  })

  it('hides admin-only columns and actions from members', async () => {
    const { calls } = mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<MembersPage />)
    await screen.findByText('田中 太郎')
    expect(screen.queryByRole('button', { name: 'メンバーを招待' })).not.toBeInTheDocument()
    expect(screen.queryByText('最終同期')).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/client-activity'))).toBe(false)
  })
})

describe('部署', () => {
  it('lists departments in order with their managers', async () => {
    mockApi(companyRoutes())
    renderInCompany(<DepartmentsPage />)
    const list = await screen.findByRole('list', { name: '部署の一覧' })
    const names = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(names[0]).toContain('営業部')
    expect(names[1]).toContain('開発部')
    await waitFor(() => expect(within(list).getByText('田中 太郎')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /営業部 を並べ替え/ })).toBeInTheDocument()
  })

  it('is read-only for members, with their own departments marked', async () => {
    mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<DepartmentsPage />)
    await screen.findByRole('list', { name: '部署の一覧' })
    expect(await screen.findByText('あなたが管理役')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '部署を追加' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /を並べ替え/ })).not.toBeInTheDocument()
  })

  it('a new department: says who edits and who reads, then asks who belongs to it at once', async () => {
    const created = { ...departments[0], id: 'd_new', name: '広報部', folder: '広報部', sortOrder: 3 }
    let list = departments
    const members = Object.fromEntries(
      [...departments, created].map((d) => [`GET ${base}/departments/${d.id}/members`, { body: ok({ members: [], canEdit: true }) }])
    )
    const { calls } = mockApi({
      ...companyRoutes(),
      ...members,
      [`GET ${base}/departments/d_new/managers`]: { body: ok({ managers: [] }) },
      [`GET ${base}/departments?flat=true`]: () => ({ body: ok(list) }),
      [`POST ${base}/departments`]: () => {
        list = [...departments, created]
        return { status: 201, body: ok(created) }
      },
    })
    renderInCompany(<DepartmentsPage />)
    await screen.findByRole('list', { name: '部署の一覧' })
    await userEvent.click(screen.getAllByRole('button', { name: '部署を追加' })[0])
    const form = await screen.findByRole('dialog', { name: '部署を追加' })
    expect(within(form).getByText(/編集できるのは部署に所属する人（とオーナー・管理者）だけです/)).toHaveTextContent(
      /だれも所属していないため、所属する人を決めるまでは、オーナーと管理者だけが編集できます。人に見せたくないものは、部署の中に非公開フォルダ/
    )
    await userEvent.type(within(form).getByLabelText('部署名'), '広報部')
    await userEvent.click(within(form).getByRole('button', { name: '部署を追加' }))

    expect(await screen.findByRole('dialog', { name: '「広報部」に所属する人' })).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/departments'))).toBe(true)
  })

  it('shows an empty state with the next action', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/departments?flat=true`]: { body: ok([]) } })
    renderInCompany(<DepartmentsPage />)
    expect(await screen.findByText('部署がありません')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '部署を追加' }).length).toBeGreaterThan(0)
  })
})
