import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import LoginPage from '@/app/login/page'
import { AuthProvider } from '@/lib/auth-context'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(),
}))

describe('login page', () => {
  it('says so when the server state cannot be read, instead of assuming an account exists', async () => {
    // It used to show the sign-in form on failure: on a fresh server the
    // first administrator could then never be created from this page.
    let configUp = false
    mockApi({
      'GET /api/me': { status: 401, body: { error: 'Unauthorized' } },
      'GET /api/config': () => (configUp
        ? { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: false } } }
        : { status: 502, body: {} }),
    })
    render(<AuthProvider><LoginPage /></AuthProvider>)
    expect(await screen.findByText('サーバーの状態を確認できませんでした')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'ログイン' })).not.toBeInTheDocument()

    configUp = true
    await userEvent.click(screen.getByRole('button', { name: /再読み込み|もう一度/ }))
    expect(await screen.findByText('最初の管理者アカウントを作成')).toBeInTheDocument()
  })
})
