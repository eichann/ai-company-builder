// 「AI の囲い」 (the company's AI sandbox setting): who sees the page, that a
// host list which would open everything cannot be saved, what a save sends,
// and that a member's override changes only that member.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentSandboxPage from '@/app/companies/[id]/agent-sandbox/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { AgentSandboxView, Capabilities } from '@/lib/api'
import { DEFAULT_SANDBOX_ALLOWED_DOMAINS } from '../../shared/core/agent-sandbox'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/agent-sandbox`,
  useSearchParams: () => new URLSearchParams(),
}))

const view: AgentSandboxView = {
  settings: { mode: 'off', allowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS], deniedReadPaths: [], onUnavailable: 'record-only' },
  defaultAllowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS],
  overrides: [],
  updatedAt: null,
  updatedBy: null,
  history: [],
}

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const routes = { ...companyRoutes(caps), [`GET ${base}/agent-sandbox`]: { body: ok(view) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
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

describe('AI の囲い', () => {
  it('is in the menu for owners and admins only, and a member never loads the setting', async () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'agent-sandbox')!
    expect(item.label).toBe('AI の囲い')
    expect(item.visible?.({ isAdmin: false, isManager: true, canViewAgentEvents: true })).toBe(false)
    expect(item.visible?.({ isAdmin: true, isManager: false, canViewAgentEvents: false })).toBe(true)
    const calls = stubApi(managerCapabilities)
    renderInCompany(<AgentSandboxPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/agent-sandbox'))).toBe(false)
  })

  it('a host list that would open every host cannot be saved', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<AgentSandboxPage />)
    const hosts = await screen.findByRole('textbox', { name: '接続してよい宛先' })
    await userEvent.type(hosts, '\n*')
    expect(await screen.findByRole('alert')).toHaveTextContent('使えない書き方があります: *')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('saving sends the whole setting, normalized, with the mode the owner chose', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-sandbox`]: (call) => ({ body: ok({ ...view, settings: call.body }) }),
    })
    renderInCompany(<AgentSandboxPage />)
    await userEvent.click(await screen.findByRole('radio', { name: /記録だけ.*何も止めません/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '接続してよい宛先' }), '\nAPI.Example.COM')
    await userEvent.type(screen.getByRole('textbox', { name: 'ほかに読ませない場所' }), '~/社外秘/')
    expect(screen.getByText('動作: 使わない → 記録だけ')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      mode: 'observe',
      onUnavailable: 'record-only',
      allowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS, 'api.example.com'],
      deniedReadPaths: ['~/社外秘'],
    })
  })

  it('shows which hosts and skills the sandbox stops or would stop, from the log', async () => {
    stubApi(ownerCapabilities, {
      [`GET ${base}/agent-events/sandbox`]: {
        body: ok({
          from: '', to: '', total: 3, truncated: false,
          byHost: [{ host: 'upload.example.net', wouldBlock: 2, blocked: 1, deniedReads: 0, members: 2, lastAt: '2026-10-30T00:00:00.000Z' }],
          bySkill: [{ skill: 'create-movie', wouldBlock: 2, blocked: 1, deniedReads: 0, members: 2, lastAt: '2026-10-30T00:00:00.000Z' }],
          byPlace: [{ place: 'ssh', wouldBlock: 0, blocked: 0, deniedReads: 1, members: 1, lastAt: '2026-10-30T00:00:00.000Z' }],
        }),
      },
    })
    renderInCompany(<AgentSandboxPage />)
    const hosts = await screen.findByRole('table', { name: '宛先ごと' })
    expect(within(hosts).getByText('upload.example.net')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'スキルごと' })).getByText('create-movie')).toBeInTheDocument()
  })

  it('choosing one member\'s mode changes only that member (staged rollout)', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/agent-sandbox/overrides/u_owner`]: (call) => ({
        body: ok({ ...view, overrides: [{ userId: 'u_owner', name: '佐藤 花子', email: 'sato@example.com', mode: (call.body as { mode: string }).mode, updatedAt: '2026-10-30T00:00:00.000Z' }] }),
      }),
    })
    renderInCompany(<AgentSandboxPage />)
    await userEvent.click(await screen.findByRole('combobox', { name: '佐藤 花子の動作' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '囲う' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => [c.url, c.body])).toEqual([[`${base}/agent-sandbox/overrides/u_owner`, { mode: 'enforce' }]])
  })
})
