/**
 * Important notices as a Slack DM (stage 3 A3, E-26; `.claude/rules/slack-connector.md`
 * "Notice DMs"): the notices service's `outside` hook (notifications.md) hands
 * in the notices it just wrote and this sends
 * a DM by the company's bot for those whose record **now waits for the
 * member** (「あなたの番」: a request type, not final, not the AI's turn, its
 * `next_actor` — else `assignee` — is the member, or the absentee a delegate's
 * copy is for). Everything else (results, overdue to the requester…) stays in
 * the app's bell only.
 *
 * The DM says only that it is the member's turn and the record's title —
 * never a field, note, body or anything else of the record — and is sent only
 * through `sendNoticeDm` (active grant, 知らせの DM not turned off, the
 * company's Slack on). Like the Mac notification (E-27), it follows
 * 「あなたの番」, not the bell's kind switches (being handed a task is the
 * bell's `others`, off by default); the member's own switch is the Slack
 * permission's `notices` feature. Nothing is stored; nothing of the text is
 * logged.
 */
import { aiTurnStates } from '../../shared/core/record-types'
import type { CompanyDataSource } from '../ports/company-data'
import type { NotificationRow } from '../ports/notifications'
import { currentTypes } from './record-index'
import type { SlackResult } from './slack-client'

/** At most this many DMs per batch of notices (one engine write or one clock run of a company). */
export const NOTICE_DMS_PER_BATCH = 20
const TITLE_MAX = 120

export interface SlackNoticesDeps {
  companyData: CompanyDataSource
  sendNoticeDm(companyId: string, userId: string, text: string): Promise<SlackResult>
  log?: Pick<Console, 'warn'>
}

/** The DM's sentence: the turn and the title only. */
export function noticeDmText(title: string, delegate: boolean): string {
  const t = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title
  return `ACB：あなたの番です。「${t}」${delegate ? '（不在の人の代わりとして）' : ''}\nACB のアプリで開いてください。`
}

/** Reasons that are the normal "this member gets no DM" (no warning). */
const QUIET = new Set(['no-grant', 'feature-off', 'not-member', 'not-configured', 'off', 'operator-stopped', 'vault-off', 'no-bot'])

export function createSlackNotices(deps: SlackNoticesDeps) {
  const log = deps.log ?? console

  /** The notices (of one company) whose record now waits for their member: one per member and record. */
  function turnNotices(companyId: string, rows: NotificationRow[]): Array<{ userId: string; title: string; delegate: boolean }> {
    if (rows.length === 0) return []
    const records = deps.companyData.forCompany(companyId).records
    const types = currentTypes(records)
    const ids = [...new Set(rows.map(r => r.recordId))]
    const recs = new Map(records.byIds(ids).map(r => [r.id, r]))
    const states = new Map(records.states(ids).map(s => [s.recordId, s]))
    const out: Array<{ userId: string; title: string; delegate: boolean }> = []
    const seen = new Set<string>()
    for (const row of rows) {
      const rec = recs.get(row.recordId)
      const def = rec ? types.get(rec.type)?.definition : undefined
      const state = states.get(row.recordId)
      if (!rec || rec.removedAt !== null || !def || !def.implements.includes('request') || !state || state.state === null) continue
      if (def.final.includes(state.state) || aiTurnStates(def).has(state.state)) continue
      let fields: Record<string, unknown> = {}
      try { fields = JSON.parse(state.fields) as Record<string, unknown> } catch { continue }
      const who = typeof fields.next_actor === 'string' ? fields.next_actor : fields.assignee
      if (typeof who !== 'string' || (who !== row.userId && who !== row.forUserId)) continue
      const key = `${row.userId}\n${row.recordId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ userId: row.userId, title: rec.title, delegate: who !== row.userId })
    }
    return out.slice(0, NOTICE_DMS_PER_BATCH)
  }

  /** Sends the DMs of these notices; the number sent. Never throws. */
  async function deliver(companyId: string, rows: NotificationRow[]): Promise<number> {
    let sent = 0
    let todo: ReturnType<typeof turnNotices>
    try {
      todo = turnNotices(companyId, rows)
    } catch {
      log.warn(`[slack] notice DMs could not be prepared company=${companyId}`)
      return 0
    }
    for (const n of todo) {
      try {
        const r = await deps.sendNoticeDm(companyId, n.userId, noticeDmText(n.title, n.delegate))
        if (r.ok) sent++
        else if (!QUIET.has(r.reason)) log.warn(`[slack] notice DM not sent company=${companyId} reason=${r.reason}${r.slackError ? ` slack=${r.slackError}` : ''}`)
      } catch {
        log.warn(`[slack] notice DM failed company=${companyId}`)
      }
    }
    return sent
  }

  return {
    deliver,
    /** The notices service's `outside` hook: fire and forget (the engine's write never waits for Slack). */
    outside(companyId: string, rows: NotificationRow[]): void {
      void deliver(companyId, rows)
    },
  }
}

export type SlackNotices = ReturnType<typeof createSlackNotices>
