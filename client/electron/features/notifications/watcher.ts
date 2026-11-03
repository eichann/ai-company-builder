// The title bar's 「あなたの番 N」 and the bell (知らせ, stage 2 S5,
// .claude/rules/notifications.md "The app"): main asks the server for the
// member's turn (`/records/my-turn`) and notices (`/me/notifications`) for the
// company on screen — at start, every 5 minutes, and when the push channel
// says something changed. The session stays here.
//
// The push channel's `records` / `notifications` signals carry no content: they
// only make this module ask the server again (「かもしれない運転」). A Mac
// notification (E-27) goes out only for an approval request, a new item in
// 「あなたの番」 or a notice the server marks fresh (`desktop`: the morning's
// 「今日のあなたの番」, 「明日が期限」, being asked) — only from what the server
// answered, never from a signal; each notice once per PC (`shownNotices`).

import { RECORDLESS_NOTIFICATION_KINDS, type NotificationItem, type NotificationList } from '../../../../shared/types/notifications'
import type { DesktopTarget, NoticesActionResult, NoticesState, TurnItem } from '../../../shared/notifications-app'
import { desktopNoticesOf, NO_NOTICES, NOTICES_OFFLINE_TEXT, thisWeeksTurn, turnItemKey } from '../../../shared/notifications-app'
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { turnTiming } from '../../../../shared/core/turn-timing'

export interface NotificationsWatcherDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** This company's state may have changed: the renderer re-reads it (main.ts sends notifications:changed). */
  onChanged: (companyId: string) => void
  /** Keep the company's push channel open, so its signals arrive. */
  watchSignals?: (companyId: string) => void
  /** A Mac notification (the shell's); a click brings the app's window forward (and opens `target`). */
  desktopNotify?: (title: string, body: string, click: { companyId: string; target: DesktopTarget }) => void
  /** The notice ids already shown as a Mac notification on this PC (kept across restarts). */
  shownNotices?: { load(): string[]; save(ids: string[]): void }
  fetch?: typeof fetch
  /** The clock (tests): the company's today decides which of the turn is this week's. */
  now?: () => number
  log?: Pick<Console, 'warn'>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export const NOTICES_CHECK_INTERVAL_MS = 5 * 60_000
/** Notice ids remembered as shown (the newest; older ones are no longer fresh anyway). */
const SHOWN_KEEP = 300

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const RECORD = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/
const NOTICE_ID = /^[A-Za-z0-9-]{1,100}$/

type Answer = { status: number; body: { data?: unknown; error?: unknown } | null }

function turnItemOf(r: unknown, today: string): TurnItem | null {
  const x = r as { id?: unknown; type?: unknown; title?: unknown; state?: unknown; fields?: Record<string, unknown>; waitCameBack?: unknown } | null
  if (!x || typeof x.id !== 'string' || !RECORD.test(x.id) || typeof x.type !== 'string' || typeof x.title !== 'string') return null
  const due = x.fields?.due
  const state = typeof x.state === 'string' ? x.state : null
  const cameBack = !!x.waitCameBack && typeof x.waitCameBack === 'object'
  // Which of the turn is this week's: the server's morning summary counts with the same rule.
  const timing = turnTiming({ type: x.type, state, fields: x.fields && typeof x.fields === 'object' ? x.fields : {}, waitCameBack: cameBack }, today)
  return {
    id: x.id, type: x.type, title: x.title.slice(0, 200), state, due: typeof due === 'string' ? due : null,
    ...(cameBack ? { waitCameBack: true as const } : {}),
    ...(timing !== 'now' ? { timing } : {}),
  }
}

const RECORDLESS = new Set<string>(RECORDLESS_NOTIFICATION_KINDS)

function noticeOf(i: NotificationItem): NotificationItem | null {
  if (!i || typeof i.id !== 'string' || !NOTICE_ID.test(i.id) || typeof i.text !== 'string' || typeof i.recordId !== 'string') return null
  // A notice is about a record, except the kinds about none (the morning summary: '').
  if (!(RECORD.test(i.recordId) || (i.recordId === '' && RECORDLESS.has(i.kind)))) return null
  const d = i.desktop as { title?: unknown; body?: unknown } | undefined
  const out: NotificationItem = { ...i }
  delete out.desktop
  if (typeof d === 'object' && d !== null && typeof d.title === 'string' && typeof d.body === 'string') {
    out.desktop = { title: d.title.slice(0, 200), body: d.body.slice(0, 200) }
  }
  return out
}

function noticeListOf(data: unknown): NotificationList | null {
  const x = data as Partial<NotificationList> | null
  if (!x || typeof x.available !== 'boolean' || typeof x.unread !== 'number' || !Array.isArray(x.items)) return null
  const items = x.items.map(noticeOf).filter((i): i is NotificationItem => i !== null)
  return { available: x.available, unread: x.unread, items }
}

