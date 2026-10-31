// 「議事録が届きました」 (milestone 4 G9, .claude/rules/minutes.md "The app"):
// the main process asks the server for new minutes — at start (the renderer
// names the company once signed in), every 10 minutes while the app is open,
// and on 「議事録を確かめる」 — only while the member has allowed Google to read
// minutes (no grant: nothing is asked and nothing is shown). Records stuck in
// 「読んでいる」 come back with `retry` (design §1-8). The session stays here.
//
// The push channel's `records` signal carries no content: it only makes this
// module ask the server again for the member's received minutes.

import type { MinutesActionResult, MinutesNotice, MinutesNoticesResult } from '../../../shared/minutes-app'
import { MINUTES_OFFLINE_TEXT } from '../../../shared/minutes-app'

export interface MinutesCheckerDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** The notices of this company may have changed: the renderer re-reads them (main.ts sends minutes:changed). */
  onChanged: (companyId: string) => void
  /** Keep the company's push channel open, so its records signals arrive. */
  watchSignals?: (companyId: string) => void
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** Per request (default 30 s: a check reads the calendar and Meet). */
  timeoutMs?: number
}

/** Design §1-2: every 10 minutes while the app is open (q5: no server timer). */
export const MINUTES_CHECK_INTERVAL_MS = 10 * 60_000

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const MINUTES = /^minutes-[0-9a-z]{6,32}$/
const DEAL = /^deal-[0-9a-z]{6,32}$/

type Answer = { status: number; body: { data?: unknown; error?: unknown; code?: unknown } | null }

/** A server sentence for the member (Japanese), else a plain fallback. */
function memberText(body: Answer['body'], fallback: string): string {
  const error = body?.error
  return typeof error === 'string' && /[぀-ヿ一-鿿]/.test(error) ? error : fallback
}

function noticeOf(r: unknown): MinutesNotice | null {
  const x = r as { id?: unknown; type?: unknown; title?: unknown; state?: unknown; version?: unknown; fields?: Record<string, unknown> } | null
  if (!x || x.type !== 'minutes' || x.state !== 'received' || typeof x.id !== 'string' || !MINUTES.test(x.id)) return null
  if (typeof x.title !== 'string' || typeof x.version !== 'number') return null
  const at = x.fields?.meeting_at
  return { id: x.id, title: x.title.slice(0, 200), meetingAt: typeof at === 'string' ? at : null, version: x.version }
}

