// 「ブラウザ操作に使う PC」 and 「ブラウザ操作を使える人」 (agent-browser.md "This PC's registration", "Who may use a site"):
// who sees the pages, each PC state and what may be pressed on it, that 使えるようにする / 止める ask first and send exactly
// one call to that PC; 「使える人」 shows registered sites × people with 使わない / 見るだけ / 変えてよい (見るだけ when
// nobody chose), sends exactly the chosen person × site × level, caps 変えてよい by the site's level, and shows no job name.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import BrowserPcsPage from '@/app/companies/[id]/advanced/ai-safety/browser/pcs/page'
import BrowserPeoplePage from '@/app/companies/[id]/advanced/ai-safety/browser/people/page'
import {
  PC_STOP_EFFECTS,
  PEOPLE_CAPPED,
  PEOPLE_COMPANY_OFF,
  PEOPLE_NO_PC,
  PEOPLE_NO_SITES,
  PEOPLE_SITE_READ_ONLY,
  PERSON_LEVEL_LABELS,
  pcEnableSentence,
} from '@/lib/agent-browser-people'
import type { AgentBrowserView, BrowserDevicesList, BrowserSiteGrantsView, Capabilities } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/ai-safety/browser`,
  useSearchParams: () => new URLSearchParams(),
}))

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, routes: Record<string, Reply | ((call: Call) => Reply)> = {}) {
  const all = { ...companyRoutes(caps), ...routes } as Record<string, Reply | ((call: Call) => Reply)>
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    const method = init?.method ?? 'GET'
    const call: Call = { method, url, headers: {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = all[`${method} ${url}`]
    const reply = !route ? { status: 404, body: { error: `no fixture for ${method} ${url}` } } : typeof route === 'function' ? route(call) : route
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

// ---------------------------------------------------------------------------
// PCs
// ---------------------------------------------------------------------------

const pc = (id: string, userId: string, label: string, state: 'pending' | 'enabled' | 'revoked', extra: Partial<BrowserDevicesList['items'][number]> = {}) => ({
  id, userId, label, state, revokeReason: null, requestedAt: '2026-11-24T01:00:00.000Z', enabledAt: null, enabledBy: null,
  revokedAt: null, revokedBy: null, lastUsedAt: null, name: null, ...extra,
})
const devices: BrowserDevicesList = {
  items: [
    pc('bd_pending', 'u_member', '田中の MacBook', 'pending'),
    pc('bd_enabled', 'u_admin', '鈴木の iMac', 'enabled', { enabledAt: '2026-11-24T02:00:00.000Z', enabledBy: 'u_owner', lastUsedAt: '2026-11-25T00:00:00.000Z' }),
    pc('bd_revoked', 'u_member', '古い PC', 'revoked', { revokeReason: 'admin', revokedAt: '2026-11-24T03:00:00.000Z', revokedBy: 'u_owner' }),
  ],
  more: false,
  history: [
    { deviceId: 'bd_revoked', userId: 'u_member', actorId: 'u_owner', action: 'revoke', reason: 'admin', at: '2026-11-24T03:00:00.000Z' },
    { deviceId: 'bd_enabled', userId: 'u_admin', actorId: 'u_owner', action: 'enable', reason: null, at: '2026-11-24T02:00:00.000Z' },
  ],
}
const pcsRoutes = { [`GET ${base}/browser-devices`]: { body: ok(devices) } }
const row = (name: string) => screen.getByRole('cell', { name }).closest('tr') as HTMLElement

describe('ブラウザ操作に使う PC', () => {
  it('is linked from 「ブラウザ操作」 with 「使える人」', async () => {
    stubApi(ownerCapabilities, { [`GET ${base}/agent-browser`]: { body: ok({ settings: { mode: 'off', sites: [] }, overrides: [], updatedAt: null, updatedBy: null, history: [] }) } })
    renderInCompany(<AgentBrowserPage />)
    expect(await screen.findByRole('link', { name: /ブラウザ操作に使う PC/ })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/pcs')
    expect(screen.getByRole('link', { name: /ブラウザ操作を使える人/ })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/people')
  })

  it('a member or a department manager sees neither page and nothing is asked', async () => {
    for (const Page of [BrowserPcsPage, BrowserPeoplePage]) {
      const calls = stubApi(managerCapabilities)
      const { unmount } = renderInCompany(<Page />)
      expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
      expect(calls.some((c) => /browser-devices|browser-site-grants|agent-browser/.test(c.url))).toBe(false)
      unmount()
    }
  })

  it('lists each PC with its person, name, state and last use; only what each state allows can be pressed', async () => {
    stubApi(ownerCapabilities, pcsRoutes)
    renderInCompany(<BrowserPcsPage />)
    await screen.findByRole('cell', { name: '田中の MacBook' })
    const pending = row('田中の MacBook')
    expect(within(pending).getByText('確認待ち')).toBeInTheDocument()
    expect(within(pending).getByText('田中 太郎')).toBeInTheDocument()
    expect(within(pending).getByText('まだ使っていません')).toBeInTheDocument()
    expect(within(pending).getByRole('button', { name: /使えるようにする/ })).toBeInTheDocument()
    expect(within(pending).getByRole('button', { name: /止める/ })).toBeInTheDocument()
    const enabled = row('鈴木の iMac')
    expect(within(enabled).getByText('使える')).toBeInTheDocument()
    expect(within(enabled).getByText('2026/11/25')).toBeInTheDocument()
    expect(within(enabled).queryByRole('button', { name: /使えるようにする/ })).toBeNull()
    expect(within(enabled).getByRole('button', { name: /止める/ })).toBeInTheDocument()
    const revoked = row('古い PC')
    expect(within(revoked).getByText('止めた')).toBeInTheDocument()
    expect(within(revoked).getByText('管理者が止めました')).toBeInTheDocument()
    expect(within(revoked).queryAllByRole('button')).toEqual([])
    const history = screen.getByRole('list', { name: 'これまでの記録' })
    expect(within(history).getByText(/佐藤 花子さんが 田中 太郎さんの「古い PC」を止めました/)).toBeInTheDocument()
    expect(within(history).getByText(/佐藤 花子さんが 鈴木 一郎さんの「鈴木の iMac」を使えるようにしました/)).toBeInTheDocument()
  })

  it('使えるようにする asks first, then enables exactly that PC once', async () => {
    const calls = stubApi(ownerCapabilities, {
      ...pcsRoutes,
      [`POST ${base}/browser-devices/bd_pending/enable`]: { body: ok({ ...devices.items[0], state: 'enabled' }) },
    })
    renderInCompany(<BrowserPcsPage />)
    await screen.findByRole('cell', { name: '田中の MacBook' })
    await userEvent.click(within(row('田中の MacBook')).getByRole('button', { name: /使えるようにする/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(new RegExp(pcEnableSentence('田中 太郎', '田中の MacBook')))).toBeInTheDocument()
    expect(writes(calls)).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: '使えるようにする' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ method: 'POST', url: `${base}/browser-devices/bd_pending/enable` })
    expect(writes(calls)[0].body).toBeUndefined()
  })

  it('止める says plainly what stops; キャンセル sends nothing, 止める stops exactly that PC', async () => {
    const calls = stubApi(ownerCapabilities, {
      ...pcsRoutes,
      [`POST ${base}/browser-devices/bd_enabled/revoke`]: { body: ok({ ...devices.items[1], state: 'revoked', revokeReason: 'admin' }) },
    })
    renderInCompany(<BrowserPcsPage />)
    await screen.findByRole('cell', { name: '鈴木の iMac' })
    await userEvent.click(within(row('鈴木の iMac')).getByRole('button', { name: /止める/ }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('鈴木 一郎さんの「鈴木の iMac」を止めますか？')).toBeInTheDocument()
    for (const line of PC_STOP_EFFECTS) expect(within(dialog).getByText(line)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(writes(calls)).toEqual([])
    await userEvent.click(within(row('鈴木の iMac')).getByRole('button', { name: /止める/ }))
    dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ method: 'POST', url: `${base}/browser-devices/bd_enabled/revoke` })
  })
})

// ---------------------------------------------------------------------------
// People (per registered site: agent-browser.md "Who may use a site")
// ---------------------------------------------------------------------------

// Fictional sites: the page must work from the company's own list, whatever the site.
const SHOP = 'shop.example.com'
const TICKETS = 'tickets.example.net'
const siteGrants = (over: Partial<BrowserSiteGrantsView> = {}): BrowserSiteGrantsView => ({
  sites: [{ host: SHOP, level: 'write' }, { host: TICKETS, level: 'read' }],
  defaultLevel: 'read',
  grants: [{ userId: 'u_admin', host: SHOP, level: 'write', grantedBy: 'u_owner', updatedAt: '2026-11-25T00:00:00.000Z' }],
  ...over,
})
const peopleRoutes = (view: BrowserSiteGrantsView, mode: 'on' | 'off' = 'on') => ({
  [`GET ${base}/browser-site-grants`]: { body: ok(view) },
  [`GET ${base}/browser-devices`]: { body: ok(devices) },
  [`GET ${base}/agent-browser`]: { body: ok({ settings: { mode, sites: [] }, overrides: [], updatedAt: null, updatedBy: null, history: [] } satisfies AgentBrowserView) },
})
const cell = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement

describe('ブラウザ操作を使える人', () => {
  it('rows are people, columns are the registered sites; a cell is the person\'s level (見るだけ when nobody chose); no job names', async () => {
    stubApi(ownerCapabilities, peopleRoutes(siteGrants(), 'off'))
    renderInCompany(<BrowserPeoplePage />)
    await screen.findByRole('combobox', { name: `鈴木 一郎：${SHOP}` })
    expect(screen.getByText(SHOP)).toBeInTheDocument()
    expect(screen.getByText(TICKETS)).toBeInTheDocument()
    expect(cell(`鈴木 一郎：${SHOP}`).value).toBe('write')
    expect(cell(`田中 太郎：${SHOP}`).value).toBe('read')
    expect(cell(`佐藤 花子：${TICKETS}`).value).toBe('read')
    expect([...cell(`田中 太郎：${SHOP}`).options].map((o) => o.textContent)).toEqual([PERSON_LEVEL_LABELS.none, PERSON_LEVEL_LABELS.read, PERSON_LEVEL_LABELS.write])
    // The notes: the company's setting off; a person with no usable PC (田中 has a pending and a stopped one only).
    expect(screen.getByText(PEOPLE_COMPANY_OFF)).toBeInTheDocument()
    const tanaka = cell(`田中 太郎：${SHOP}`).closest('tr') as HTMLElement
    expect(within(tanaka).getByRole('link', { name: PEOPLE_NO_PC })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/pcs')
    // Generic units only: no site's job words, no hash or version.
    expect(document.body.textContent).not.toMatch(/sha256|1\.0\.\d|作業|点検/)
  })

  it('a choice sends exactly that person × site × level, once', async () => {
    const calls = stubApi(ownerCapabilities, {
      ...peopleRoutes(siteGrants()),
      [`PUT ${base}/browser-site-grants/u_member`]: { body: ok(siteGrants({ grants: [{ userId: 'u_member', host: SHOP, level: 'write', grantedBy: 'u_owner', updatedAt: '2026-11-25T00:00:00.000Z' }] })) },
    })
    renderInCompany(<BrowserPeoplePage />)
    await screen.findByRole('combobox', { name: `田中 太郎：${SHOP}` })
    await userEvent.selectOptions(cell(`田中 太郎：${SHOP}`), 'write')
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    expect(writes(calls)[0]).toMatchObject({ method: 'PUT', url: `${base}/browser-site-grants/u_member`, body: { host: SHOP, level: 'write' } })
    await waitFor(() => expect(cell(`田中 太郎：${SHOP}`).value).toBe('write'))
  })

  it('a site the company set to 見るだけ cannot be chosen 変えてよい; a person set so before shows the cap', async () => {
    stubApi(ownerCapabilities, peopleRoutes(siteGrants({
      grants: [{ userId: 'u_admin', host: TICKETS, level: 'write', grantedBy: 'u_owner', updatedAt: '2026-11-25T00:00:00.000Z' }],
    })))
    renderInCompany(<BrowserPeoplePage />)
    await screen.findByRole('combobox', { name: `田中 太郎：${TICKETS}` })
    expect(screen.getByText(PEOPLE_SITE_READ_ONLY)).toBeInTheDocument()
    const write = [...cell(`田中 太郎：${TICKETS}`).options].find((o) => o.value === 'write')!
    expect(write.disabled).toBe(true)
    const suzuki = cell(`鈴木 一郎：${TICKETS}`).closest('td') as HTMLElement
    expect(within(suzuki).getByText(PEOPLE_CAPPED)).toBeInTheDocument()
    // On a site that allows writing, 変えてよい can be chosen.
    expect([...cell(`田中 太郎：${SHOP}`).options].find((o) => o.value === 'write')!.disabled).toBe(false)
  })

  it('no registered site: says so and offers nothing to choose', async () => {
    stubApi(ownerCapabilities, peopleRoutes(siteGrants({ sites: [], grants: [] })))
    renderInCompany(<BrowserPeoplePage />)
    expect(await screen.findByText(PEOPLE_NO_SITES)).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
