/**
 * 「ブラウザ操作」 の記録 (agent-browser.md "Recording"; design memo D2 / D3): a member who knows the work recorded it once in
 * the app's window and sends it here; the company's owners / admins (the FDE enters a company as one) read it and build a
 * company Skill from it. **The server is the authority** on what may be stored and who reads it:
 *
 * - **Sending** (`send`): the person is a member (the route), this PC may use 「ブラウザ操作」 (`devices.check`: an enabled
 *   registration, or the owner's transition exception — the same first check as every plan step), the company's setting
 *   is 「使う」 for them, lists the domain, and lets this person at least 見るだけ there (`siteGrants.allows`, 「使える人」), and the content is exactly a recording of that domain as the core's rules
 *   write it (`browserRecordingProblem`: every label, address and key already in its kept form, no value, no token field).
 *   Stored with `delete_at` = 30 days later.
 * - **Reading** (every list, open): the sender — only what they sent while a member this time (someone who left and came
 *   back sees nothing of before) — and the company's owners / admins (current members: `companyMember`). Anyone else,
 *   another company's recording and one past its 30 days are the same 404 as one that never existed. Checked on every
 *   read, so a role taken away counts at once. A sender who left: the recording stays for the company until its 30 days.
 * - **Deleting**: the sender (as above) or an owner / admin, any time; the row and its content go. The server clock
 *   deletes every recording past its 30 days (`expire`), and every read leaves one out even before that.
 * - **A draft of a Skill** is made in the same transaction from a recording that holds a write the rule keeps
 *   (services/browser-skill-drafts.ts `makeOnSend`; agent-browser.md "A Skill's draft from a recording"): the answer adds
 *   `draftId` and a sentence. A recording is handed to an AI only as its sender's own, through the drafts' routes (D1):
 *   no record token, and no AI tool calls the routes here, where an owner / admin reads everyone's.
 */
import {
  BROWSER_RECORDING_DAYS, browserRecordingProblem, type BrowserRecordingContent,
} from '../../shared/core/browser-recording'
import { normalizeBrowserHost } from '../../shared/core/browser-operation'
import type { BrowserRecordingDetail, BrowserRecordingSent, BrowserRecordingsList, BrowserRecordingSummary } from '../../shared/types/browser-recordings'
import type { AccountDirectory } from '../ports/accounts'
import type { BrowserRecordingHead, BrowserRecordingRepository } from '../ports/browser-recordings'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import type { BrowserDeviceGate } from './browser-devices'
import type { BrowserSiteGrants } from './browser-site-grants'
import type { BrowserSkillDraftService } from './browser-skill-drafts'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserRecordingDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  memberships: Pick<MembershipRepository, 'joinedAt'>
  accounts: Pick<AccountDirectory, 'byIds'>
  /** Who may use which registered site (services/browser-site-grants.ts): the one rule, asked here for 見るだけ. */
  siteGrants: Pick<BrowserSiteGrants, 'allows'>
  /** This PC's check (the first check of every plan step: an enabled registration, or the owner's exception). */
  devices: Pick<BrowserDeviceGate, 'check'>
  transactions: Transactions
  /** The Skill's draft made from the recording, in the same transaction (agent-browser.md "A Skill's draft from a recording"). */
  drafts: Pick<BrowserSkillDraftService, 'makeOnSend'>
}

export const BROWSER_RECORDING_LIST_LIMIT = 200
/** Recordings one member may have kept in a company at once (each goes after 30 days, or when deleted). */
export const BROWSER_RECORDING_PER_MEMBER = 20
const DAY_MS = 24 * 60 * 60 * 1000
const ID_RE = /^br_[0-9a-f]{32}$/
const iso = (ms: number) => new Date(ms).toISOString()
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const BROWSER_RECORDING_SERVER_WORDS = Object.freeze({
  notFound: 'この記録は見つかりません（消されたか、30日が過ぎました）。',
  badBody: '記録の形が正しくありません。アプリを新しくしてから、もう一度記録してください。',
  tooLarge: '記録が大きすぎます。',
  tooMany: '送った記録が多すぎます（ひとり20件まで）。要らない記録を管理者に消してもらうか、30日たって消えるのを待ってください。',
  notAllowed: 'このサイトは、いまは記録できません（会社の設定で「使う」になっていないか、登録されていないか、あなたが使えるようになっていません）。',
})
const W = BROWSER_RECORDING_SERVER_WORDS

