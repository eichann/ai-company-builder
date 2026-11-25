// 「ブラウザ操作」 (the company's browser-operation setting): who sees the page, that it is
// linked from 「AI の安全」, that a site written wrongly cannot be saved, what a save sends,
// that a member's override changes only that member, and that the words come from the lib.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AiSafetyPage from '@/app/companies/[id]/advanced/ai-safety/page'
import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import { BROWSER_INTRO, BROWSER_LEVEL_LABELS, BROWSER_LOGIN_NOTE, BROWSER_MODE_LABELS, BROWSER_NOT_YET_NOTE, BROWSER_PARTS_NOTE } from '@/lib/agent-browser'
import type { AgentBrowserView, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/ai-safety/browser`,
  useSearchParams: () => new URLSearchParams(),
}))

const view: AgentBrowserView = {
  settings: { mode: 'off', sites: [] },
  overrides: [],
  updatedAt: null,
  updatedBy: null,
  history: [],
  siteParts: [],
}

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}, current: AgentBrowserView = view) {
  const routes = { ...companyRoutes(caps), [`GET ${base}/agent-browser`]: { body: ok(current) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    const method = init?.method ?? 'GET'
    const call: Call = { method, url, headers: {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = routes[`${method} ${url}`]
    const reply = !route ? { status: 404, body: { error: `no fixture for ${method} ${url}` } } : typeof route === 'function' ? route(call) : route
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

/** The free-text parts hosts are a developer setting: shown only in a console built with this flag. */
const developerConsole = () => vi.stubEnv('NEXT_PUBLIC_ACB_BROWSER_DEVELOPER', '1')

describe('ブラウザ操作', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is linked from 「AI の安全」, and a member never loads the setting', async () => {
    stubApi(ownerCapabilities)
    const { unmount } = renderInCompany(<AiSafetyPage />)
    expect(await screen.findByRole('link', { name: /ブラウザ操作/ })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser')
    unmount()
    const calls = stubApi(managerCapabilities)
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/agent-browser'))).toBe(false)
  })

  it('shows the explanation and the login note from the lib, starting at 「使わない」', async () => {
    stubApi(ownerCapabilities)
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByText(BROWSER_INTRO)).toBeInTheDocument()
    expect(await screen.findByText(BROWSER_LOGIN_NOTE)).toBeInTheDocument()
    // The app does nothing with it yet: said next to the choice.
    expect(screen.getByText(BROWSER_NOT_YET_NOTE)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: new RegExp(`^${BROWSER_MODE_LABELS.off}`) })).toBeChecked()
    expect(screen.getByText('まだサイトはありません。')).toBeInTheDocument()
  })

  it('the parts hosts are the site\'s reviewed declaration\'s: no address field, and a save keeps what an admin stored before (plan B)', async () => {
    const stored = { host: 'manager.linestep.net', level: 'write' as const, assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'www.google.com'] }
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-browser`]: (call) => ({ body: ok({ ...view, settings: call.body }) }),
    }, { ...view, settings: { mode: 'off', sites: [stored] } })
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByText(BROWSER_PARTS_NOTE)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'サイト 1 の画面の部品を取る先' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(`^${BROWSER_MODE_LABELS.on}`) }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    // Stored data stays as it was (a released app before plan B still reads it); the current app ignores it.
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ mode: 'on', sites: [stored] })
  })

  it('what an admin wrote before is shown read only, and 「前に書いたものを消す」 clears it (an older app still loads from it)', async () => {
    const stored = { host: 'manager.linestep.net', level: 'write' as const, assetHosts: ['www.google.com'] }
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-browser`]: (call) => ({ body: ok({ ...view, settings: call.body }) }),
    }, { ...view, settings: { mode: 'on', sites: [stored] } })
    renderInCompany(<AgentBrowserPage />)
    const group = await screen.findByRole('group', { name: 'サイト 1 の前に書いた部品を取る先' })
    expect(group).toHaveTextContent('www.google.com')
    await userEvent.click(within(group).getByRole('button', { name: '前に書いたものを消す' }))
    expect(screen.queryByRole('group', { name: 'サイト 1 の前に書いた部品を取る先' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ mode: 'on', sites: [{ ...stored, assetHosts: [] }] })
  })

  it('a wildcard parts host, or the operated host as a parts host, cannot be saved (the developer setting)', async () => {
    developerConsole()
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<AgentBrowserPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'サイトを追加' }))
    // A new site without its address cannot be saved either.
    expect(await screen.findByRole('alert')).toHaveTextContent('操作するサイトを書いてください')
    await userEvent.type(screen.getByRole('textbox', { name: 'サイト 1 の操作するサイト' }), 'crm.example.com')
    const parts = screen.getByRole('textbox', { name: 'サイト 1 の画面の部品を取る先' })
    await userEvent.type(parts, '*.cdn.example.net')
    expect(await screen.findByRole('alert')).toHaveTextContent('使えない書き方があります: *.cdn.example.net')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await userEvent.clear(parts)
    await userEvent.type(parts, 'CRM.example.com')
    expect(await screen.findByRole('alert')).toHaveTextContent('操作するサイトは、画面の部品を取る先に書けません')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('the same site twice cannot be saved', async () => {
    stubApi(ownerCapabilities, {}, { ...view, settings: { mode: 'on', sites: [{ host: 'crm.example.com', level: 'read', assetHosts: [] }] } })
    renderInCompany(<AgentBrowserPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'サイトを追加' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'サイト 2 の操作するサイト' }), 'CRM.Example.com')
    expect(await screen.findByRole('alert')).toHaveTextContent('同じサイトが2回あります: crm.example.com')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('saving sends the whole setting, normalized, with the mode and level chosen', async () => {
    developerConsole()
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-browser`]: (call) => ({ body: ok({ ...view, settings: call.body }) }),
    })
    renderInCompany(<AgentBrowserPage />)
    await userEvent.click(await screen.findByRole('radio', { name: new RegExp(`^${BROWSER_MODE_LABELS.on}`) }))
    await userEvent.click(screen.getByRole('button', { name: 'サイトを追加' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'サイト 1 の操作するサイト' }), 'CRM.Example.com')
    await userEvent.click(screen.getByRole('combobox', { name: 'サイト 1 の段階' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: BROWSER_LEVEL_LABELS.write }))
    await userEvent.type(screen.getByRole('textbox', { name: 'サイト 1 の画面の部品を取る先' }), 'cdn.example.net\nCDN.example.net\nfonts.example.org')
    expect(screen.getByText('動作: 使わない → 使う')).toBeInTheDocument()
    expect(screen.getByText('サイトを追加: crm.example.com（入力・保存まで）')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      mode: 'on',
      sites: [{ host: 'crm.example.com', level: 'write', assetHosts: ['cdn.example.net', 'fonts.example.org'] }],
    })
  })

  it('choosing one member\'s mode changes only that member', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-browser/overrides/u_owner`]: (call) => ({
        body: ok({ ...view, overrides: [{ userId: 'u_owner', name: '佐藤 花子', email: 'sato@example.com', mode: (call.body as { mode: string }).mode, updatedAt: '2026-11-20T00:00:00.000Z' }] }),
      }),
    })
    renderInCompany(<AgentBrowserPage />)
    await userEvent.click(await screen.findByRole('combobox', { name: '佐藤 花子の動作' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: BROWSER_MODE_LABELS.on }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => [c.url, c.body])).toEqual([[`${base}/agent-browser/overrides/u_owner`, { mode: 'on' }]])
  })

  describe('a saved site\'s 「詳しい設定」 (agent-browser.md "A domain\'s parts and login helpers")', () => {
    const saved = { ...view, settings: { mode: 'on' as const, sites: [{ host: 'shop.example.com', level: 'write' as const, assetHosts: [] }, { host: 'desk.example.com', level: 'read' as const, assetHosts: [] }] } }

    it('is folded under each saved site, and saving sends that site\'s whole setting, normalized', async () => {
      const calls = stubApi(ownerCapabilities, {
        [`PUT ${base}/agent-browser/site-parts`]: (call) => ({ body: ok({ ...saved, siteParts: [call.body] }) }),
      }, saved)
      renderInCompany(<AgentBrowserPage />)
      const group = await screen.findByRole('group', { name: 'shop.example.com の詳しい設定' })
      expect(within(group).getByRole('button', { name: '詳しい設定を保存' })).toBeDisabled()
      await userEvent.type(within(group).getByRole('textbox', { name: 'shop.example.com の部品を読み込む先' }), 'IMG.example.net\nimg.example.net\nfonts.example.net')
      await userEvent.click(within(group).getByRole('button', { name: 'ログインの補助を追加' }))
      await userEvent.type(within(group).getByRole('textbox', { name: 'ログインの補助 1 のアドレス' }), 'check.example.org')
      await userEvent.type(within(group).getByRole('textbox', { name: 'ログインの補助 1 の道' }), '/challenge/')
      await userEvent.click(within(group).getByRole('checkbox', { name: '画面の中に表示してよい' }))
      await userEvent.click(within(group).getByRole('button', { name: '詳しい設定を保存' }))
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
      const puts = calls.filter((c) => c.method === 'PUT')
      expect(puts.map((c) => [c.url, c.body])).toEqual([[`${base}/agent-browser/site-parts`, {
        host: 'shop.example.com',
        assetHosts: ['img.example.net', 'fonts.example.net'],
        loginHelpers: [{ host: 'check.example.org', pathPrefix: '/challenge/', frame: true, post: false }],
      }]])
    })

    it('a registered site as another site\'s part or helper, a wildcard or a bad path cannot be saved', async () => {
      const calls = stubApi(ownerCapabilities, {}, saved)
      renderInCompany(<AgentBrowserPage />)
      const group = await screen.findByRole('group', { name: 'shop.example.com の詳しい設定' })
      const parts = within(group).getByRole('textbox', { name: 'shop.example.com の部品を読み込む先' })
      await userEvent.type(parts, 'desk.example.com')
      expect(await within(group).findByRole('alert')).toHaveTextContent('操作するサイトとして登録したアドレスは、ここには書けません: desk.example.com')
      expect(within(group).getByRole('button', { name: '詳しい設定を保存' })).toBeDisabled()
      await userEvent.clear(parts)
      await userEvent.type(parts, '*.example.net')
      expect(await within(group).findByRole('alert')).toHaveTextContent('使えない書き方があります: *.example.net')
      await userEvent.clear(parts)
      await userEvent.click(within(group).getByRole('button', { name: 'ログインの補助を追加' }))
      await userEvent.type(within(group).getByRole('textbox', { name: 'ログインの補助 1 のアドレス' }), 'check.example.org')
      await userEvent.type(within(group).getByRole('textbox', { name: 'ログインの補助 1 の道' }), '/')
      expect(await within(group).findByRole('alert')).toHaveTextContent('ログインの補助の道は / で始まり / で終わる形')
      expect(within(group).getByRole('button', { name: '詳しい設定を保存' })).toBeDisabled()
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    })

    it('a site not saved yet has none (its setting needs the registered site first)', async () => {
      stubApi(ownerCapabilities, {}, saved)
      renderInCompany(<AgentBrowserPage />)
      await screen.findByRole('group', { name: 'shop.example.com の詳しい設定' })
      await userEvent.click(screen.getByRole('button', { name: 'サイトを追加' }))
      await userEvent.type(screen.getByRole('textbox', { name: 'サイト 3 の操作するサイト' }), 'new.example.com')
      expect(screen.queryByRole('group', { name: 'new.example.com の詳しい設定' })).toBeNull()
    })
  })
})
