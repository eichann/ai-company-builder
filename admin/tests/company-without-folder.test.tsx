// A company with or without the shared company folder (全社フォルダ, owner decision 2026-11-07):
// the operator chooses when creating it (nothing is sent that would change today's default), and
// a company without one is not offered folder pages or actions that need the folder.
import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import NewCompanyPage from '@/app/companies/new/page'
import DepartmentsPage from '@/app/companies/[id]/departments/page'
import FoldersPage from '@/app/companies/[id]/folders/page'
import MembersPage from '@/app/companies/[id]/members/page'
import OverviewPage from '@/app/companies/[id]/page'
import SettingsPage from '@/app/companies/[id]/advanced/info/page'
import { AuthProvider } from '@/lib/auth-context'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { busyOverview, company, homeOf, ok, quietOverview } from './fixtures'
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

// Words that talk about files being synced or downloaded are a git company's only (owner decision
// 2026-11-07): a company without the shared folder says what its departments are for instead.
const routesOf = (kind: 'git' | 'none', extra: Record<string, unknown> = {}) => ({
  ...(kind === 'none' ? withoutFolder() : companyRoutes()),
  [`GET ${base}/overview`]: { body: ok(quietOverview) },
  ...extra,
})
const GIT_INVITE_TEXT = /アプリは最初に、所属する部署のファイルだけを自動で入れます/
const NONE_INVITE_TEXT = '参加すると、選んだ部署に所属します。部署は、所属・記録の置き場所・お願いの届け先に使います。選ばないときは、あとから部署のページで入れられます。'

describe.each(['git', 'none'] as const)('wording for a %s company', (kind) => {
  const none = kind === 'none'

  it('the invitation says what 所属する部署 does; 最終同期 only where members sync', async () => {
    mockApi(routesOf(kind))
    renderInCompany(<MembersPage />)
    await screen.findByText('田中 太郎')
    expect(screen.queryByRole('columnheader', { name: /最終同期/ }) !== null).toBe(!none)
    await userEvent.click(screen.getByRole('button', { name: 'メンバーを招待' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('所属する部署')).toBeInTheDocument()
    expect(within(dialog).queryByText(GIT_INVITE_TEXT) !== null).toBe(!none)
    expect(within(dialog).queryByText(NONE_INVITE_TEXT) !== null).toBe(none)
    expect(within(dialog).queryAllByText(/同期|ダウンロード|ファイル/).length > 0).toBe(!none)
  })

  it('removing a member says what they lose', async () => {
    mockApi(routesOf(kind))
    renderInCompany(<MembersPage />)
    const row = (await screen.findByText('田中 太郎')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: '田中 太郎 の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /会社から削除/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/同期できなくなります/) !== null).toBe(!none)
    expect(within(dialog).queryByText(/やること・記録などを見られなくなります/) !== null).toBe(none)
  })

  it('the role window says what a member can use', async () => {
    mockApi(routesOf(kind))
    renderInCompany(<MembersPage />)
    const row = (await screen.findByText('田中 太郎')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: '田中 太郎 の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /役割を変更/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/会社のファイルやAIスキルを同期して使えます/) !== null).toBe(!none)
    expect(within(dialog).queryByText('やること・記録・承認や AI スキルを使えます。管理画面の設定は変更できません。') !== null).toBe(none)
  })

  it('home: the departments step and 「しばらく同期していません」 follow the kind', async () => {
    const home = homeOf(busyOverview)
    const setup = { ...home.setup!, done: 0, steps: home.setup!.steps.map((s) => ({ ...s, done: false })) }
    const stale = { ...busyOverview.attention.unknownClients[0], lastFetchAt: null, lastPushAt: null }
    mockApi(routesOf(kind, { [`GET ${base}/home`]: { body: ok({ ...home, setup, attention: { ...home.attention, notSyncedRecently: [stale] } }) } }))
    renderInCompany(<OverviewPage />)
    const list = await screen.findByRole('list', { name: '最初にやること' })
    expect(within(list).queryByText('会社のフォルダは部署ごとに分かれます。') !== null).toBe(!none)
    expect(within(list).queryByText('部署は、所属・記録の置き場所・お願いの届け先に使います。') !== null).toBe(none)
    expect(screen.queryByText('しばらく同期していません') !== null).toBe(!none)
  })

  it('home with nothing to do does not speak of syncing', async () => {
    const stale = { ...busyOverview.attention.unknownClients[0], lastFetchAt: null, lastPushAt: null }
    const home = homeOf(quietOverview)
    mockApi(routesOf(kind, { [`GET ${base}/home`]: { body: ok({ ...home, attention: { ...home.attention, notSyncedRecently: none ? [stale] : [] } }) } }))
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
    expect(screen.queryByText(/最近の同期も問題なく/) !== null).toBe(!none)
  })

  it('leaving the company says what is lost', async () => {
    // Only an admin leaves (an owner hands the company over first).
    const admin = { role: 'admin' as const, managedDepartmentIds: [], canViewAgentEvents: true }
    const routes = companyRoutes(admin)
    mockApi({ ...routes, ...(none ? { [`GET ${base}`]: { body: ok({ ...company, role: 'admin', folderKind: 'none' }) } } : {}) })
    renderInCompany(<SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: '退出する' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/同期できなくなります/) !== null).toBe(!none)
    expect(within(dialog).queryByText(/やること・記録などを見られなくなります/) !== null).toBe(none)
  })
})
