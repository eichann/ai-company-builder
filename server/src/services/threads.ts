/**
 * The card's 元のスレッド (stage 3 A4, `.claude/rules/outbound-mail.md` "Replies"):
 * the original thread of a record that came from outside, read now through
 * the core role with the **viewing member's own** permission — mail through
 * メールを読む (`MailReader.getThread`, their own mailbox), chat through
 * チャットの連絡を受け取る (`ChatReader.thread`, their own token). Nothing of the
 * thread is stored or logged; the record keeps only its pointers
 * (`thread_ref` / `source_ref`, written by the inbox: `inbox.md`).
 *
 * Who sees it: the member must read the record asked about and, through its
 * `interaction` link, the 来た連絡 itself (an owner-only 連絡 stays its
 * owner's). A record that is unreadable, missing, another company's or has no
 * 連絡 answers the same 404.
 */
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { OutboundChannel, OutboundMailState } from '../../shared/types/outbound-mail'
import type { ThreadChannel, ThreadMessageView, ThreadUnavailableReason, ThreadView } from '../../shared/types/threads'
import type { ChatReader, ChatReadFailure } from '../ports/chat'
import type { CompanyDataSource } from '../ports/company-data'
import type { MailReader, MailReadFailure } from '../ports/mail'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import { RECORDS_DISABLED } from './records'

export const THREAD_NOT_FOUND = { error: '元の連絡が見つかりません', code: 'THREAD_NOT_FOUND' }

const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,30}$/
const SLACK_TS_RE = /^\d{9,11}\.\d{1,6}$/

/** Where a 連絡's thread is, from the pointers the inbox / the mail service wrote. */
export type ThreadPointer =
  | { kind: 'mail'; threadId: string | null; messageId: string | null }
  | { kind: 'chat'; channelId: string; threadTs: string }

/**
 * `thread_ref` `gmail:<thread id>` / `slack:<channel>:<thread ts>`, else the message's own
 * `source_ref` (`gmail:<message id>`, `slack:<channel>:<ts>`). Anything else: no pointer.
 */
export function threadPointerOf(fields: Record<string, LedgerValue>): ThreadPointer | null {
  const parse = (ref: unknown, isThread: boolean): ThreadPointer | null => {
    if (typeof ref !== 'string') return null
    const gmail = /^gmail:(.+)$/.exec(ref)
    if (gmail && GMAIL_ID_RE.test(gmail[1])) return isThread ? { kind: 'mail', threadId: gmail[1], messageId: null } : { kind: 'mail', threadId: null, messageId: gmail[1] }
    const slack = /^slack:([^:]+):([^:]+)$/.exec(ref)
    if (slack && SLACK_CHANNEL_RE.test(slack[1]) && SLACK_TS_RE.test(slack[2])) return { kind: 'chat', channelId: slack[1], threadTs: slack[2] }
    return null
  }
  return parse(fields.thread_ref, true) ?? parse(fields.source_ref, false)
}

/** The mail thread's id: the pointer's own, else the one of the message it points at (read with the member's permission). */
export async function mailThreadIdOf(reader: Pick<MailReader, 'getMessage'>, member: Member, p: Extract<ThreadPointer, { kind: 'mail' }>):
Promise<{ ok: true; threadId: string } | { ok: false; reason: MailReadFailure }> {
  if (p.threadId) return { ok: true, threadId: p.threadId }
  if (!p.messageId) return { ok: false, reason: 'not-found' }
  const m = await reader.getMessage(member.companyId, member.userId, p.messageId)
  return m.ok ? { ok: true, threadId: m.value.threadId } : m
}

export function fieldsOf(handle: ReturnType<CompanyDataSource['forCompany']>, id: string): { state: string | null; fields: Record<string, LedgerValue> } {
  const s = handle.records.states([id])[0]
  let fields: Record<string, LedgerValue> = {}
  try { fields = JSON.parse(s?.fields ?? '{}') as Record<string, LedgerValue> } catch { fields = {} }
  return { state: s?.state ?? null, fields }
}

const TEXTS: Record<ThreadChannel, Record<ThreadUnavailableReason, string>> = {
  email: {
    'not-connected': 'Google で「受信を読む」を許可すると、ここに元のメールが出ます（設定 → Google）。',
    'turned-off': '「受信を読む」をオフにしているため、元のメールを出せません（設定 → Google でオンにできます）。',
    stopped: 'いまはメールを読めません（つなぎ先が止まっています）。',
    'choice-needed': 'どのサービスでメールを読むかを管理者が選ぶまで、元のメールを読めません。',
    'not-found': '元のメールが見つかりません（あなたのメールボックスにないか、消されています）。',
    unavailable: 'いまは元のメールを読めません。少し待ってから開き直してください。',
    'no-thread': 'この連絡には、元のメールへの目印がありません。',
  },
  chat: {
    'not-connected': 'Slack で「自分あての DM とメンションを読む」を許可すると、ここに元のスレッドが出ます（設定 → Slack）。',
    'turned-off': '「自分あての DM とメンションを読む」をオフにしているため、元のスレッドを出せません（設定 → Slack でオンにできます）。',
    stopped: 'いまは Slack を読めません（つなぎ先が止まっています）。',
    'choice-needed': 'どのサービスでチャットを読むかを管理者が選ぶまで、元のスレッドを読めません。',
    'not-found': '元のスレッドが見つかりません（あなたの Slack から見えないか、消されています）。',
    unavailable: 'いまは元のスレッドを読めません。少し待ってから開き直してください。',
    'no-thread': 'この連絡には、元のスレッドへの目印がありません。',
  },
}

