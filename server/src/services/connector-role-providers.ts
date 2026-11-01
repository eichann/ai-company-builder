/**
 * The core roles as the core services use them (stage 3 A1,
 * `.claude/rules/connector-roles.md` "Role providers"): one provider-neutral
 * port per role — 予定を読む (`CalendarReader`), 会議の記録を読む
 * (`MeetingRecordsReader`), メールを読む (`MailReader`), メールを送る
 * (`MailSender`), チャットの連絡を受け取る・返す (`ChatReader`, `ChatSender`) — that resolves, call by call, which core connector serves
 * the role in the member's company and hands the call to that connector's
 * implementation. The core services (calendar, minutes, outbound mail, and
 * later the inbox) take these ports and never name a service
 * (`tests/unit/connector-boundary.test.ts`).
 *
 * Resolution per call: a company switching its connector off, the operator's
 * stop, or the admin's choice between two apply from the next call. No usable
 * connector, or two without the admin's choice, is an answer in the role's own
 * terms (an empty calendar with a reason, a refusal), never a guess.
 */
import type { ConnectorRole, RoleResolution } from '../../shared/core/connector-roles'
import type { CalendarRead, CalendarReader } from '../ports/calendar'
import type { ChatReader, ChatSender } from '../ports/chat'
import type { MailReader, MailSender } from '../ports/mail'
import { MeetingReadFailed, type MeetingRecordsReader } from '../ports/meeting-records'

/** What a core connector implements of the roles it declared. */
export interface RoleImplementations {
  calendar?: CalendarReader
  meetings?: MeetingRecordsReader
  mailReader?: MailReader
  mailSender?: MailSender
  /** チャットの連絡を受け取る (one thread, on demand). */
  chatReader?: ChatReader
  /** チャットに返す (a reply into a thread). */
  chatSender?: ChatSender
}

export interface RoleResolver {
  resolve(companyId: string, role: ConnectorRole, operation?: string | null): Promise<RoleResolution>
}

type Picked<T> = { ok: true; impl: T } | { ok: false; reason: 'none' | 'choice-needed' }

export function createRoleProviders(resolver: RoleResolver, given: Record<string, RoleImplementations>) {
  // A connector wired later (Slack, in the lane's own wiring) adds its implementations with `provide`.
  const implementations: Record<string, RoleImplementations> = { ...given }
  async function pick<K extends keyof RoleImplementations>(companyId: string, role: ConnectorRole, operation: string, key: K): Promise<Picked<NonNullable<RoleImplementations[K]>>> {
    const r = await resolver.resolve(companyId, role, operation)
    if (!r.ok) return { ok: false, reason: r.reason }
    const impl = implementations[r.connectorId]?.[key]
    // A connector that declared the role must implement it; a missing one counts as none (never another's).
    return impl ? { ok: true, impl: impl as NonNullable<RoleImplementations[K]> } : { ok: false, reason: 'none' }
  }

  /** 会議の記録を読む: each call routed; no connector → a not-sent failure the minutes show as stopped. */
  async function meetingsOf(companyId: string): Promise<MeetingRecordsReader> {
    const p = await pick(companyId, 'meetings', 'read', 'meetings')
    if (!p.ok) throw new MeetingReadFailed({ ok: false, kind: 'not-sent', reason: p.reason === 'none' ? 'no-connector' : 'choice-needed' })
    return p.impl
  }

  const calendar: CalendarReader = {
    async eventsBetween(companyId, userId, fromMs, toMs): Promise<CalendarRead> {
      const p = await pick(companyId, 'calendar', 'read', 'calendar')
      if (!p.ok) return { ok: false, reason: p.reason === 'none' ? 'stopped' : 'unavailable' }
      return p.impl.eventsBetween(companyId, userId, fromMs, toMs)
    },
  }

  const meetings: MeetingRecordsReader = {
    meetEvents: async (companyId, userId, from, to) => (await meetingsOf(companyId)).meetEvents(companyId, userId, from, to),
    event: async (companyId, userId, eventId) => (await meetingsOf(companyId)).event(companyId, userId, eventId),
    conferenceFor: async (companyId, userId, event) => (await meetingsOf(companyId)).conferenceFor(companyId, userId, event),
    documents: async (companyId, userId, conferenceId) => (await meetingsOf(companyId)).documents(companyId, userId, conferenceId),
    docVersion: async (companyId, userId, docId) => (await meetingsOf(companyId)).docVersion(companyId, userId, docId),
    docText: async (companyId, userId, docId, max) => (await meetingsOf(companyId)).docText(companyId, userId, docId, max),
  }

  const mailReader: MailReader = {
    async listMessages(companyId, userId, query) {
      const p = await pick(companyId, 'mail', 'read', 'mailReader')
      if (!p.ok) return { ok: false, reason: p.reason === 'none' ? 'stopped' : 'choice-needed' }
      return p.impl.listMessages(companyId, userId, query)
    },
    async getMessage(companyId, userId, messageId) {
      const p = await pick(companyId, 'mail', 'read', 'mailReader')
      if (!p.ok) return { ok: false, reason: p.reason === 'none' ? 'stopped' : 'choice-needed' }
      return p.impl.getMessage(companyId, userId, messageId)
    },
    async getThread(companyId, userId, threadId) {
      const p = await pick(companyId, 'mail', 'read', 'mailReader')
      if (!p.ok) return { ok: false, reason: p.reason === 'none' ? 'stopped' : 'choice-needed' }
      return p.impl.getThread(companyId, userId, threadId)
    },
  }

  const mailSender: MailSender = {
    async senderAccount(companyId, userId) {
      const p = await pick(companyId, 'mail', 'send', 'mailSender')
      if (!p.ok) return { ok: false, reason: 'unavailable' }
      return p.impl.senderAccount(companyId, userId)
    },
    async send(companyId, userId, raw, options) {
      const p = await pick(companyId, 'mail', 'send', 'mailSender')
      if (!p.ok) return { ok: false, kind: 'not-sent', reason: p.reason === 'none' ? 'no-connector' : 'choice-needed' }
      return p.impl.send(companyId, userId, raw, options)
    },
  }

  const chatReader: ChatReader = {
    async thread(companyId, userId, ref) {
      const p = await pick(companyId, 'chat', 'receive', 'chatReader')
      if (!p.ok) return { ok: false, reason: p.reason === 'none' ? 'stopped' : 'choice-needed' }
      return p.impl.thread(companyId, userId, ref)
    },
  }

  const chatSender: ChatSender = {
    async replierAccount(companyId, userId) {
      const p = await pick(companyId, 'chat', 'reply', 'chatSender')
      if (!p.ok) return { ok: false, reason: 'unavailable' }
      return p.impl.replierAccount(companyId, userId)
    },
    async reply(companyId, userId, ref, text) {
      const p = await pick(companyId, 'chat', 'reply', 'chatSender')
      if (!p.ok) return { ok: false, kind: 'not-sent', reason: p.reason === 'none' ? 'no-connector' : 'choice-needed' }
      return p.impl.reply(companyId, userId, ref, text)
    },
  }

  return {
    calendar, meetings, mailReader, mailSender, chatReader, chatSender,
    /** A connector registered later hands in what it implements (once, at wiring). */
    provide(connectorId: string, impl: RoleImplementations): void {
      implementations[connectorId] = { ...implementations[connectorId], ...impl }
    },
  }
}

export type RoleProviders = ReturnType<typeof createRoleProviders>
