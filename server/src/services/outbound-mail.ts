/**
 * Outbound mail (「お礼メール」, milestone 4 G8, `.claude/rules/outbound-mail.md`;
 * design 節目4 §1-6, §3-5, §3-7, §4-2 … §4-5, §9 q8 / q9).
 *
 * - **Verified recipients only.** A draft names its recipients by an opaque
 *   `ref`; a ref resolves only to an address found, fresh, in one of the
 *   draft's sources: the meeting's calendar attendees outside the company's
 *   domain (`meetingAttendees`), the outside system's contacts of the まとまり
 *   (a 案件's HubSpot contacts: a declared read through the plugin connector,
 *   for members in its read scope who may read it), ACB members (CC), and
 *   addresses a person typed on the
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
  awaitReplyDefault, awaitReplyUntilProblem, awaitReplyWaitUntil,
  chatReplyCanonical, chatReplyProblems, countLinks, emailDomain, isExternalAddress, mailContentCanonical, mailContentProblems, MAIL_LIMITS,
  MESSAGE_ID_RE, normalizeEmail, REPLY_REFERENCES_MAX, type MailReplyHeaders, type RecipientSource,
} from '../../shared/core/mail'
import { MEETING_TYPE } from '../../shared/core/minutes'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { MailRecipientsView, MailRecipientView, MailSendAnswer, OutboundMailState, OutboundMailView } from '../../shared/types/outbound-mail'
import type { Clock, IdGenerator } from '../ports/clock'
import type { ChatSender, ChatSendResult } from '../ports/chat'
import type { MailReader, MailSendResult, MailSender, MailThread } from '../ports/mail'
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
import { placeOfRow, type ActorInput, type ServicePlace, type ServiceRecordWriter, type ServiceWriteFailed } from './record-engine'
import { currentTypes } from './record-index'
import { RECORDS_DISABLED } from './records'
import { findMeetingOutput } from './meeting-outputs'
import { MEETING_OUTPUT_REUSED_NOTE } from '../../shared/core/meeting-outputs'
import { fieldsOf, mailThreadIdOf, threadPointerOf, type ThreadPointer } from './threads'

/** How long a sent / discarded mail's body stays on the server (§9 q9). */
export const MAIL_BODY_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const CLEANUP_CHUNK = 500

export const MAIL_NOT_FOUND = { error: 'メールの下書きが見つかりません', code: 'MAIL_NOT_FOUND' }
export const MAIL_UNKNOWN_TEXT = '届いたか分かりません。Gmail の送信済みを確かめてください。'
const MAIL_UNAVAILABLE = 'いまは Google でメールを送れません（止められているか、つながりません）。何も送っていません。'
const MAIL_TURNED_OFF = '「メールを送る」をオフにしています。アプリの「設定」→「Google」でオンにしてから、もう一度押してください。何も送っていません。'
const UNVERIFIABLE = 'いまは宛先の出どころ（カレンダー・HubSpot）を読めず、宛先を確かめられないため送れません。少し待ってから、もう一度「確かめて送る」を押してください。'

export type { MailSendResult }

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
  meetingAttendees: (companyId: string, userId: string, meetingId: string) => Promise<Array<{ email: string; name: string | null; organizer: boolean }> | null>
  /** The まとまり's contacts in its outside system, read now through the plugin connector (plugin-import.ts `recordContacts`). */
  bundleContacts: (member: Member, bundleId: string) => Promise<{ ok: true; contacts: Array<{ email: string | null; name: string | null }> } | { ok: false; reason: string }>
  /** The core role メールを送る (connector-roles.md): the member's own permission at the company's mail connector; never retried. */
  mail: MailSender
  /** メールを読む (the role): a reply's thread — its recipients (source `thread`) and its In-Reply-To / References. */
  mailReader?: Pick<MailReader, 'getThread' | 'getMessage'>
  /** チャットに返す (the role): a Slack reply, the member's own permission; never retried. */
  chat?: ChatSender
  /** Every company (the retention run opens each one's handle). */
  companyIds: () => string[]
  /** The company's own holidays (`YYYY-MM-DD`): 「返事を待つ」's default day counts business days. */
  holidaysOf?: (companyId: string) => string[]
}

/** A new mail sent with 「返事を待つ」 ticked: the inbox starts waiting for their answer (outbound-mail.md "Waiting for their answer"). */
export interface SentAwaitingReply {
  companyId: string
  userId: string
  /** The interaction recorded for the sent mail. */
  interactionId: string
  /** Our Message-ID (what their reply references). */
  messageId: string
  sourceRef: string
  occurredAt: string
  /** `wait_until`: the picked day's morning. */
  waitUntil: string
  title: string
  waitingOn: string
  to: string | null
  taskId: string | null
}

/** A reply that left (a person's confirmed send, or 「送られていた」): the inbox hears it as the company's own message in the thread. */
export interface ReplySent {
  companyId: string
  userId: string
  interactionId: string
  channel: 'email' | 'chat'
  /** This message's id in the inbox's terms (mail: its Message-ID; chat: `<channel>:<ts>`). */
  messageId: string
  sourceRef: string
  /** The 連絡's own message id (the inbox finds its interaction by it). */
  references: string[]
  occurredAt: string
  from: string
}