export interface ThreadServiceDeps {
  companyData: CompanyDataSource
  /** メールを読む (the role, routed). */
  mailReader: Pick<MailReader, 'getThread' | 'getMessage'>
  /** チャットの連絡を受け取る (the role, routed). */
  chatReader: ChatReader
  /** The member's ACB email (their own messages are marked 「自分」). */
  emailOf: (companyId: string, userId: string) => string | null
}

export function createThreadService(deps: ThreadServiceDeps) {
  const { companyData } = deps
  const notFound = () => refuse('not-found', THREAD_NOT_FOUND.error, { code: THREAD_NOT_FOUND.code })

  /** The record asked about and its 連絡, both readable by the member; else null (one answer for every reason). */
  function interactionFor(member: Member, recordId: unknown): { record: RecordRow; interaction: RecordRow } | null {
    if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return null
    const handle = companyData.forCompany(member.companyId)
    const reader = recordReader(member, handle.scopes.listWithRules())
    const readable = (id: string | null | undefined): RecordRow | null => {
      if (!id) return null
      const row = handle.records.byIds([id])[0]
      return row && row.removedAt === null && reader.record(row) ? row : null
    }
    const record = readable(recordId)
    if (!record) return null
    if (record.type === 'interaction') return { record, interaction: record }
    const link = handle.records.linksFrom([record.id]).find(l => l.name === 'interaction')
    const interaction = readable(link?.targetId)
    return interaction && interaction.type === 'interaction' ? { record, interaction } : null
  }

  /** The member's own reply drafts to the 連絡 (newest first). */
  function repliesOf(member: Member, interactionId: string): ThreadView['replies'] {
    const handle = companyData.forCompany(member.companyId)
    const ids = handle.records.candidates({ types: ['outbound_message'], link: { name: 'interaction', id: interactionId } }, 50).map(r => r.id)
    return ids
      .filter(id => handle.outbound.mail(id)?.authorId === member.userId)
      .map(id => {
        const s = handle.records.states([id])[0]
        const f = fieldsOf(handle, id).fields
        return { id, state: (s?.state ?? 'draft') as OutboundMailState, channel: (f.channel === 'slack' ? 'slack' : 'email') as OutboundChannel, updatedAt: s?.updatedAt ?? '' }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(r => ({ id: r.id, state: r.state, channel: r.channel }))
  }

  return {
    /** GET …/threads/:recordId (a person's session). */
    async thread(member: Member, recordId: unknown): Promise<Outcome<{ thread: ThreadView }>> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const found = interactionFor(member, recordId)
      if (!found) return notFound()
      const { fields } = fieldsOf(handle, found.interaction.id)
      const pointer = threadPointerOf(fields)
      const channel: ThreadChannel = pointer?.kind === 'chat' || fields.channel === 'chat' || fields.channel === 'slack' ? 'chat' : 'email'
      const base = { recordId: found.record.id, interactionId: found.interaction.id, channel, replies: repliesOf(member, found.interaction.id) }
      const unavailable = (reason: ThreadUnavailableReason) => ok({
        thread: {
          ...base, messages: [], more: false,
          unavailable: { reason, text: TEXTS[channel][reason], allow: reason === 'not-connected' || reason === 'turned-off' ? (channel === 'email' ? 'google-inbox' as const : 'slack-read' as const) : null },
        },
      })
      if (!pointer) return unavailable('no-thread')

      if (pointer.kind === 'chat') {
        const r = await deps.chatReader.thread(member.companyId, member.userId, { channelId: pointer.channelId, threadTs: pointer.threadTs })
        if (!r.ok) return unavailable(r.reason as ChatReadFailure)
        const messages: ThreadMessageView[] = r.value.messages.map(m => ({
          id: m.ts, fromName: m.authorName, fromAddress: null, to: [], cc: [], at: m.at, subject: null, text: m.text, truncated: m.truncated, mine: m.mine,
        }))
        return ok({ thread: { ...base, messages, more: r.value.more, unavailable: null } })
      }

      const id = await mailThreadIdOf(deps.mailReader, member, pointer)
      if (!id.ok) return unavailable(id.reason)
      const r = await deps.mailReader.getThread(member.companyId, member.userId, id.threadId)
      if (!r.ok) return unavailable(r.reason)
      const me = deps.emailOf(member.companyId, member.userId)
      const messages: ThreadMessageView[] = r.value.messages.map(m => ({
        id: m.id, fromName: m.from?.name || null, fromAddress: m.from?.email ?? null,
        to: m.to.map(a => a.email), cc: m.cc.map(a => a.email), at: m.receivedAt, subject: m.subject,
        text: m.text, truncated: m.truncated, mine: me !== null && m.from?.email === me,
      }))
      return ok({ thread: { ...base, messages, more: r.value.more, unavailable: null } })
    },
  }
}

export type ThreadService = ReturnType<typeof createThreadService>
