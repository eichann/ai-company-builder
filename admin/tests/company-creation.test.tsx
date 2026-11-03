// 「会社を作成」 only for those the server lets create a company (owner decision
// 2026-11-02): GET /api/me's canCreateCompany, the check POST /api/companies
// makes. An older server's answer lacks the field: offered as before.
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import NewCompanyPage from '@/app/companies/new/page'
import DashboardPage from '@/app/dashboard/page'
import { AppShell } from '@/components/app/app-shell'
import { AuthProvider } from '@/lib/auth-context'
import { companyRoutes, renderInCompany } from './company-harness'
import { ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/companies/co_123',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const me = (canCreateCompany?: boolean) => ({
  body: ok({ id: 'u_1', email: 'sato@example.com', name: '佐藤 花子', ...(canCreateCompany === undefined ? {} : { canCreateCompany }) }),
})

describe('dashboard with no company yet', () => {
  it('someone who may not create one is told to open their invitation link, with no button', async () => {
    mockApi({ 'GET /api/me': me(false), 'GET /api/companies': { body: ok([]) } })
    render(<AuthProvider><DashboardPage /></AuthProvider>)
    expect(await screen.findByText('まだ会社に参加していません')).toBeInTheDocument()
    expect(screen.getByText(/届いた招待リンクを開いてください/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /会社を作成/ })).not.toBeInTheDocument()
  })

  it.each([[true], [undefined]])('canCreateCompany %s: the button is offered', async (flag) => {
    mockApi({ 'GET /api/me': me(flag), 'GET /api/companies': { body: ok([]) } })
    render(<AuthProvider><DashboardPage /></AuthProvider>)
    expect(await screen.findByRole('link', { name: /会社を作成/ })).toHaveAttribute('href', '/companies/new')
  })
})

describe('/companies/new reached by URL', () => {
  it('shows a plain message instead of the form to someone who may not create a company', async () => {
    mockApi({ 'GET /api/me': me(false) })
    render(<AuthProvider><NewCompanyPage /></AuthProvider>)
    expect(await screen.findByText('会社の作成はできません')).toBeInTheDocument()
    expect(screen.queryByLabelText('会社名')).not.toBeInTheDocument()
  })

  it('shows the form to an operator', async () => {
    mockApi({ 'GET /api/me': me(true) })
    render(<AuthProvider><NewCompanyPage /></AuthProvider>)
    expect(await screen.findByLabelText('会社名')).toBeInTheDocument()
  })
})

describe('the company switcher', () => {
  it.each([[false, false], [true, true]])('canCreateCompany %s: 「新しい会社を作成」 shown = %s', async (flag, shown) => {
    mockApi({ ...companyRoutes(), 'GET /api/me': me(flag) })
    renderInCompany(<AppShell>page</AppShell>)
    // The account has loaded (the user menu shows only then).
    await screen.findAllByRole('button', { name: 'アカウントメニュー' })
    const [trigger] = await screen.findAllByRole('button', { name: '会社を切り替える' })
    await userEvent.click(trigger)
    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('menuitem', { name: '新しい会社を作成' }) !== null).toBe(shown)
  })
})
