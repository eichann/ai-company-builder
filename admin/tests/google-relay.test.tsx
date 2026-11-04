// 「API キー」→「本人の許可で中継する」 (google-connector.md "The relay"): each control sends only
// what it changes — a service tick only that service, the cap only the cap, a member's stop only
// after the admin confirms it and only for that member — and the records never show more than the
// server gave (no cell content exists to show).
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import ApiKeysPage from '@/app/companies/[id]/advanced/ai-safety/keys/page'
import type { BrokerView, GoogleRelayAdminView } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/api-keys`,
  useSearchParams: () => new URLSearchParams(),
}))

const broker: BrokerView = {
  status: { enabled: true, reason: null },
  settings: { memberKeysAllowed: true, internalHosts: [], updatedAt: null, updatedBy: null },
  services: [], keys: [], departments: [], history: [],
}

const relay: GoogleRelayAdminView = {
  available: true, reason: null,
  services: [{ service: 'sheets', on: false }],
  capPerMemberPerDay: 500, stopped: false,
  members: [
    { userId: 'u_takasugi', memberName: '高杉 晋', memberEmail: 'takasugi@example.com', allowed: true, allowedAt: '2026-11-04T00:10:00.000Z', stopped: false, usedToday: 37 },
    { userId: 'u_sato', memberName: '佐藤 花子', memberEmail: 'sato@example.com', allowed: true, allowedAt: null, stopped: false, usedToday: 6 },
  ],
  records: [
    { id: 'e1', at: '2026-11-04T01:32:00.000Z', userId: 'u_takasugi', memberName: '高杉 晋', service: 'sheets', operation: 'spreadsheets.batchUpdate', spreadsheetId: 'sheet-123', range: null, status: 403, result: 'refused', reason: 'deletion' },
    { id: 'e2', at: '2026-11-04T01:31:00.000Z', userId: 'u_sato', memberName: '佐藤 花子', service: 'sheets', operation: 'values.get', spreadsheetId: 'sheet-9', range: '売上!A1:C9', status: 200, result: 'ok', reason: null },
  ],
}

type Reply = { status?: number; body: unknown }
function stubApi(extra: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const routes = { ...companyRoutes(ownerCapabilities), [`GET ${base}/broker`]: { body: ok(broker) }, [`GET ${base}/google/relay`]: { body: ok(relay) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
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

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

describe('本人の許可で中継する', () => {
  it('ticking スプレッドシート sends only that service; the cap sends only the cap', async () => {
    const calls = stubApi({
      [`PUT ${base}/google/relay`]: (call) => ({ body: ok({ ...relay, services: [{ service: 'sheets', on: true }], capPerMemberPerDay: (call.body as { capPerMemberPerDay?: number }).capPerMemberPerDay ?? 500 }) }),
    })
    renderInCompany(<ApiKeysPage />)
    const card = await screen.findByTestId('google-relay')
    await userEvent.click(within(card).getByRole('checkbox', { name: /スプレッドシート/ }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ method: 'PUT', url: `${base}/google/relay`, body: { services: { sheets: true } } })
    const cap = within(card).getByLabelText('1人あたりの上限')
    await userEvent.clear(cap)
    await userEvent.type(cap, '0')
    expect(within(card).getByRole('button', { name: '保存' })).toBeDisabled()
    await userEvent.clear(cap)
    await userEvent.type(cap, '300')
    await userEvent.click(within(card).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(2))
    expect(writes(calls)[1].body).toEqual({ capPerMemberPerDay: 300 })
  })

  it('a member\'s stop asks first and sends only that member', async () => {
    const calls = stubApi({
      [`PUT ${base}/google/relay/members/u_takasugi`]: { body: ok({ ...relay, members: [{ ...relay.members[0], stopped: true }, relay.members[1]] }) },
    })
    renderInCompany(<ApiKeysPage />)
    const row = await screen.findByTestId('google-relay-member-u_takasugi')
    await userEvent.click(within(row).getByRole('button', { name: /この人の中継を止める/ }))
    expect(writes(calls)).toHaveLength(0)
    await userEvent.click(within(row).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ method: 'PUT', url: `${base}/google/relay/members/u_takasugi`, body: { stopped: true } })
    expect(await within(screen.getByTestId('google-relay-member-u_takasugi')).findByText('止めています')).toBeInTheDocument()
  })

  it('stopping everyone asks first; the records say a deletion was not relayed', async () => {
    const calls = stubApi({ [`PUT ${base}/google/relay`]: { body: ok({ ...relay, stopped: true }) } })
    renderInCompany(<ApiKeysPage />)
    const card = await screen.findByTestId('google-relay')
    expect(within(card).getByText('消す操作は中継しません')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: /全員の中継を止める/ }))
    expect(writes(calls)).toHaveLength(0)
    await userEvent.click(within(card).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0].body).toEqual({ stopped: true })
  })
})
