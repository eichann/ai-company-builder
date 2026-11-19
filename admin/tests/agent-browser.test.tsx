// 「ブラウザ操作」 (the company's browser-operation setting): who sees the page, that it is
// linked from 「AI の安全」, that a site written wrongly cannot be saved, what a save sends,
// that a member's override changes only that member, and that the words come from the lib.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AiSafetyPage from '@/app/companies/[id]/advanced/ai-safety/page'
import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import { BROWSER_INTRO, BROWSER_LEVEL_LABELS, BROWSER_LOGIN_NOTE, BROWSER_MODE_LABELS } from '@/lib/agent-browser'
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

describe('ブラウザ操作', () => {
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
    expect(screen.getByRole('radio', { name: new RegExp(`^${BROWSER_MODE_LABELS.off}`) })).toBeChecked()
    expect(screen.getByText('まだサイトはありません。')).toBeInTheDocument()
  })

  it('a wildcard parts host, or the operated host as a parts host, cannot be saved', async () => {
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
})
