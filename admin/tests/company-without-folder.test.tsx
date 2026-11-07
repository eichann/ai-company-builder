// A company with or without the shared company folder (全社フォルダ, owner decision 2026-11-07):
// the operator chooses when creating it (nothing is sent that would change today's default), and
// a company without one is not offered folder pages or actions that need the folder.
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import NewCompanyPage from '@/app/companies/new/page'
import DepartmentsPage from '@/app/companies/[id]/departments/page'
import FoldersPage from '@/app/companies/[id]/folders/page'
import { AuthProvider } from '@/lib/auth-context'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { company, ok } from './fixtures'
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

const operator = { body: ok({ id: 'u_1', email: 'sato@example.com', name: '佐藤 花子', canCreateCompany: true }) }
const created = { status: 201, body: ok({ ...company, id: 'co_new', role: 'owner' }) }

describe('creating a company', () => {
  it('keeps today\'s company unless the operator chooses otherwise', async () => {
    const { calls } = mockApi({ 'GET /api/me': operator, 'POST /api/companies': created })
    render(<AuthProvider><NewCompanyPage /></AuthProvider>)
    await userEvent.type(await screen.findByLabelText('会社名'), '株式会社サンプル')
    expect(screen.getByRole('radio', { name: /全社フォルダを使う（今までどおり）/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', { name: '会社を作成' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: '株式会社サンプル', folderKind: 'git' })
  })

  it('sends 「使わない」 when chosen, and says it cannot be changed later', async () => {
    const { calls } = mockApi({ 'GET /api/me': operator, 'POST /api/companies': created })
    render(<AuthProvider><NewCompanyPage /></AuthProvider>)
    await userEvent.type(await screen.findByLabelText('会社名'), '株式会社サンプル')
    expect(screen.getByText('あとから変えることはできません。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /全社フォルダを使わない（各自の PC のフォルダだけ）/ }))
    await userEvent.click(screen.getByRole('button', { name: '会社を作成' }))
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ folderKind: 'none' })
  })
})

const withoutFolder = () => {
  const routes = companyRoutes()
  return { ...routes, [`GET ${base}`]: { body: ok({ ...company, role: 'owner', folderKind: 'none' }) } }
}

describe('a company without the shared folder', () => {
  it('「フォルダ」 reached by URL says there is nothing to manage and asks the server nothing about folders', async () => {
    const { calls } = mockApi(withoutFolder())
    renderInCompany(<FoldersPage />)
    expect(await screen.findByText('この会社は全社フォルダを使わない設定です')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/permissions') || c.url.includes('/private-folders'))).toBe(false)
  })

  it('「部署」 offers no 「フォルダを取り込む」; a company with the folder still does', async () => {
    mockApi(withoutFolder())
    const { unmount } = renderInCompany(<DepartmentsPage />)
    expect(await screen.findByText(/この会社は全社フォルダを使いません/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /フォルダを取り込む/ })).not.toBeInTheDocument()
    unmount()

    mockApi(companyRoutes())
    renderInCompany(<DepartmentsPage />)
    expect(await screen.findByRole('button', { name: /フォルダを取り込む/ })).toBeInTheDocument()
  })
})
