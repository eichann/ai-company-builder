// 「もう一方の AI に聞く」 (owner decision 2026-11-02): owners and admins choose whether a
// consultation may ask the other AI; the choice is sent at once as { allowed }, and a member
// (department manager) never loads or changes it.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import SecondOpinionPage from '@/app/companies/[id]/advanced/ai-safety/second-opinion/page'
import type { SecondOpinionView } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/ai-safety/second-opinion`,
  useSearchParams: () => new URLSearchParams(),
}))

const off: SecondOpinionView = { allowed: false, updatedAt: null, updatedByName: null }

describe('もう一方の AI に聞く', () => {
  it('starts at 聞かない; choosing 聞いてよい sends { allowed: true } and shows who changed it', async () => {
    const { calls } = mockApi({
      ...companyRoutes(ownerCapabilities),
      [`GET ${base}/second-opinion`]: { body: ok(off) },
      [`PUT ${base}/second-opinion`]: { body: ok({ allowed: true, updatedAt: '2026-11-02T01:00:00.000Z', updatedByName: '佐藤 花子' }) },
    })
    renderInCompany(<SecondOpinionPage />)
    expect(await screen.findByRole('radio', { name: /聞かない/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('radio', { name: /聞いてよい/ }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /聞いてよい/ })).toHaveAttribute('aria-checked', 'true'))
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ allowed: true }])
    expect(screen.getByText(/佐藤 花子/)).toBeInTheDocument()
  })

  it('is for owners and admins only: a department manager sees the lock, and nothing is loaded', async () => {
    const { calls } = mockApi({ ...companyRoutes(managerCapabilities) })
    renderInCompany(<SecondOpinionPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/second-opinion'))).toBe(false)
  })
})
