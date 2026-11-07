// 「詳しい設定 › 使う機能」 (records.md "Features on and off"): the five feature switches with their
// lines; turning one off asks first (past records stay, 見るだけ) and only then sends; turning one on
// sends at once; someone the server does not let change them sees them read only.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import FeaturesSettingsPage from '@/app/companies/[id]/advanced/features/page'
import type { Capabilities, FeaturesView } from '@/lib/api'
import { featuresChanged } from '@/lib/advanced'
import { DEFAULT_FEATURES, FEATURE_IDS, FEATURE_OFF_CONFIRM, FEATURE_WORDS } from '../../shared/core/features'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/features`,
  useSearchParams: () => new URLSearchParams(),
}))

const viewOf = (over: Partial<FeaturesView['features']> = {}, canEdit = true): FeaturesView => ({
  features: { ...DEFAULT_FEATURES, ...over }, canEdit, updatedAt: null, updatedBy: null, updatedByName: null,
})

type Reply = { status?: number; body: unknown }
function stubApi(caps: Capabilities, view: FeaturesView) {
  let current = view
  const routes: Record<string, Reply | ((call: Call) => Reply)> = {
    ...companyRoutes(caps),
    [`GET ${base}/features`]: () => ({ body: ok(current) }),
    [`PUT ${base}/features`]: (call) => {
      const { feature, on } = call.body as { feature: keyof FeaturesView['features']; on: boolean }
      current = { ...current, features: { ...current.features, [feature]: on }, updatedAt: '2026-11-07T00:00:00.000Z' }
      return { body: ok(current) }
    },
  }
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

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/features')).map((c) => c.body)

describe('使う機能', () => {
  it('shows the five switches, each with what it is and what turning it off does', async () => {
    stubApi(ownerCapabilities, viewOf({ inbox: false }))
    renderInCompany(<FeaturesSettingsPage />)
    const list = await screen.findByRole('list', { name: '使う機能' })
    for (const id of FEATURE_IDS) {
      const toggle = within(list).getByRole('switch', { name: FEATURE_WORDS[id].name })
      expect(toggle).toHaveAttribute('aria-checked', id === 'inbox' ? 'false' : 'true')
      expect(toggle).toBeEnabled()
      expect(within(list).getByText(FEATURE_WORDS[id].what)).toBeInTheDocument()
      expect(within(list).getByText(`オフにすると：${FEATURE_WORDS[id].whenOff}`)).toBeInTheDocument()
    }
  })

  it('turning one off asks first, says past records stay, and sends only after 「オフにする」', async () => {
    const calls = stubApi(ownerCapabilities, viewOf())
    renderInCompany(<FeaturesSettingsPage />)
    const toggle = await screen.findByRole('switch', { name: FEATURE_WORDS.meetings.name })

    await userEvent.click(toggle)
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(FEATURE_OFF_CONFIRM)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(puts(calls)).toEqual([])
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)
    dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'オフにする' }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(puts(calls)).toEqual([{ feature: 'meetings', on: false }])
  })

  it('turning one on sends at once, without asking', async () => {
    const calls = stubApi(ownerCapabilities, viewOf({ projects: false }))
    renderInCompany(<FeaturesSettingsPage />)
    const toggle = await screen.findByRole('switch', { name: FEATURE_WORDS.projects.name })
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(puts(calls)).toEqual([{ feature: 'projects', on: true }])
  })

  it('someone the server does not let change them sees them read only and sends nothing', async () => {
    const calls = stubApi(managerCapabilities, viewOf({}, false))
    renderInCompany(<FeaturesSettingsPage />)
    const list = await screen.findByRole('list', { name: '使う機能' })
    for (const toggle of within(list).getAllByRole('switch')) expect(toggle).toBeDisabled()
    expect(screen.getByText('変えられるのはオーナーと管理者だけです。')).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('switch', { name: FEATURE_WORDS.decisions.name }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(puts(calls)).toEqual([])
  })

  it('詳しい設定 counts it as 「変えています」 once any feature is off', () => {
    expect(featuresChanged({ ...DEFAULT_FEATURES })).toBe(false)
    expect(featuresChanged({ ...DEFAULT_FEATURES, taskList: false })).toBe(true)
  })
})
