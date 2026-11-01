// 「つなぎ先」 (connector plugins, milestone 3 P8): who sees it, that a key is
// shown by its name and last 4 only, that the practice HubSpot is said
// plainly, that the table view writes YAML the server's strict reader takes
// back unchanged (stage never offered for writing, comments aside), that an
// automatic field is saved only after the workflow acknowledgement is ticked
// and then sent as `acknowledgeAuto`, that 「HubSpot に聞いて確かめる」 sends
// the text being edited and shows what does not match, that who may read the
// outside system through the relay is chosen by department / member and an
// empty choice is said plainly (the server refuses turning on), and that the
// page speaks without jargon.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import IntegrationsPage from '@/app/companies/[id]/integrations/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { BrokerKeySummary, BrokerView, Capabilities, CoreConnectorsView, GoogleAdminView, GoogleGrantSummary, PluginDetail, PluginListItem } from '@/lib/api'
import { changeMappingField, mappingRows, mappingToYaml } from '@/lib/integrations'
import { parseYamlLite } from '../../shared/core/yaml-lite'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/integrations`,
  useSearchParams: () => new URLSearchParams(),
}))

const MAPPING = `# 会社の読み替え表
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
    updated_within_days: 180
    max: 500
  fields:
    title:      { from: dealname, write: false }
    stage:      { from: dealstage, write: false, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal } }
    confidence: { from: hs_forecast_probability, write: true, values: { "0.8": a, "0.5": b, "0.2": c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
  links:
    customer:   { from_association: companies }
people:
  owners:
    "75123001": u_member
policy:
  amount: prior
`

/** The connector (owner decision 2026-11-01): a shared part with the key and who may read it; no mapping. */
const pkg = {
  id: 'hubspot', label: 'HubSpot', version: '0.3.0', kind: 'official' as const, role: 'connector' as const, description: null, service: 'hubspot', host: 'api.hubapi.com',
  scopes: [], operationScopes: {}, types: [], operations: [], fingerprint: 'f', stopped: false, connector: null,
}
/** The business using it: the records' shape, the mapping and the import. */
const salesPkg = {
  ...pkg, id: 'corporate-sales', label: '法人営業', version: '0.2.0', role: 'business' as const, service: '', host: '', types: ['deal', 'customer'],
  connector: { id: 'hubspot', minVersion: '0.3.0', label: 'HubSpot' },
}
const item: PluginListItem = {
  id: 'hubspot', versions: [pkg],
  install: {
    version: '0.3.0', enabled: false, keyId: 'k1', mappingVersion: 0, connectionId: 'c1', accountId: null, managedSince: null,
    updatedAt: '2026-10-31T00:00:00.000Z', updatedBy: 'u_owner', problem: 'off',
  },
}
const detail: PluginDetail = {
  plugin: item, mapping: null, mappingVersions: [], policies: [], labels: {}, mappingErrors: [], autoAcknowledgements: [],
  history: [{ action: 'install', at: '2026-10-31T00:00:00.000Z', by: 'u_owner', change: {} }],
  readScope: { departmentIds: [], userIds: [] },
}
const salesItem: PluginListItem = {
  id: 'corporate-sales', versions: [salesPkg],
  install: { ...item.install!, version: '0.2.0', keyId: null, enabled: true, problem: null, mappingVersion: 1, connectionId: 'c2' },
}
const salesDetail: PluginDetail = {
  plugin: salesItem,
  mapping: { version: 1, text: MAPPING, createdAt: '2026-10-31T00:00:00.000Z', createdBy: 'u_owner' },
  mappingVersions: [{ version: 1, createdAt: '2026-10-31T00:00:00.000Z', createdBy: 'u_owner' }],
  policies: [
    { operation: 'update_deal', object: 'deal', field: 'confidence', policy: 'prior' },
    { operation: 'update_deal', object: 'deal', field: 'next_step', policy: 'auto' },
    { operation: 'update_deal', object: 'deal', field: 'amount', policy: 'prior' },
  ],
  labels: { deal: { label: '案件', fields: { title: '件名', stage: '段階', confidence: '確度', next_step: '次のアクション', amount: '金額' } } },
  mappingErrors: [],
  autoAcknowledgements: [],
  history: [{ action: 'install', at: '2026-10-31T00:00:00.000Z', by: 'u_owner', change: {} }],
  readScope: { departmentIds: [], userIds: [] },
}

const SECRET = 'pat-fake-NOT-REAL-admin-integrations-9876'
const key: BrokerKeySummary = {
  id: 'k1', scope: 'company', ownerUserId: null, ownerName: null, service: 'hubspot', displayName: '営業の HubSpot', last4: SECRET.slice(-4),
  destinations: { hosts: ['api.hubapi.com'], pathPrefixes: [], models: [] },
  audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
  caps: { requestsPerDay: null, tokensPerDay: null, requestsPerMemberPerDay: null, tokensPerMemberPerDay: null },
  allowPrivateContent: false, status: 'active', createdAt: '2026-10-30T00:00:00.000Z', createdBy: 'u_owner',
  updatedAt: '2026-10-30T00:00:00.000Z', updatedBy: 'u_owner', secretUpdatedAt: '2026-10-30T00:00:00.000Z', usableBy: [], usageToday: { requests: 0, tokens: 0 },
}
const broker = (practice: boolean): BrokerView => ({
  status: { enabled: true, reason: null },
  settings: { memberKeysAllowed: true, internalHosts: [], updatedAt: null, updatedBy: null },
  services: [{ service: 'hubspot', label: 'HubSpot', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.hubapi.com'], companyKeys: 1, userKeys: 0, updatedAt: null, relay: null, readOnly: true, defaultKeyId: null, practice }],
  keys: [key],
  departments: [],
  history: [],
})

const GOOGLE_SECRET = 'fake-google-secret-NOT-REAL-admin-1234'
const googleGrant: GoogleGrantSummary = {
  userId: 'u_member', memberEmail: 'tanaka@example.com', memberName: '田中 太郎', googleEmail: 'tanaka@example.com',
  features: ['minutes'], featuresOff: [], scopes: [], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null,
}
const googleView = (over: Partial<GoogleAdminView> = {}): GoogleAdminView => ({
  vaultEnabled: true, configured: true, clientId: '123-abc.apps.googleusercontent.com', secretLast4: GOOGLE_SECRET.slice(-4), domain: 'example.com',
  enabled: true, redirectUri: 'https://acb.example.com/api/oauth/google/callback', practice: false, operatorStopped: false,
  updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'u_owner', grants: [googleGrant], history: [],
  picker: { configured: false, appId: null, apiKeyLast4: null, pageUrl: 'https://acb.example.com/api/google-picker' }, ...over,
})

const coreView = (over: { enabled?: boolean; candidates?: string[]; choice?: string | null } = {}): CoreConnectorsView => {
  const enabled = over.enabled ?? true
  const candidates = over.candidates ?? (enabled ? ['google'] : [])
  const choiceNeeded = candidates.length > 1 && !over.choice
  const served = choiceNeeded ? null : over.choice ?? candidates[0] ?? null
  return {
    connectors: [{
      id: 'google', label: 'Google Workspace', summary: 'メンバーが自分で許可すると、予定・メール・Meet の議事録を ACB が読みます。', status: enabled ? 'on' : 'off',
      configured: true, enabled, operatorStopped: false,
      roles: [
        { role: 'calendar', label: '予定を読む', operations: ['read'], capabilities: [] },
        { role: 'mail', label: 'メールを読む・送る', operations: ['read', 'send'], capabilities: [] },
      ],
      capabilities: [{ id: 'drive', label: 'Drive で選んだものを読む・置く' }],
    }],
    roles: [
      { role: 'calendar', label: '予定を読む', candidates, choice: over.choice ?? null, servedBy: served, choiceNeeded },
      { role: 'chat', label: 'チャットの連絡を受け取る・返す', candidates: [], choice: null, servedBy: null, choiceNeeded: false },
    ],
  }
}

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}, practice = false, plugins: PluginListItem[] = [item]) {
  const routes = {
    ...companyRoutes(caps),
    [`GET ${base}/plugins`]: { body: ok({ plugins }) },
    [`GET ${base}/plugins/hubspot`]: { body: ok(detail) },
    [`GET ${base}/plugins/corporate-sales`]: { body: ok(salesDetail) },
    [`GET ${base}/broker`]: { body: ok(broker(practice)) },
    [`GET ${base}/google`]: { body: ok(googleView({ configured: false, clientId: null, secretLast4: null, domain: null, enabled: false, grants: [] })) },
    [`GET ${base}/connectors`]: { body: ok(coreView()) },
    ...extra,
  } as Record<string, Reply | ((call: Call) => Reply)>
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

describe('the table view of the mapping', () => {
  it('writes YAML the strict reader takes back as the same value (quoted ids and numbers, Japanese folders)', () => {
    const parsed = parseYamlLite(MAPPING)
    if (!parsed.ok) throw new Error(parsed.error)
    const again = parseYamlLite(mappingToYaml(parsed.value as Record<string, never>))
    expect(again).toEqual(parsed)
    const odd = { deal: { fields: { next_step: { from: 'a "quoted" value: with # and , [x]', write: true } } }, policy: { next_step: 'auto' }, people: { owners: { '007': 'null', yes: 'true' } } }
    expect(parseYamlLite(mappingToYaml(odd))).toEqual({ ok: true, value: odd })
  })

  it('a choice sets write and an explicit policy; reading only drops the policy; the stage is never automatic', () => {
    const auto = changeMappingField(MAPPING, 'deal', 'confidence', { choice: 'auto' })
    const rows = mappingRows(auto, [])
    if (!rows.ok) throw new Error(rows.error)
    expect(rows.rows.find((r) => r.field === 'confidence')).toMatchObject({ choice: 'auto', from: 'hs_forecast_probability' })
    const v = parseYamlLite(auto)
    expect(v.ok && (v.value as Record<string, Record<string, unknown>>).policy).toEqual({ amount: 'prior', confidence: 'auto' })

    const read = changeMappingField(auto, 'deal', 'amount', { choice: 'read' })
    const r2 = parseYamlLite(read)
    expect(r2.ok && (r2.value as Record<string, Record<string, unknown>>).policy).toEqual({ confidence: 'auto' })
    expect(r2.ok && ((r2.value as Record<string, Record<string, Record<string, Record<string, unknown>>>>).deal.fields.amount.write)).toBe(false)

    // A policy the text leaves to the package's defaults shows what the server says is in force.
    const fromServer = mappingRows(MAPPING, salesDetail.policies)
    expect(fromServer.ok && fromServer.rows.find((r) => r.field === 'next_step')?.choice).toBe('auto')
    expect(fromServer.ok && fromServer.rows.find((r) => r.field === 'stage')?.priorOnly).toBe(true)
  })
})

describe('つなぎ先', () => {
  it('is in the menu for owners and admins only, and a member never loads anything', async () => {
    const nav = NAV_ITEMS.find((i) => i.segment === 'integrations')!
    expect(nav.label).toBe('つなぎ先')
    expect(nav.visible?.({ isAdmin: false, isManager: true, canViewAgentEvents: true })).toBe(false)
    expect(nav.visible?.({ isAdmin: true, isManager: false, canViewAgentEvents: false })).toBe(true)
    const calls = stubApi(managerCapabilities)
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/plugins') || c.url.includes('/broker'))).toBe(false)
  })

  it('names the key by its name and last 4, says when HubSpot is the practice one, and uses no jargon', async () => {
    stubApi(ownerCapabilities, {}, true)
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByRole('option', { name: `営業の HubSpot（末尾 ${SECRET.slice(-4)}）` })).toBeInTheDocument()
    expect(await screen.findByText(/練習用の HubSpot につながっています/)).toBeInTheDocument()
    const text = document.body.textContent ?? ''
    for (const word of ['プラグイン', 'オントロジー', '型']) expect(text).not.toContain(word)
  })

  it("the business's mapping as a table: each field by its Japanese name, the stage never automatic, no jargon", async () => {
    stubApi(ownerCapabilities, {}, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    // The mapping table arrives with the detail (its own request).
    expect(await screen.findByText('受注・失注につながるため、自動にはできません')).toBeInTheDocument()
    const stage = screen.getByRole('combobox', { name: 'stage の書き戻し' })
    expect([...stage.querySelectorAll('option')].map((o) => o.textContent)).not.toContain('自動で書き戻す')
    // Each field by its Japanese name, the identifier only as small print beside it.
    const confidence = screen.getByRole('combobox', { name: 'confidence の書き戻し' }).closest('tr')!
    expect(confidence.querySelector('td')!.textContent).toBe('案件・確度deal.confidence')
    const text = document.body.textContent ?? ''
    for (const word of ['プラグイン', 'オントロジー', '型']) expect(text).not.toContain(word)
  })

  it('an automatic field is saved only after the workflow check is ticked, then sent as acknowledgeAuto', async () => {
    const saves: Call[] = []
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/plugins/corporate-sales/mapping`]: (call) => {
        saves.push(call)
        const body = call.body as { acknowledgeAuto: string[] }
        if (!body.acknowledgeAuto.includes('confidence')) {
          return { status: 400, body: { error: 'x', code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: ['confidence'], acknowledgement: 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました' } }
        }
        return { body: ok({ ...salesDetail, mapping: { ...salesDetail.mapping!, version: 2, text: (call.body as { text: string }).text } }) }
      },
    }, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'confidence の書き戻し' }), 'auto')
    await userEvent.click(screen.getByRole('button', { name: '保存（新しい版にする）' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: '確認して保存する' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました' }))
    await userEvent.click(confirm)
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[0].body).toMatchObject({ acknowledgeAuto: [] })
    expect(saves[1].body).toMatchObject({ acknowledgeAuto: ['confidence'] })
    const saved = parseYamlLite((saves[1].body as { text: string }).text)
    expect(saved.ok && (saved.value as Record<string, Record<string, unknown>>).policy).toMatchObject({ confidence: 'auto' })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('「HubSpot に聞いて確かめる」 sends the text being edited and shows what does not match', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/plugins/corporate-sales/mapping/check`]: () => ({
        body: ok({ reachable: true, reason: null, checkedAt: '2026-10-31T00:00:00.000Z', objects: { deal: { errors: ['欄「next_step」の項目「hs_next_stepp」は、つなぎ先にありません'], warnings: [] } } }),
      }),
    }, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    const input = await screen.findByRole('textbox', { name: 'next_step の HubSpot の項目' })
    await userEvent.clear(input)
    await userEvent.type(input, 'hs_next_stepp')
    await userEvent.click(screen.getByRole('button', { name: 'HubSpot に聞いて確かめる' }))
    expect(await screen.findByText('欄「next_step」の項目「hs_next_stepp」は、つなぎ先にありません')).toBeInTheDocument()
    const sent = calls.find((c) => c.url.endsWith('/mapping/check'))!.body as { text: string }
    expect(sent.text).toContain('hs_next_stepp')
    // Nothing saved by asking.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('when HubSpot cannot be asked it says so in plain words', async () => {
    stubApi(ownerCapabilities, {
      [`POST ${base}/plugins/corporate-sales/mapping/check`]: { body: ok({ reachable: false, reason: 'key-rejected', checkedAt: '2026-10-31T00:00:00.000Z', objects: {} }) },
    }, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'HubSpot に聞いて確かめる' }))
    expect(await screen.findByText(/HubSpot に聞けませんでした：鍵が受け付けられませんでした/)).toBeInTheDocument()
  })

  it('who may read HubSpot: nobody until chosen (said plainly); departments and members are sent by id', async () => {
    const saves: Call[] = []
    stubApi(ownerCapabilities, {
      [`PUT ${base}/plugins/hubspot/read-scope`]: (call) => {
        saves.push(call)
        return { body: ok({ ...detail, readScope: call.body }) }
      },
      [`PUT ${base}/plugins/hubspot/enabled`]: { status: 409, body: { error: 'x', code: 'READ_SCOPE_REQUIRED' } },
    })
    renderInCompany(<IntegrationsPage />)
    const section = await screen.findByRole('region', { name: 'HubSpot を読める人' })
    expect(within(section).getByText('まだ誰も選ばれていません（いまは誰も読めません）。')).toBeInTheDocument()
    // Turning on without a choice: the server's refusal in plain words.
    const error = vi.spyOn(toast, 'error')
    await userEvent.click(screen.getByRole('button', { name: 'オンにする' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('保存できませんでした', { description: expect.stringMatching(/先に「読める人」（部署かメンバー）を選んで保存してください/) }))

    await userEvent.click(within(section).getByRole('checkbox', { name: '営業部' }))
    await userEvent.click(within(section).getByRole('checkbox', { name: '田中 太郎' }))
    await userEvent.click(within(section).getByRole('button', { name: '読める人を保存' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body).toEqual({ departmentIds: ['d_sales'], userIds: ['u_member'] })
  })
})

describe('役割 of a business (plan C3)', () => {
  const roles = (userIds: string[]) => ok({
    pluginId: 'corporate-sales', label: '法人営業',
    roles: [{ name: 'sales_manager', label: '営業の責任者', description: '金額の承認をする人', userIds }],
    overrides: [], history: [],
  })
  it('lists each role by its label, says plainly when nobody holds it, and saves exactly the chosen members', async () => {
    const saves: Call[] = []
    stubApi(ownerCapabilities, {
      [`GET ${base}/plugins/corporate-sales/roles`]: { body: roles([]) },
      [`PUT ${base}/plugins/corporate-sales/roles/sales_manager`]: (call) => {
        saves.push(call)
        return { body: roles((call.body as { userIds: string[] }).userIds) }
      },
    }, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    const section = await screen.findByRole('region', { name: '役割' })
    const role = within(section).getByRole('group', { name: '営業の責任者' })
    expect(within(role).getByText('まだ誰も選ばれていません。')).toBeInTheDocument()
    await userEvent.click(within(role).getByRole('checkbox', { name: '田中 太郎' }))
    await userEvent.click(within(role).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body).toEqual({ userIds: ['u_member'] })
    for (const word of ['プラグイン', 'オントロジー', '型']) expect(section.textContent).not.toContain(word)
  })
})

describe('つなぎ先 and the business using it, each on its own (owner decision 2026-11-01)', () => {
  it('a connector shows its key, readers and switch, no mapping or import, and names no business', async () => {
    const calls = stubApi(ownerCapabilities)
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByRole('combobox', { name: '鍵' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'HubSpot を読める人' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取り込む' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'HubSpot に聞いて確かめる' })).toBeNull()
    expect(screen.getByText(/このつなぎ先を使うすべての業務の取り込みと書き戻しが、次の1回から止まります/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/先に「法人営業」/)
    expect(calls.some((c) => c.url.includes('/mapping'))).toBe(false)
  })

  it('a business says whether it is connected; while the connector is stopped it says so plainly and its records stay', async () => {
    const stopped: PluginListItem = { ...salesItem, install: { ...salesItem.install!, problem: 'connector-stopped' } }
    stubApi(ownerCapabilities, {
      [`GET ${base}/plugins/corporate-sales`]: { body: ok({ ...salesDetail, plugin: stopped }) },
    }, false, [stopped])
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByText('HubSpot との行き来は止まっています：つなぎ先がオフか、止まっています。記録はそのまま使えます。')).toBeInTheDocument()
    expect(screen.getByText('使っています')).toBeInTheDocument()
    expect(screen.getByText('案件や顧客などの記録を扱う業務です（外のサービスとは「HubSpot」でつなぎます）')).toBeInTheDocument()
    // No key or readers of its own: those are the connector's.
    expect(screen.queryByRole('combobox', { name: '鍵' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'HubSpot を読める人' })).toBeNull()
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
    const text = document.body.textContent ?? ''
    for (const word of ['プラグイン', 'オントロジー', '型']) expect(text).not.toContain(word)
  })

  it('a business not yet used says its records come at once and what the exchange with HubSpot needs', async () => {
    const fresh: PluginListItem = { ...salesItem, install: null }
    stubApi(ownerCapabilities, {
      [`GET ${base}/plugins/corporate-sales`]: { body: ok({ ...salesDetail, plugin: fresh, mapping: null }) },
    }, false, [fresh])
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByText(/使い始めると、すぐに案件や顧客などの記録が使えます。HubSpot との行き来（取り込みと書き戻し）には、「HubSpot」（0\.3\.0 以上）も使い始めて、オンにしてください/)).toBeInTheDocument()
  })

  it("saving the mapping before the connector is there: the server's sentence names what is needed", async () => {
    const sentence = '先に「HubSpot」（0.3.0 以上）を入れてください（読み替え表は「HubSpot」の項目と照らし合わせます）'
    stubApi(ownerCapabilities, {
      [`PUT ${base}/plugins/corporate-sales/mapping`]: { status: 409, body: { error: sentence, code: 'CONNECTOR_REQUIRED', plugin: 'hubspot', minVersion: '0.3.0' } },
    }, false, [salesItem])
    const error = vi.spyOn(toast, 'error')
    renderInCompany(<IntegrationsPage />)
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'amount の書き戻し' }), 'read')
    await userEvent.click(screen.getByRole('button', { name: '保存（新しい版にする）' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('保存できませんでした', { description: sentence }))
  })

  it('another HubSpot account found by the import: a new connection is started on the connector', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`POST ${base}/plugins/corporate-sales/import`]: { status: 409, body: { error: 'x', code: 'ACCOUNT_CHANGED' } },
      [`POST ${base}/plugins/hubspot/connection/renew`]: { body: ok({ connectionId: 'c3' }) },
    }, false, [salesItem])
    renderInCompany(<IntegrationsPage />)
    await userEvent.click(await screen.findByRole('button', { name: '取り込む' }))
    await userEvent.click(await screen.findByRole('button', { name: '新しいつなぎ先として始める' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '新しく始める' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/plugins/hubspot/connection/renew'))).toBe(true))
    expect(calls.some((c) => c.url.endsWith('/plugins/corporate-sales/connection/renew'))).toBe(false)
  })

  it('a business inside ACB only shows its version and switch: no key, readers, mapping or import', async () => {
    const acbOnly: PluginListItem = { ...salesItem, id: 'minutes-pack', versions: [{ ...salesPkg, id: 'minutes-pack', label: '会議の記録', connector: null }], install: { ...salesItem.install!, mappingVersion: 0 } }
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/plugins/minutes-pack`]: { body: ok({ ...salesDetail, plugin: acbOnly, mapping: null, mappingVersions: [], policies: [], labels: {} }) },
    }, false, [acbOnly])
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByText('案件や顧客などの記録を扱う業務です（外のサービスにはつなぎません）')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '版' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '鍵' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取り込む' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'HubSpot に聞いて確かめる' })).toBeNull()
    expect(calls.some((c) => c.url.includes('/read-scope') || c.url.includes('/mapping'))).toBe(false)
  })
})

