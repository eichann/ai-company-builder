/**
 * Gmail as Google's side of the core role メールを読む・送る (`ports/mail.ts`,
 * `.claude/rules/connector-roles.md`, `google-connector.md` "Gmail"):
 *
 * - read (`inbox` feature, `gmail.readonly`, 受信を読む): the member's own
 *   received messages — header facts for a list, the text of one on demand.
 *   Nothing is stored and nothing of a message (subject, address, text) is
 *   logged; the one Google client records only the operation name and status.
 * - send (`mail` feature, `gmail.send`): a message the member confirmed
 *   (`services/outbound-mail.ts`), once, never retried.
 *
 * Every call goes through the one Google client (`google-client.ts`), so every
 * switch — the operator's stop, the company's Google off, the vault, the
 * member's grant, the scope and the member's own feature switch
 * (`features_off`) — applies from the next call. Only `users/me` is ever
 * asked for: nothing here can name another mailbox.
 */
import { googleFeaturesOff, GOOGLE_SCOPE } from '../../shared/core/google'
import { normalizeEmail } from '../../shared/core/mail'
import type { CompanyDataSource } from '../ports/company-data'
import type { InboxSource } from '../ports/inbox'
import type { MailAddress, MailMessage, MailRead, MailReader, MailReadFailure, MailSender, MailSenderAccount, MailSummary } from '../ports/mail'
import type { GoogleResult } from './google-client'
import type { GoogleRequester } from './google-meetings'

/** The longest text handed out for one message (characters); longer is cut with a notice. */
export const MAIL_TEXT_MAX = 20_000
const TRUNCATED = '\n【長いため、ここから先は省きました】'
/** A thread on the card: at most this many of its newest messages, each at most this long. */
export const THREAD_MESSAGES_MAX = 20
export const THREAD_TEXT_MAX = 8_000
const PAGE_MAX = 50
const PAGE_DEFAULT = 25
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{1,500}$/
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'X-Autoreply']
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']

export interface GoogleMailDeps {
  request: GoogleRequester
  companyData: CompanyDataSource
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Why a Gmail answer gives nothing, as the neutral reason. */
export function mailReadReasonOf(r: Extract<GoogleResult, { ok: false }>): MailReadFailure {
  if (r.kind === 'not-sent') {
    if (r.reason === 'feature-off') return 'turned-off'
    if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'token-refused'].includes(r.reason)) return 'not-connected'
    if (['operator-stopped', 'not-configured', 'off', 'vault-off', 'not-member', 'practice-real-secret'].includes(r.reason)) return 'stopped'
  }
  if (r.kind === 'refused' && (r.status === 404 || r.status === 410)) return 'not-found'
  if (r.kind === 'refused' && (r.status === 401 || r.status === 403)) return 'not-connected'
  return 'unavailable'
}

/** RFC 2047 encoded words (`=?UTF-8?B?…?=`, `=?ISO-2022-JP?B?…?=`, Q encoding) → text. Unknown charsets stay as written. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
        return new TextDecoder(charset.toLowerCase()).decode(bytes)
      } catch {
        return whole
      }
    })
}

/** An address list header (`"名前" <a@b.example>, c@d.example`) → addresses (lower case), unreadable entries left out. */
export function parseAddressList(value: string | null): MailAddress[] {
  if (!value) return []
  const out: MailAddress[] = []
  let depth = 0
  let quoted = false
  let current = ''
  const parts: string[] = []
  for (const ch of decodeEncodedWords(value)) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') depth++
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1)
    if (ch === ',' && !quoted && depth === 0) { parts.push(current); current = '' } else current += ch
  }
  parts.push(current)
  for (const part of parts) {
    const p = part.trim()
    if (!p) continue
    const angle = /^(.*)<([^<>]+)>\s*$/.exec(p)
    const email = normalizeEmail(angle ? angle[2] : p)
    if (!email) continue
    const name = angle ? angle[1].trim().replace(/^"(.*)"$/, '$1').trim() : ''
    out.push({ email, name })
  }
  return out
}

function headersOf(payload: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const list = isObj(payload) && Array.isArray(payload.headers) ? payload.headers : []
  for (const h of list) {
    if (!isObj(h)) continue
    const name = str(h.name)?.toLowerCase()
    const value = str(h.value)
    if (name && value !== null && !out.has(name)) out.set(name, value)
  }
  return out
}

