import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import DepartmentsPage from '@/app/companies/[id]/departments/page'
import MembersPage from '@/app/companies/[id]/members/page'
import OverviewPage from '@/app/companies/[id]/page'
import PermissionsPage from '@/app/companies/[id]/permissions/page'
import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { EmptyState, ErrorState } from '@/components/app/states'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/lib/auth-context'
import { CompanyProvider } from '@/lib/company-context'
import { CheckCircle } from '@phosphor-icons/react'
import {
  COMPANY_ID,
  busyOverview,
  clientActivity,
  company,
  departments,
  invitations,
  managerCapabilities,
  managers,
  members,
  ok,
  ownerCapabilities,
  permissionScopes,
  quietOverview,
} from './fixtures'
import { mockApi, pending } from './mock-api'

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

const base = `/api/companies/${COMPANY_ID}`

function companyRoutes(caps = ownerCapabilities) {
  const managerRoutes = Object.fromEntries(
    departments.map((d) => [`GET ${base}/departments/${d.id}/managers`, { body: ok({ managers: managers[d.id] }) }])
  )
  return {
    'GET /api/me': { body: ok({ id: 'u_owner', email: 'sato@example.com', name: '佐藤 花子' }) },
    [`GET ${base}`]: { body: ok({ ...company, role: caps.role }) },
    'GET /api/companies': { body: ok([company]) },
    [`GET ${base}/me/capabilities`]: { body: ok(caps) },
    [`GET ${base}/members`]: { body: ok(members) },
    [`GET ${base}/departments?flat=true`]: { body: ok(departments) },
    [`GET ${base}/client-activity`]: { body: ok(clientActivity) },
    [`GET ${base}/invitations`]: { body: ok(invitations) },
    ...managerRoutes,
  }
}

function renderInCompany(ui: ReactNode) {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <CompanyProvider companyId={COMPANY_ID}>{ui}</CompanyProvider>
      </AuthProvider>
    </TooltipProvider>
  )
}

describe('shared states', () => {
  it('empty state shows its next action', () => {
    render(<EmptyState icon={CheckCircle} title="何もありません" action={<button>追加</button>} />)
    expect(screen.getByText('何もありません')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '追加' })).toBeInTheDocument()
  })

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

describe('概要', () => {
  it('shows a loading skeleton while the overview loads', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: () => pending() })
    renderInCompany(<OverviewPage />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '概要' })).toBeInTheDocument())
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('shows the empty state when nothing needs attention', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: { body: ok(quietOverview) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
    expect(screen.getByText('3人')).toBeInTheDocument()
  })

  it('lists rejections in plain Japanese and shows unknown markers raw', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: { body: ok(busyOverview) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('管理者だけが変更できる設定ファイルが含まれていた')).toBeInTheDocument()
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument()
    expect(screen.getByText('ほか1件')).toBeInTheDocument()
    expect(screen.getByText('アプリの更新が必要です')).toBeInTheDocument()
    expect(screen.getByText('アプリのバージョンがわかりません')).toBeInTheDocument()
  })

  it('offers a retry when the overview fails', async () => {
    let fail = true
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/overview`]: () => (fail ? { status: 500, body: { error: 'boom' } } : { body: ok(quietOverview) }),
    })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('サーバーでエラーが発生しました')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
  })

  it('members and managers see their own role instead of the admin overview', async () => {
    const { calls } = mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('あなたの役割: メンバー')).toBeInTheDocument()
    expect(await screen.findByText('営業部')).toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/overview'))).toBe(false)
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
    expect(await screen.findByText('あなたが責任者')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '部署を追加' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /を並べ替え/ })).not.toBeInTheDocument()
  })

  it('shows an empty state with the next action', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/departments?flat=true`]: { body: ok([]) } })
    renderInCompany(<DepartmentsPage />)
    expect(await screen.findByText('部署がありません')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '部署を追加' }).length).toBeGreaterThan(0)
  })
})

describe('権限', () => {
  it('shows the company default prominently and marks inherited scopes', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/permissions`]: { body: ok({ scopes: permissionScopes }) } })
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('会社全体の基本ルール')).toBeInTheDocument()
    expect(screen.getAllByText('全員が閲覧・編集できます').length).toBeGreaterThan(0)
    expect(screen.getAllByText('継承 · 全員が閲覧・編集できます')).toHaveLength(2)
    expect(screen.getByText('一部の人だけがアクセスできます')).toBeInTheDocument()
    expect(screen.getAllByText('閲覧・編集', { selector: 'span' })).toHaveLength(2)
    // Read-only: no editing controls at all.
    expect(screen.queryByRole('button', { name: /編集|変更|追加/ })).not.toBeInTheDocument()
  })

  it('explains when the user may not view permissions', async () => {
    mockApi({
      ...companyRoutes(managerCapabilities),
      [`GET ${base}/permissions`]: { status: 403, body: { error: 'Only owners, admins and department managers can view permissions' } },
    })
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('権限を確認できるのは、オーナー・管理者と部署の責任者です')).toBeInTheDocument()
  })
})
