import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import { RECIPIENT_SOURCE_LABELS, RECIPIENT_SOURCES, type RecipientSource } from '../../shared/core/mail'
import type { MailRecipientsView, MailRecipientView, OutboundMailState, OutboundMailView } from '../../shared/types/outbound-mail'

/**
 * The chat's mail card (milestone 4 G8, `.claude/rules/outbound-mail.md`): when
 * the member's AI drafts a mail (`mail_draft_create` / `mail_draft_update`),
 * main adds the draft to the reply as a data part; it is stored with the
 * message (`mailDrafts`). The card is drawn by the app — the AI's text appears
 * only inside the draft's fields — and its buttons are the person's own,
 * through IPC with the member's session: edit (a new version), 「確かめて送る」
 * (sends the hash of the version shown), 送られていた／送られていなかった, 捨てる.
 * No jargon on the card (no ハッシュ / OAuth).
 */
export const MAIL_DRAFT_PART_TYPE = 'data-mail-draft'

export interface MailDraftCard {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  /** The draft as the server answered (its version and hash: the send carries this hash). */
  draft: OutboundMailView
  /** The AI drafted it (the credential decided). */
  byAi: boolean
  at: string
}

export const MAIL_WORDS = {
  sendButton: '確かめて送る',
  confirmTitle: '送る前に、もう一度確かめてください',
  confirmNote: '中身が変わっていないことを確かめて送ります。送ったメールは取り消せません。',
  confirmSend: 'この内容で送る',
  firstTime: 'この宛先に送るのは初めてです',
  links: (n: number) => `本文にリンクが ${n} つあります`,
  unknown: '届いたか分かりません。Gmail の送信済みを確かめてください。',
  wasSent: '送られていた',
  wasNotSent: '送られていなかった',
  discard: '捨てる',
  edit: '直す',
  save: '保存する',
  consent: 'メールを送る許可',
  consentNote: 'メールを送るには、Google で「メールを送る許可」が要ります。',
  bodyDeleted: '本文は送ってから30日たったため、サーバーから消しました（Gmail の送信済みには残っています）。',
  byAi: 'AI が下書き',
} as const

export const MAIL_STATE_LABELS: Record<OutboundMailState, string> = {
  draft: '下書き',
  sent: '送りました',
  unknown: '届いたか分かりません',
  discarded: '捨てました',
}

export const sourceLabel = (s: RecipientSource) => RECIPIENT_SOURCE_LABELS[s]

/** How a recipient is shown: 「鈴木 一郎 <suzuki@…>（カレンダーの参加者）」. */
export function recipientLine(r: Pick<MailRecipientView, 'email' | 'name' | 'source'>): string {
  return `${r.name ? `${r.name} <${r.email}>` : r.email}（${sourceLabel(r.source)}）`
}

const STATES = new Set<OutboundMailState>(['draft', 'sent', 'unknown', 'discarded'])
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const nul = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)

function readRecipient(x: unknown): MailRecipientView | undefined {
  if (!x || typeof x !== 'object') return undefined
  const r = x as Record<string, unknown>
  if (!str(r.ref, 40) || !str(r.email, 254) || !(RECIPIENT_SOURCES as readonly string[]).includes(r.source as string)) return undefined
  return { ref: r.ref, email: r.email, name: nul(r.name, 100), source: r.source as RecipientSource, firstTime: r.firstTime === true }
}

/** A draft view from the server or storage, validated (undefined when malformed). */
export function readMailDraft(data: unknown): OutboundMailView | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 80) || !STATES.has(d.state as OutboundMailState) || typeof d.version !== 'number' || !str(d.hash, 80) || !CONTENT_HASH_RE.test(d.hash)) return undefined
  if (!str(d.from, 254) || typeof d.subject !== 'string' || d.subject.length > 1000 || !Array.isArray(d.to) || !Array.isArray(d.cc) || d.to.length > 50 || d.cc.length > 50) return undefined
  const to = d.to.map(readRecipient)
  const cc = d.cc.map(readRecipient)
  if (to.some(r => !r) || cc.some(r => !r)) return undefined
  const body = typeof d.body === 'string' && d.body.length <= 50_000 ? d.body : null
  return {
    id: d.id, state: d.state as OutboundMailState, version: d.version, hash: d.hash, from: d.from,
    to: to as MailRecipientView[], cc: cc as MailRecipientView[], subject: d.subject, body, bodyDeleted: body === null,
    linkCount: typeof d.linkCount === 'number' ? d.linkCount : 0,
    minutesId: nul(d.minutesId, 80), dealId: nul(d.dealId, 80), sentAt: nul(d.sentAt, 40), providerMessageId: nul(d.providerMessageId, 100),
    lastChangedBy: d.lastChangedBy === 'ai' ? 'ai' : 'human', updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt.slice(0, 40) : '',
  }
}

/** A stored / streamed card, validated (undefined when malformed). */
export function readMailDraftCard(data: unknown): MailDraftCard | undefined {
  if (!data || typeof data !== 'object') return undefined
  const c = data as Record<string, unknown>
  if (!str(c.id, 200) || !str(c.companyId, 200) || !str(c.at, 40)) return undefined
  const draft = readMailDraft(c.draft)
  if (!draft) return undefined
  return { id: c.id, companyId: c.companyId, conversationId: typeof c.conversationId === 'string' ? c.conversationId : null, draft, byAi: c.byAi === true, at: c.at }
}

/** What the AI is told about a draft it made: the content, never a claim that anything was sent. */
export function aiMailSummary(draft: OutboundMailView): Record<string, unknown> {
  return {
    id: draft.id, version: draft.version, state: draft.state,
    to: draft.to.map(r => ({ ref: r.ref, email: r.email, name: r.name, source: r.source })),
    cc: draft.cc.map(r => ({ ref: r.ref, email: r.email, name: r.name, source: r.source })),
    subject: draft.subject, body: draft.body,
    instruction: 'The draft is shown to the member as a card. It is NOT sent: only the member sends it, from the card (「確かめて送る」). Never say it was sent. To change it, call mail_draft_update with this version as expectedVersion.',
  }
}

export const OUTBOUND_MAIL_OFFLINE_TEXT = 'サーバーに接続できないため、いまは操作できません（オフラインの可能性があります）。'

/** The answer of the card's own actions (IPC `outboundMail:*`), sent with the person's session. */
export type OutboundMailResult =
  | { success: true; draft: OutboundMailView; outcome?: 'sent' | 'unknown'; message?: string; recipients?: MailRecipientsView; recipient?: MailRecipientView }
  | { success: false; offline: boolean; code: string | null; error: string; needsGoogleConsent?: 'mail'; draft?: OutboundMailView }

/** A version change the card makes (the person's own edit). */
export interface MailDraftEdit {
  expectedVersion: number
  toRefs?: string[]
  ccRefs?: string[]
  subject?: string
  body?: string
}

/** Validation of what the renderer passes to main (main checks again before calling the server). */
export const MESSAGE_ID_RE = /^outbound_message-[0-9a-z]{6,32}$/
export function isContentHash(v: unknown): v is string {
  return typeof v === 'string' && CONTENT_HASH_RE.test(v)
}
