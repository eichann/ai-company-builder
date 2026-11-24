// 「ブラウザ操作に使う PC」 and 「ブラウザ操作を使える人」 (agent-browser.md "This PC's registration", "Per-line grants"):
// who sees the pages, each PC state and what may be pressed on it, that 使えるようにする / 止める ask first and send exactly
// one call to that PC, that a tick sends exactly the approved row of that 作業 for that person, that an untick takes
// the 作業 away in one call, and that a 作業 still waiting for its review cannot be ticked.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentBrowserPage from '@/app/companies/[id]/advanced/ai-safety/browser/page'
import BrowserPcsPage from '@/app/companies/[id]/advanced/ai-safety/browser/pcs/page'
import BrowserPeoplePage from '@/app/companies/[id]/advanced/ai-safety/browser/people/page'
import {
  PC_STOP_EFFECTS,
  PEOPLE_CHANGED,
  PEOPLE_COMPANY_OFF,
  PEOPLE_NO_PC,
  PEOPLE_PARTIAL,
  PEOPLE_WAITING,
  pcEnableSentence,
} from '@/lib/agent-browser-people'
import type { AgentBrowserView, BrowserDevicesList, BrowserLineGrantsView, Capabilities } from '@/lib/api'
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
      expect(calls.some((c) => /browser-devices|browser-line-grants|agent-browser/.test(c.url))).toBe(false)
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
// People
// ---------------------------------------------------------------------------

const H = (c: string) => `sha256:${c.repeat(64)}`
const MEANING = H('a')
const inspect = (mapVersion: string, mechanicsHash: string) => ({
  site: 'lstep', line: 'landing_inspect', version: '1.0.0', mapVersion, meaningHash: MEANING, mechanicsHash, label: '流入経路を点検する', writes: false,
})
// Three approved rows of one 作業 (map 1.0.1, 1.0.2, 1.0.4), listed newest-first on purpose: the page orders them itself.
const ROWS = [inspect('1.0.4', H('4')), inspect('1.0.1', H('1')), inspect('1.0.2', H('2'))]
const grant = (userId: string, r: typeof ROWS[number], from: BrowserLineGrantsView['grants'][number]['from'] = { kind: 'direct' }) => ({
  site: r.site, line: r.line, version: r.version, mapVersion: r.mapVersion, meaningHash: r.meaningHash, mechanicsHash: r.mechanicsHash,
  userId, name: null, from, grantedAt: '2026-11-24T00:00:00.000Z', grantedBy: 'u_owner',
})
const carried = { kind: 'carried' as const, version: '1.0.0', mapVersion: '1.0.1', mechanicsHash: H('1') }
const grants = (over: Partial<BrowserLineGrantsView> = {}): BrowserLineGrantsView => ({
  lines: ROWS,
  waiting: [{ site: 'lstep', line: 'landing_create', label: '流入経路を複製して作る', writes: true }],
  // 鈴木 holds a grant on the first row that the later rows carry: in force everywhere, so ticked.
  grants: [grant('u_admin', ROWS[1]), grant('u_admin', ROWS[2], carried), grant('u_admin', ROWS[0], carried)],
  ...over,
})
const peopleRoutes = (view: BrowserLineGrantsView, mode: 'on' | 'off' = 'on') => ({
  [`GET ${base}/browser-line-grants`]: { body: ok(view) },
  [`GET ${base}/browser-devices`]: { body: ok(devices) },
  [`GET ${base}/agent-browser`]: { body: ok({ settings: { mode, sites: [] }, overrides: [], updatedAt: null, updatedBy: null, history: [] } satisfies AgentBrowserView) },
})
const box = (name: RegExp) => screen.getByRole('checkbox', { name })

