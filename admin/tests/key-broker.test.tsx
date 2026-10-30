// 「API キー」 (the key broker's admin page): who sees it, that a key's value is
// sent once and never shown, that editing never sends a value, that a
// destination which is not an exact host cannot be saved, that the two dials
// (which departments' work, which people) reach the request as chosen, and
// what the page says when the server has no key-encryption key.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import ApiKeysPage from '@/app/companies/[id]/api-keys/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { BrokerKeySummary, BrokerView, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/api-keys`,
  useSearchParams: () => new URLSearchParams(),
}))

const FAKE = 'fake-test-key-NOT-REAL-admin-0123456789'

const services: BrokerView['services'] = [
  { service: 'gemini', label: 'Google Gemini', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['generativelanguage.googleapis.com'], companyKeys: 0, userKeys: 0, updatedAt: null },
  { service: 'openai', label: 'OpenAI', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.openai.com'], companyKeys: 0, userKeys: 0, updatedAt: null },
]

const view: BrokerView = {
  status: { enabled: true, reason: null },
  settings: { memberKeysAllowed: true, internalHosts: [], updatedAt: null, updatedBy: null },
  services,
  keys: [],
  departments: [{ id: 'd_sales', name: '営業部', folder: '営業部' }, { id: 'd_dev', name: '開発部', folder: 'development' }],
  history: [],
}

const stored: BrokerKeySummary = {
  id: 'k1', scope: 'company', ownerUserId: null, ownerName: null, service: 'gemini', displayName: '営業用 Gemini', last4: FAKE.slice(-4),
  destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: [] },
  audience: { allDepartments: false, departmentIds: ['d_sales'], everyone: false, addUserIds: ['u_owner'], removeUserIds: [] },
  caps: { requestsPerDay: null, tokensPerDay: null, requestsPerMemberPerDay: null, tokensPerMemberPerDay: null },
  allowPrivateContent: false, status: 'active', createdAt: '2026-10-30T00:00:00.000Z', createdBy: 'u_owner',
  updatedAt: '2026-10-30T00:00:00.000Z', updatedBy: 'u_owner', secretUpdatedAt: '2026-10-30T00:00:00.000Z',
  usableBy: [{ userId: 'u_owner', name: '佐藤 花子', email: 'sato@example.com', via: 'person' }],
  usageToday: { requests: 3, tokens: 1200 },
}

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const routes = { ...companyRoutes(caps), [`GET ${base}/broker`]: { body: ok(view) }, ...extra } as Record<string, Reply | ((call: Call) => Reply)>
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

describe('API キー', () => {
  it('is in the menu for owners and admins only, and a member never loads the keys', async () => {
    const item = NAV_ITEMS.find((i) => i.segment === 'api-keys')!
    expect(item.label).toBe('API キー')
    expect(item.visible?.({ isAdmin: false, isManager: true, canViewAgentEvents: true })).toBe(false)
    expect(item.visible?.({ isAdmin: true, isManager: false, canViewAgentEvents: false })).toBe(true)
    const calls = stubApi(managerCapabilities)
    renderInCompany(<ApiKeysPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/broker'))).toBe(false)
  })

  it('a key is sent once, in a password field, and the page shows only its last 4 afterwards', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/broker/keys`]: () => ({ body: ok({ ...view, keys: [stored] }) }),
    })
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'API キーを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名前'), '営業用 Gemini')
    const secret = within(dialog).getByLabelText('キー')
    expect(secret).toHaveAttribute('type', 'password')
    await userEvent.type(secret, FAKE)
    await userEvent.click(within(dialog).getByRole('radio', { name: '選んだ部署だけ' }))
    // No department chosen yet: nothing to save.
    expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '営業部' }))
    await userEvent.click(within(dialog).getByRole('radio', { name: '指定した人だけ' }))
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '田中 太郎の扱い' }), 'add')
    await userEvent.click(within(dialog).getByRole('button', { name: '登録' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      service: 'gemini',
      displayName: '営業用 Gemini',
      secret: FAKE,
      destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: [] },
      audience: { allDepartments: false, departmentIds: ['d_sales'], everyone: false, addUserIds: ['u_member'], removeUserIds: [] },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(`…${FAKE.slice(-4)}`)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(FAKE)
    expect(document.body.innerHTML).not.toContain(FAKE)
  })

  it('editing a key\'s settings never sends a value', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/broker`]: { body: ok({ ...view, keys: [stored] }) },
      [`PATCH ${base}/broker/keys/k1`]: () => ({ body: ok({ ...view, keys: [stored] }) }),
    })
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: '設定を変更' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('キー')).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('radio', { name: '全員' }))
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '田中 太郎の扱い' }), 'remove')
    await userEvent.click(within(dialog).getByRole('radio', { name: '全社' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const body = calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>
    expect(body).not.toHaveProperty('secret')
    // 全員 keeps only removals; 全社 drops the departments.
    expect(body.audience).toEqual({ allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: ['u_member'] })
  })

  it('a destination that is not one exact host cannot be saved', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'API キーを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名前'), 'x')
    await userEvent.type(within(dialog).getByLabelText('キー'), FAKE)
    await userEvent.type(within(dialog).getByRole('textbox', { name: '送ってよいホスト' }), '\n*.googleapis.com')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('*.googleapis.com')
    expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('without a key-encryption key on the server: says so and offers no registration', async () => {
    stubApi(ownerCapabilities, {
      [`GET ${base}/broker`]: { body: ok({ ...view, status: { enabled: false, reason: 'not-configured' } }) },
    })
    renderInCompany(<ApiKeysPage />)
    expect(await screen.findByText('API キーを預かる機能は、いまは使えません')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'API キーを登録' })).not.toBeInTheDocument()
  })
})
