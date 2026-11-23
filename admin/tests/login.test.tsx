import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { toast } from 'sonner'

import DashboardPage from '@/app/dashboard/page'
import LoginPage from '@/app/login/page'
import { AuthProvider, SIGN_OUT_FAILED } from '@/lib/auth-context'
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

    it('goes back to the administrator guide as a whole page, and says why to sign in (server.md "The administrator guide")', async () => {
      const replace = vi.fn()
      vi.stubGlobal('location', { ...window.location, replace })
      nav.search = 'redirect=%2Fmanual-admin%2F03-busho.html'
      mockApi({
        'GET /api/me': { status: 401, body: { error: 'Unauthorized' } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
        'POST /api/auth/sign-in/email': { body: {} },
      })
      render(<AuthProvider><LoginPage /></AuthProvider>)
      expect(await screen.findByText('ログインすると管理者の手引きを見られます。')).toBeInTheDocument()
      mockApi({
        'GET /api/me': { body: { success: true, data: { id: 'u1', email: 'a@example.com', name: 'A' } } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
        'POST /api/auth/sign-in/email': { body: {} },
      })
      await userEvent.type(screen.getByLabelText('メールアドレス'), 'a@example.com')
      await userEvent.type(screen.getByLabelText('パスワード'), 'password1')
      await userEvent.click(screen.getByRole('button', { name: 'ログイン' }))
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/manual-admin/03-busho.html'))
      expect(nav.replace).not.toHaveBeenCalled()
    })

    it('offers an already signed-in reader a link back to the administrator guide, without bouncing there by itself', async () => {
      const replace = vi.fn()
      vi.stubGlobal('location', { ...window.location, replace })
      nav.search = 'redirect=%2Fmanual-admin%2Findex.html'
      mockApi({
        'GET /api/me': { body: { success: true, data: { id: 'u1', email: 'a@example.com', name: 'A' } } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
      })
      render(<AuthProvider><LoginPage /></AuthProvider>)
      const open = await screen.findByRole('button', { name: '管理者の手引きを開く' })
      expect(replace).not.toHaveBeenCalled()
      expect(nav.replace).not.toHaveBeenCalled()
      await userEvent.click(open)
      expect(replace).toHaveBeenCalledWith('/manual-admin/index.html')
    })

    it('does not bounce an already signed-in reader back to the manual by itself (a manual that refused them would loop), but offers a link', async () => {
      const replace = vi.fn()
      vi.stubGlobal('location', { ...window.location, replace })
      nav.search = 'redirect=%2Fmanual%2Fguide.html'
      mockApi({
        'GET /api/me': { body: { success: true, data: { id: 'u1', email: 'a@example.com', name: 'A' } } },
        'GET /api/config': { body: { success: true, data: { name: 'ACB', version: '1', setupComplete: true } } },
      })
      render(<AuthProvider><LoginPage /></AuthProvider>)
      const open = await screen.findByRole('button', { name: '使い方を開く' })
      expect(replace).not.toHaveBeenCalled()
      expect(nav.replace).not.toHaveBeenCalled()
      await userEvent.click(open)
      expect(replace).toHaveBeenCalledWith('/manual/guide.html')
    })
  })
})

// A sign-out that did not reach the server leaves the session alive (7 days): showing the console as
// signed out would let the next person on a shared PC reload straight back in.
describe('signing out', () => {
  afterEach(() => {
    nav.replace.mockReset()
    vi.restoreAllMocks()
  })

  const signedIn = { body: { success: true, data: { id: 'u1', email: 'a@example.com', name: 'A', canCreateCompany: false } } }

  async function openDashboard(signOutReply: Parameters<typeof mockApi>[0][string]) {
    mockApi({
      'GET /api/me': signedIn,
      'GET /api/companies': { body: { success: true, data: [] } },
      'POST /api/auth/sign-out': signOutReply,
    })
    render(<AuthProvider><DashboardPage /></AuthProvider>)
    return screen.findByRole('button', { name: 'ログアウト' })
  }

  it.each([
    ['the network fails', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the server fails', { status: 500, body: { error: 'Internal error' } }],
  ] as const)('when %s, keeps the user signed in and says so', async (_name, reply) => {
    const error = vi.spyOn(toast, 'error')
    const button = await openDashboard(reply)
    await userEvent.click(button)
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(SIGN_OUT_FAILED))
    expect(nav.replace).not.toHaveBeenCalled()
    // Still the signed-in page, not the sign-in form.
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument()
    expect(screen.getByText('まだ会社に参加していません')).toBeInTheDocument()
  })

  it.each([
    ['succeeds', { body: { success: true } }],
    ['finds no session any more (401)', { status: 401, body: { error: 'Unauthorized' } }],
  ] as const)('when it %s, clears the user and goes to the sign-in page', async (_name, reply) => {
    const error = vi.spyOn(toast, 'error')
    const button = await openDashboard(reply)
    await userEvent.click(button)
    await vi.waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login'))
    expect(error).not.toHaveBeenCalled()
    // RequireAuth no longer shows the page to a signed-out user.
    await vi.waitFor(() => expect(screen.queryByText('まだ会社に参加していません')).not.toBeInTheDocument())
  })
})