describe('つなぎ先 → Google', () => {
  it('shows the address to register, sends the secret once (never shown), keeps it when left empty, stops a member, and uses no jargon', async () => {
    const saves: Call[] = []
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/google`]: { body: ok(googleView({ practice: true })) },
      [`PUT ${base}/google/client`]: (call) => { saves.push(call); return { body: ok(googleView({ practice: true })) } },
      [`DELETE ${base}/google/grants/u_member`]: { body: ok(googleView({ practice: true, grants: [{ ...googleGrant, status: 'stopped' }] })) },
    })
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByTestId('google-redirect-uri')).toHaveTextContent('https://acb.example.com/api/oauth/google/callback')
    expect(screen.getByText(/練習用の Google につながっています/)).toBeInTheDocument()
    expect(screen.getByText(/予定と議事録を読む/)).toBeInTheDocument()

    // A typed secret is sent once, in the PUT, and the field is emptied.
    const secret = screen.getByLabelText('クライアント シークレット')
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret).toHaveAttribute('placeholder', expect.stringContaining(`末尾 ${GOOGLE_SECRET.slice(-4)}`))
    await userEvent.type(secret, GOOGLE_SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Google の設定を保存' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body).toEqual({ clientId: '123-abc.apps.googleusercontent.com', domain: 'example.com', clientSecret: GOOGLE_SECRET })
    await waitFor(() => expect(secret).toHaveValue(''))
    expect(document.body.innerHTML).not.toContain(GOOGLE_SECRET)
    // Changing only the domain never sends a secret.
    const domain = screen.getByLabelText('社内のドメイン')
    await userEvent.clear(domain)
    await userEvent.type(domain, 'example.co.jp')
    await userEvent.click(screen.getByRole('button', { name: 'Google の設定を保存' }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].body).toEqual({ clientId: '123-abc.apps.googleusercontent.com', domain: 'example.co.jp' })

    // 「止める」 asks first, then stops that member only.
    const row = screen.getByTestId('google-grant-u_member')
    await userEvent.click(within(row).getByRole('button', { name: '止める' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `${base}/google/grants/u_member`)).toBe(true))
    expect(await screen.findByText('止めました')).toBeInTheDocument()

    const text = document.body.textContent ?? ''
    for (const word of ['OAuth', 'スコープ', 'トークン', 'プラグイン', 'オントロジー']) expect(text).not.toContain(word)
  })
  it('Drive の ファイル選び: shows the page to allow, sends the API key once (password field), keeps it when left empty', async () => {
    const saves: Call[] = []
    const registered = googleView({ picker: { configured: true, appId: '123456789012', apiKeyLast4: 'wxyz', pageUrl: 'https://acb.example.com/api/google-picker' } })
    stubApi(ownerCapabilities, {
      [`GET ${base}/google`]: { body: ok(googleView()) },
      [`PUT ${base}/google/picker`]: (call) => { saves.push(call); return { body: ok(registered) } },
    })
    renderInCompany(<IntegrationsPage />)
    expect(await screen.findByTestId('google-picker-page')).toHaveTextContent('https://acb.example.com/api/google-picker')
    const key = screen.getByLabelText('API キー')
    expect(key).toHaveAttribute('type', 'password')
    const KEY = 'AIzaFAKE-NOT-REAL-picker-key-0000wxyz'
    await userEvent.type(key, KEY)
    await userEvent.type(screen.getByLabelText('プロジェクト番号'), '123456789012')
    await userEvent.click(screen.getByRole('button', { name: 'ファイル選びの設定を保存' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body).toEqual({ appId: '123456789012', apiKey: KEY })
    await waitFor(() => expect(key).toHaveValue(''))
    expect(document.body.innerHTML).not.toContain(KEY)
    expect(key).toHaveAttribute('placeholder', expect.stringContaining('末尾 wxyz'))
    await userEvent.click(screen.getByRole('button', { name: 'ファイル選びの設定を保存' }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].body).toEqual({ appId: '123456789012' })
  })
})

describe('つなぎ先 → つないでいるサービス', () => {
  it('shows Google with what it does and its state, switches it with its own switch, and uses no jargon', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/connectors/google/enabled`]: { body: ok(coreView({ enabled: false })) },
      [`GET ${base}/google`]: { body: ok(googleView({ grants: [{ ...googleGrant, features: ['minutes', 'inbox'], featuresOff: ['inbox'] }] })) },
    })
    renderInCompany(<IntegrationsPage />)
    const row = await screen.findByTestId('connected-service-google')
    expect(row).toHaveTextContent('Google Workspace')
    expect(row).toHaveTextContent('動いています')
    expect(row).toHaveTextContent('予定を読む・メールを読む・送る・Drive で選んだものを読む・置く')
    expect(screen.getByTestId('connected-role-calendar')).toHaveTextContent('Google Workspace')
    expect(screen.getByTestId('connected-role-chat')).toHaveTextContent('つないでいるサービスがありません')
    // The admin sees which member turned 受信を読む off themselves.
    expect(await screen.findByTestId('google-grant-u_member')).toHaveTextContent('受信を読む（本人がオフ）')

    await userEvent.click(within(row).getByRole('button', { name: 'Google Workspace をオフにする' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === `${base}/connectors/google/enabled`)).toBe(true))
    expect(calls.find((c) => c.method === 'PUT' && c.url === `${base}/connectors/google/enabled`)!.body).toEqual({ enabled: false })
    expect(await within(screen.getByTestId('connected-service-google')).findByText('オフ')).toBeInTheDocument()
    expect(screen.getByTestId('connected-role-calendar')).toHaveTextContent('つないでいるサービスがありません')

    const text = screen.getByTestId('connected-services').textContent ?? ''
    for (const word of ['OAuth', 'スコープ', 'トークン', 'プラグイン', '役目', 'ロール', 'connector']) expect(text).not.toContain(word)
  })

  it('only when two services could do the same job, the admin is asked which one; the choice is sent by id', async () => {
    const calls = stubApi(ownerCapabilities, {
      [`GET ${base}/connectors`]: { body: ok(coreView({ candidates: ['google', 'microsoft365'] })) },
      [`PUT ${base}/connector-roles/calendar`]: { body: ok(coreView({ candidates: ['google', 'microsoft365'], choice: 'google' })) },
    })
    renderInCompany(<IntegrationsPage />)
    const select = await screen.findByLabelText('予定を読むに使うサービス')
    expect(select).toHaveValue('')
    expect(screen.queryByLabelText('チャットの連絡を受け取る・返すに使うサービス')).toBeNull()
    await userEvent.selectOptions(select, 'google')
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === `${base}/connector-roles/calendar`)).toBe(true))
    expect(calls.find((c) => c.url === `${base}/connector-roles/calendar`)!.body).toEqual({ connectorId: 'google' })
  })
})
