import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import LoginPage from '@/app/login/page'
import { AuthProvider } from '@/lib/auth-context'
import { mockApi } from './mock-api'

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn() }),
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(nav.search),
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

  describe('coming from the user manual (server.md "The user manual")', () => {
    afterEach(() => {
      nav.search = ''
      nav.replace.mockReset()
      vi.unstubAllGlobals()
    })

    it('goes back to the manual page as a whole page (the API serves it, not this console), and says why to sign in', async () => {
      const replace = vi.fn()
      vi.stubGlobal('location', { ...window.location, replace })
      nav.search = 'redirect=%2Fmanual%2Fguide.html'
      mockApi({
        'GET /api/me': { status: 401, body: { error: 'Unauthorized' } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
        'POST /api/auth/sign-in/email': { body: {} },
      })
      render(<AuthProvider><LoginPage /></AuthProvider>)
      expect(await screen.findByText('ログインすると使い方を見られます。')).toBeInTheDocument()
      mockApi({
        'GET /api/me': { body: { success: true, data: { id: 'u1', email: 'a@example.com', name: 'A' } } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
        'POST /api/auth/sign-in/email': { body: {} },
      })
      await userEvent.type(screen.getByLabelText('メールアドレス'), 'a@example.com')
      await userEvent.type(screen.getByLabelText('パスワード'), 'password1')
      await userEvent.click(screen.getByRole('button', { name: 'ログイン' }))
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/manual/guide.html'))
      expect(nav.replace).not.toHaveBeenCalled()
    })
  })
})
