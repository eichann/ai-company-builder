// 「管理者の手引き」 in the menu (server.md "The administrator guide"): shown to whoever the server lets
// read /manual-admin/ — an owner or admin of this company or of another one in their list — and
// opened in a tab of its own. Members and 部署の管理役 do not see it (the server answers them 404).
import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/components/app/app-shell'
import { companyRoutes, renderInCompany } from './company-harness'
import { company, managerCapabilities, ok, ownerCapabilities } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${company.id}`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const memberCapabilities = { role: 'member' as const, managedDepartmentIds: [], canViewAgentEvents: false }
const other = { ...company, id: 'co_other', name: '別の会社', slug: 'other' }

async function menuShown() {
  // The account has loaded (the user menu shows only then), and so has the company.
  await screen.findAllByRole('button', { name: 'アカウントメニュー' })
  await screen.findAllByText(company.name)
}

describe('「管理者の手引き」 in the menu', () => {
  it.each([
    ['an owner', ownerCapabilities],
    ['an admin', { ...ownerCapabilities, role: 'admin' as const }],
  ])('%s sees it, opening the guide in a new tab', async (_who, caps) => {
    mockApi({ ...companyRoutes(caps), 'GET /api/companies': { body: ok([{ ...company, role: caps.role }]) } })
    renderInCompany(<AppShell>page</AppShell>)
    const [link] = await screen.findAllByRole('link', { name: /管理者の手引き/ })
    expect(link).toHaveAttribute('href', '/manual-admin/index.html')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('a member here who is an admin of another company sees it too (the server lets them read it)', async () => {
    mockApi({
      ...companyRoutes(memberCapabilities),
      'GET /api/companies': { body: ok([{ ...company, role: 'member' }, { ...other, role: 'admin' }]) },
    })
    renderInCompany(<AppShell>page</AppShell>)
    expect((await screen.findAllByRole('link', { name: /管理者の手引き/ })).length).toBeGreaterThan(0)
  })

  it.each([
    ['a member', memberCapabilities],
    ['a 部署の管理役', managerCapabilities],
  ])('%s who is admin nowhere does not see it', async (_who, caps) => {
    mockApi({
      ...companyRoutes(caps),
      'GET /api/companies': { body: ok([{ ...company, role: 'member' }, { ...other, role: 'member' }]) },
    })
    renderInCompany(<AppShell>page</AppShell>)
    await menuShown()
    expect(screen.queryAllByRole('link', { name: /管理者の手引き/ })).toEqual([])
  })
})
