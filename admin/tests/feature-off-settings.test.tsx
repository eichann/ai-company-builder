// Settings of a feature that is off in 「使う機能」 (records.md "Features on and off", owner decision
// 2026-11-08): each such card keeps its title and shows one plain line instead of its questions —
// 仕事の進め方 (受信を読む, 返事の目安 → 受信; 会議から AI が作るやること → 会議; 束ねるものの名前 →
// プロジェクト; やることの一覧を使う部署 → やることの一覧), 来た連絡の決まり (受信) and つなぎ先's 会議の記録
// (会議). With everything on — and with a server that does not answer the switches — nothing changes.
import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import InboxRulesPage from '@/app/companies/[id]/advanced/inbox/page'
import WorkSettingsPage from '@/app/companies/[id]/advanced/work/page'
import { MinutesFolderSection } from '@/app/companies/[id]/integrations/minutes-folder'
import type { FeaturesView, TaskSettingsView } from '@/lib/api'
import { DEFAULT_FEATURES, FEATURE_OFF_SETTINGS_LINE } from '../../shared/core/features'
import { defaultTaskSettings } from '../../shared/core/task-settings'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { ok, ownerCapabilities } from './fixtures'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/advanced/work`,
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(() => vi.unstubAllGlobals())

const ALL_OFF = { taskList: false, meetings: false, inbox: false, decisions: false, projects: false }
const featuresOf = (over: Partial<FeaturesView['features']>): FeaturesView => ({
  features: { ...DEFAULT_FEATURES, ...over }, canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null,
})
const taskView: TaskSettingsView = { settings: defaultTaskSettings(), canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }

/** `features` null: the server has no 「使う機能」 route (404), read as everything on. */
function stubApi(features: FeaturesView | null) {
  const routes: Record<string, unknown> = {
    ...companyRoutes(ownerCapabilities),
    [`GET ${base}/task-settings`]: { body: ok(taskView) },
    [`GET ${base}/records/settings`]: { body: ok({ enabled: true, updatedAt: null }) },
    [`GET ${base}/google/minutes-folder`]: { body: ok({ folder: '営業部', choices: ['営業部'], meetings: 'external', bundleQuestionDays: 7 }) },
    ...(features ? { [`GET ${base}/features`]: { body: ok(features) } } : {}),
  }
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    urls.push(url)
    const route = routes[`${init?.method ?? 'GET'} ${url}`] as { status?: number; body: unknown } | undefined
    const reply = route ?? { status: 404, body: { error: `no fixture for ${url}` } }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return urls
}

const featureCards = (questions: string[]) => questions.map((name) => screen.queryByRole('radiogroup', { name }))

describe('仕事の進め方 with features off', () => {
  const QUESTIONS = ['受信を読む 使ってよいか', '会議から AI が作るやること', '返事の目安', 'やることの一覧を使う部署']

  it('each card of a feature that is off keeps its title and says one line; the others stay', async () => {
    stubApi(featuresOf(ALL_OFF))
    renderInCompany(<WorkSettingsPage />)
    await waitFor(() => expect(screen.getAllByTestId('feature-off-card')).toHaveLength(5))
    expect(featureCards(QUESTIONS)).toEqual([null, null, null, null])
    expect(screen.queryByLabelText('呼び名:')).not.toBeInTheDocument()
    expect(screen.getByText('受信を読む')).toBeInTheDocument()
    expect(screen.getByText('やることを束ねるものの名前')).toBeInTheDocument()
    for (const card of screen.getAllByTestId('feature-off-card')) expect(card).toHaveTextContent(FEATURE_OFF_SETTINGS_LINE)
    for (const link of screen.getAllByRole('link', { name: '使う機能' })) expect(link).toHaveAttribute('href', '/companies/co_123/advanced/features')
    // Not any feature's: always asked.
    expect(screen.getByRole('radiogroup', { name: 'AI に押さなくても仕事を進めさせるか' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'チームの進め方' })).toBeInTheDocument()
  })

  it('only the feature that is off: 会議 off hides 会議から AI が作るやること alone', async () => {
    stubApi(featuresOf({ meetings: false }))
    renderInCompany(<WorkSettingsPage />)
    await waitFor(() => expect(screen.getAllByTestId('feature-off-card')).toHaveLength(1))
    expect(screen.queryByRole('radiogroup', { name: '会議から AI が作るやること' })).not.toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '返事の目安' })).toBeInTheDocument()
  })

  it('everything on, or a server without the switches: every question, no line', async () => {
    for (const features of [featuresOf({}), null]) {
      stubApi(features)
      const { unmount } = renderInCompany(<WorkSettingsPage />)
      expect(await screen.findByRole('radiogroup', { name: '返事の目安' })).toBeInTheDocument()
      expect(featureCards(QUESTIONS).every((q) => q !== null)).toBe(true)
      expect(screen.getByLabelText('呼び名:')).toBeInTheDocument()
      expect(screen.queryByTestId('feature-off-card')).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe('来た連絡の決まり and 会議の記録 with their feature off', () => {
  it('来た連絡の決まり: 受信 off shows the line and reads no intake settings', async () => {
    const urls = stubApi(featuresOf({ inbox: false }))
    renderInCompany(<InboxRulesPage />)
    expect(await screen.findByTestId('feature-off-card')).toHaveTextContent(FEATURE_OFF_SETTINGS_LINE)
    expect(urls.some((u) => u.includes('intake'))).toBe(false)
  })

  it('会議の記録: 会議 off shows the line instead of the period; on, the period is chosen', async () => {
    stubApi(featuresOf({ meetings: false }))
    const { unmount } = renderInCompany(<MinutesFolderSection companyId="co_123" />)
    expect(await screen.findByTestId('feature-off-line')).toHaveTextContent(FEATURE_OFF_SETTINGS_LINE)
    expect(screen.queryByRole('combobox', { name: 'どの案件・プロジェクトの会議かを聞く期間' })).not.toBeInTheDocument()
    unmount()

    stubApi(featuresOf({}))
    renderInCompany(<MinutesFolderSection companyId="co_123" />)
    expect(await screen.findByRole('combobox', { name: 'どの案件・プロジェクトの会議かを聞く期間' })).toBeInTheDocument()
    expect(screen.queryByTestId('feature-off-line')).not.toBeInTheDocument()
  })
})