const CHAT_REPLY_TITLE = 'Slack の返事'
const CHAT_UNKNOWN_TEXT = '届いたか分かりません。Slack のスレッドを確かめてください。'
const SLACK_CONSENT = '返事を Slack に送るには、Slack で「返事を送る許可」が要ります（設定 → Slack）。何も送っていません。'
const SLACK_TURNED_OFF = '「返事を送る」をオフにしています。アプリの「設定」→「Slack」でオンにしてから、もう一度押してください。何も送っていません。'
const SLACK_UNAVAILABLE = 'いまは Slack に返事を送れません（止められているか、つながりません）。何も送っていません。'

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
  // A reply's 連絡 is part of its context (a draft without one keeps the scope — and the refs — it always had).
  const contextScope = (userId: string, meetingId: string | null, bundleId: string | null, interactionId: string | null = null) =>
    `${userId}|${meetingId ?? ''}|${bundleId ?? ''}${interactionId ? `|${interactionId}` : ''}`
  const replyListeners: Array<(r: ReplySent) => void> = []
  const awaitListeners: Array<(a: SentAwaitingReply) => void> = []

  /** The やること a draft was made for: its own `task` link, else a task that links it as what its AI prepared. */
  function taskOf(companyId: string, messageId: string): string | null {
    const records = companyData.forCompany(companyId).records
    const own = records.linksFrom([messageId]).find(l => l.name === 'task' && l.targetId)?.targetId
    if (own) return own
    const preparedBy = records.linksTo([messageId]).filter(l => l.name === 'prepared').map(l => l.sourceId)
    return records.byIds(preparedBy).find(r => r.type === 'task' && r.removedAt === null)?.id ?? null
  }

  /** 「返事を待つ」 is offered for a new mail (not a reply in a thread, not Slack). */
  const offersAwait = (companyId: string, messageId: string, fields: Record<string, LedgerValue>) =>
    fields.channel !== 'slack' && interactionOf(companyId, messageId) === null

  /** The 連絡 a draft answers (its `interaction` link), or null. */
  const interactionOf = (companyId: string, messageId: string): string | null =>
    companyData.forCompany(companyId).records.linksFrom([messageId]).find(l => l.name === 'interaction')?.targetId ?? null

  /** The 連絡's thread pointer and its own message id. */
  function pointerOf(companyId: string, interactionId: string): { pointer: ThreadPointer | null; messageId: string | null } {
    const { fields } = fieldsOf(companyData.forCompany(companyId), interactionId)
    return { pointer: threadPointerOf(fields), messageId: typeof fields.message_id === 'string' ? fields.message_id : null }
  }

  /** The reply's mail thread in the member's own mailbox, read now (null: cannot be read). */
  async function mailThreadOf(member: Member, interactionId: string): Promise<MailThread | null> {
    const reader = deps.mailReader
    const { pointer } = pointerOf(member.companyId, interactionId)
    if (!reader || pointer?.kind !== 'mail') return null
    try {
      const id = await mailThreadIdOf(reader, member, pointer)
      if (!id.ok) return null
      const t = await reader.getThread(member.companyId, member.userId, id.threadId)
      return t.ok ? t.value : null
    } catch (err) {
      logError('outbound-mail', 'thread could not be read', err)
      return null
    }
  }

  /** In-Reply-To / References of a reply: the thread's newest message and its ids (well-formed ones only). */
  function replyHeadersOf(thread: MailThread): MailReplyHeaders | null {
    const ids = thread.messages.map(m => m.messageIdHeader).filter((m): m is string => m !== null && MESSAGE_ID_RE.test(m))
    if (ids.length === 0) return null
    return { threadId: thread.id, inReplyTo: ids[ids.length - 1], references: ids.slice(-REPLY_REFERENCES_MAX) }
  }

  function enabled(companyId: string): Refusal | null {
    return companyData.forCompany(companyId).records.settings().enabled
      ? null : refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
  }

  /**
   * A record the member may read, of `kind`: a meeting (type `meeting`) or a まとまり
   * (any type implementing `bundle`), or null.
   */
  function readable(member: Member, id: unknown, kind: 'meeting' | 'bundle' | 'interaction' | 'task'): RecordRow | null {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null
    const handle = companyData.forCompany(member.companyId)
    const row = handle.records.byIds([id])[0]
    if (!row || row.removedAt !== null) return null
    const fits = kind === 'meeting'
      ? row.type === MEETING_TYPE
      : kind === 'interaction' || kind === 'task'
        ? row.type === kind
        : currentTypes(handle.records).get(row.type)?.definition.implements.includes('bundle') === true
    if (!fits) return null
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
    member: Member, ctx: Ctx,
    need: ReadonlySet<RecipientSource> | null = null,
  ): Promise<{ recipients: OutboundRecipientRow[]; unreadable: RecipientSource[]; thread: MailThread | null }> {
    const scope = contextScope(member.userId, ctx.meetingId, ctx.bundleId, ctx.interactionId)
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
    if (ctx.meetingId && wants('calendar')) {
      let attendees: Awaited<ReturnType<OutboundMailDeps['meetingAttendees']>> = null
      try { attendees = await deps.meetingAttendees(member.companyId, member.userId, ctx.meetingId) } catch (err) { logError('outbound-mail', 'calendar attendees could not be read', err) }
      if (attendees === null) unreadable.push('calendar')
      else {
        const internal = internalDomains(member.companyId, ctx.from)
        for (const a of attendees) if (normalizeEmail(a.email) && isExternalAddress(normalizeEmail(a.email)!, internal)) add('calendar', a.email, a.name)
      }
    }
    if (ctx.bundleId && wants('hubspot')) {
      let r: Awaited<ReturnType<OutboundMailDeps['bundleContacts']>>
      try { r = await deps.bundleContacts(member, ctx.bundleId) } catch (err) { logError('outbound-mail', 'contacts could not be read', err); r = { ok: false, reason: 'error' } }
      if (!r.ok) unreadable.push('hubspot')
      else for (const c of r.contacts) add('hubspot', c.email, c.name)
    }
    if (wants('member')) {
      for (const m of deps.members(member.companyId)) if (m.userId !== member.userId) add('member', m.email, m.name)
    }
    if (ctx.messageId && wants('typed')) {
      for (const t of companyData.forCompany(member.companyId).outbound.typedRecipients(ctx.messageId)) add('typed', t.email, t.name, `typed|${ctx.messageId}`)
    }
    // A reply: everyone on the thread in the member's own mailbox, read now (the member left out).
    let thread: MailThread | null = null
    if (ctx.interactionId && wants('thread')) {
      thread = await mailThreadOf(member, ctx.interactionId)
      if (thread === null) unreadable.push('thread')
      else {
        for (const m of thread.messages) {
          for (const a of [...(m.from ? [m.from] : []), ...m.to, ...m.cc]) if (normalizeEmail(a.email) !== ctx.from) add('thread', a.email, a.name || null)
        }
      }
    }
    return { recipients: out, unreadable, thread }
  }

  interface Ctx { meetingId: string | null; bundleId: string | null; interactionId: string | null; messageId: string | null; from: string }
  const draftCtx = (companyId: string, mail: OutboundMailRow): Ctx => ({
    meetingId: mail.meetingId, bundleId: mail.bundleId, interactionId: interactionOf(companyId, mail.messageId), messageId: mail.messageId, from: mail.fromEmail,
  })

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
      channel: fields.channel === 'slack' ? 'slack' : 'email',
      interactionId: interactionOf(companyId, mail.messageId),
      from: mail.fromEmail,
      to: v.to.map(shown),
      cc: v.cc.map(shown),
      subject,
      body,
      bodyDeleted: body === null,
      linkCount: body === null ? 0 : countLinks(body),
      meetingId: mail.meetingId,
      bundleId: mail.bundleId,
      sentAt: typeof fields.sent_at === 'string' ? fields.sent_at : null,
      providerMessageId: typeof fields.provider_message_id === 'string' ? fields.provider_message_id : null,
      lastChangedBy: v.actorKind,
      updatedAt: s.updatedAt,
      ...(offersAwait(companyId, mail.messageId, fields) ? {
        awaitReply: {
          expected: fields.expects_reply === true,
          defaultUntil: awaitReplyDefault(new Date(deps.clock.nowMs()), deps.holidaysOf?.(companyId) ?? []),
          chosenUntil: typeof fields.reply_wait_until === 'string' ? fields.reply_wait_until : null,
        },
      } : {}),
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

  /**
   * The draft context from a request: a meeting, a まとまり and/or the 来た連絡 it answers, each one the
   * member may read (a meeting's or 連絡's まとまり is taken along; an owner-only 連絡 is its owner's only).
   */
  function contextOf(member: Member, body: Record<string, unknown>): { meetingId: string | null; bundleId: string | null; interactionId: string | null; taskId: string | null; meeting: RecordRow | null; bundle: RecordRow | null; interaction: RecordRow | null; task: RecordRow | null } | Refusal {
    const given = (v: unknown) => v !== undefined && v !== null
    const meeting = given(body.meetingId) ? readable(member, body.meetingId, 'meeting') : null
    if (given(body.meetingId) && !meeting) return refuse('not-found', '会議が見つかりません', { code: 'RECORD_NOT_FOUND' })
    const interaction = given(body.interactionId) ? readable(member, body.interactionId, 'interaction') : null
    if (given(body.interactionId) && !interaction) return refuse('not-found', '返事をする連絡が見つかりません', { code: 'RECORD_NOT_FOUND' })
    // The やること the mail is for (the consultation's task): its まとまり is taken along; a reply waits there too.
    const task = given(body.taskId) ? readable(member, body.taskId, 'task') : null
    if (given(body.taskId) && !task) return refuse('not-found', 'やることが見つかりません', { code: 'RECORD_NOT_FOUND' })
    let bundle = given(body.bundleId) ? readable(member, body.bundleId, 'bundle') : null
    if (given(body.bundleId) && !bundle) return refuse('not-found', 'まとまり（案件など）が見つかりません', { code: 'RECORD_NOT_FOUND' })
    for (const from of [meeting, interaction, task]) {
      if (bundle || !from) continue
      const linked = companyData.forCompany(member.companyId).records.linksFrom([from.id]).find(l => l.name === 'bundle')
      bundle = linked?.targetId ? readable(member, linked.targetId, 'bundle') : null
    }
    if (!meeting && !bundle && !interaction && !task) return bad('meetingId, bundleId, interactionId or taskId: the meeting, まとまり, 連絡 or やること the mail is about', 'MAIL_CONTEXT_REQUIRED')
    return { meetingId: meeting?.id ?? null, bundleId: bundle?.id ?? null, interactionId: interaction?.id ?? null, taskId: task?.id ?? null, meeting, bundle, interaction, task }
  }

  /** The drafting AI's mark 「返事が来るはず」 (absent = no; an older app never sends it). */
  function expectsReplyOf(body: Record<string, unknown>): boolean | Refusal | undefined {
    if (body.expectsReply === undefined) return undefined
    return typeof body.expectsReply === 'boolean' ? body.expectsReply : bad('expectsReply: true when the mail asks something the other side should answer')
  }

  /** Resolve refs: from `known` first (kept from the current version), else from fresh sources (read once, lazily). */
  async function resolveRefs(
    member: Member, refs: { to: string[]; cc: string[] }, known: OutboundRecipientRow[],
    ctx: Ctx,
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

  function contentCheck(from: string, to: OutboundRecipientRow[], cc: OutboundRecipientRow[], subject: unknown, body: unknown, reply?: MailReplyHeaders): { canonical: string; subject: string } | Refusal {
    if (typeof subject !== 'string' || typeof body !== 'string') return bad('subject and body: text', 'MAIL_INVALID')
    const content = { from, to: to.map(r => r.email), cc: cc.map(r => r.email), subject, body, ...(reply ? { reply } : {}) }
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
    // 「返事を待つ」 (a new mail only): the day the member picked, checked before anything leaves.
    let waitDay: string | null = null
    if (body.awaitReply !== undefined && body.awaitReply !== null && body.awaitReply !== false) {
      if (!offersAwait(member.companyId, d.mail.messageId, d.fields)) return bad('返事を待つのは、新しく送るメールだけです（返事は元の連絡の「返事のお願い」が待ちます）。', 'AWAIT_REPLY_NOT_OFFERED')
      const until = isObj(body.awaitReply) ? body.awaitReply.until : undefined
      const problem = awaitReplyUntilProblem(until, new Date(deps.clock.nowMs()))
      if (problem) return bad(problem, 'AWAIT_REPLY_DATE')
      waitDay = until as string
    }
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
    if (d.fields.channel === 'slack') return chatSendStep(member, d, version, body.hash, payload.canonical)
    let content: { from: string; to: string[]; cc: string[]; subject: string; body: string; reply?: MailReplyHeaders }
    try { content = JSON.parse(payload.canonical) as typeof content } catch { return notFound() }
    // 2. The member's permission to send mail (the role メールを送る), from the account the draft names.
    const sender = await deps.mail.senderAccount(member.companyId, member.userId)
    if (!sender.ok && sender.reason === 'consent-needed') {
      return refuse('conflict', 'メールを送るには、Google で「メールを送る許可」が要ります。', { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'mail' })
    }
    if (!sender.ok && sender.reason === 'turned-off') return refuse('conflict', MAIL_TURNED_OFF, { code: 'GOOGLE_FEATURE_OFF', feature: 'mail' })
    if (!sender.ok) return refuse('unavailable', MAIL_UNAVAILABLE, { code: 'GOOGLE_UNAVAILABLE', reason: 'no-connector' })
    const fromAccount = normalizeEmail(sender.account)
    if (fromAccount === null || fromAccount !== normalizeEmail(content.from)) {
      return refuse('conflict', '差出人の Google アカウントが下書きと違います。下書きを作り直してください。', { code: 'FROM_CHANGED' })
    }
    // 3. Every recipient is still at its source right now.
    const all = [...v.to, ...v.cc]
    const need = new Set(all.map(r => r.source))
    const fresh = await collect(member, draftCtx(member.companyId, d.mail), need)
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
    // 5. Gmail, once (a reply: into the member's own conversation, with the thread's ids).
    let result: MailSendResult
    try {
      const raw = gmailRaw(buildMailMessage({
        from: content.from, to: content.to, cc: content.cc, subject: content.subject, body: content.body, date: new Date(deps.clock.nowMs()),
        messageId: ourMessageId(sendId, content.from),
        ...(content.reply ? { inReplyTo: content.reply.inReplyTo, references: content.reply.references } : {}),
      }))
      result = await deps.mail.send(member.companyId, member.userId, raw, content.reply ? { threadId: content.reply.threadId } : undefined)
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
      const threadId = isObj(result.json) && typeof result.json.threadId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.json.threadId) ? result.json.threadId : null
      return finishSent(member, d.mail, d.recordVersion, at, gmailId, content.to.concat(content.cc), actor, sendId, { threadId, waitDay })
    }
    if (result.kind === 'not-sent' || result.kind === 'refused' || result.kind === 'rate-limited') {
      handle.outbound.finishSend(sendId, result.kind === 'not-sent' ? 'not-sent' : 'refused', result.googleReason ?? result.reason, null, at)
      if (result.kind === 'not-sent' && ['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted'].includes(result.reason)) {
        return refuse('conflict', 'メールを送るには、Google で「メールを送る許可」が要ります。', { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'mail' })
      }
      if (result.kind === 'not-sent' && result.reason === 'feature-off') return refuse('conflict', MAIL_TURNED_OFF, { code: 'GOOGLE_FEATURE_OFF', feature: 'mail' })
      if (result.kind === 'not-sent') return refuse('unavailable', MAIL_UNAVAILABLE, { code: 'GOOGLE_UNAVAILABLE', reason: result.reason })
      return refuse('conflict', 'Gmail が受け付けませんでした。何も送っていません。', { code: 'SEND_REFUSED', ...(result.googleReason ? { googleReason: result.googleReason } : {}) })
    }
    // A lost answer or a 5xx: it may have been sent. Never re-sent; the person checks Gmail.
    handle.outbound.finishSend(sendId, 'unknown', result.googleReason ?? result.reason, null, at)
    // The choice is kept: 「送られていた」 later starts the waiting as a confirmed send would.
    const moved = writer.transition(member.companyId, {
      recordId: d.mail.messageId, action: 'send_unknown', expectedVersion: d.recordVersion, to: 'unknown', actor, ...(waitDay ? { fields: { reply_wait_until: waitDay } } : {}),
    })
    if (!moved.ok) logError('outbound-mail', 'unknown state not recorded', undefined, { message: d.mail.messageId, reason: moved.reason })
    const view = viewOf(member.companyId, d.mail, d.mail.messageId)
    return view ? ok({ outcome: 'unknown', draft: view, message: MAIL_UNKNOWN_TEXT }) : notFound()
  }

  /** The record → sent, the retention clock, and the 「やりとり」 on its まとまり (design §1-6 step 19). */
  function finishSent(
    member: Member, mail: OutboundMailRow, recordVersion: number, at: string, gmailId: string | null, recipients: string[], actor: { id: string; kind: 'human'; source: null }, sendId: string | null,
    awaiting: { threadId: string | null; waitDay: string | null },
  ): Outcome<MailSendAnswer> {
    const handle = companyData.forCompany(member.companyId)
    const moved = writer.transition(member.companyId, {
      recordId: mail.messageId, action: 'send', expectedVersion: recordVersion, to: 'sent', actor,
      fields: { sent_at: at, ...(gmailId ? { provider_message_id: gmailId } : {}), ...(awaiting.waitDay ? { reply_wait_until: awaiting.waitDay } : {}) },
    })
    if (!moved.ok) logError('outbound-mail', 'sent state not recorded', undefined, { message: mail.messageId, reason: moved.reason })
    handle.outbound.setFinished(mail.messageId, at)
    const interactionId = interactionOf(member.companyId, mail.messageId)
    const ownId = sendId ? ourMessageId(sendId, mail.fromEmail) : null
    // A reply belongs to its 連絡's thread (one interaction per thread, inbox.md): the inbox hears it; no new receipt.
    if (interactionId) tellReplySent(member, interactionId, 'email', ownId, gmailId ? `gmail:${gmailId}` : null, at, mail.fromEmail)
    else {
      const waiting = awaiting.waitDay && ownId ? { messageId: ownId, threadId: awaiting.threadId } : null
      const receipt = recordInteraction(member, mail, at, gmailId, recipients, waiting)
      if (receipt && ownId && awaiting.waitDay) tellAwaiting(member, mail, receipt, ownId, gmailId, at, awaiting.waitDay)
    }
    const view = viewOf(member.companyId, mail, mail.messageId)
    return view ? ok({ outcome: 'sent', draft: view }) : notFound()
  }

  /** The Message-ID ACB gives a mail it sends (known afterwards, for the inbox's thread). */
  const ourMessageId = (sendId: string, from: string) => `<acb.${sendId.replace(/[^A-Za-z0-9.-]/g, '')}@${emailDomain(from)}>`

  function tellReplySent(member: Member, interactionId: string, channel: 'email' | 'chat', messageId: string | null, sourceRef: string | null, at: string, from: string) {
    const own = pointerOf(member.companyId, interactionId).messageId
    if (!own || !messageId) return
    const reply: ReplySent = {
      companyId: member.companyId, userId: member.userId, interactionId, channel, messageId, sourceRef: sourceRef ?? `acb:${messageId}`, references: [own], occurredAt: at, from,
    }
    for (const listen of replyListeners) {
      try { listen(reply) } catch (err) { logError('outbound-mail', 'reply listener failed', err) }
    }
  }

  /** 「確かめて送る」 of a Slack reply: the member's permission to reply, the send row first, one post into the thread. */
  async function chatSendStep(member: Member, d: NonNullable<ReturnType<typeof ownDraft>>, version: number, hash: string, canonical: string): Promise<Outcome<MailSendAnswer>> {
    const handle = companyData.forCompany(member.companyId)
    let content: { from: string; thread: { channel: string; ts: string }; body: string }
    try { content = JSON.parse(canonical) as typeof content } catch { return notFound() }
    if (!deps.chat) return refuse('unavailable', SLACK_UNAVAILABLE, { code: 'SLACK_UNAVAILABLE', reason: 'no-connector' })
    const account = await deps.chat.replierAccount(member.companyId, member.userId)
    if (!account.ok && account.reason === 'consent-needed') return refuse('conflict', SLACK_CONSENT, { code: 'SLACK_CONSENT_NEEDED', needsSlackConsent: 'reply' })
    if (!account.ok && account.reason === 'turned-off') return refuse('conflict', SLACK_TURNED_OFF, { code: 'SLACK_FEATURE_OFF', feature: 'reply' })
    if (!account.ok) return refuse('unavailable', SLACK_UNAVAILABLE, { code: 'SLACK_UNAVAILABLE', reason: 'no-connector' })
    if (normalizeEmail(account.account) !== normalizeEmail(content.from)) {
      return refuse('conflict', 'Slack の許可が下書きを作ったときと違うアカウントのものです。下書きを作り直してください。', { code: 'FROM_CHANGED' })
    }
    const sendId = deps.ids.newId()
    if (!handle.outbound.startSend({ id: sendId, messageId: d.mail.messageId, version, hash, by: member.userId, startedAt: deps.clock.now(), outcome: 'sending', reason: null, providerMessageId: null, finishedAt: null })) {
      return refuse('conflict', 'この返事はいま送っている途中か、すでに送られています。', { code: 'SEND_IN_PROGRESS' })
    }
    const ref = { channelId: content.thread.channel, threadTs: content.thread.ts }
    let result: ChatSendResult
    try {
      result = await deps.chat.reply(member.companyId, member.userId, ref, content.body)
    } catch (err) {
      logError('outbound-mail', 'chat reply threw', err, { message: d.mail.messageId })
      result = { ok: false, kind: 'unknown', reason: 'error' }
    }
    const at = deps.clock.now()
    const actor = { id: member.userId, kind: 'human' as const, source: null }
    if (result.ok) {
      handle.outbound.finishSend(sendId, 'sent', null, result.ts, at)
      return finishChatSent(member, d.mail, d.recordVersion, at, result.ts, ref, actor)
    }
    if (result.kind === 'not-sent' || result.kind === 'refused' || result.kind === 'rate-limited') {
      handle.outbound.finishSend(sendId, result.kind === 'not-sent' ? 'not-sent' : 'refused', result.reason, null, at)
      if (result.kind === 'not-sent' && ['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted'].includes(result.reason)) {
        return refuse('conflict', SLACK_CONSENT, { code: 'SLACK_CONSENT_NEEDED', needsSlackConsent: 'reply' })
      }
      if (result.kind === 'not-sent' && result.reason === 'feature-off') return refuse('conflict', SLACK_TURNED_OFF, { code: 'SLACK_FEATURE_OFF', feature: 'reply' })
      if (result.kind === 'not-sent') return refuse('unavailable', SLACK_UNAVAILABLE, { code: 'SLACK_UNAVAILABLE', reason: result.reason })
      return refuse('conflict', 'Slack が受け付けませんでした。何も送っていません。', { code: 'SEND_REFUSED' })
    }
    // A lost answer or a 5xx: it may have been posted. Never re-sent; the person looks at the thread.
    handle.outbound.finishSend(sendId, 'unknown', result.reason, null, at)
    const moved = writer.transition(member.companyId, { recordId: d.mail.messageId, action: 'send_unknown', expectedVersion: d.recordVersion, to: 'unknown', actor })
    if (!moved.ok) logError('outbound-mail', 'unknown state not recorded', undefined, { message: d.mail.messageId, reason: moved.reason })
    const view = viewOf(member.companyId, d.mail, d.mail.messageId)
    return view ? ok({ outcome: 'unknown', draft: view, message: CHAT_UNKNOWN_TEXT }) : notFound()
  }

  function finishChatSent(member: Member, mail: OutboundMailRow, recordVersion: number, at: string, ts: string | null, ref: { channelId: string; threadTs: string }, actor: { id: string; kind: 'human'; source: null }): Outcome<MailSendAnswer> {
    const moved = writer.transition(member.companyId, {
      recordId: mail.messageId, action: 'send', expectedVersion: recordVersion, to: 'sent', actor,
      fields: { sent_at: at, ...(ts ? { provider_message_id: ts } : {}) },
    })
    if (!moved.ok) logError('outbound-mail', 'sent state not recorded', undefined, { message: mail.messageId, reason: moved.reason })
    companyData.forCompany(member.companyId).outbound.setFinished(mail.messageId, at)
    const interactionId = interactionOf(member.companyId, mail.messageId)
    if (interactionId && ts) tellReplySent(member, interactionId, 'chat', `${ref.channelId}:${ts}`, `slack:${ref.channelId}:${ts}`, at, mail.fromEmail)
    const view = viewOf(member.companyId, mail, mail.messageId)
    return view ? ok({ outcome: 'sent', draft: view }) : notFound()
  }

  /** The まとまり's 相手 (the first record it links to whose type implements `counterpart`), as a link of the interaction. */
  function counterpartLink(companyId: string, bundleId: string): { counterpart?: string[] } {
    const records = companyData.forCompany(companyId).records
    const types = currentTypes(records)
    const targets = records.linksFrom([bundleId]).map(l => l.targetId).filter((t): t is string => !!t)
    const found = records.byIds(targets).find(r => r.removedAt === null && types.get(r.type)?.definition.implements.includes('counterpart'))
    return found ? { counterpart: [found.id] } : {}
  }

  /** The subject a draft's record holds now. */
  function subjectOf(companyId: string, messageId: string): string {
    const s = companyData.forCompany(companyId).records.states([messageId])[0]
    try { return String((JSON.parse(s?.fields ?? '{}') as { subject?: unknown }).subject ?? '') } catch { return '' }
  }

  /**
   * The 「やりとり」 of a sent new mail. With `waiting` (「返事を待つ」 ticked) it also keeps our
   * Message-ID and the Gmail thread (their reply finds it), is placed like the mail itself and is
   * the sender's, already handled (nobody's turn; a reply after the waiting ended is judged again by
   * their AI, inbox.md). Without it: in the まとまり's folder — except that a mail whose own record is
   * owner-only or members-only keeps that place either way (records.md "Members-only records"):
   * the receipt says what was sent, so it is never wider than the mail.
   */
  function recordInteraction(member: Member, mail: OutboundMailRow, at: string, gmailId: string | null, recipients: string[], waiting: { messageId: string; threadId: string | null } | null = null): string | null {
    const handle = companyData.forCompany(member.companyId)
    const bundle = mail.bundleId ? handle.records.byIds([mail.bundleId])[0] : undefined
    const subject = subjectOf(member.companyId, mail.messageId)
    const domains = [...new Set(recipients.map(emailDomain))].join(', ').slice(0, 500)
    const own = handle.records.byIds([mail.messageId])[0]
    // Without its own record the mail's place is not known: no receipt rather than a guessed one.
    if (!own) { logError('outbound-mail', 'interaction not recorded', undefined, { message: mail.messageId, reason: 'no-record' }); return null }
    const place = waiting || restricted(own) ? placeOfRow(own) : { folder: bundle?.folder ?? null }
    const made = writer.create(member.companyId, {
      type: 'interaction', title: titleOf(subject), summary: subject.slice(0, 300), ...place,
      fields: {
        occurred_at: at, channel: 'email', counterpart_text: domains, source_ref: gmailId ? `gmail:${gmailId}` : null, needs_reply: false,
        ...(waiting ? { message_id: waiting.messageId, thread_ref: waiting.threadId ? `gmail:${waiting.threadId}` : null, assignee: member.userId } : {}),
      },
      links: bundle ? { bundle: [bundle.id], ...counterpartLink(member.companyId, bundle.id) } : {},
      actor: { id: member.userId, kind: 'human', source: null },
      ...(waiting ? { state: 'handled', quiet: true } : {}),
    })
    if (!made.ok) { logError('outbound-mail', 'interaction not recorded', undefined, { message: mail.messageId, reason: made.reason }); return null }
    return made.record.id
  }

  /** 「返事を待つ」: the inbox starts waiting for their answer in that thread (never throws). */
  function tellAwaiting(member: Member, mail: OutboundMailRow, interactionId: string, messageId: string, gmailId: string | null, at: string, waitDay: string) {
    const handle = companyData.forCompany(member.companyId)
    const payload = deps.payloads.current(member.companyId, KIND, mail.messageId)
    const v = payload ? handle.outbound.version(mail.messageId, payload.version) : null
    const first = v?.to[0] ?? null
    // 「〇〇さんからの返事」: a name when the source gave one, else the domain (no address on a shared record).
    const waitingOn = first ? (first.name ? `${first.name}さんからの返事` : `${emailDomain(first.email)} の方からの返事`) : '相手からの返事'
    const event: SentAwaitingReply = {
      companyId: member.companyId, userId: member.userId, interactionId, messageId, sourceRef: gmailId ? `gmail:${gmailId}` : `acb:${messageId}`,
      occurredAt: at, waitUntil: awaitReplyWaitUntil(waitDay), title: titleOf(subjectOf(member.companyId, mail.messageId)), waitingOn, to: first?.email ?? null,
      taskId: taskOf(member.companyId, mail.messageId),
    }
    for (const listen of awaitListeners) {
      try { listen(event) } catch (err) { logError('outbound-mail', 'await listener failed', err) }
    }
  }

  /**
   * Who may see the draft's record: an owner-only or members-only 連絡's / meeting's / やること's mail
   * stays theirs, whatever its まとまり (the mail carries their content; a まとまり's folder would widen
   * it); else the まとまり's / meeting's / 連絡's / やること's folder.
   */
  function placeOf(ctx: { meeting: RecordRow | null; bundle: RecordRow | null; interaction: RecordRow | null; task?: RecordRow | null }): ServicePlace {
    for (const r of [ctx.interaction, ctx.meeting, ctx.task]) if (r && restricted(r)) return placeOfRow(r)
    return { folder: ctx.bundle?.folder ?? ctx.meeting?.folder ?? ctx.interaction?.folder ?? ctx.task?.folder ?? null }
  }

  /** Owner-only or members-only: what is made from it keeps its place (records.md "Members-only records"). */
  function restricted(r: RecordRow): boolean {
    return r.personalOwner !== null || r.members !== null
  }

  const linksOf = (ctx: { meetingId: string | null; bundleId: string | null; interactionId: string | null; taskId?: string | null }) => ({
    ...(ctx.bundleId ? { bundle: [ctx.bundleId] } : {}),
    ...(ctx.meetingId ? { meeting: [ctx.meetingId] } : {}),
    ...(ctx.interactionId ? { interaction: [ctx.interactionId] } : {}),
    ...(ctx.taskId ? { task: [ctx.taskId] } : {}),
  })

  function chatCheck(from: string, ref: { channelId: string; threadTs: string }, body: unknown): { canonical: string } | Refusal {
    if (typeof body !== 'string') return bad('body: text', 'MAIL_INVALID')
    const problems = chatReplyProblems({ body })
    if (problems.length > 0) return bad(problems[0], 'MAIL_INVALID', { problems })
    return { canonical: chatReplyCanonical({ from, channelId: ref.channelId, threadTs: ref.threadTs, body }) }
  }

  /** A Slack reply's draft: no recipients, no subject; the thread fixed with it. */
  async function createChatReply(member: Member, actor: ActorInput, body: Record<string, unknown>, ctx: Exclude<ReturnType<typeof contextOf>, Refusal>, ref: Extract<ThreadPointer, { kind: 'chat' }>): Promise<Outcome<{ draft: OutboundMailView }>> {
    const given = (v: unknown) => Array.isArray(v) && v.length > 0
    if (given(body.toRefs) || given(body.ccRefs)) return bad('Slack への返事には宛先がありません（スレッドに返します）。', 'MAIL_INVALID')
    const from = fromOf(member)
    if (!from) return notFound()
    const checked = chatCheck(from, ref, body.body)
    if ('ok' in checked) return checked
    const messageId = `outbound_message-${deps.ids.newToken().slice(0, 16)}`
    const at = deps.clock.now()
    const handle = companyData.forCompany(member.companyId)
    const mail: OutboundMailRow = { messageId, authorId: member.userId, fromEmail: from, meetingId: ctx.meetingId, bundleId: ctx.bundleId, createdAt: at, finishedAt: null, bodyDeletedAt: null }
    const made = tryWrite(() => {
      const fixed = deps.payloads.fix(member.companyId, KIND, messageId, checked.canonical)
      if (!fixed || fixed.version !== 1) throw new WriteFailed({ ok: false, reason: 'exists' })
      const r = writer.create(member.companyId, {
        type: 'outbound_message', id: messageId, title: CHAT_REPLY_TITLE,
        ...placeOf(ctx),
        fields: { requested_by: member.userId, assignee: member.userId, subject: '', payload_hash: fixed.hash, payload_version: 1, channel: 'slack', slack_thread: `${ref.channelId}:${ref.threadTs}` },
        links: linksOf(ctx),
        actor: { id: member.userId, ...actor, source: actor.source ?? null },
      })
      if (!r.ok) throw new WriteFailed(r)
      handle.outbound.insertMail(mail)
      handle.outbound.insertVersion({ messageId, version: 1, to: [], cc: [], actorKind: actor.kind, createdAt: at })
      return r
    })
    if (!made.ok) return writeFailed(made)
    return draftAnswer(member, mail)
  }

  /** A new version of a draft: the content, the record's fields and the recipients, all or nothing. */
  function newVersion(member: Member, actor: ActorInput, d: NonNullable<ReturnType<typeof ownDraft>>, version: number, canonical: string, subject: string, to: OutboundRecipientRow[], cc: OutboundRecipientRow[], extra: Record<string, LedgerValue> = {}): Outcome<{ draft: OutboundMailView }> {
    const handle = companyData.forCompany(member.companyId)
    const next = version + 1
    const at = deps.clock.now()
    const moved = tryWrite(() => {
      const fixed = deps.payloads.fix(member.companyId, KIND, d.mail.messageId, canonical)
      if (!fixed || fixed.version !== next) throw new WriteFailed({ ok: false, reason: 'stale' })
      const r = writer.transition(member.companyId, {
        recordId: d.mail.messageId, action: 'edit', expectedVersion: d.recordVersion, to: null,
        fields: { subject, payload_hash: fixed.hash, payload_version: next, ...extra }, actor: { id: member.userId, ...actor, source: actor.source ?? null },
      })
      if (!r.ok) throw new WriteFailed(r)
      handle.outbound.insertVersion({ messageId: d.mail.messageId, version: next, to, cc, actorKind: actor.kind, createdAt: at })
      return r
    })
    if (!moved.ok) return writeFailed(moved)
    return draftAnswer(member, d.mail)
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
      const got = await collect(member, { meetingId: ctx.meetingId, bundleId: ctx.bundleId, interactionId: ctx.interactionId, messageId: null, from })
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
      const got = await collect(member, draftCtx(member.companyId, d.mail))
      const sent = new Set(companyData.forCompany(member.companyId).outbound.sentDomains())
      const internal = internalDomains(member.companyId, d.mail.fromEmail)
      return ok({
        recipients: got.recipients.map(r => ({ ...r, firstTime: isExternalAddress(r.email, internal) && !sent.has(emailDomain(r.email)) })),
        unreadable: got.unreadable,
      })
    },

    /** A new draft (person or their AI): POST /outbound. */
    async create(member: Member, actor: ActorInput, rawBody: unknown): Promise<Outcome<{ draft: OutboundMailView; reused?: true; note?: string }>> {
      const off = enabled(member.companyId)
      if (off) return off
      const body = isObj(rawBody) ? rawBody : {}
      const ctx = contextOf(member, body)
      if ('ok' in ctx) return ctx
      // A reply answers its 連絡 in the same thread: Slack → a reply in the thread; mail → a reply in the member's own conversation.
      const pointer = ctx.interactionId ? pointerOf(member.companyId, ctx.interactionId).pointer : null
      if (ctx.interactionId && !pointer) return refuse('conflict', 'この連絡には、返事をするスレッドがありません。', { code: 'THREAD_UNKNOWN' })
      if (pointer?.kind === 'chat') return createChatReply(member, actor, body, ctx, pointer)
      const expects = expectsReplyOf(body)
      if (expects !== undefined && typeof expects !== 'boolean') return expects
      const to = refList(body.toRefs, MAIL_LIMITS.to, 'toRefs')
      if (!Array.isArray(to)) return to
      const cc = refList(body.ccRefs, MAIL_LIMITS.cc, 'ccRefs')
      if (!Array.isArray(cc)) return cc
      const from = fromOf(member)
      if (!from) return notFound()
      const resolved = await resolveRefs(member, { to, cc }, [], { meetingId: ctx.meetingId, bundleId: ctx.bundleId, interactionId: ctx.interactionId, messageId: null, from })
      if ('ok' in resolved) return resolved
      let reply: MailReplyHeaders | undefined
      if (ctx.interactionId) {
        const thread = await mailThreadOf(member, ctx.interactionId)
        reply = thread ? replyHeadersOf(thread) ?? undefined : undefined
        if (!reply) return refuse('conflict', 'いまは返事をするメールのスレッドを読めません。少し待ってから、もう一度作ってください。', { code: 'THREAD_UNREADABLE' })
      }
      const checked = contentCheck(from, resolved.to, resolved.cc, body.subject, body.body, reply)
      if ('ok' in checked) return checked
      const handle = companyData.forCompany(member.companyId)
      // A meeting's mail made once (minutes.md "Outputs made once"): the member's own draft of this meeting with
      // the same subject, not discarded, is the answer. Checked here, in the stretch that writes, so two calls make one.
      if (ctx.meetingId && !ctx.interactionId) {
        const mine = (r: RecordRow) => handle.outbound.mail(r.id)?.authorId === member.userId && handle.records.states([r.id])[0]?.state !== 'discarded'
        const same = findMeetingOutput(handle.records, mine, { type: 'outbound_message', meetingId: ctx.meetingId, title: titleOf(checked.subject) })
        const sameMail = same ? handle.outbound.mail(same.id) : null
        if (sameMail) {
          const answer = draftAnswer(member, sameMail)
          return answer.ok ? ok({ ...answer.value, reused: true as const, note: MEETING_OUTPUT_REUSED_NOTE }) : answer
        }
      }
      const messageId = `outbound_message-${deps.ids.newToken().slice(0, 16)}`
      const at = deps.clock.now()
      // The content (its hash goes into the record), the record and the rows: all or nothing.
      const mail: OutboundMailRow = { messageId, authorId: member.userId, fromEmail: from, meetingId: ctx.meetingId, bundleId: ctx.bundleId, createdAt: at, finishedAt: null, bodyDeletedAt: null }
      const made = tryWrite(() => {
        const fixed = deps.payloads.fix(member.companyId, KIND, messageId, checked.canonical)
        if (!fixed || fixed.version !== 1) throw new WriteFailed({ ok: false, reason: 'exists' })
        const hash = fixed.hash
        const r = writer.create(member.companyId, {
        type: 'outbound_message', id: messageId, title: titleOf(checked.subject),
        ...placeOf(ctx),
        fields: {
          requested_by: member.userId, assignee: member.userId, subject: checked.subject, payload_hash: hash, payload_version: 1, channel: 'email',
          // The AI's mark only for a new mail (a reply's waiting is its 返事のお願い's).
          ...(expects === true && !ctx.interactionId ? { expects_reply: true } : {}),
        },
        links: linksOf(ctx),
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
      const expects = expectsReplyOf(body)
      if (expects !== undefined && typeof expects !== 'boolean') return expects
      if (d.state !== 'draft') return refuse('conflict', 'この下書きはもう直せません。', { code: 'NOT_DRAFT', state: d.state })
      const handle = companyData.forCompany(member.companyId)
      if (handle.outbound.lastSend(d.mail.messageId)?.outcome === 'sending') return refuse('conflict', 'このメールはいま送っている途中です。', { code: 'SEND_IN_PROGRESS' })
      const version = typeof d.fields.payload_version === 'number' ? d.fields.payload_version : 0
      if (body.expectedVersion !== version) return refuse('conflict', 'ほかの変更が先にありました。もう一度読み込んでください。', { code: 'VERSION_CONFLICT', version })
      const current = handle.outbound.version(d.mail.messageId, version)
      const payload = deps.payloads.current(member.companyId, KIND, d.mail.messageId)
      if (!current || !payload || payload.canonical === null || payload.version !== version) return notFound()
      let old: { subject: string; body: string; reply?: MailReplyHeaders; from?: string; thread?: { channel: string; ts: string } }
      try { old = JSON.parse(payload.canonical) as typeof old } catch { return notFound() }
      if (d.fields.channel === 'slack') {
        if ((toRefs?.length ?? 0) > 0 || (ccRefs?.length ?? 0) > 0) return bad('Slack への返事には宛先がありません（スレッドに返します）。', 'MAIL_INVALID')
        if (!old.thread || !old.from) return notFound()
        const chatChecked = chatCheck(old.from, { channelId: old.thread.channel, threadTs: old.thread.ts }, body.body ?? old.body)
        if ('ok' in chatChecked) return chatChecked
        return newVersion(member, actor, d, version, chatChecked.canonical, '', [], [])
      }
      const resolved = await resolveRefs(member, { to: toRefs ?? current.to.map(r => r.ref), cc: ccRefs ?? current.cc.map(r => r.ref) },
        [...current.to, ...current.cc, ...handle.outbound.typedRecipients(d.mail.messageId)],
        draftCtx(member.companyId, d.mail))
      if ('ok' in resolved) return resolved
      // A reply keeps the thread it was drafted for (the hash covers it).
      const checked = contentCheck(d.mail.fromEmail, resolved.to, resolved.cc, body.subject ?? old.subject, body.body ?? old.body, old.reply)
      if ('ok' in checked) return checked
      const mark: Record<string, LedgerValue> = expects !== undefined && offersAwait(member.companyId, d.mail.messageId, d.fields) ? { expects_reply: expects } : {}
      return newVersion(member, actor, d, version, checked.canonical, checked.subject, resolved.to, resolved.cc, mark)
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

    /** Who hears a reply that left (the inbox: the company's own message in the thread). Bound once at wiring. */
    onReplySent(listen: (reply: ReplySent) => void): void { replyListeners.push(listen) },

    /** Who starts waiting for their answer to a new mail sent with 「返事を待つ」 (the inbox). Bound once at wiring. */
    onAwaitingReply(listen: (a: SentAwaitingReply) => void): void { awaitListeners.push(listen) },

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
        const r = d.fields.channel === 'slack'
          ? finishChatSent(member, d.mail, d.recordVersion, at, null, { channelId: '', threadTs: '' }, actor)
          : finishSent(member, d.mail, d.recordVersion, at, null, to, actor, last?.id ?? null, {
            threadId: null, waitDay: typeof d.fields.reply_wait_until === 'string' ? d.fields.reply_wait_until : null,
          })
        return r.ok ? ok({ draft: r.value.draft }) : r
      }
      // Not sent: the 「返事を待つ」 of that try is chosen again at the next 確かめて送る.
      const moved = writer.transition(member.companyId, {
        recordId: d.mail.messageId, action: 'not_sent', expectedVersion: d.recordVersion, to: 'draft', actor,
        ...(typeof d.fields.reply_wait_until === 'string' ? { fields: { reply_wait_until: null } } : {}),
      })
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
