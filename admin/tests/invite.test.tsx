import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import InvitePage from '@/app/invite/[token]/page'
import { appOpenLink } from '@/lib/app-link'
import { AuthProvider } from '@/lib/auth-context'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/invite/tok-secret',
  useSearchParams: () => new URLSearchParams(),
}))

const TOKEN = 'tok-secret'

describe('the app link (「アプリを開く」)', () => {
  it('carries this server\'s origin only, never the invitation token or the page\'s path', () => {
    const link = appOpenLink(`https://acb.example.com/invite/${TOKEN}?x=1#y`)
    expect(link).toBe('ai-company-builder://open?server=https%3A%2F%2Facb.example.com')
    expect(link).not.toContain(TOKEN)
  })
})

/** A promise React's use() reads at once (already fulfilled), as Next hands a page its params. */
function resolved<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value })
}

function renderInvite(appDownloadUrl: string | null) {
  const api = mockApi({
    'GET /api/me': { body: { success: true, data: { id: 'u-1', email: 'hanako@example.com', name: '山本 花子' } } },
    'GET /api/config': { body: { success: true, data: { name: 'AI Company Builder', version: '1', setupComplete: true, appDownloadUrl } } },
    [`GET /api/invitations/${TOKEN}`]: {
      body: { success: true, data: { companyName: 'サンプル商事', role: 'member', expiresAt: '2026-11-12T00:00:00Z', inviterName: '阿部', departmentNames: ['営業部'] } },
    },
    [`POST /api/invitations/${TOKEN}/accept`]: { body: { success: true, data: { companyId: 'co-1', companyName: 'サンプル商事', role: 'member' } } },
  })
  render(
    <AuthProvider>
      <Suspense fallback={null}>
        <InvitePage params={resolved({ token: TOKEN })} />
      </Suspense>
    </AuthProvider>
  )
  return api
}

describe('invitation page: 招待リンク → アカウント → アプリ', () => {
  it('after joining: download (only an https URL the server gave) and open the app with this server only', async () => {
    renderInvite('https://example.com/ACB.dmg')
    await userEvent.click(await screen.findByRole('button', { name: '参加する' }))
    expect(await screen.findByText('アプリを入れて開く')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /アプリをダウンロード/ })).toHaveAttribute('href', 'https://example.com/ACB.dmg')
    const open = screen.getByRole('link', { name: /アプリを開く/ })
    expect(open.getAttribute('href')).toBe(appOpenLink(window.location.href))
    expect(open.getAttribute('href')).not.toContain(TOKEN)
    expect(screen.getByText(/営業部のファイルが自動で入ります/)).toBeInTheDocument()
  })

  it('without a download URL it says where the app comes from instead of linking anywhere', async () => {
    renderInvite(null)
    await userEvent.click(await screen.findByRole('button', { name: '参加する' }))
    expect(await screen.findByText('アプリは、招待した方から受け取ってください。')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /アプリをダウンロード/ })).not.toBeInTheDocument()
  })
})