/** One Gmail message resource → the neutral header facts, or null when it has no usable id. */
export function mailSummaryOf(raw: unknown): MailSummary | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  const threadId = str(raw.threadId) ?? id
  if (!id || !ID_RE.test(id) || !threadId || !ID_RE.test(threadId)) return null
  const h = headersOf(raw.payload)
  const labels = Array.isArray(raw.labelIds) ? raw.labelIds.filter((l): l is string => typeof l === 'string') : []
  const internal = Number(str(raw.internalDate) ?? raw.internalDate)
  const precedence = (h.get('precedence') ?? '').trim().toLowerCase()
  const autoSubmitted = (h.get('auto-submitted') ?? '').trim().toLowerCase()
  return {
    id,
    threadId,
    from: parseAddressList(h.get('from') ?? null)[0] ?? null,
    to: parseAddressList(h.get('to') ?? null),
    cc: parseAddressList(h.get('cc') ?? null),
    subject: decodeEncodedWords(h.get('subject') ?? '').trim().normalize('NFC'),
    receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null,
    messageIdHeader: h.get('message-id')?.trim() || null,
    inReplyTo: h.get('in-reply-to')?.trim() || null,
    bulk: h.has('list-id') || h.has('list-unsubscribe') || precedence === 'bulk' || precedence === 'list' || labels.some(l => BULK_LABELS.includes(l)),
    automated: (autoSubmitted !== '' && autoSubmitted !== 'no') || h.has('x-autoreply') || precedence === 'auto_reply',
  }
}

function decodeData(data: string, charset: string | null): string {
  const bytes = Buffer.from(data, 'base64url')
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function charsetOf(part: Record<string, unknown>): string | null {
  const ct = headersOf(part).get('content-type') ?? ''
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1]?.toLowerCase() ?? null
}

/** The first part of a MIME type in the tree (depth first), skipping attachments. */
function findPart(part: unknown, mimeType: string): Record<string, unknown> | null {
  if (!isObj(part)) return null
  const filename = str(part.filename)
  if (str(part.mimeType)?.toLowerCase() === mimeType && !filename && isObj(part.body) && typeof part.body.data === 'string') return part
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return null
}

