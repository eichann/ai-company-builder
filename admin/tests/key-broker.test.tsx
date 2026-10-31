// 「API キー」 (the key broker's admin page): who sees it, that a key's value is
// sent once and never shown, that editing never sends a value, that a
// destination which is not an exact host cannot be saved, that the two dials
// (which departments' work, which people) reach the request as chosen, that
// a generic service (K9) is saved only with https to one exact host and a
// safe header, its keys going only there, that one switch per built-in service
// allows own keys without typing a host, that the page says how a saved key's
// check went (and that a refused key was not saved) without ever showing it, a
// generic service's check path is a plain path, and what the page says when
// the server has no key-encryption key.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
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
  { service: 'gemini', label: 'Google Gemini', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['generativelanguage.googleapis.com'], companyKeys: 0, userKeys: 0, updatedAt: null, relay: null, readOnly: false, practice: false },
  { service: 'openai', label: 'OpenAI', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.openai.com'], companyKeys: 0, userKeys: 0, updatedAt: null, relay: null, readOnly: false, practice: false },
  { service: 'hubspot', label: 'HubSpot', builtin: true, category: 'system', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.hubapi.com'], companyKeys: 0, userKeys: 0, updatedAt: null, relay: null, readOnly: false, practice: false },
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

  it('a built-in service\'s key goes to that service\'s host, also when its name is typed under その他 (staging: a HubSpot key saved with Gemini\'s host)', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/broker/keys`]: () => ({ body: ok(view) }),
    })
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'API キーを登録' }))
    const dialog = await screen.findByRole('dialog')
    // The form opens on the first service (Gemini); the name is then typed under その他.
    await userEvent.selectOptions(within(dialog).getByLabelText('サービス'), 'その他（名前を入力）')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'サービス名' }), 'hubspot')
    await userEvent.type(within(dialog).getByLabelText('名前'), '営業の HubSpot')
    await userEvent.type(within(dialog).getByLabelText('キー'), FAKE)
    const hosts = within(dialog).getByRole('textbox', { name: '送ってよいホスト' })
    expect(hosts).toHaveValue('api.hubapi.com')
    expect(hosts).toHaveAttribute('readonly')
    await userEvent.click(within(dialog).getByRole('button', { name: '登録' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ service: 'hubspot', destinations: { hosts: ['api.hubapi.com'] } })
  })

  it('chosen from the list, a built-in service\'s host is fixed (no field that could keep another service\'s host)', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/broker/keys`]: () => ({ body: ok(view) }),
    })
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'API キーを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByLabelText('サービス'), 'HubSpot')
    await userEvent.type(within(dialog).getByLabelText('名前'), 'H')
    await userEvent.type(within(dialog).getByLabelText('キー'), FAKE)
    await userEvent.type(within(dialog).getByRole('textbox', { name: '送ってよいホスト' }), '\ngenerativelanguage.googleapis.com')
    await userEvent.click(within(dialog).getByRole('button', { name: '登録' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ service: 'hubspot', destinations: { hosts: ['api.hubapi.com'] } })
  })

  it('a saved built-in key whose hosts are not its service\'s is marked to fix, and editing it sends the service\'s host', async () => {
    const wrong: BrokerKeySummary = { ...stored, id: 'k2', service: 'hubspot', displayName: '営業の HubSpot', destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: [] } }
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/broker`]: { body: ok({ ...view, keys: [wrong] }) },
      [`PATCH ${base}/broker/keys/k2`]: () => ({ body: ok({ ...view, keys: [wrong] }) }),
    })
    renderInCompany(<ApiKeysPage />)
    expect(await screen.findByText(/送り先が HubSpot のものではないため、この鍵は使われていません/)).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: '設定を変更' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: '送ってよいホスト' })).toHaveValue('api.hubapi.com')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ destinations: { hosts: ['api.hubapi.com'] } })
  })

  it('a destination that is not one exact host cannot be saved', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'API キーを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByLabelText('サービス'), 'その他（名前を入力）')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'サービス名' }), 'my-crm')
    await userEvent.type(within(dialog).getByLabelText('名前'), 'x')
    await userEvent.type(within(dialog).getByLabelText('キー'), FAKE)
    await userEvent.type(within(dialog).getByRole('textbox', { name: '送ってよいホスト' }), 'api.example.com\n*.googleapis.com')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('*.googleapis.com')
    expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a generic service (K9) cannot be saved with an address that is not https to one exact public host', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'サービスを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('サービス名（英字）'), 'crm')
    await userEvent.type(within(dialog).getByLabelText('表示名'), '顧客管理')
    const url = within(dialog).getByLabelText('送り先（ベース URL）')
    for (const bad of ['http://api.crm.example.com', 'https://10.0.0.5', 'https://api.crm.example.com:8443', 'https://crm.internal']) {
      await userEvent.clear(url)
      await userEvent.type(url, bad)
      expect(within(dialog).getByRole('alert'), bad).toHaveTextContent('https://')
      expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    }
    // A header that would let the key frame or route the request.
    await userEvent.clear(url)
    await userEvent.type(url, 'https://api.crm.example.com/v2')
    await userEvent.selectOptions(within(dialog).getByLabelText('鍵の渡し方'), 'custom')
    await userEvent.type(within(dialog).getByLabelText('鍵を入れるヘッダの名前'), 'Host')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('ヘッダ')
    expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('a generic service is registered with its destination and header, and its keys can go only to that host', async () => {
    const crm = {
      service: 'crm', label: '顧客管理', builtin: false, category: 'system' as const, rule: 'company-only' as const, ownKeyHosts: [], defaultHosts: ['api.crm.example.com'],
      companyKeys: 0, userKeys: 0, updatedAt: '2026-10-30T00:00:00.000Z',
      relay: { label: '顧客管理', host: 'api.crm.example.com', basePath: '/v2', header: 'authorization', format: 'Bearer {key}' },
    }
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/broker/relay-services/crm`]: () => ({ body: ok({ ...view, services: [...services, crm] }) }),
      [`POST ${base}/broker/keys`]: () => ({ body: ok({ ...view, services: [...services, crm] }) }),
    })
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'サービスを登録' }))
    let dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('サービス名（英字）'), 'crm')
    await userEvent.type(within(dialog).getByLabelText('表示名'), '顧客管理')
    await userEvent.clear(within(dialog).getByLabelText('送り先（ベース URL）'))
    await userEvent.type(within(dialog).getByLabelText('送り先（ベース URL）'), 'https://api.crm.example.com/v2')
    await userEvent.selectOptions(within(dialog).getByLabelText('種類'), 'system')
    await userEvent.click(within(dialog).getByRole('button', { name: '登録' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      label: '顧客管理', baseUrl: 'https://api.crm.example.com/v2', header: 'authorization', format: 'Bearer {key}', category: 'system',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The names a script reads in the app.
    expect(await screen.findByText('ACB_CRM_BASE_URL・ACB_CRM_API_KEY')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'API キーを登録' }))
    dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(within(dialog).getByLabelText('サービス'), 'crm')
    const hosts = within(dialog).getByRole('textbox', { name: '送ってよいホスト' })
    expect(hosts).toHaveAttribute('readonly')
    await userEvent.type(within(dialog).getByLabelText('名前'), 'CRM')
    await userEvent.type(within(dialog).getByLabelText('キー'), FAKE)
    await userEvent.click(within(dialog).getByRole('button', { name: '登録' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ service: 'crm', destinations: { hosts: ['api.crm.example.com'] } })
  })

  it('one switch lets members use own keys for a built-in service: only { allowed } is sent, no host typed', async () => {
    const on = services.map((s) => (s.service === 'gemini' ? { ...s, rule: 'company-first' as const, ownKeyHosts: ['generativelanguage.googleapis.com'] } : s))
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/broker/services/gemini/own-keys`]: () => ({ body: ok({ ...view, services: on }) }),
    })
    renderInCompany(<ApiKeysPage />)
    const row = await screen.findByRole('listitem', { name: 'Google Gemini' })
    // The detailed form (hosts typed by hand) stays closed for a service whose destination is known.
    expect(within(row).queryByRole('textbox', { name: 'Google Geminiの自分の鍵の送り先' })).not.toBeInTheDocument()
    await userEvent.click(within(row).getByRole('checkbox', { name: /メンバーが自分の鍵を使ってよい/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')!
    expect([put.url, put.body]).toEqual([`${base}/broker/services/gemini/own-keys`, { allowed: true }])
    const after = await screen.findByRole('listitem', { name: 'Google Gemini' })
    expect(within(after).getByRole('checkbox', { name: /メンバーが自分の鍵を使ってよい/ })).toBeChecked()
    expect(within(after).getByText('generativelanguage.googleapis.com')).toBeInTheDocument()
    expect(within(after).getByText('決め方: 会社の鍵が優先、なければ自分の鍵')).toBeInTheDocument()
  })

  it('says how the one check of a saved key went, and a refused key is reported as not saved', async () => {
    const answers = [
      { body: ok({ ...view, keys: [stored], check: { service: 'gemini', result: 'valid' } }) },
      { status: 400, body: { error: 'The service refused this key (one read-only check request); it was not saved', code: 'KEY_REJECTED' } },
    ]
    stubApi(ownerCapabilities, {
      [`GET ${base}/broker`]: { body: ok({ ...view, keys: [stored] }) },
      [`PUT ${base}/broker/keys/k1/secret`]: () => answers.shift()!,
    })
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    renderInCompany(<ApiKeysPage />)
    const replace = async () => {
      await userEvent.click(await screen.findByRole('button', { name: 'キーを差し替える' }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.type(within(dialog).getByLabelText('新しいキー'), FAKE)
      await userEvent.click(within(dialog).getByRole('button', { name: '差し替える' }))
    }
    await replace()
    await waitFor(() => expect(success).toHaveBeenCalledWith('キーを差し替えました', { description: '鍵が有効なことを確かめました' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await replace()
    await waitFor(() => expect(error).toHaveBeenCalledWith('保存できませんでした', { description: 'この鍵は使えませんでした（発行元の画面で確かめてください）。保存していません。' }))
    // The dialog stays open so the member can paste another key; nothing shows the value.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(JSON.stringify([...success.mock.calls, ...error.mock.calls])).not.toContain(FAKE)
    expect(document.body.textContent).not.toContain(FAKE)
  })

  it('a generic service\'s check path must be a plain path (no query, no ..)', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<ApiKeysPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'サービスを登録' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('サービス名（英字）'), 'crm')
    await userEvent.type(within(dialog).getByLabelText('表示名'), '顧客管理')
    await userEvent.clear(within(dialog).getByLabelText('送り先（ベース URL）'))
    await userEvent.type(within(dialog).getByLabelText('送り先（ベース URL）'), 'https://api.crm.example.com/v2')
    const check = within(dialog).getByLabelText('鍵を確かめる住所（なくてもよい）')
    for (const bad of ['/me?x=1', '/../admin', 'me']) {
      await userEvent.clear(check)
      await userEvent.type(check, bad)
      expect(within(dialog).getByRole('alert'), bad).toHaveTextContent('鍵を確かめる住所')
      expect(within(dialog).getByRole('button', { name: '登録' })).toBeDisabled()
    }
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
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