export function createBrowserRecordingService(deps: BrowserRecordingDeps) {
  const repo = (companyId: string): BrowserRecordingRepository => deps.companyData.forCompany(companyId).browserRecordings
  const missing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_RECORDING_NOT_FOUND' })
  const now = () => iso(deps.clock.nowMs())
  /** The sender reads only what they sent while a member this time (null: not a member, nothing). */
  const sinceOf = (member: Member) => deps.memberships.joinedAt(member.companyId, member.userId)
  const mayRead = (member: Member, row: BrowserRecordingHead): boolean => {
    if (hasFullAccess(member.role)) return true
    const since = sinceOf(member)
    return row.userId === member.userId && since !== null && row.createdAt >= since
  }
  const summaries = (member: Member, rows: BrowserRecordingHead[]): BrowserRecordingSummary[] => {
    const people = deps.accounts.byIds([...new Set(rows.map(r => r.userId))])
    return rows.map(r => ({
      id: r.id, userId: r.userId, name: people.get(r.userId)?.name ?? null, domain: r.domain, lines: r.lines,
      createdAt: r.createdAt, deleteAt: r.deleteAt, mine: r.userId === member.userId,
    }))
  }

  return {
    /** POST /browser-recordings { domain, content } + this PC's key header. */
    send(member: Member, deviceKey: string | undefined, body: unknown): Outcome<BrowserRecordingSent> {
      const pc = deps.devices.check(member, deviceKey, null)
      if (!pc.ok) return pc
      if (!isMap(body) || Object.keys(body).length !== 2 || typeof body.domain !== 'string') return refuse('bad-request', W.badBody, { code: 'BROWSER_RECORDING_BAD' })
      const domain = normalizeBrowserHost(body.domain)
      if (!domain || domain !== body.domain) return refuse('bad-request', W.badBody, { code: 'BROWSER_RECORDING_BAD' })
      // The company's 「使う」 with the domain registered, and this person allowed at least 見るだけ there (「使える人」).
      if (!deps.siteGrants.allows(member, domain, 'read')) return refuse('forbidden', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
      const problem = browserRecordingProblem(body.content, domain)
      if (problem === 'size') return refuse('too-large', W.tooLarge, { code: 'BROWSER_RECORDING_TOO_LARGE' })
      if (problem) return refuse('bad-request', W.badBody, { code: 'BROWSER_RECORDING_BAD', problem })
      const content = body.content as BrowserRecordingContent
      // The recording and its draft together: never a recording whose draft was lost halfway (design memo §7 "止まったら").
      return deps.transactions.run((): Outcome<BrowserRecordingSent> => {
        const at = deps.clock.nowMs()
        if (repo(member.companyId).countOf(member.userId, iso(at)) >= BROWSER_RECORDING_PER_MEMBER) {
          return refuse('conflict', W.tooMany, { code: 'BROWSER_RECORDING_LIMIT' })
        }
        const row = {
          id: `br_${deps.ids.newToken().slice(0, 32)}`, userId: member.userId, domain, lines: content.steps.length,
          content: JSON.stringify(content), createdAt: iso(at), deleteAt: iso(at + BROWSER_RECORDING_DAYS * DAY_MS),
        }
        repo(member.companyId).insert(row)
        const draft = deps.drafts.makeOnSend(member, { id: row.id, content, createdAtMs: at })
        return ok({ ...summaries(member, [row])[0], draftId: draft.draftId, draftNote: draft.note })
      })
    },

    /** GET /browser-recordings: an owner / admin every recording of the company; anyone else their own. */
    list(member: Member): Outcome<BrowserRecordingsList> {
      const full = hasFullAccess(member.role)
      const since = sinceOf(member)
      if (!full && since === null) return ok({ items: [], more: false })
      const rows = repo(member.companyId).list(now(), BROWSER_RECORDING_LIST_LIMIT + 1, full ? undefined : { userId: member.userId, since: since as string })
      return ok({ items: summaries(member, rows.slice(0, BROWSER_RECORDING_LIST_LIMIT)), more: rows.length > BROWSER_RECORDING_LIST_LIMIT })
    },

    /** GET /browser-recordings/:recordingId (the permission is checked on every read). */
    get(member: Member, recordingId: string): Outcome<BrowserRecordingDetail> {
      if (!ID_RE.test(recordingId)) return missing()
      const row = repo(member.companyId).byId(recordingId, now())
      if (!row || !mayRead(member, row)) return missing()
      let content: BrowserRecordingContent
      try { content = JSON.parse(row.content) as BrowserRecordingContent } catch { return missing() }
      return ok({ ...summaries(member, [row])[0], content })
    },

    /** DELETE /browser-recordings/:recordingId: the sender or an owner / admin; the content goes with the row. */
    remove(member: Member, recordingId: string): Outcome<{ deleted: true }> {
      if (!ID_RE.test(recordingId)) return missing()
      const r = repo(member.companyId)
      const row = r.byId(recordingId, now())
      if (!row || !mayRead(member, row)) return missing()
      r.delete(recordingId)
      return ok({ deleted: true })
    },

    /** The server clock: every recording of the company past its 30 days goes; how many. */
    expire(companyId: string): number {
      return repo(companyId).deleteExpired(now())
    },
  }
}

export type BrowserRecordingService = ReturnType<typeof createBrowserRecordingService>
