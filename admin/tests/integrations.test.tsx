// 「つなぎ先」 (connector plugins, milestone 3 P8): who sees it, that a key is
// shown by its name and last 4 only, that the practice HubSpot is said
// plainly, that the table view writes YAML the server's strict reader takes
// back unchanged (stage never offered for writing, comments aside), that an
// automatic field is saved only after the workflow acknowledgement is ticked
// and then sent as `acknowledgeAuto`, that 「HubSpot に聞いて確かめる」 sends
// the text being edited and shows what does not match, and that the page
// speaks without jargon.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import IntegrationsPage from '@/app/companies/[id]/integrations/page'
import { NAV_ITEMS } from '@/components/app/app-shell'
import type { BrokerKeySummary, BrokerView, Capabilities, PluginDetail, PluginListItem } from '@/lib/api'
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

const pkg = {
  id: 'hubspot', label: 'HubSpot', version: '0.1.0', kind: 'official' as const, description: null, service: 'hubspot', host: 'api.hubapi.com',
  scopes: [], operationScopes: {}, types: ['deal'], operations: [], fingerprint: 'f', stopped: false,
}
const item: PluginListItem = {
  id: 'hubspot', versions: [pkg],
  install: {
    version: '0.1.0', enabled: false, keyId: 'k1', mappingVersion: 1, connectionId: 'c1', accountId: null, managedSince: null,
    updatedAt: '2026-10-31T00:00:00.000Z', updatedBy: 'u_owner', problem: 'off',
  },
}
const detail: PluginDetail = {
  plugin: item,
  mapping: { version: 1, text: MAPPING, createdAt: '2026-10-31T00:00:00.000Z', createdBy: 'u_owner' },
  mappingVersions: [{ version: 1, createdAt: '2026-10-31T00:00:00.000Z', createdBy: 'u_owner' }],
  policies: [
    { operation: 'update_deal', object: 'deal', field: 'confidence', policy: 'prior' },
    { operation: 'update_deal', object: 'deal', field: 'next_step', policy: 'auto' },
    { operation: 'update_deal', object: 'deal', field: 'amount', policy: 'prior' },
  ],
  mappingErrors: [],
  autoAcknowledgements: [],
  history: [{ action: 'install', at: '2026-10-31T00:00:00.000Z', by: 'u_owner', change: {} }],
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
  services: [{ service: 'hubspot', label: 'HubSpot', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.hubapi.com'], companyKeys: 1, userKeys: 0, updatedAt: null, relay: null, readOnly: true, practice }],
  keys: [key],
  departments: [],
  history: [],
})

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, extra: Record<string, Reply | ((call: Call) => Reply)> = {}, practice = false) {
  const routes = {
    ...companyRoutes(caps),
    [`GET ${base}/plugins`]: { body: ok({ plugins: [item] }) },
    [`GET ${base}/plugins/hubspot`]: { body: ok(detail) },
    [`GET ${base}/broker`]: { body: ok(broker(practice)) },
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

  it('a choice sets write and an explicit policy; reading only drops the policy; the stage is never offered', () => {
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
    const fromServer = mappingRows(MAPPING, detail.policies)
    expect(fromServer.ok && fromServer.rows.find((r) => r.field === 'next_step')?.choice).toBe('auto')
    expect(fromServer.ok && fromServer.rows.find((r) => r.field === 'stage')?.locked).toBe(true)
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
    // The mapping table arrives with the detail (its own request).
    expect(await screen.findByText('書き戻せません（受注・失注につながるため）')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'stage の書き戻し' })).not.toBeInTheDocument()
    const text = document.body.textContent ?? ''
    for (const word of ['プラグイン', 'オントロジー', '型']) expect(text).not.toContain(word)
  })

  it('an automatic field is saved only after the workflow check is ticked, then sent as acknowledgeAuto', async () => {
    const saves: Call[] = []
    const calls = stubApi(ownerCapabilities, {
      [`PUT ${base}/plugins/hubspot/mapping`]: (call) => {
        saves.push(call)
        const body = call.body as { acknowledgeAuto: string[] }
        if (!body.acknowledgeAuto.includes('confidence')) {
          return { status: 400, body: { error: 'x', code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: ['confidence'], acknowledgement: 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました' } }
        }
        return { body: ok({ ...detail, mapping: { ...detail.mapping!, version: 2, text: (call.body as { text: string }).text } }) }
      },
    })
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
      [`POST ${base}/plugins/hubspot/mapping/check`]: () => ({
        body: ok({ reachable: true, reason: null, checkedAt: '2026-10-31T00:00:00.000Z', objects: { deal: { errors: ['欄「next_step」の項目「hs_next_stepp」は、つなぎ先にありません'], warnings: [] } } }),
      }),
    })
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
      [`POST ${base}/plugins/hubspot/mapping/check`]: { body: ok({ reachable: false, reason: 'key-rejected', checkedAt: '2026-10-31T00:00:00.000Z', objects: {} }) },
    })
    renderInCompany(<IntegrationsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'HubSpot に聞いて確かめる' }))
    expect(await screen.findByText(/HubSpot に聞けませんでした：鍵が受け付けられませんでした/)).toBeInTheDocument()
  })
})
