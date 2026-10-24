// AI の操作の記録 (monitoring M1, PR 4): labels for every value of the
// contract's enums, the URL filters, targets, the summary, the navigation
// entry, the log page and its settings (retention preview, viewer cards).
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AgentEventsPage from '@/app/companies/[id]/agent-events/page'
import { AppShell, NAV_ITEMS } from '@/components/app/app-shell'
import { changeLines, draftDays } from '@/components/agent-events/settings-view'
import {
  AGENT_KINDS,
  AGENT_LABELS,
  CATEGORY_LABELS,
  DECISION_LABELS,
  GUARD_REASONS,
  GUARD_REASON_LABELS,
  OUTCOME_LABELS,
  SENSITIVE_LABELS,
  SENSITIVE_LOCATIONS,
  TOOL_CATEGORIES,
  TOOL_DECISIONS,
  TOOL_OUTCOMES,
  VIEWER_MODE_LABELS,
  describeTarget,
  filtersToSearch,
  formatDuration,
  isDenied,
  parseFilters,
  periodDays,
  periodRange,
  summaryRows,
} from '@/lib/agent-events'
import type { AgentEventRecord, AgentEventSettings, AgentEventViewers, Capabilities } from '@/lib/api'
import { AGENT_EVENT_VIEWER_MODES } from '../../shared/types/agent-events'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { clientActivity, managerCapabilities, ok, ownerCapabilities } from './fixtures'
import type { Call } from './mock-api'

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn(), pathname: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn() }),
  usePathname: () => nav.pathname || `/companies/co_123/agent-events`,
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// ---------------------------------------------------------------------------
// Fixtures and a fetch stub that matches by path (the list's `from` moves with the clock)
// ---------------------------------------------------------------------------

function event(over: Partial<AgentEventRecord>): AgentEventRecord {
  return {
    id: 'e1', callId: 'toolu_1', userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com',
    at: new Date().toISOString(), atAdjusted: false, receivedAt: new Date().toISOString(), durationMs: 1200,
    conversationId: 'conv-a', turnId: 't1', department: '営業部', agent: 'claude-code', model: 'claude-opus-5-5',
    subagentType: null, tool: 'Read', category: 'read', target: { kind: 'file', path: '営業部/提案書.md' },
    decision: 'auto-allowed', guardReason: null, outcome: 'ok', clientVersion: null, ...over,
  }
}

const events: AgentEventRecord[] = [
  event({ id: 'e1' }),
  event({ id: 'e2', tool: 'Write', category: 'write', decision: 'guard-denied', guardReason: 'read-only-folder', outcome: null, target: { kind: 'file', path: '人事部/規程.md' } }),
  event({ id: 'e3', tool: 'Read', target: { kind: 'hidden' }, userId: 'u_admin', name: '鈴木 一郎', conversationId: 'conv-b' }),
  event({ id: 'e4', tool: 'Bash', category: 'command', target: { kind: 'command', programs: ['git push'], redirect: true }, decision: 'member-allowed', guardReason: 'dangerous-command' }),
  event({ id: 'e5', tool: 'Read', target: { kind: 'outside', sensitive: 'ssh' }, decision: 'stopped', outcome: null }),
]

const settings: AgentEventSettings = {
  retentionDays: 180, viewers: 'admins', updatedAt: '2026-10-20T01:00:00.000Z', updatedBy: 'u_owner',
  history: [{
    id: 'h1', changedAt: '2026-10-20T01:00:00.000Z', changedBy: 'u_owner', name: '佐藤 花子', email: 'sato@example.com',
    before: { retentionDays: 90, viewers: 'admins' }, after: { retentionDays: 180, viewers: 'admins' },
  }],
}

