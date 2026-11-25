// 「ブラウザ操作の記録」 (agent-browser.md "Recording"): linked from 「ブラウザ操作」; a member or a department manager sees nothing
// and nothing is asked; the list says who, when, which site and how many lines; opening shows the steps in the core's
// words (never more than the recording holds); 消す asks first, キャンセル sends nothing, 消す deletes exactly that recording.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import BrowserRecordingsPage from '@/app/companies/[id]/advanced/ai-safety/browser/recordings/page'
import type { BrowserRecordingDetail, BrowserRecordingsList, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/ai-safety/browser/recordings`,
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

const ID = `br_${'a'.repeat(32)}`
const summary = {
  id: ID, userId: 'u_member', name: '田中 太郎', domain: 'shop.example.test', lines: 3,
  createdAt: '2026-11-25T01:00:00.000Z', deleteAt: '2026-12-25T01:00:00.000Z', mine: false,
}
const list: BrowserRecordingsList = { items: [summary], more: false }
const detail: BrowserRecordingDetail = {
  ...summary,
  content: {
    format: 1, domain: 'shop.example.test',
    steps: [
      { id: 1, kind: 'page', address: '/orders/{n}' },
      { id: 2, kind: 'click', target: 'button', label: '保存', address: null },
      { id: 3, kind: 'send', method: 'POST', override: null, address: '/api/orders/{n}', fields: [{ name: 'end_date', value: '値1', from: null }], status: 200, answerKeys: null, after: 2, count: 1 },
    ],
    hosts: [{ host: 'cdn.example-assets.test', loaded: false }],
  },
}
const routes = { [`GET ${base}/browser-recordings`]: { body: ok(list) }, [`GET ${base}/browser-recordings/${ID}`]: { body: ok(detail) } }

describe('ブラウザ操作の記録', () => {
  it('is linked from 「ブラウザ操作」', async () => {
    stubApi(ownerCapabilities, { [`GET ${base}/agent-browser`]: { body: ok({ settings: { mode: 'off', sites: [] }, overrides: [], updatedAt: null, updatedBy: null, history: [] }) } })
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByRole('link', { name: /ブラウザ操作の記録/ })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/recordings')
  })

  it('a member or a department manager sees nothing and nothing is asked', async () => {
    const calls = stubApi(managerCapabilities)
    renderInCompany(<BrowserRecordingsPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => /browser-recordings/.test(c.url))).toBe(false)
  })

  it('lists who sent it, when, which site and how many lines; opening shows its steps in the core\'s words', async () => {
    stubApi(ownerCapabilities, routes)
    renderInCompany(<BrowserRecordingsPage />)
    const cell = await screen.findByRole('cell', { name: '田中 太郎' })
    const tr = cell.closest('tr') as HTMLElement
    expect(within(tr).getByText('shop.example.test')).toBeInTheDocument()
    expect(within(tr).getByText('3')).toBeInTheDocument()
    await userEvent.click(within(tr).getByRole('button', { name: '開く' }))
    const steps = await screen.findByRole('list', { name: '記録の手順' })
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3)
    expect(within(steps).getByText('「保存」')).toBeInTheDocument()
    expect(within(steps).getByText(/POST \/api\/orders\/\{n\} ［end_date=値1］ → 200/)).toBeInTheDocument()
    expect(within(steps).getByText('（推定）手順2のあと')).toBeInTheDocument()
    expect(screen.getByText('cdn.example-assets.test（読み込めませんでした）')).toBeInTheDocument()
  })

  it('消す asks first; キャンセル sends nothing, 消す deletes exactly that recording', async () => {
    const calls = stubApi(ownerCapabilities, { ...routes, [`DELETE ${base}/browser-recordings/${ID}`]: { body: ok({ deleted: true }) } })
    renderInCompany(<BrowserRecordingsPage />)
    const tr = (await screen.findByRole('cell', { name: '田中 太郎' })).closest('tr') as HTMLElement
    await userEvent.click(within(tr).getByRole('button', { name: /消す/ }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('この記録を消しますか？')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    await userEvent.click(within(tr).getByRole('button', { name: /消す/ }))
    dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '消す' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ url: `${base}/browser-recordings/${ID}` })
  })
})
