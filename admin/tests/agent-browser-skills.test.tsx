// 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"): linked from 「ブラウザ操作」; a member or a
// department manager sees nothing and nothing is asked; each Skill shows its domain, write targets in plain words and its
// state; 承認する / 前もって承認 send exactly the version shown; 取り消す asks first; an unusable declaration offers nothing.
// The site is fictional.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import BrowserSkillsPage from '@/app/companies/[id]/advanced/ai-safety/browser/skills/page'
import type { BrowserSkillView, BrowserSkillsView, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/ai-safety/browser/skills`,
  useSearchParams: () => new URLSearchParams(),
}))

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, routes: Record<string, Reply> = {}) {
  const all = { ...companyRoutes(caps), ...routes } as Record<string, Reply>
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ method, url, headers: {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const reply = all[`${method} ${url}`] ?? { status: 404, body: { error: `no fixture for ${method} ${url}` } }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

const HASH = `sha256:${'a'.repeat(64)}`
const waiting: BrowserSkillView = {
  name: 'order-copy', declarationHash: HASH, files: 'git:abc', status: 'waiting', problem: null, domain: 'shop.example.test',
  writes: ['/api/orders/register に送る（作る・保存する）：1回まで'], neverRead: ['/api/orders/{n}?copy=1'], afterRead: ['/api/orders/{created}'],
  accountMarker: 'shop-account-id', approval: null,
}
const approved: BrowserSkillView = {
  ...waiting, name: 'order-close', status: 'pre_approved',
  approval: { mode: 'pre_approved', how: 'edited', approvedBy: 'u_owner', approvedByName: '山田 花子', approvedAt: '2026-11-25T01:00:00.000Z' },
}
const invalid: BrowserSkillView = {
  ...waiting, name: 'broken', status: 'invalid', problem: '宣言のドメインが、この会社のブラウザ操作に登録されていません。', domain: null, writes: [], neverRead: [], afterRead: [], accountMarker: null,
}
const list: BrowserSkillsView = { items: [waiting, approved, invalid] }
const routes = { [`GET ${base}/browser-skill-approvals`]: { body: ok(list) } }
const row = async (name: string) => (await screen.findByText(name)).closest('li[data-skill]') as HTMLElement

describe('Skill の承認', () => {
  it('is linked from 「ブラウザ操作」', async () => {
    stubApi(ownerCapabilities, { [`GET ${base}/agent-browser`]: { body: ok({ settings: { mode: 'off', sites: [] }, overrides: [], updatedAt: null, updatedBy: null, history: [] }) } })
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByRole('link', { name: /Skill の承認/ })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/skills')
  })

  it('a member or a department manager sees nothing and nothing is asked', async () => {
    const calls = stubApi(managerCapabilities)
    renderInCompany(<BrowserSkillsPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => /browser-skill/.test(c.url))).toBe(false)
  })

  it('shows each Skill\'s domain, write targets, state and who approved', async () => {
    stubApi(ownerCapabilities, routes)
    renderInCompany(<BrowserSkillsPage />)
    const w = await row('order-copy')
    expect(within(w).getByText('承認待ち')).toBeInTheDocument()
    expect(within(w).getByText('shop.example.test')).toBeInTheDocument()
    expect(within(w).getByText('/api/orders/register に送る（作る・保存する）：1回まで')).toBeInTheDocument()
    expect(within(w).getByText(/読んではいけないアドレス：\/api\/orders\/\{n\}\?copy=1/)).toBeInTheDocument()
    expect(within(w).queryByRole('button', { name: /取り消す/ })).toBeNull()
    const a = await row('order-close')
    expect(within(a).getByText('前もって承認')).toBeInTheDocument()
    expect(within(a).getByText(/宣言を直したので承認：山田 花子/)).toBeInTheDocument()
    expect(within(a).queryByRole('button', { name: '前もって承認' })).toBeNull()
    const i = await row('broken')
    expect(within(i).getByText('使えません')).toBeInTheDocument()
    expect(within(i).getByText(/登録されていません/)).toBeInTheDocument()
    expect(within(i).queryAllByRole('button')).toEqual([])
  })

  it('承認する / 前もって承認 send exactly the version shown', async () => {
    const calls = stubApi(ownerCapabilities, { ...routes, [`POST ${base}/browser-skill-approvals`]: { body: ok({ ...waiting, status: 'approved' }) } })
    renderInCompany(<BrowserSkillsPage />)
    const w = await row('order-copy')
    await userEvent.click(within(w).getByRole('button', { name: '承認する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1))
    await userEvent.click(within(await row('order-copy')).getByRole('button', { name: '前もって承認' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { skill: 'order-copy', declarationHash: HASH, files: 'git:abc', mode: 'per_run' },
      { skill: 'order-copy', declarationHash: HASH, files: 'git:abc', mode: 'pre_approved' },
    ])
  })

  it('取り消す asks first; キャンセル sends nothing', async () => {
    const calls = stubApi(ownerCapabilities, { ...routes, [`POST ${base}/browser-skill-approvals/revoke`]: { body: ok({ revoked: true }) } })
    renderInCompany(<BrowserSkillsPage />)
    const a = await row('order-close')
    await userEvent.click(within(a).getByRole('button', { name: /取り消す/ }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('この Skill の承認を取り消しますか？')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    await userEvent.click(within(a).getByRole('button', { name: /取り消す/ }))
    dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '取り消す' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `${base}/browser-skill-approvals/revoke`, body: { skill: 'order-close' } })
  })
})
