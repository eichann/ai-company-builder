/**
 * Outbound mail (「お礼メール」, milestone 4 G8, `.claude/rules/outbound-mail.md`;
 * design 節目4 §1-6, §3-5, §3-7, §4-2 … §4-5, §9 q8 / q9).
 *
 * - **Verified recipients only.** A draft names its recipients by an opaque
 *   `ref`; a ref resolves only to an address found, fresh, in one of the
 *   draft's sources: the meeting's calendar attendees outside the company's
 *   domain (`meetingAttendees`), the HubSpot contacts of the deal (a declared
 *   read through the plugin connector, for members in its read scope who may
 *   read the deal), ACB members (CC), and addresses a person typed on the
 *   screen for this draft (「あなたが入力」, session only). An address the AI
 *   wrote that is in none of these is never offered: the AI passes refs only.
 * - **Versions.** Every change is a new version: its canonical content
 *   (`mailContentCanonical`, From = the member's ACB / Google email) and hash
 *   in `fixed_payloads` (owner kind `outbound_message`), its recipients (ref,
 *   address, name, source) in `outbound_mail_versions`; the record holds
 *   `payload_hash` / `payload_version` / `subject`.
 * - **Sending is a person's, with their session** (no AI route, no admin key,
 *   nothing automatic): the author, the hash of the version on screen equal to
 *   the current one, every recipient still at its source right now (calendar
 *   and HubSpot read again; unreadable → nothing sent), the member's Google
 *   permission to send, then the send row is written BEFORE Gmail is called,
 *   once, never retried. A lost answer or a 5xx is `unknown` until the person
 *   says whether it was sent.
 * - **Retention** (§9 q9): the body (the canonical text) is deleted 30 days
 *   after sent / discarded; the hash, recipients, subject and Gmail id stay.
 *
 * Never logged: subjects, bodies, addresses (only ids and fixed words).
 */
import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import {
  countLinks, emailDomain, isExternalAddress, mailContentCanonical, mailContentProblems, MAIL_LIMITS, normalizeEmail,
  type RecipientSource,
} from '../../shared/core/mail'
import { GOOGLE_SCOPE, sameEmail } from '../../shared/core/google'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { MailRecipientsView, MailRecipientView, MailSendAnswer, OutboundMailState, OutboundMailView } from '../../shared/types/outbound-mail'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { OutboundMailRow, OutboundRecipientRow } from '../ports/outbound-mail'
import type { RecordRow } from '../ports/records'
import type { Transactions } from '../ports/transactions'
import type { FixedPayloadService } from './fixed-payloads'
import { buildMailMessage, gmailRaw } from '../lib/mail-message'
import { logError } from '../lib/error-log'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import { recordReader } from './record-access'
import type { ActorInput, ServiceRecordWriter, ServiceWriteFailed } from './record-engine'
import { RECORDS_DISABLED } from './records'

/** How long a sent / discarded mail's body stays on the server (§9 q9). */
export const MAIL_BODY_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const CLEANUP_CHUNK = 500

export const MAIL_NOT_FOUND = { error: 'メールの下書きが見つかりません', code: 'MAIL_NOT_FOUND' }
export const MAIL_UNKNOWN_TEXT = '届いたか分かりません。Gmail の送信済みを確かめてください。'
const UNVERIFIABLE = 'いまは宛先の出どころ（カレンダー・HubSpot）を読めず、宛先を確かめられないため送れません。少し待ってから、もう一度「確かめて送る」を押してください。'

/** Gmail's send as the Google client makes it (services/google-client.ts `request`). */
export type MailSendResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown'; reason: string; status?: number; googleReason?: string }

/** Fixed content (services/fixed-payloads.ts, shared with approvals): mail is owner kind `outbound_message`. */
export type MailPayloadStore = Pick<FixedPayloadService, 'fix' | 'current' | 'clearBodies'>
const KIND = 'outbound_message' as const

export interface OutboundMailDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  transactions: Transactions
  writer: ServiceRecordWriter
  payloads: MailPayloadStore
  /** sha256 hex of a text (the refs; not a secret). */
  digest: (text: string) => string
  /** The company's members with their ACB email and display name. */
  members: (companyId: string) => Array<{ userId: string; email: string; name: string | null }>
  /** The meeting's calendar attendees, re-read from Google now; null when they cannot be read (minutes, G7). */
  meetingAttendees: (companyId: string, userId: string, minutesId: string) => Promise<Array<{ email: string; name: string | null; organizer: boolean }> | null>
  /** The deal's HubSpot contacts, read now through the plugin connector (plugin-import.ts `dealContacts`). */
  dealContacts: (member: Member, dealId: string) => Promise<{ ok: true; contacts: Array<{ email: string | null; name: string | null }> } | { ok: false; reason: string }>
  /** Gmail `users.messages.send` with the member's own grant; never retried. */
  gmailSend: (companyId: string, userId: string, raw: string) => Promise<MailSendResult>
  /** Every company (the retention run opens each one's handle). */
  companyIds: () => string[]
}