const viewersAdmins: AgentEventViewers = {
  mode: 'admins',
  viewers: [
    { userId: 'u_owner', name: '佐藤 花子', email: 'sato@example.com', role: 'owner', scope: 'all', departments: [] },
    { userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com', role: 'admin', scope: 'all', departments: [] },
  ],
}
const viewersManagers: AgentEventViewers = {
  mode: 'admins-and-managers',
  viewers: [
    ...viewersAdmins.viewers,
    { userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com', role: 'member', scope: 'departments', departments: [{ id: 'd_sales', name: '営業部', folder: '営業部' }] },
  ],
}

type Reply = { status?: number; body: unknown }
type Route = Reply | ((call: Call) => Reply)

function stubApi(caps: Capabilities, extra: Record<string, Route> = {}) {
  const exact: Record<string, Route> = { ...companyRoutes(caps), ...extra }
  const byPath = new Map(Object.entries(exact).map(([k, v]) => [k.split('?')[0], v]))
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input))
    const method = init?.method ?? 'GET'
    const call: Call = { method, url, headers: {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const route = exact[`${method} ${url}`] ?? byPath.get(`${method} ${url.split('?')[0]}`)
    const reply = !route ? { status: 404, body: { error: `no fixture for ${method} ${url}` } } : typeof route === 'function' ? route(call) : route
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

const ae = `${base}/agent-events`
const ownerCaps: Capabilities = { ...ownerCapabilities, canViewAgentEvents: true }
const logRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [`GET ${ae}`]: { body: ok({ events, nextCursor: null }) },
  [`GET ${ae}/summary`]: {
    body: ok({
      from: '', to: '', tzOffsetMinutes: 540,
      days: [{ day: periodDays({ period: '7d' }).at(-1)!, userId: 'u_member', total: 4, denied: 2, byCategory: { read: 2, write: 1, command: 1 } }],
      members: [{ userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com' }],
    }),
  },
  [`GET ${base}/client-activity`]: {
    body: ok(clientActivity.map((a) => ({ ...a, supportsAgentEvents: a.userId === 'u_owner' }))),
  },
  [`GET ${ae}/settings`]: { body: ok(settings) },
  [`GET ${ae}/viewers?mode=admins`]: { body: ok(viewersAdmins) },
  [`GET ${ae}/viewers?mode=admins-and-managers`]: { body: ok(viewersManagers) },
  ...over,
})

function setUrl(search: string) {
  nav.search = search
  nav.replace.mockReset()
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('labels cover every value of the contract', () => {
  // A value added to shared/types/agent-events.ts without a label fails here
  // (and in the compiler, through Record<…>).
  const cases: Array<[string, readonly string[], Record<string, unknown>]> = [
    ['category', TOOL_CATEGORIES, CATEGORY_LABELS],
    ['decision', TOOL_DECISIONS, DECISION_LABELS],
    ['guard reason', GUARD_REASONS, GUARD_REASON_LABELS],
    ['agent', AGENT_KINDS, AGENT_LABELS],
    ['outcome', TOOL_OUTCOMES, OUTCOME_LABELS],
    ['sensitive location', SENSITIVE_LOCATIONS, SENSITIVE_LABELS],
    ['viewer mode', AGENT_EVENT_VIEWER_MODES, VIEWER_MODE_LABELS],
  ]
  it.each(cases)('%s', (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort())
    for (const v of values) {
      const label = labels[v]
      const text = typeof label === 'string' ? label : (label as { label: string }).label
      expect(text, v).toMatch(/\S/)
    }
  })

  it('decision labels say who decided, in plain words', () => {
    expect(DECISION_LABELS['policy-default'].label).toBe('AI の設定に任せた')
    expect(DECISION_LABELS['policy-default'].description).toMatch(/アプリは判断せず、AI 自身の権限の設定/)
    expect(DECISION_LABELS['guard-denied'].label).toBe('アプリの守りで拒否')
    for (const d of TOOL_DECISIONS) {
      const { label, description } = DECISION_LABELS[d]
      // No vague or technical words a member would not know.
      expect(label, d).not.toMatch(/設定どおり|ガード|ポリシー|policy|guard/i)
      expect(description, d).toMatch(/。$/)
    }
    const labels = TOOL_DECISIONS.map((d) => DECISION_LABELS[d].label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('every denied decision is shown as a denial', () => {
    for (const d of TOOL_DECISIONS) expect(DECISION_LABELS[d].tone === 'denied', d).toBe(isDenied(d))
  })
})

describe('targets and durations', () => {
  it('describes each kind without inventing a path', () => {
    expect(describeTarget({ kind: 'hidden' }).items).toEqual([{ kind: 'hidden', text: '非公開（表示できません）' }])
    expect(describeTarget({ kind: 'outside', sensitive: 'env-file' }).items).toEqual([{ kind: 'outside', text: '会社フォルダの外', sensitive: '.env ファイル' }])
    expect(describeTarget({ kind: 'file', path: '' }).items[0].text).toBe('会社フォルダ全体')
    const files = describeTarget({ kind: 'files', files: [{ kind: 'file', path: 'a.md' }, { kind: 'hidden' }], more: 3 })
    expect(files.items.map((i) => i.kind)).toEqual(['path', 'hidden'])
    expect(files.more).toBe(3)
    expect(describeTarget({ kind: 'command', programs: ['git push', '?'], redirect: true })).toMatchObject({ redirect: true, items: [{ kind: 'code', text: 'git push' }, { kind: 'plain' }] })
    expect(describeTarget({ kind: 'mcp', server: 'github', tool: 'create_issue' }).items[0].text).toBe('github / create_issue')
    expect(describeTarget({ kind: 'none' }).items).toEqual([])
  })

  it('formats durations for people', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(420)).toBe('0.4秒')
    expect(formatDuration(12_300)).toBe('12秒')
    expect(formatDuration(185_000)).toBe('3分5秒')
    expect(formatDuration(3_600_000)).toBe('1時間')
  })
})

describe('filters in the URL', () => {
  it('round-trips and drops unknown values', () => {
    const f = parseFilters(new URLSearchParams('period=custom&from=2026-10-01&to=2026-10-20&member=u1&category=write&decision=stopped&q=営業&conversation=c1'))
    expect(f).toEqual({ period: 'custom', fromDay: '2026-10-01', toDay: '2026-10-20', userId: 'u1', category: 'write', decision: 'stopped', q: '営業', conversationId: 'c1' })
    expect(parseFilters(new URLSearchParams(filtersToSearch(f)))).toEqual(f)
    expect(parseFilters(new URLSearchParams('period=year&category=nope&decision=maybe&from=yesterday'))).toEqual({ period: '7d' })
    expect(filtersToSearch({ period: '7d' })).toBe('')
    expect(filtersToSearch({ period: 'today' }, { tab: 'settings' })).toBe('tab=settings&period=today')
  })

  it('periods are whole local days', () => {
    const now = new Date(2026, 9, 25, 15, 30)
    expect(periodRange({ period: 'today' }, now)).toEqual({ from: new Date(2026, 9, 25).toISOString() })
    expect(periodRange({ period: '7d' }, now)).toEqual({ from: new Date(2026, 9, 19).toISOString() })
    expect(periodRange({ period: 'custom', fromDay: '2026-10-01', toDay: '2026-10-02' }, now)).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 3).toISOString(),
    })
    expect(periodDays({ period: '7d' }, now)).toHaveLength(7)
    expect(periodDays({ period: 'custom', fromDay: '2026-10-01', toDay: '2026-10-02' }, now)).toEqual(['2026-10-01', '2026-10-02'])
  })

  it('summary rows per member, busiest first, with daily counts', () => {
    const rows = summaryRows(
      {
        from: '', to: '', tzOffsetMinutes: 540,
        days: [
          { day: '2026-10-01', userId: 'a', total: 2, denied: 1, byCategory: { read: 2 } },
          { day: '2026-10-02', userId: 'a', total: 3, denied: 0, byCategory: { write: 3 } },
          { day: '2026-10-02', userId: 'b', total: 9, denied: 0, byCategory: { command: 9 } },
        ],
        members: [{ userId: 'a', name: 'A', email: null }, { userId: 'b', name: null, email: 'b@example.com' }],
      },
      ['2026-10-01', '2026-10-02']
    )
    expect(rows.map((r) => [r.name, r.total, r.denied, r.perDay])).toEqual([
      ['b@example.com', 9, 0, [0, 9]],
      ['A', 5, 1, [2, 3]],
    ])
    expect(rows[1].topCategories[0]).toEqual({ category: 'write', count: 3 })
  })
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('navigation', () => {
  const item = NAV_ITEMS.find((i) => i.segment === 'agent-events')!

  it('owner/admin always; a manager only when the setting allows; members never', () => {
    expect(item.label).toBe('AI の操作の記録')
    expect(item.visible!({ isAdmin: true, isManager: false, canViewAgentEvents: true })).toBe(true)
    expect(item.visible!({ isAdmin: false, isManager: true, canViewAgentEvents: false })).toBe(false)
    expect(item.visible!({ isAdmin: false, isManager: true, canViewAgentEvents: true })).toBe(true)
    expect(item.visible!({ isAdmin: false, isManager: false, canViewAgentEvents: false })).toBe(false)
  })

  it('the sidebar follows /me/capabilities', async () => {
    stubApi({ ...managerCapabilities, canViewAgentEvents: true })
    renderInCompany(<AppShell>page</AppShell>)
    expect((await screen.findAllByRole('link', { name: 'AI の操作の記録' })).length).toBeGreaterThan(0)
  })

  it('hidden from a manager while only admins may read', async () => {
    stubApi({ ...managerCapabilities, canViewAgentEvents: false })
    renderInCompany(<AppShell>page</AppShell>)
    await screen.findAllByRole('link', { name: '権限' })
    expect(screen.queryByRole('link', { name: 'AI の操作の記録' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// The log page
// ---------------------------------------------------------------------------

describe('the log page', () => {
  it('explains what is recorded and lists events with plain labels', async () => {
    setUrl('')
    stubApi(ownerCaps, logRoutes())
    renderInCompany(<AgentEventsPage />)
    expect(await screen.findByText(/会話の中身・ファイルの中身・コマンドの引数は記録しません/)).toBeInTheDocument()
    expect(await screen.findByText('営業部/提案書.md')).toBeInTheDocument()
    expect(screen.getByText('アプリの守りで拒否')).toBeInTheDocument()
    expect(screen.getByText('理由: 閲覧のみのフォルダ')).toBeInTheDocument()
    expect(screen.getByText('非公開（表示できません）')).toBeInTheDocument()
    expect(screen.getByText('git push')).toBeInTheDocument()
    expect(screen.getByText('ファイルに出力')).toBeInTheDocument()
    expect(screen.getByText('秘密の置き場所: SSH の鍵（~/.ssh）')).toBeInTheDocument()
    expect(screen.getByText('AI の停止中のため拒否')).toBeInTheDocument()
    expect(screen.getAllByText('Claude Code（claude-opus-5-5）').length).toBeGreaterThan(0)
    // The summary and the apps that do not send the log.
    expect(await screen.findByText('4件')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: /記録を送っていないアプリ（2人）/ })).toBeInTheDocument()
  })

  it('the apps that do not send the log: one line, the list behind a toggle', async () => {
    setUrl('')
    stubApi(ownerCaps, logRoutes())
    renderInCompany(<AgentEventsPage />)
    const notice = await screen.findByRole('region', { name: /記録を送っていないアプリ（2人）/ })
    const toggle = within(notice).getByRole('button', { name: '一覧を表示' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(list).not.toBeVisible()
    expect(within(notice).queryByRole('listitem')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('閉じる')
    expect(list).toBeVisible()
    expect(within(notice).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('鈴木 一郎')).toBeInTheDocument()
    // The version when known, else a short 「版は不明」.
    expect(within(list).getByText(/^0\.0\.1（2026\/10\/0?1 版）$/)).toBeInTheDocument()
    expect(within(list).getByText('版は不明')).toBeInTheDocument()
    expect(within(notice).queryByText('アプリの版がわかりません')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(list).not.toBeVisible()
  })

  it('filters go into the URL; a conversation opens in time order', async () => {
    setUrl('decision=guard-denied')
    const calls = stubApi(ownerCaps, logRoutes())
    renderInCompany(<AgentEventsPage />)
    await screen.findByText('営業部/提案書.md')
    const list = calls.find((c) => c.url.startsWith(`${ae}?`))!
    expect(list.url).toContain('decision=guard-denied')
    expect(list.url).toMatch(/from=\d{4}-/)
    await userEvent.click(screen.getAllByRole('button', { name: 'この会話の流れ' })[0])
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining('conversation=conv-a'), { scroll: false })
    await userEvent.click(screen.getByRole('radio', { name: '今日' }))
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining('period=today'), { scroll: false })
  })

  it('the conversation view asks only for that conversation and shows it oldest first', async () => {
    setUrl('conversation=conv-a&category=write')
    const calls = stubApi(ownerCaps, logRoutes())
    renderInCompany(<AgentEventsPage />)
    expect(await screen.findByText('この会話の流れ')).toBeInTheDocument()
    await screen.findByText('営業部/提案書.md')
    const list = calls.find((c) => c.url.startsWith(`${ae}?`))!
    expect(list.url).toContain('conversationId=conv-a')
    expect(list.url).not.toContain('category=')
    const paths = screen.getAllByText(/営業部\/提案書\.md|人事部\/規程\.md/).map((n) => n.textContent)
    expect(paths).toEqual(['人事部/規程.md', '営業部/提案書.md'])
  })

  it('a member without access gets a plain explanation', async () => {
    setUrl('')
    stubApi({ role: 'member', managedDepartmentIds: [], canViewAgentEvents: false }, logRoutes({
      [`GET ${ae}`]: { status: 403, body: { error: 'Only owners and admins can view the AI action log' } },
    }))
    renderInCompany(<AgentEventsPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
  })

  it('empty and error states', async () => {
    setUrl('')
    stubApi(ownerCaps, logRoutes({ [`GET ${ae}`]: { body: ok({ events: [], nextCursor: null }) } }))
    renderInCompany(<AgentEventsPage />)
    expect(await screen.findByText('この期間の記録はありません')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('helpers: custom days are validated, changes summarised', () => {
    expect(draftDays({ choice: 'custom', customDays: '6', viewers: 'admins' })).toBeNull()
    expect(draftDays({ choice: 'custom', customDays: '45', viewers: 'admins' })).toBe(45)
    expect(draftDays({ choice: 365, customDays: '', viewers: 'admins' })).toBe(365)
    expect(changeLines({ retentionDays: 180, viewers: 'admins' }, { retentionDays: 365, viewers: 'admins-and-managers' })).toEqual([
      '保存期間: 180日 → 1年',
      '記録を見られる人: オーナーと管理者だけ → オーナーと管理者、各部署の責任者（自分の部署の分だけ）',
    ])
  })

  it('shortening the retention asks with the number that would go, then saves', async () => {
    setUrl('tab=settings')
    const calls = stubApi(ownerCaps, logRoutes({
      [`GET ${ae}/settings/retention-preview?days=30`]: { body: ok({ days: 30, olderThan: '2026-09-25T00:00:00.000Z', wouldDelete: 12 }) },
      [`PUT ${ae}/settings`]: (call) => ({ body: ok({ ...settings, ...(call.body as object) }) }),
    }))
    renderInCompany(<AgentEventsPage />)
    expect(await screen.findByText('佐藤 花子', { selector: '.truncate' })).toBeInTheDocument()
    // History: who changed what.
    expect(screen.getByText('保存期間: 90日 → 180日')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: '30日' }))
    expect(screen.getByText('保存期間: 180日 → 30日')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('30日より前')
    expect(dialog).toHaveTextContent('記録 12 件が消えます。よろしいですか？')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    await userEvent.click(within(dialog).getByRole('button', { name: '短くして保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ retentionDays: 30 }))
  })

  it('lengthening or changing viewers saves without the deletion question', async () => {
    setUrl('tab=settings')
    const calls = stubApi(ownerCaps, logRoutes({
      [`PUT ${ae}/settings`]: (call) => ({ body: ok({ ...settings, ...(call.body as object) }) }),
    }))
    renderInCompany(<AgentEventsPage />)
    await userEvent.click(await screen.findByRole('radio', { name: /各部署の責任者/ }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ viewers: 'admins-and-managers' }))
    expect(calls.some((c) => c.url.includes('retention-preview'))).toBe(false)
  })

  it('the viewer cards list who would see what', async () => {
    setUrl('tab=settings')
    stubApi(ownerCaps, logRoutes())
    renderInCompany(<AgentEventsPage />)
    const selected = await screen.findByRole('region', { name: 'オーナーと管理者だけのときに見られる人' })
    expect(await within(selected).findByText('鈴木 一郎')).toBeInTheDocument()
    expect(within(selected).getAllByText('全部')).toHaveLength(2)
    // The other card shows its list on hover.
    expect(screen.queryByRole('region', { name: /各部署の責任者.*のときに見られる人/ })).not.toBeInTheDocument()
    await userEvent.hover(screen.getByRole('radio', { name: /各部署の責任者/ }))
    const other = await screen.findByRole('region', { name: /各部署の責任者.*のときに見られる人/ })
    expect(await within(other).findByText('営業部の分')).toBeInTheDocument()
    expect(within(other).getByText('田中 太郎')).toBeInTheDocument()
  })

  it('the settings tab is for owner/admin only', async () => {
    setUrl('tab=settings')
    stubApi({ ...managerCapabilities, canViewAgentEvents: true }, logRoutes())
    renderInCompany(<AgentEventsPage />)
    await screen.findByText('営業部/提案書.md')
    expect(screen.queryByRole('tab', { name: '設定' })).not.toBeInTheDocument()
    expect(screen.queryByText('保存期間')).not.toBeInTheDocument()
    expect(screen.getByText(/あなたが責任者の部署で行われた操作だけ/)).toBeInTheDocument()
  })
})