export function createMinutesChecker(deps: MinutesCheckerDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return t })
  const stopEvery = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

  let current: string | null = null
  let timer: unknown = null
  /** Per company: allowed (grant) and the received minutes, as last asked. */
  const known = new Map<string, MinutesNoticesResult>()
  const refreshing = new Map<string, { again: boolean }>()
  const checking = new Set<string>()

  async function call(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json().catch(() => null) as Answer['body'] }
    } catch {
      return null
    }
  }

  /** Whether the member has allowed Google to read their calendar and minutes (any failure: no). */
  async function hasGrant(companyId: string): Promise<boolean> {
    const r = await call(companyId, 'GET', '/me/google')
    const data = r && r.status === 200 ? (r.body?.data as { connected?: unknown; features?: unknown } | undefined) : undefined
    return !!data && data.connected === true && Array.isArray(data.features) && data.features.includes('minutes')
  }

  function publish(companyId: string, next: MinutesNoticesResult) {
    const before = known.get(companyId)
    known.set(companyId, next)
    if (JSON.stringify(before) !== JSON.stringify(next)) deps.onChanged(companyId)
  }

  /** Ask the server for the member's received minutes (「AI の番」 of type minutes). */
  async function refresh(companyId: string): Promise<void> {
    const running = refreshing.get(companyId)
    if (running) { running.again = true; return }
    const state = { again: false }
    refreshing.set(companyId, state)
    try {
      do {
        state.again = false
        const r = await call(companyId, 'GET', '/records/ai-turn')
        if (!r || r.status !== 200) {
          // Off line, records off, an older server: keep what was shown.
          if (r) log.warn(`[minutes] ai-turn: answered ${r.status}`)
          return
        }
        const records = (r.body?.data as { records?: unknown[] } | undefined)?.records ?? []
        const notices = records.map(noticeOf).filter((n): n is MinutesNotice => n !== null)
        publish(companyId, { available: true, notices })
      } while (state.again)
    } finally {
      refreshing.delete(companyId)
    }
  }

  /** `retry` on a record stuck in 「読んでいる」 (design §1-8), with its current version. */
  async function putBack(companyId: string, recordId: string): Promise<void> {
    if (!MINUTES.test(recordId)) return
    const item = await call(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}`)
    const record = (item?.body?.data as { record?: { state?: unknown; version?: unknown } } | undefined)?.record
    if (!record || record.state !== 'reading' || typeof record.version !== 'number') return
    const r = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/retry`, { expectedVersion: record.version })
    if (!r || r.status >= 300) log.warn(`[minutes] retry: answered ${r?.status ?? 'nothing'}`)
  }

  /** One check: grant → the server looks at the calendar → stale ones back → the notices. */
  async function check(companyId: string): Promise<MinutesActionResult> {
    if (!await hasGrant(companyId)) {
      publish(companyId, { available: false, notices: [] })
      return { success: true }
    }
    if (checking.has(companyId)) return { success: true }
    checking.add(companyId)
    try {
      const r = await call(companyId, 'POST', '/me/minutes/check')
      if (!r) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (r.status !== 200) {
        log.warn(`[minutes] check: answered ${r.status}`)
        return { success: false, error: memberText(r.body, `議事録を確かめられませんでした（サーバーの応答 ${r.status}）。`) }
      }
      const data = r.body?.data as { checked?: unknown; message?: unknown; stale?: unknown } | undefined
      for (const id of Array.isArray(data?.stale) ? data.stale : []) if (typeof id === 'string') await putBack(companyId, id)
      await refresh(companyId)
      if (data?.checked === false) return { success: true, ...(typeof data.message === 'string' ? { message: data.message } : {}) }
      return { success: true }
    } finally {
      checking.delete(companyId)
    }
  }

  /** The notice's version, read again when not known. */
  async function versionOf(companyId: string, minutesId: string): Promise<number | null> {
    const cached = known.get(companyId)?.notices.find(n => n.id === minutesId)
    if (cached) return cached.version
    const item = await call(companyId, 'GET', `/records/item/${encodeURIComponent(minutesId)}`)
    const version = (item?.body?.data as { record?: { version?: unknown } } | undefined)?.record?.version
    return typeof version === 'number' ? version : null
  }

  return {
    /** The company the member works in now (null: none / signed out). Starts the loop for it. */
    async watch(companyId: string | null): Promise<void> {
      if (companyId !== null && !COMPANY.test(companyId)) return
      if (companyId === current) return
      if (timer !== null) { stopEvery(timer); timer = null }
      current = companyId
      if (!companyId) return
      deps.watchSignals?.(companyId)
      timer = every(() => { if (current) void check(current) }, MINUTES_CHECK_INTERVAL_MS)
      await check(companyId)
    },

    /** 「議事録を確かめる」. */
    checkNow(companyId: string): Promise<MinutesActionResult> {
      if (!COMPANY.test(companyId)) return Promise.resolve({ success: false, error: '入力が正しくありません。' })
      return check(companyId)
    },

    /** What the notices show; asked once when not known yet. */
    async notices(companyId: string): Promise<MinutesNoticesResult> {
      if (!COMPANY.test(companyId)) return { available: false, notices: [] }
      return known.get(companyId) ?? { available: false, notices: [] }
    },

    /**
     * The push channel's `records` signal for a company: something of the
     * member's records changed. Only asks again — the signal's content is never
     * read (it has none worth trusting) and nothing else happens.
     */
    recordsSignal(companyId: string): void {
      if (companyId !== current || known.get(companyId)?.available !== true) return
      void refresh(companyId)
    },

    /** 「今は読まない」: the type's `skip`, with the member's session. */
    async skip(companyId: string, minutesId: string): Promise<MinutesActionResult> {
      if (!COMPANY.test(companyId) || !MINUTES.test(minutesId)) return { success: false, error: '入力が正しくありません。' }
      const version = await versionOf(companyId, minutesId)
      if (version === null) return { success: false, error: MINUTES_OFFLINE_TEXT }
      const r = await call(companyId, 'POST', `/records/item/${encodeURIComponent(minutesId)}/actions/skip`, { expectedVersion: version })
      await refresh(companyId)
      if (!r) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (r.status >= 300) return { success: false, error: memberText(r.body, `できませんでした（サーバーの応答 ${r.status}）。`) }
      return { success: true }
    },

    /** 「どの案件の議事録ですか？」: link the chosen deal (nothing is written to HubSpot). */
    async linkDeal(companyId: string, minutesId: string, dealId: string): Promise<MinutesActionResult> {
      if (!COMPANY.test(companyId) || !MINUTES.test(minutesId) || !DEAL.test(dealId)) return { success: false, error: '入力が正しくありません。' }
      const r = await call(companyId, 'POST', `/me/minutes/item/${encodeURIComponent(minutesId)}/deal`, { dealId })
      if (!r) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (r.status >= 300) {
        log.warn(`[minutes] deal: answered ${r.status}`)
        return { success: false, error: memberText(r.body, `案件につなげませんでした（サーバーの応答 ${r.status}）。`) }
      }
      return { success: true }
    },

    /** Sign-out / quit: forget everything and stop the loop. */
    stop(): void {
      if (timer !== null) stopEvery(timer)
      timer = null
      current = null
      known.clear()
    },
  }
}

export type MinutesChecker = ReturnType<typeof createMinutesChecker>