const bad = (error: string, code = 'BAD_REQUEST', extra: Record<string, unknown> = {}) => refuse('bad-request', error, { code, ...extra })
const notFound = () => refuse('not-found', MAIL_NOT_FOUND.error, { code: MAIL_NOT_FOUND.code })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const REF_RE = /^r[0-9a-f]{24}$/

function refList(raw: unknown, max: number, name: string): string[] | Refusal {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > max || !raw.every(r => typeof r === 'string' && REF_RE.test(r))) {
    return bad(`${name}: a list of recipient refs from mail_recipients (at most ${max})`)
  }
  return raw as string[]
}

/** A refusal of the service writer inside a transaction: thrown to roll the content back, answered as the refusal. */
class WriteFailed extends Error {
  constructor(readonly result: ServiceWriteFailed) { super(result.reason) }
}

export function createOutboundMailService(deps: OutboundMailDeps) {
  const { companyData, writer } = deps

  /** All or nothing: the fixed content, the record and the rows. */
  function tryWrite<T>(fn: () => T): T | ServiceWriteFailed {
    try {
      return deps.transactions.run(fn)
    } catch (e) {
      if (e instanceof WriteFailed) return e.result
      throw e
    }
  }

  const refOf = (scope: string, source: RecipientSource, email: string) => `r${deps.digest(`${scope}\n${source}\n${email}`).slice(0, 24)}`
  const contextScope = (userId: string, minutesId: string | null, dealId: string | null) => `${userId}|${minutesId ?? ''}|${dealId ?? ''}`

  function enabled(companyId: string): Refusal | null {
    return companyData.forCompany(companyId).records.settings().enabled
      ? null : refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
  }

  /** A record of `type` the member may read, or null. */
  function readable(member: Member, id: unknown, type: string): RecordRow | null {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id) || !id.startsWith(`${type}-`)) return null
    const handle = companyData.forCompany(member.companyId)
    const row = handle.records.byIds([id])[0]
    if (!row || row.removedAt !== null || row.type !== type) return null
    return recordReader(member, handle.scopes.listWithRules()).record(row) ? row : null
  }

  /** The company's own domains: the Google Workspace domain, else the author's. */
  function internalDomains(companyId: string, from: string): string[] {
    const google = companyData.forCompany(companyId).connectors.client()?.domain
    return google ? [google, emailDomain(from)] : [emailDomain(from)]
  }

  /**
   * Every verified recipient of a draft context, read fresh from the sources
   * in `need` (default all). A source that cannot be read is reported and offers nothing.
   */
  async function collect(
    member: Member, ctx: { minutesId: string | null; dealId: string | null; messageId: string | null; from: string },
    need: ReadonlySet<RecipientSource> | null = null,
  ): Promise<{ recipients: OutboundRecipientRow[]; unreadable: RecipientSource[] }> {
    const scope = contextScope(member.userId, ctx.minutesId, ctx.dealId)
    const out: OutboundRecipientRow[] = []
    const unreadable: RecipientSource[] = []
    const seen = new Set<string>()
    const add = (source: RecipientSource, rawEmail: string | null, name: string | null, refScope = scope) => {
      const email = normalizeEmail(rawEmail)
      if (!email || seen.has(`${source}|${email}`)) return
      seen.add(`${source}|${email}`)
      out.push({ ref: refOf(refScope, source, email), email, name: name ? name.normalize('NFC').slice(0, 100) : null, source })
    }
    const wants = (s: RecipientSource) => need === null || need.has(s)
    if (ctx.minutesId && wants('calendar')) {
      let attendees: Awaited<ReturnType<OutboundMailDeps['meetingAttendees']>> = null
      try { attendees = await deps.meetingAttendees(member.companyId, member.userId, ctx.minutesId) } catch (err) { logError('outbound-mail', 'calendar attendees could not be read', err) }
      if (attendees === null) unreadable.push('calendar')
      else {
        const internal = internalDomains(member.companyId, ctx.from)
        for (const a of attendees) if (normalizeEmail(a.email) && isExternalAddress(normalizeEmail(a.email)!, internal)) add('calendar', a.email, a.name)
      }
    }
    if (ctx.dealId && wants('hubspot')) {
      let r: Awaited<ReturnType<OutboundMailDeps['dealContacts']>>
      try { r = await deps.dealContacts(member, ctx.dealId) } catch (err) { logError('outbound-mail', 'deal contacts could not be read', err); r = { ok: false, reason: 'error' } }
      if (!r.ok) unreadable.push('hubspot')
      else for (const c of r.contacts) add('hubspot', c.email, c.name)
    }
    if (wants('member')) {
      for (const m of deps.members(member.companyId)) if (m.userId !== member.userId) add('member', m.email, m.name)
    }
    if (ctx.messageId && wants('typed')) {
      for (const t of companyData.forCompany(member.companyId).outbound.typedRecipients(ctx.messageId)) add('typed', t.email, t.name, `typed|${ctx.messageId}`)
    }
    return { recipients: out, unreadable }
  }

  function viewOf(companyId: string, mail: OutboundMailRow, recordId: string): OutboundMailView | null {
    const handle = companyData.forCompany(companyId)
    const s = handle.records.states([recordId])[0]
    if (!s) return null
    let fields: Record<string, LedgerValue> = {}
    try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { fields = {} }
    const version = typeof fields.payload_version === 'number' ? fields.payload_version : 1
    const v = handle.outbound.version(mail.messageId, version)
    const payload = deps.payloads.current(companyId, KIND, mail.messageId)
    if (!v || !payload || payload.version !== version) return null
    let body: string | null = null
    let subject = typeof fields.subject === 'string' ? fields.subject : ''
    if (payload.canonical !== null) {
      try {
        const c = JSON.parse(payload.canonical) as { subject?: unknown; body?: unknown }
        if (typeof c.subject === 'string') subject = c.subject
        if (typeof c.body === 'string') body = c.body
      } catch { /* shown without a body */ }
    }
    const sentDomains = new Set(handle.outbound.sentDomains())
    const internal = internalDomains(companyId, mail.fromEmail)
    const shown = (r: OutboundRecipientRow): MailRecipientView => ({
      ...r, firstTime: isExternalAddress(r.email, internal) && !sentDomains.has(emailDomain(r.email)),
    })
    return {
      id: mail.messageId,
      state: s.state as OutboundMailState,
      version,
      hash: payload.hash,
      from: mail.fromEmail,
      to: v.to.map(shown),
      cc: v.cc.map(shown),
      subject,
      body,
      bodyDeleted: body === null,
      linkCount: body === null ? 0 : countLinks(body),
      minutesId: mail.minutesId,
      dealId: mail.dealId,
      sentAt: typeof fields.sent_at === 'string' ? fields.sent_at : null,
      providerMessageId: typeof fields.provider_message_id === 'string' ? fields.provider_message_id : null,
      lastChangedBy: v.actorKind,
      updatedAt: s.updatedAt,
    }
  }

  /** The member's own draft (the author only; anyone else, another company's id or a missing one: the same 404). */
  function ownDraft(member: Member, messageId: unknown): { mail: OutboundMailRow; state: string; recordVersion: number; fields: Record<string, LedgerValue> } | null {
    if (typeof messageId !== 'string' || !RECORD_ID_RE.test(messageId) || !messageId.startsWith('outbound_message-')) return null
    const handle = companyData.forCompany(member.companyId)
    const mail = handle.outbound.mail(messageId)
    if (!mail || mail.authorId !== member.userId) return null
    const s = handle.records.states([messageId])[0]
    if (!s || s.state === null) return null
    let fields: Record<string, LedgerValue> = {}
    try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { fields = {} }
    return { mail, state: s.state, recordVersion: s.version, fields }
  }

  function draftAnswer(member: Member, mail: OutboundMailRow): Outcome<{ draft: OutboundMailView }> {
    const view = viewOf(member.companyId, mail, mail.messageId)
    return view ? ok({ draft: view }) : notFound()
  }

  /** The member's ACB email (the From of their mail), or null. */
  function fromOf(member: Member): string | null {
    const me = deps.members(member.companyId).find(m => m.userId === member.userId)
    return me ? normalizeEmail(me.email) : null
  }

  /** The draft context from a request: minutes and/or deal the member may read (a minutes' deal is taken along). */
  function contextOf(member: Member, body: Record<string, unknown>): { minutesId: string | null; dealId: string | null; minutes: RecordRow | null; deal: RecordRow | null } | Refusal {
    const minutes = body.minutesId === undefined || body.minutesId === null ? null : readable(member, body.minutesId, 'minutes')
    if ((body.minutesId !== undefined && body.minutesId !== null) && !minutes) return refuse('not-found', '議事録が見つかりません', { code: 'RECORD_NOT_FOUND' })
    let deal = body.dealId === undefined || body.dealId === null ? null : readable(member, body.dealId, 'deal')
    if ((body.dealId !== undefined && body.dealId !== null) && !deal) return refuse('not-found', '案件が見つかりません', { code: 'RECORD_NOT_FOUND' })
    if (!deal && minutes) {
      const linked = companyData.forCompany(member.companyId).records.linksFrom([minutes.id]).find(l => l.name === 'deal')
      deal = linked?.targetId ? readable(member, linked.targetId, 'deal') : null
    }
    if (!minutes && !deal) return bad('minutesId or dealId: the minutes or deal the mail is about', 'MAIL_CONTEXT_REQUIRED')
    return { minutesId: minutes?.id ?? null, dealId: deal?.id ?? null, minutes, deal }
  }

  /** Resolve refs: from `known` first (kept from the current version), else from fresh sources (read once, lazily). */
  async function resolveRefs(
    member: Member, refs: { to: string[]; cc: string[] }, known: OutboundRecipientRow[],
    ctx: { minutesId: string | null; dealId: string | null; messageId: string | null; from: string },
  ): Promise<{ to: OutboundRecipientRow[]; cc: OutboundRecipientRow[] } | Refusal> {
    const byRef = new Map(known.map(r => [r.ref, r]))
    if ([...refs.to, ...refs.cc].some(r => !byRef.has(r))) {
      for (const r of (await collect(member, ctx)).recipients) if (!byRef.has(r.ref)) byRef.set(r.ref, r)
    }
    const missing = [...refs.to, ...refs.cc].filter(r => !byRef.has(r))
    if (missing.length > 0) {
      return bad('この宛先は、確かめた宛先の中にありません。宛先は mail_recipients で示されたものから選んでください（アドレスを直接は書けません）。', 'RECIPIENT_NOT_OFFERED', { refs: missing })
    }
    return { to: refs.to.map(r => byRef.get(r)!), cc: refs.cc.map(r => byRef.get(r)!) }
  }

  function contentCheck(from: string, to: OutboundRecipientRow[], cc: OutboundRecipientRow[], subject: unknown, body: unknown): { canonical: string; subject: string } | Refusal {
    if (typeof subject !== 'string' || typeof body !== 'string') return bad('subject and body: text', 'MAIL_INVALID')
    const content = { from, to: to.map(r => r.email), cc: cc.map(r => r.email), subject, body }
    const problems = mailContentProblems(content)
    if (problems.length > 0) return bad(problems[0], 'MAIL_INVALID', { problems })
    return { canonical: mailContentCanonical(content), subject: subject.normalize('NFC') }
  }

  /** The record's title: the subject, kept within the record title's limit. */
  const titleOf = (subject: string) => (subject.trim() === '' ? '（件名なし）' : subject.trim().slice(0, 200))

  function writeFailed(r: { reason: string }): Refusal {
    if (r.reason === 'stale') return refuse('conflict', 'ほかの変更が先にありました。もう一度読み込んでください。', { code: 'VERSION_CONFLICT' })
    if (r.reason === 'records-off') return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    if (r.reason === 'assignee-cannot-read') return refuse('bad-request', 'この場所の記録として下書きを作れません。', { code: 'MAIL_PLACE_REFUSED' })
    return refuse('conflict', '下書きを保存できませんでした。', { code: 'MAIL_NOT_SAVED', reason: r.reason })
  }

  async function sendStep(member: Member, messageId: unknown, rawBody: unknown): Promise<Outcome<MailSendAnswer>> {
    const off = enabled(member.companyId)
    if (off) return off
    const d = ownDraft(member, messageId)
    if (!d) return notFound()
    const body = isObj(rawBody) ? rawBody : {}
    if (typeof body.hash !== 'string' || !CONTENT_HASH_RE.test(body.hash)) return bad('hash: the content hash shown on the screen')
    if (d.state !== 'draft') return refuse('conflict', 'この下書きはもう送ったか、捨てたか、結果を確かめている途中です。', { code: 'NOT_DRAFT', state: d.state })
    const handle = companyData.forCompany(member.companyId)
    const version = typeof d.fields.payload_version === 'number' ? d.fields.payload_version : 0
    const payload = deps.payloads.current(member.companyId, KIND, d.mail.messageId)
    const v = handle.outbound.version(d.mail.messageId, version)
    if (!payload || !v || payload.canonical === null || payload.version !== version) return notFound()
    // 1. The content on screen is the content now (one character's difference is another hash).
    if (payload.hash !== body.hash || d.fields.payload_hash !== body.hash) {
      const view = viewOf(member.companyId, d.mail, d.mail.messageId)
      return refuse('conflict', '内容が変わりました。もう一度確かめてください。', { code: 'CONTENT_CHANGED', ...(view ? { draft: view } : {}) })
    }
    let content: { from: string; to: string[]; cc: string[]; subject: string; body: string }
    try { content = JSON.parse(payload.canonical) as typeof content } catch { return notFound() }
    // 2. Google: the member's permission to send mail, from the account the draft names.
    const grant = handle.connectors.grant('google', member.userId)
    if (!grant || grant.status !== 'active' || !grant.scopes.includes(GOOGLE_SCOPE.gmailSend)) {
      return refuse('conflict', 'メールを送るには、Google で「メールを送る許可」が要ります。', { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'mail' })
    }
    if (!sameEmail(grant.accountEmail, content.from)) {
      return refuse('conflict', '差出人の Google アカウントが下書きと違います。下書きを作り直してください。', { code: 'FROM_CHANGED' })
    }
    // 3. Every recipient is still at its source right now.
    const all = [...v.to, ...v.cc]
    const need = new Set(all.map(r => r.source))
    const fresh = await collect(member, { minutesId: d.mail.minutesId, dealId: d.mail.dealId, messageId: d.mail.messageId, from: d.mail.fromEmail }, need)
    if (all.some(r => fresh.unreadable.includes(r.source))) return refuse('conflict', UNVERIFIABLE, { code: 'RECIPIENTS_UNVERIFIABLE' })
    const now = new Set(fresh.recipients.map(r => `${r.ref}|${r.email}`))
    const gone = all.filter(r => !now.has(`${r.ref}|${r.email}`)).map(r => r.ref)
    if (gone.length > 0) {
      return refuse('conflict', '宛先の中に、もう出どころ（カレンダーの参加者・HubSpot の連絡先など）にない人がいます。宛先を直してから、もう一度確かめてください。', { code: 'RECIPIENT_GONE', goneRefs: gone })
    }
    // 4. The operation record, before anything leaves (one send at a time; never twice).
    const sendId = deps.ids.newId()
    const startedAt = deps.clock.now()
    if (!handle.outbound.startSend({ id: sendId, messageId: d.mail.messageId, version, hash: body.hash, by: member.userId, startedAt, outcome: 'sending', reason: null, providerMessageId: null, finishedAt: null })) {
      return refuse('conflict', 'このメールはいま送っている途中か、すでに送られています。', { code: 'SEND_IN_PROGRESS' })
    }
    // 5. Gmail, once.
    let result: MailSendResult
    try {
      const raw = gmailRaw(buildMailMessage({ from: content.from, to: content.to, cc: content.cc, subject: content.subject, body: content.body, date: new Date(deps.clock.nowMs()) }))
      result = await deps.gmailSend(member.companyId, member.userId, raw)
    } catch (err) {
      // Whether it left is not known (the build cannot fail for a stored version; a throw in the call can be after sending).
      logError('outbound-mail', 'send threw', err, { message: d.mail.messageId })
      result = { ok: false, kind: 'unknown', reason: 'error' }
    }
    const at = deps.clock.now()
    const actor = { id: member.userId, kind: 'human' as const, source: null }
    if (result.ok) {
      const gmailId = isObj(result.json) && typeof result.json.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.json.id) ? result.json.id : null
      handle.outbound.finishSend(sendId, 'sent', null, gmailId, at)
      return finishSent(member, d.mail, d.recordVersion, at, gmailId, content.to.concat(content.cc), actor)
    }
    if (result.kind === 'not-sent' || result.kind === 'refused' || result.kind === 'rate-limited') {
      handle.outbound.finishSend(sendId, result.kind === 'not-sent' ? 'not-sent' : 'refused', result.googleReason ?? result.reason, null, at)
      if (result.kind === 'not-sent' && ['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted'].includes(result.reason)) {
        return refuse('conflict', 'メールを送るには、Google で「メールを送る許可」が要ります。', { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'mail' })
      }
      if (result.kind === 'not-sent') return refuse('unavailable', 'いまは Google でメールを送れません（止められているか、つながりません）。何も送っていません。', { code: 'GOOGLE_UNAVAILABLE', reason: result.reason })
      return refuse('conflict', 'Gmail が受け付けませんでした。何も送っていません。', { code: 'SEND_REFUSED', ...(result.googleReason ? { googleReason: result.googleReason } : {}) })
    }
    // A lost answer or a 5xx: it may have been sent. Never re-sent; the person checks Gmail.
    handle.outbound.finishSend(sendId, 'unknown', result.googleReason ?? result.reason, null, at)
    const moved = writer.transition(member.companyId, { recordId: d.mail.messageId, action: 'send_unknown', expectedVersion: d.recordVersion, to: 'unknown', actor })
    if (!moved.ok) logError('outbound-mail', 'unknown state not recorded', undefined, { message: d.mail.messageId, reason: moved.reason })
    const view = viewOf(member.companyId, d.mail, d.mail.messageId)
    return view ? ok({ outcome: 'unknown', draft: view, message: MAIL_UNKNOWN_TEXT }) : notFound()
  }

  /** The record → sent, the retention clock, and the deal's 「やりとり」 (design §1-6 step 19). */
  function finishSent(member: Member, mail: OutboundMailRow, recordVersion: number, at: string, gmailId: string | null, recipients: string[], actor: { id: string; kind: 'human'; source: null }): Outcome<MailSendAnswer> {
    const handle = companyData.forCompany(member.companyId)
    const moved = writer.transition(member.companyId, {
      recordId: mail.messageId, action: 'send', expectedVersion: recordVersion, to: 'sent', actor,
      fields: { sent_at: at, ...(gmailId ? { provider_message_id: gmailId } : {}) },
    })
    if (!moved.ok) logError('outbound-mail', 'sent state not recorded', undefined, { message: mail.messageId, reason: moved.reason })
    handle.outbound.setFinished(mail.messageId, at)
    recordInteraction(member, mail, at, gmailId, recipients)
    const view = viewOf(member.companyId, mail, mail.messageId)
    return view ? ok({ outcome: 'sent', draft: view }) : notFound()
  }

  function recordInteraction(member: Member, mail: OutboundMailRow, at: string, gmailId: string | null, recipients: string[]) {
    const handle = companyData.forCompany(member.companyId)
    const deal = mail.dealId ? handle.records.byIds([mail.dealId])[0] : undefined
    const subjectField = handle.records.states([mail.messageId])[0]
    let subject = ''
    try { subject = String((JSON.parse(subjectField?.fields ?? '{}') as { subject?: unknown }).subject ?? '') } catch { subject = '' }
    const domains = [...new Set(recipients.map(emailDomain))].join(', ').slice(0, 500)
    const made = writer.create(member.companyId, {
      type: 'interaction', title: titleOf(subject), summary: subject.slice(0, 300), folder: deal?.folder ?? null,
      fields: { occurred_at: at, channel: 'email', counterpart: domains, source_ref: gmailId ? `gmail:${gmailId}` : null, needs_reply: false },
      links: mail.dealId ? { deal: [mail.dealId] } : {},
      actor: { id: member.userId, kind: 'human', source: null },
    })
    if (!made.ok) logError('outbound-mail', 'interaction not recorded', undefined, { message: mail.messageId, reason: made.reason })
  }

  return {
    /** Verified recipients of a context (POST /outbound-recipients; the AI's mail_recipients). */
    async recipients(member: Member, rawBody: unknown): Promise<Outcome<MailRecipientsView>> {
      const off = enabled(member.companyId)
      if (off) return off
      const ctx = contextOf(member, isObj(rawBody) ? rawBody : {})
      if ('ok' in ctx) return ctx
      const from = fromOf(member)
      if (!from) return notFound()
      const got = await collect(member, { minutesId: ctx.minutesId, dealId: ctx.dealId, messageId: null, from })
      const sent = new Set(companyData.forCompany(member.companyId).outbound.sentDomains())
      const internal = internalDomains(member.companyId, from)
      return ok({
        recipients: got.recipients.map(r => ({ ...r, firstTime: isExternalAddress(r.email, internal) && !sent.has(emailDomain(r.email)) })),
        unreadable: got.unreadable,
      })
    },

    /** The candidates of an existing draft, typed ones included (GET /outbound/:id/recipients). */
    async draftRecipients(member: Member, messageId: unknown): Promise<Outcome<MailRecipientsView>> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      if (!d) return notFound()
      const got = await collect(member, { minutesId: d.mail.minutesId, dealId: d.mail.dealId, messageId: d.mail.messageId, from: d.mail.fromEmail })
      const sent = new Set(companyData.forCompany(member.companyId).outbound.sentDomains())
      const internal = internalDomains(member.companyId, d.mail.fromEmail)
      return ok({
        recipients: got.recipients.map(r => ({ ...r, firstTime: isExternalAddress(r.email, internal) && !sent.has(emailDomain(r.email)) })),
        unreadable: got.unreadable,
      })
    },

    /** A new draft (person or their AI): POST /outbound. */
    async create(member: Member, actor: ActorInput, rawBody: unknown): Promise<Outcome<{ draft: OutboundMailView }>> {
      const off = enabled(member.companyId)
      if (off) return off
      const body = isObj(rawBody) ? rawBody : {}
      const ctx = contextOf(member, body)
      if ('ok' in ctx) return ctx
      const to = refList(body.toRefs, MAIL_LIMITS.to, 'toRefs')
      if (!Array.isArray(to)) return to
      const cc = refList(body.ccRefs, MAIL_LIMITS.cc, 'ccRefs')
      if (!Array.isArray(cc)) return cc
      const from = fromOf(member)
      if (!from) return notFound()
      const resolved = await resolveRefs(member, { to, cc }, [], { minutesId: ctx.minutesId, dealId: ctx.dealId, messageId: null, from })
      if ('ok' in resolved) return resolved
      const checked = contentCheck(from, resolved.to, resolved.cc, body.subject, body.body)
      if ('ok' in checked) return checked
      const messageId = `outbound_message-${deps.ids.newToken().slice(0, 16)}`
      const at = deps.clock.now()
      const handle = companyData.forCompany(member.companyId)
      // The content (its hash goes into the record), the record and the rows: all or nothing.
      const mail: OutboundMailRow = { messageId, authorId: member.userId, fromEmail: from, minutesId: ctx.minutesId, dealId: ctx.dealId, createdAt: at, finishedAt: null, bodyDeletedAt: null }
      const made = tryWrite(() => {
        const fixed = deps.payloads.fix(member.companyId, KIND, messageId, checked.canonical)
        if (!fixed || fixed.version !== 1) throw new WriteFailed({ ok: false, reason: 'exists' })
        const hash = fixed.hash
        const r = writer.create(member.companyId, {
        type: 'outbound_message', id: messageId, title: titleOf(checked.subject),
        folder: ctx.deal?.folder ?? ctx.minutes?.folder ?? null,
        fields: { requested_by: member.userId, assignee: member.userId, subject: checked.subject, payload_hash: hash, payload_version: 1, channel: 'email' },
        links: { ...(ctx.dealId ? { about: [ctx.dealId] } : {}), ...(ctx.minutesId ? { minutes: [ctx.minutesId] } : {}) },
        actor: { id: member.userId, ...actor, source: actor.source ?? null },
        })
        if (!r.ok) throw new WriteFailed(r)
        handle.outbound.insertMail(mail)
        handle.outbound.insertVersion({ messageId, version: 1, to: resolved.to, cc: resolved.cc, actorKind: actor.kind, createdAt: at })
        return r
      })
      if (!made.ok) return writeFailed(made)
      return draftAnswer(member, mail)
    },

    /** GET /outbound/:id — the author's draft. */
    get(member: Member, messageId: unknown): Outcome<{ draft: OutboundMailView }> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      return d ? draftAnswer(member, d.mail) : notFound()
    },

    /** A new version (person or their AI): PUT /outbound/:id { expectedVersion, toRefs?, ccRefs?, subject?, body? }. */
    async update(member: Member, actor: ActorInput, messageId: unknown, rawBody: unknown): Promise<Outcome<{ draft: OutboundMailView }>> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      if (!d) return notFound()
      const body = isObj(rawBody) ? rawBody : {}
      if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) return bad('expectedVersion: the version you read')
      const toRefs = body.toRefs === undefined ? null : refList(body.toRefs, MAIL_LIMITS.to, 'toRefs')
      if (toRefs !== null && !Array.isArray(toRefs)) return toRefs
      const ccRefs = body.ccRefs === undefined ? null : refList(body.ccRefs, MAIL_LIMITS.cc, 'ccRefs')
      if (ccRefs !== null && !Array.isArray(ccRefs)) return ccRefs
      if (d.state !== 'draft') return refuse('conflict', 'この下書きはもう直せません。', { code: 'NOT_DRAFT', state: d.state })
      const handle = companyData.forCompany(member.companyId)
      if (handle.outbound.lastSend(d.mail.messageId)?.outcome === 'sending') return refuse('conflict', 'このメールはいま送っている途中です。', { code: 'SEND_IN_PROGRESS' })
      const version = typeof d.fields.payload_version === 'number' ? d.fields.payload_version : 0
      if (body.expectedVersion !== version) return refuse('conflict', 'ほかの変更が先にありました。もう一度読み込んでください。', { code: 'VERSION_CONFLICT', version })
      const current = handle.outbound.version(d.mail.messageId, version)
      const payload = deps.payloads.current(member.companyId, KIND, d.mail.messageId)
      if (!current || !payload || payload.canonical === null || payload.version !== version) return notFound()
      let old: { subject: string; body: string }
      try { old = JSON.parse(payload.canonical) as typeof old } catch { return notFound() }
      const resolved = await resolveRefs(member, { to: toRefs ?? current.to.map(r => r.ref), cc: ccRefs ?? current.cc.map(r => r.ref) },
        [...current.to, ...current.cc, ...handle.outbound.typedRecipients(d.mail.messageId)],
        { minutesId: d.mail.minutesId, dealId: d.mail.dealId, messageId: d.mail.messageId, from: d.mail.fromEmail })
      if ('ok' in resolved) return resolved
      const checked = contentCheck(d.mail.fromEmail, resolved.to, resolved.cc, body.subject ?? old.subject, body.body ?? old.body)
      if ('ok' in checked) return checked
      const next = version + 1
      const at = deps.clock.now()
      const moved = tryWrite(() => {
        const fixed = deps.payloads.fix(member.companyId, KIND, d.mail.messageId, checked.canonical)
        if (!fixed || fixed.version !== next) throw new WriteFailed({ ok: false, reason: 'stale' })
        const r = writer.transition(member.companyId, {
          recordId: d.mail.messageId, action: 'edit', expectedVersion: d.recordVersion, to: null,
          fields: { subject: checked.subject, payload_hash: fixed.hash, payload_version: next }, actor: { id: member.userId, ...actor, source: actor.source ?? null },
        })
        if (!r.ok) throw new WriteFailed(r)
        handle.outbound.insertVersion({ messageId: d.mail.messageId, version: next, to: resolved.to, cc: resolved.cc, actorKind: actor.kind, createdAt: at })
        return r
      })
      if (!moved.ok) return writeFailed(moved)
      return draftAnswer(member, d.mail)
    },

    /** A person types an address (「あなたが入力」): POST /outbound/:id/recipients { email, name? }. Session only. */
    addTyped(member: Member, messageId: unknown, rawBody: unknown): Outcome<{ recipient: MailRecipientView; draft: OutboundMailView }> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      if (!d) return notFound()
      const body = isObj(rawBody) ? rawBody : {}
      const email = normalizeEmail(body.email)
      if (!email) return bad('メールアドレスの形が正しくありません。', 'BAD_ADDRESS')
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.normalize('NFC').trim().slice(0, 100) : null
      if (name !== null && /[\r\n<>"]/.test(name)) return bad('名前に使えない文字が入っています。', 'BAD_ADDRESS')
      if (d.state !== 'draft') return refuse('conflict', 'この下書きはもう直せません。', { code: 'NOT_DRAFT', state: d.state })
      const handle = companyData.forCompany(member.companyId)
      if (handle.outbound.typedRecipients(d.mail.messageId).length >= 50) return bad('入力できる宛先は 50 件までです。', 'TOO_MANY')
      const row: OutboundRecipientRow = { ref: refOf(`typed|${d.mail.messageId}`, 'typed', email), email, name, source: 'typed' }
      handle.outbound.addTypedRecipient(d.mail.messageId, row, member.userId, deps.clock.now())
      const view = viewOf(member.companyId, d.mail, d.mail.messageId)
      if (!view) return notFound()
      const sent = new Set(handle.outbound.sentDomains())
      return ok({ recipient: { ...row, firstTime: isExternalAddress(email, internalDomains(member.companyId, d.mail.fromEmail)) && !sent.has(emailDomain(email)) }, draft: view })
    },

    /** 「確かめて送る」: POST /outbound/:id/send { hash }. A person's session only (no AI route exists). */
    send: sendStep,

    /** After an unknown send: POST /outbound/:id/resolve { sent }. sent → `sent`; not sent → back to `draft` (sending again needs 確かめて送る again). */
    resolve(member: Member, messageId: unknown, rawBody: unknown): Outcome<{ draft: OutboundMailView }> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      if (!d) return notFound()
      const body = isObj(rawBody) ? rawBody : {}
      if (typeof body.sent !== 'boolean') return bad('sent: true (it is in Gmail\'s sent mail) or false')
      if (d.state !== 'unknown') return refuse('conflict', 'この下書きは、結果を確かめる状態ではありません。', { code: 'NOT_UNKNOWN', state: d.state })
      const handle = companyData.forCompany(member.companyId)
      const last = handle.outbound.lastSend(d.mail.messageId)
      const at = deps.clock.now()
      const actor = { id: member.userId, kind: 'human' as const, source: null }
      if (body.sent) {
        if (last?.outcome === 'unknown') handle.outbound.resolveSend(last.id, 'sent', at)
        let to: string[] = []
        const v = last ? handle.outbound.version(d.mail.messageId, last.version) : null
        if (v) to = [...v.to, ...v.cc].map(r => r.email)
        const r = finishSent(member, d.mail, d.recordVersion, at, null, to, actor)
        return r.ok ? ok({ draft: r.value.draft }) : r
      }
      const moved = writer.transition(member.companyId, { recordId: d.mail.messageId, action: 'not_sent', expectedVersion: d.recordVersion, to: 'draft', actor })
      if (!moved.ok) return writeFailed(moved)
      if (last?.outcome === 'unknown') handle.outbound.resolveSend(last.id, 'not-sent', at)
      return draftAnswer(member, d.mail)
    },

    /** 「捨てる」: POST /outbound/:id/discard. A person only. */
    discard(member: Member, messageId: unknown): Outcome<{ draft: OutboundMailView }> {
      const off = enabled(member.companyId)
      if (off) return off
      const d = ownDraft(member, messageId)
      if (!d) return notFound()
      if (d.state !== 'draft' && d.state !== 'unknown') return refuse('conflict', 'この下書きは捨てられません。', { code: 'NOT_DRAFT', state: d.state })
      const handle = companyData.forCompany(member.companyId)
      if (handle.outbound.lastSend(d.mail.messageId)?.outcome === 'sending') return refuse('conflict', 'このメールはいま送っている途中です。', { code: 'SEND_IN_PROGRESS' })
      const moved = writer.transition(member.companyId, { recordId: d.mail.messageId, action: 'discard', expectedVersion: d.recordVersion, to: 'discarded', actor: { id: member.userId, kind: 'human', source: null } })
      if (!moved.ok) return writeFailed(moved)
      handle.outbound.setFinished(d.mail.messageId, deps.clock.now())
      return draftAnswer(member, d.mail)
    },

    /**
     * Retention (§9 q9): the body of every mail sent or discarded more than
     * 30 days ago is deleted, company by company through each one's handle.
     * The hash, recipients, subject and Gmail id stay.
     */
    cleanupBodies(): { deleted: number } {
      const cutoff = new Date(deps.clock.nowMs() - MAIL_BODY_RETENTION_DAYS * DAY_MS).toISOString()
      const at = deps.clock.now()
      let deleted = 0
      for (const companyId of deps.companyIds()) {
        const outbound = companyData.forCompany(companyId).outbound
        for (;;) {
          const due = outbound.finishedBefore(cutoff, CLEANUP_CHUNK)
          for (const m of due) {
            deps.transactions.run(() => {
              deps.payloads.clearBodies(companyId, KIND, [m.messageId])
              outbound.markBodyDeleted(m.messageId, at)
            })
            deleted++
          }
          if (due.length < CLEANUP_CHUNK) break
        }
      }
      return { deleted }
    },
  }
}

export type OutboundMailService = ReturnType<typeof createOutboundMailService>