export function createNotificationsWatcher(deps: NotificationsWatcherDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return t })
  const stopEvery = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

  let current: string | null = null
  let timer: unknown = null
  const known = new Map<string, NoticesState>()
  /** Per company: the turn items already seen (null until the first answer). */
  const seenTurn = new Map<string, Set<string>>()
  const refreshing = new Map<string, { again: boolean }>()

  async function call(companyId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json().catch(() => null) as Answer['body'] }
    } catch {
      return null
    }
  }

  function publish(companyId: string, next: NoticesState) {
    const before = known.get(companyId)
    known.set(companyId, next)
    if (JSON.stringify(before) !== JSON.stringify(next)) deps.onChanged(companyId)
  }

  let shown: Set<string> | null = null
  const shownIds = (): Set<string> => {
    if (shown === null) {
      try { shown = new Set(deps.shownNotices?.load() ?? []) } catch { shown = new Set() }
    }
    return shown
  }

  function notifyDesktop(companyId: string, items: TurnItem[], notices: NotificationItem[]) {
    const before = seenTurn.get(companyId) ?? null
    seenTurn.set(companyId, new Set(items.map(turnItemKey)))
    const ids = shownIds()
    const out = desktopNoticesOf(before, items, notices, ids)
    for (const n of out) {
      try { deps.desktopNotify?.(n.title, n.body, { companyId, target: n.target }) } catch { /* no notification: the title bar still shows it */ }
      if (!n.key.startsWith('turn:')) ids.add(n.key)
    }
    if (out.some(n => !n.key.startsWith('turn:'))) {
      try { deps.shownNotices?.save([...ids].slice(-SHOWN_KEEP)) } catch { /* shown again after a restart at worst */ }
    }
  }

  async function refresh(companyId: string): Promise<void> {
    const running = refreshing.get(companyId)
    if (running) { running.again = true; return }
    const state = { again: false }
    refreshing.set(companyId, state)
    try {
      do {
        state.again = false
        const [turn, notices] = await Promise.all([call(companyId, 'GET', '/records/my-turn'), call(companyId, 'GET', '/me/notifications')])
        // Off line or an older server: keep what was shown.
        if (!turn || !notices) return
        if (turn.status !== 200 || notices.status !== 200) {
          if (turn.status === 404 && notices.status === 200) { publish(companyId, NO_NOTICES); return } // records off
          if (notices.status !== 404) log.warn(`[notifications] answered ${turn.status} / ${notices.status}`)
          return
        }
        const data = turn.body?.data as { total?: unknown; records?: unknown[] } | undefined
        const today = dayWindow((deps.now ?? Date.now)(), DEFAULT_COMPANY_TIME_ZONE).date
        const items = (data?.records ?? []).map(r => turnItemOf(r, today)).filter((i): i is TurnItem => i !== null)
        const list = noticeListOf(notices.body?.data)
        if (!list) return
        if (companyId === current) notifyDesktop(companyId, items, list.items)
        publish(companyId, {
          available: list.available,
          myTurn: thisWeeksTurn(items, typeof data?.total === 'number' ? data.total : items.length),
          notices: list,
        })
      } while (state.again)
    } finally {
      refreshing.delete(companyId)
    }
  }

  return {
    /** The company on screen (null: none): checked now, every 5 minutes, and on its signals. */
    async watch(companyId: string | null): Promise<void> {
      if (companyId !== null && !COMPANY.test(companyId)) return
      if (companyId === current) return
      current = companyId
      if (timer !== null) { stopEvery(timer); timer = null }
      if (companyId === null) return
      deps.watchSignals?.(companyId)
      timer = every(() => { if (current) void refresh(current) }, NOTICES_CHECK_INTERVAL_MS)
      await refresh(companyId)
    },

    state(companyId: string): NoticesState {
      return known.get(companyId) ?? NO_NOTICES
    },

    /** A push signal (no content): ask the server again for the company on screen. */
    signal(companyId: string): void {
      if (companyId === current) void refresh(companyId)
    },

    async markRead(companyId: string, ids: string[] | 'all'): Promise<NoticesActionResult> {
      if (!COMPANY.test(companyId)) return { success: false, error: '入力が正しくありません。' }
      if (ids !== 'all' && (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every(i => typeof i === 'string' && NOTICE_ID.test(i)))) {
        return { success: false, error: '入力が正しくありません。' }
      }
      const r = await call(companyId, 'POST', '/me/notifications/read', ids === 'all' ? { all: true } : { ids })
      if (!r) return { success: false, error: NOTICES_OFFLINE_TEXT }
      if (r.status !== 200) return { success: false, error: `既読にできませんでした（サーバーの応答 ${r.status}）。` }
      await refresh(companyId)
      return { success: true }
    },

    async settings(companyId: string): Promise<{ success: true; kinds: Record<string, boolean> } | { success: false; error: string }> {
      if (!COMPANY.test(companyId)) return { success: false, error: '入力が正しくありません。' }
      const r = await call(companyId, 'GET', '/me/notifications/settings')
      const kinds = (r?.body?.data as { kinds?: unknown } | undefined)?.kinds
      if (!r) return { success: false, error: NOTICES_OFFLINE_TEXT }
      if (r.status !== 200 || typeof kinds !== 'object' || kinds === null) return { success: false, error: `知らせの設定を読めませんでした（サーバーの応答 ${r.status}）。` }
      return { success: true, kinds: kinds as Record<string, boolean> }
    },

    async setSetting(companyId: string, kind: string, on: boolean): Promise<NoticesActionResult> {
      if (!COMPANY.test(companyId) || !/^[a-z_]{1,40}$/.test(kind) || typeof on !== 'boolean') return { success: false, error: '入力が正しくありません。' }
      const r = await call(companyId, 'PUT', '/me/notifications/settings', { kinds: { [kind]: on } })
      if (!r) return { success: false, error: NOTICES_OFFLINE_TEXT }
      if (r.status !== 200) return { success: false, error: `知らせの設定を変えられませんでした（サーバーの応答 ${r.status}）。` }
      await refresh(companyId)
      return { success: true }
    },

    /** Sign-out / quit: forget everything (another account must not see this one's). */
    stop(): void {
      current = null
      if (timer !== null) { stopEvery(timer); timer = null }
      known.clear()
      seenTurn.clear()
      shown = null
    },
  }
}

export type NotificationsWatcher = ReturnType<typeof createNotificationsWatcher>
