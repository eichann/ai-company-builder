// 「AI の緊急停止」: only owners and admins see the stop (a member never loads
// it), the bar on every page stops exactly the scope chosen and then says
// something is stopped, a release asks first and sends the stop's id, and the
// count of apps that do not follow the stop is shown with their names.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentStopPage from '@/app/companies/[id]/agent-stop/page'
import { AgentStopProvider } from '@/components/agent-stop/agent-stop-context'
import { StopBar } from '@/components/agent-stop/stop-bar'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { AgentStopEntry, AgentStopView, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/agent-stop`,
  useSearchParams: () => new URLSearchParams(),
}))

const empty: AgentStopView = { active: [], history: [], unsupported: [], keys: { enabled: false, active: 0, stopped: 0 } }
const stopOf = (over: Partial<AgentStopEntry>): AgentStopEntry => ({
  id: 's1', userId: null, userName: null, userEmail: null, tool: null, reason: '', stoppedAt: '2026-10-31T01:00:00.000Z',
  stoppedBy: 'u_owner', stoppedByName: '佐藤 花子', releasedAt: null, releasedBy: null, releasedByName: null, ...over,
})

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const routes = { ...companyRoutes(caps), [`GET ${base}/agent-stops`]: { body: ok(empty) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
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

const renderPage = () => renderInCompany(<AgentStopProvider><StopBar /><AgentStopPage /></AgentStopProvider>)

describe('AI の緊急停止', () => {
  it('is for owners and admins only: a manager sees neither the button nor the page, and nothing is loaded', async () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'agent-stop')!
    expect(item.label).toBe('AI の緊急停止')
    expect(item.visible?.({ isAdmin: false, isManager: true, canViewAgentEvents: true })).toBe(false)
    expect(item.visible?.({ isAdmin: true, isManager: false, canViewAgentEvents: false })).toBe(true)
    const calls = stubApi(managerCapabilities)
    renderPage()
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'AI を止める' })).toBeNull()
    expect(calls.some((c) => c.url.endsWith('/agent-stops'))).toBe(false)
  })

  it('the bar stops exactly the chosen member and kind, then says the AI is stopped', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/agent-stops`]: (call) => ({ body: ok({ ...empty, active: [stopOf({ userId: 'u_member', userName: '田中 太郎', tool: 'command', reason: (call.body as { reason: string }).reason })] }) }),
    })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'AI を止める' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '田中 太郎' })).toBeInTheDocument())
    await userEvent.selectOptions(within(dialog).getByLabelText('だれの AI を'), 'u_member')
    await userEvent.click(within(dialog).getByRole('radio', { name: /コマンドの実行/ }))
    await userEvent.type(within(dialog).getByLabelText(/理由/), '調査のため')
    expect(within(dialog).getByText('「田中 太郎さんのコマンドの実行」を止めます。')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ userId: 'u_member', tool: 'command', reason: '調査のため' })
    expect(await screen.findByRole('status')).toHaveTextContent('AI を止めています（1 件）')
    expect(within(screen.getByRole('list', { name: 'いま止めているもの' })).getByText('田中 太郎さんのコマンドの実行')).toBeInTheDocument()
  })

  it('the default is everyone and the whole AI', async () => {
    const calls = stubApi(ownerCapabilities, { [`POST ${base}/agent-stops`]: { body: ok({ ...empty, active: [stopOf({})] }) } })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'AI を止める' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('「全員の AI のすべて」を止めます。')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ userId: null, tool: null, reason: '' })
  })

  it('a release asks first and sends that stop\'s id', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/agent-stops`]: { body: ok({ ...empty, active: [stopOf({ id: 'stop-9' })] }) },
      [`DELETE ${base}/agent-stops/stop-9`]: { body: ok({ ...empty, history: [stopOf({ id: 'stop-9', releasedAt: '2026-10-31T02:00:00.000Z', releasedByName: '佐藤 花子' })] }) },
    })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '解除' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/agent-stops/stop-9'))).toBe(true))
    expect(await screen.findByText('止めているものはありません。')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows how many members\' apps do not follow the stop, with their names behind a toggle', async () => {
    stubApi(ownerCapabilities, {
      [`GET ${base}/agent-stops`]: { body: ok({ ...empty, unsupported: [
        { userId: 'u_member', name: '田中 太郎', email: null, clientVersion: '0.0.1+abc.20261020000000' },
        { userId: 'u_admin', name: '鈴木 一郎', email: null, clientVersion: null },
      ] }) },
    })
    renderPage()
    expect(await screen.findByText('停止に対応していないアプリ: 2 人')).toBeInTheDocument()
    expect(screen.queryByText('田中 太郎')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '一覧を表示' }))
    expect(screen.getByText('田中 太郎')).toBeInTheDocument()
    expect(screen.getByText('版は不明')).toBeInTheDocument()
  })
})