describe('ブラウザ操作を使える人', () => {
  it('rows are people, columns are 作業 in plain words; ticks show grants in force; a 作業 waiting for review is greyed and cannot be ticked', async () => {
    const calls = stubApi(ownerCapabilities, peopleRoutes(grants(), 'off'))
    renderInCompany(<BrowserPeoplePage />)
    await screen.findByRole('checkbox', { name: '鈴木 一郎：流入経路を点検する' })
    expect(screen.getAllByText('流入経路を点検する')).toHaveLength(1) // one column for the three rows
    expect(screen.getByText('（見るだけ）')).toBeInTheDocument()
    expect(screen.getByText('（書き込む）')).toBeInTheDocument()
    expect(screen.getByText(PEOPLE_WAITING)).toBeInTheDocument()
    expect(box(/^鈴木 一郎：流入経路を点検する$/)).toBeChecked()
    expect(box(/^田中 太郎：流入経路を点検する$/)).not.toBeChecked()
    const waiting = box(/田中 太郎：流入経路を複製して作る（まだ使えません/)
    expect(waiting).toBeDisabled()
    await userEvent.click(waiting)
    expect(writes(calls)).toEqual([])
    // The notes: the company's setting off; a person with no usable PC (田中 has a pending and a stopped one only).
    expect(screen.getByText(PEOPLE_COMPANY_OFF)).toBeInTheDocument()
    const tanaka = screen.getByRole('checkbox', { name: /^田中 太郎：流入経路を点検する$/ }).closest('tr') as HTMLElement
    expect(within(tanaka).getByRole('link', { name: PEOPLE_NO_PC })).toHaveAttribute('href', '/companies/co_123/advanced/ai-safety/browser/pcs')
    const suzuki = box(/^鈴木 一郎：流入経路を点検する$/).closest('tr') as HTMLElement
    expect(within(suzuki).queryByText(PEOPLE_NO_PC)).toBeNull()
    // Nothing about hashes or versions on screen.
    expect(document.body.textContent).not.toMatch(/sha256|1\.0\.\d/)
  })

  it('a tick sends exactly the oldest approved row of that 作業 for that person, and stops once the newer rows carry it', async () => {
    const calls = stubApi(ownerCapabilities, {
      ...peopleRoutes(grants()),
      [`PUT ${base}/browser-line-grants/u_member`]: (call) => ({
        body: ok(grants({ grants: [...grants().grants, grant('u_member', ROWS[1]), grant('u_member', ROWS[2], carried), grant('u_member', ROWS[0], carried)] })),
        ...(call.body ? {} : { status: 400 }),
      }),
    })
    renderInCompany(<BrowserPeoplePage />)
    await userEvent.click(await screen.findByRole('checkbox', { name: '田中 太郎：流入経路を点検する' }))
    await waitFor(() => expect(box(/^田中 太郎：流入経路を点検する$/)).toBeChecked())
    expect(writes(calls)).toHaveLength(1)
    expect(writes(calls)[0]).toMatchObject({ method: 'PUT', url: `${base}/browser-line-grants/u_member` })
    expect(writes(calls)[0].body).toEqual({ site: 'lstep', line: 'landing_inspect', meaningHash: MEANING, mechanicsHash: H('1'), allowed: true })
  })

  it('a row no grant carries to gets its own call (oldest first), and nothing for another 作業 or person', async () => {
    let n = 0
    const calls = stubApi(ownerCapabilities, {
      ...peopleRoutes(grants()),
      [`PUT ${base}/browser-line-grants/u_member`]: () => {
        n += 1
        // The first grant is carried to 1.0.2 but not to 1.0.4 (no reviewed carry-over): a second call for 1.0.4.
        const mine = n === 1 ? [grant('u_member', ROWS[1]), grant('u_member', ROWS[2], carried)]
          : [grant('u_member', ROWS[1]), grant('u_member', ROWS[2], carried), grant('u_member', ROWS[0])]
        return { body: ok(grants({ grants: [...grants().grants, ...mine] })) }
      },
    })
    renderInCompany(<BrowserPeoplePage />)
    await userEvent.click(await screen.findByRole('checkbox', { name: '田中 太郎：流入経路を点検する' }))
    await waitFor(() => expect(writes(calls)).toHaveLength(2))
    expect(writes(calls).map((c) => [c.url, (c.body as { mechanicsHash: string }).mechanicsHash])).toEqual([
      [`${base}/browser-line-grants/u_member`, H('1')],
      [`${base}/browser-line-grants/u_member`, H('4')],
    ])
    expect(writes(calls).every((c) => (c.body as { line: string; allowed: boolean }).line === 'landing_inspect' && (c.body as { allowed: boolean }).allowed)).toBe(true)
  })

  it('an untick takes the 作業 away from that person in one call (the server removes carried grants too)', async () => {
    const calls = stubApi(ownerCapabilities, {
      ...peopleRoutes(grants()),
      [`PUT ${base}/browser-line-grants/u_admin`]: { body: ok(grants({ grants: [] })) },
    })
    renderInCompany(<BrowserPeoplePage />)
    await userEvent.click(await screen.findByRole('checkbox', { name: '鈴木 一郎：流入経路を点検する' }))
    await waitFor(() => expect(box(/^鈴木 一郎：流入経路を点検する$/)).not.toBeChecked())
    expect(writes(calls)).toHaveLength(1)
    expect(writes(calls)[0].body).toEqual({ site: 'lstep', line: 'landing_inspect', meaningHash: MEANING, mechanicsHash: H('4'), allowed: false })
  })

  it('a 作業 whose content changed asks to choose again; access to the earlier content shows ticked and one untick takes it away (Codex review)', async () => {
    const old = { ...ROWS[1], meaningHash: H('o'), mechanicsHash: H('9'), mapVersion: '0.9.0' }
    const calls = stubApi(ownerCapabilities, {
      ...peopleRoutes(grants({ lines: [...ROWS, old], grants: [grant('u_member', old)] })),
      [`PUT ${base}/browser-line-grants/u_member`]: { status: 400, body: { error: 'まだ使えない作業です', code: 'BROWSER_LINE_NOT_APPROVED' } },
    })
    renderInCompany(<BrowserPeoplePage />)
    expect(await screen.findByText(PEOPLE_CHANGED)).toBeInTheDocument()
    const tanaka = box(/^田中 太郎：流入経路を点検する$/)
    expect(tanaka).toBeChecked()
    expect(within(tanaka.closest('td') as HTMLElement).getByText(PEOPLE_PARTIAL)).toBeInTheDocument()
    await userEvent.click(tanaka)
    // A refused change is said and the table read again.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/browser-line-grants'))).toHaveLength(2))
    expect(writes(calls).map((c) => c.body)).toEqual([{ site: 'lstep', line: 'landing_inspect', meaningHash: MEANING, mechanicsHash: H('4'), allowed: false }])
  })

  it('a fill that stopped halfway still shows ticked (with the note), so it can be taken away', async () => {
    stubApi(ownerCapabilities, peopleRoutes(grants({ grants: [grant('u_member', ROWS[1]), grant('u_member', ROWS[2], carried)] })))
    renderInCompany(<BrowserPeoplePage />)
    const tanaka = await screen.findByRole('checkbox', { name: '田中 太郎：流入経路を点検する' })
    expect(tanaka).toBeChecked()
    expect(within(tanaka.closest('td') as HTMLElement).getByText(PEOPLE_PARTIAL)).toBeInTheDocument()
    expect(screen.queryByText(PEOPLE_CHANGED)).toBeNull()
  })
})