/** HTML → plain text: tags removed, block ends as new lines, the common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** A message resource (format=full) → its plain text (text/plain first, else the HTML's text). */
export function mailTextOf(raw: unknown, max = MAIL_TEXT_MAX): { text: string; truncated: boolean } {
  const payload = isObj(raw) ? raw.payload : null
  const plain = findPart(payload, 'text/plain')
  const html = plain ? null : findPart(payload, 'text/html')
  const part = plain ?? html
  let text = ''
  if (part) {
    const decoded = decodeData((part.body as { data: string }).data, charsetOf(part))
    text = html ? htmlToText(decoded) : decoded
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC').trim()
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd()}${TRUNCATED}`, truncated: true }
}

export function createGoogleMail(deps: GoogleMailDeps): MailReader & MailSender {
  const { request } = deps

  async function metadata(companyId: string, userId: string, id: string): Promise<MailRead<MailSummary>> {
    const r = await request(companyId, userId, {
      api: 'gmail', method: 'GET', path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      query: { format: 'metadata', metadataHeaders: METADATA_HEADERS },
      scope: GOOGLE_SCOPE.gmailReadonly, operation: 'gmail.messages.get',
    })
    if (!r.ok) return { ok: false, reason: mailReadReasonOf(r) }
    const summary = mailSummaryOf(r.json)
    return summary ? { ok: true, value: summary } : { ok: false, reason: 'unavailable' }
  }

  return {
    async listMessages(companyId, userId, query) {
      const max = Math.min(Math.max(Math.trunc(query.max ?? PAGE_DEFAULT), 1), PAGE_MAX)
      if (query.pageToken !== undefined && !PAGE_TOKEN_RE.test(query.pageToken)) return { ok: false, reason: 'unavailable' }
      const after = Math.max(0, Math.floor(query.afterMs / 1000))
      const r = await request(companyId, userId, {
        api: 'gmail', method: 'GET', path: '/gmail/v1/users/me/messages',
        query: { q: `after:${after}`, labelIds: 'INBOX', maxResults: String(max), ...(query.pageToken ? { pageToken: query.pageToken } : {}) },
        scope: GOOGLE_SCOPE.gmailReadonly, operation: 'gmail.messages.list',
      })
      if (!r.ok) return { ok: false, reason: mailReadReasonOf(r) }
      const body = isObj(r.json) ? r.json : {}
      const ids = (Array.isArray(body.messages) ? body.messages : [])
        .map(m => (isObj(m) ? str(m.id) : null))
        .filter((id): id is string => id !== null && ID_RE.test(id))
        .slice(0, max)
      const messages: MailSummary[] = []
      for (const id of ids) {
        const m = await metadata(companyId, userId, id)
        if (m.ok) { messages.push(m.value); continue }
        // A message removed between the list and the read is skipped; anything else stops the page.
        if (m.reason !== 'not-found') return { ok: false, reason: m.reason }
      }
      const next = str(body.nextPageToken)
      return { ok: true, value: { messages, nextPageToken: next && PAGE_TOKEN_RE.test(next) ? next : null } }
    },

    async getMessage(companyId, userId, messageId) {
      if (!ID_RE.test(messageId)) return { ok: false, reason: 'not-found' }
      const r = await request(companyId, userId, {
        api: 'gmail', method: 'GET', path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
        query: { format: 'full' },
        scope: GOOGLE_SCOPE.gmailReadonly, operation: 'gmail.messages.get',
      })
      if (!r.ok) return { ok: false, reason: mailReadReasonOf(r) }
      const summary = mailSummaryOf(r.json)
      if (!summary) return { ok: false, reason: 'unavailable' }
      const message: MailMessage = { ...summary, ...mailTextOf(r.json) }
      return { ok: true, value: message }
    },

    async getThread(companyId, userId, threadId) {
      if (!ID_RE.test(threadId)) return { ok: false, reason: 'not-found' }
      const r = await request(companyId, userId, {
        api: 'gmail', method: 'GET', path: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
        query: { format: 'full' },
        scope: GOOGLE_SCOPE.gmailReadonly, operation: 'gmail.threads.get',
      })
      if (!r.ok) return { ok: false, reason: mailReadReasonOf(r) }
      const body = isObj(r.json) ? r.json : {}
      const all = (Array.isArray(body.messages) ? body.messages : [])
        .map(raw => {
          const summary = mailSummaryOf(raw)
          return summary ? { ...summary, ...mailTextOf(raw, THREAD_TEXT_MAX) } : null
        })
        .filter((m): m is MailMessage => m !== null)
      // Gmail lists a thread oldest first; only the newest ones are handed out.
      const messages = all.slice(-THREAD_MESSAGES_MAX)
      return { ok: true, value: { id: threadId, messages, more: all.length > messages.length } }
    },

    async senderAccount(companyId, userId): Promise<MailSenderAccount> {
      const grant = deps.companyData.forCompany(companyId).connectors.grant('google', userId)
      if (!grant || grant.status !== 'active' || !grant.scopes.includes(GOOGLE_SCOPE.gmailSend)) return { ok: false, reason: 'consent-needed' }
      if (googleFeaturesOff(grant.featuresOff).includes('mail')) return { ok: false, reason: 'turned-off' }
      return { ok: true, account: grant.accountEmail }
    },

    send(companyId, userId, raw, options) {
      const threadId = options?.threadId && ID_RE.test(options.threadId) ? options.threadId : null
      return request(companyId, userId, {
        api: 'gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send',
        body: threadId ? { raw, threadId } : { raw }, scope: GOOGLE_SCOPE.gmailSend, operation: threadId ? 'gmail.send.reply' : 'gmail.send',
      })
    },
  }
}

/** The most messages one poll hands the inbox (a 7-day read-back of a busy mailbox stays bounded). */
export const INBOX_POLL_MAX = 1000

/**
 * Gmail as the inbox's source (`ports/inbox.ts` `InboxSource`, inbox.md
 * "Receiving"): the member's received messages since a time, oldest first,
 * as header facts and pointers (`gmail:<id>`, `gmail:<thread id>`) — never
 * the text. Any failure reads as `not-connected`, so the poll keeps its window.
 */
export function googleMailInboxSource(reader: Pick<MailReader, 'listMessages'>, nowMs: () => number, log: (message: string) => void = m => console.warn(m)): InboxSource {
  const party = (a: MailAddress) => ({ address: a.email, name: a.name || null })
  return {
    async listSince(companyId, userId, since) {
      const afterMs = Date.parse(since)
      const found: MailSummary[] = []
      let pageToken: string | undefined
      do {
        const r = await reader.listMessages(companyId, userId, { afterMs, max: PAGE_MAX, ...(pageToken ? { pageToken } : {}) })
        if (!r.ok) return 'not-connected'
        found.push(...r.value.messages)
        pageToken = r.value.nextPageToken ?? undefined
      } while (pageToken && found.length < INBOX_POLL_MAX)
      if (pageToken) log(`[inbox] gmail poll of company ${companyId} stopped at ${INBOX_POLL_MAX} messages`)
      return found
        // Gmail's `after:` counts whole seconds: what came before the window is left out here.
        .filter((m): m is MailSummary & { from: MailAddress; receivedAt: string } => m.from !== null && m.receivedAt !== null && Date.parse(m.receivedAt) >= afterMs)
        .reverse()
        .map(m => ({
          channel: 'email' as const,
          messageId: m.messageIdHeader ?? `gmail:${m.id}`,
          references: m.inReplyTo ? [m.inReplyTo] : [],
          threadRef: `gmail:${m.threadId}`,
          sourceRef: `gmail:${m.id}`,
          occurredAt: m.receivedAt,
          subject: m.subject,
          from: party(m.from),
          to: m.to.map(party),
          cc: m.cc.map(party),
          outgoing: false,
          bulk: m.bulk,
          automated: m.automated,
        }))
    },
    // Ready = one list call answers now: granted, 受信を読む on, the company's switches on.
    async ready(companyId, userId) {
      return (await reader.listMessages(companyId, userId, { afterMs: nowMs(), max: 1 })).ok
    },
  }
}
