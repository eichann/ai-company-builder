/**
 * The inbox (来た連絡, stage 3 B2, `.claude/rules/inbox.md`): messages that
 * came in by mail or chat become `interaction` records, and the AI's
 * judgement of one becomes a `reply_request` (返事のお願い).
 *
 * Noticing is the server's job, judging the member's PC's:
 * - `receive` is the one entry point every core connector calls for one
 *   message (Slack from its events; Gmail through `poll`, which the server
 *   clock runs). It reads the core role (`mail` / `read`), never a service
 *   by name: a connector registers its `InboxSource` under its connector id.
 * - The routing rules are the company's intake settings
 *   (shared/core/intake-settings.ts `routeIncoming`): the To person's own
 *   record (持ち主だけ), CC told nothing, 確認待ち, the department's turn for a
 *   shared address, internal mail and newsletters left out.
 * - One interaction per thread per company: a message id is taken once, a
 *   message answering a known one joins its interaction; a reply from the
 *   other side moves a 返事待ち to the AI's check (`reply_arrived`), a reply
 *   from someone of the company ends it or has the AI check it (setting).
 * - No body is ever stored: pointers, ids, times, the subject and the
 *   addresses on the owner's own record.
 *
 * No leaks: an interaction or reply request is read through `recordReader`
 * (owner-only: its owner alone, admins included); a record the caller cannot
 * read gets exactly the missing record's answer. Lists answer only the
 * caller's own.
 */
import { INBOX_ACTIONS, INBOX_ACTOR, WAIT_OVER_ACTION } from '../../shared/core/core-types'
import type { ConnectorRole, RoleResolution } from '../../shared/core/connector-roles'
import {
  companyDomains, defaultIntakeSettings, parseIntakeSettings, pollWindow, routeIncoming, BACKFILL_DAYS,
  type IntakeSettings, type RoutedParty,
} from '../../shared/core/intake-settings'
import { normalizeEmail } from '../../shared/core/mail'
import { BUILTIN_NOTIFICATION_SENDERS, notificationServiceOf, type ConnectedNotifier } from '../../shared/core/notification-senders'
import { findPrivateScope } from '../../shared/core/permissions'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { isDateValue } from '../../shared/core/record-types'
import { RECORD_ID_RE } from '../../shared/core/records'
import { replyTarget, type TaskSettings } from '../../shared/core/task-settings'
import {
  INBOX_AI_TITLE_MAX, INBOX_CHANNELS, INBOX_NO_SUBJECT, type IncomingMessage, type IncomingParty, type InboxChannel, type InboxItemView, type InboxJudgementResult,
  type InboxReplyCheckResult,
  type InboxSettingsView, type InboxStatus, type IntakeOutcome, type SetAsideItem, type SetAsideList,
} from '../../shared/types/inbox'
import type { RecordSummary } from '../../shared/types/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { InboxSource } from '../ports/inbox'
import type { RecordRow } from '../ports/records'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import { placeOfRow, type ServiceActor, type ServiceRecordWriter, type ServiceWriteResult } from './record-engine'
import { recordSummaries, RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

/** How far before its window each poll also lists (mail that shows up late keeps its earlier time). */
export const INBOX_POLL_OVERLAP_MS = 10 * 60_000
export const INBOX_SETTINGS_FORBIDDEN = 'Only owners and admins can change the intake settings'
export const INBOX_NOT_CONNECTED = { error: 'まだつないでいません。設定から「つなぐ」を押してください', code: 'INBOX_NOT_CONNECTED' }
export const NOT_AI_TURN = { error: 'この連絡はいま AI の番ではありません', code: 'NOT_AI_TURN' }
export const PERSON_DECIDED = { error: '人が「やることにする」と決めた連絡です。AI はやることにしないにはできません', code: 'PERSON_DECIDED' }
export const NOT_UNCLAIMED = { error: 'この連絡はもう誰かが引き受けました', code: 'NOT_UNCLAIMED' }
export const NOT_FROM_THIS_REPLY = { error: 'この連絡から作った、あなたが担当でまだ終わっていないタスクだけを扱えます', code: 'NOT_FROM_THIS_REPLY' }
export const NEEDS_CHECK = { error: '「確かめてから」のタスクは、確かめる人の OK で完了します。open にしてください', code: 'NEEDS_CHECK' }
const VERSION_CONFLICT = { error: 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', code: 'VERSION_CONFLICT' }

/** Limits of what the inbox keeps from a message (no body is ever kept). */
export const INBOX_LIMITS = {
  messageId: 998,
  sourceRef: 500,
  references: 50,
  parties: 50,
  /** Addresses kept on the record (To / CC each), the rest only counted. */
  keptAddresses: 20,
  title: 200,
  /** The AI's short title for a message without a subject (a chat message, a mail with none). */
  aiTitle: INBOX_AI_TITLE_MAX,
  reason: 500,
  endCondition: 2000,
  deadlineNote: 200,
  setAsideList: 100,
} as const

const SUBJECT_NONE = INBOX_NO_SUBJECT
/** The ledger's note when the member's own reply was seen in the thread. */
const REPLIED_THERE: Record<InboxChannel, string> = { email: 'メールで返信済み', chat: 'チャット（Slack）で返信済み' }
/** A task the member's reply may have finished (owner FB #19): open, theirs to work on — not 準備中 (the AI's), not waiting for acceptance or a check. */
const REPLY_CHECK_TASK_STATES = ['todo', 'in_progress', 'waiting']
/** The note on a task the member's reply did not finish (owner FB #19). */
export const REPLY_NOTED = '返事は済み'
/** The note on a task the member's reply finished (the notice `replied_done` says it to them). */
export const REPLIED_DONE = '返事をしたので完了にしました'
/** The most tasks one reply check decides. */
const REPLY_CHECK_MAX = 20
/**
 * Mail that left the mailbox inbox (owner decision 2026-11-05, inbox.md "Mail archived in the
 * mailbox"): at most this many conversations are checked per member and poll (one read each).
 */
export const LEFT_CHECK_MAX = 20
/** The states a message is closed from when its mail left the inbox (the type's `left_inbox`). */
const LEFT_CLOSES_FROM = ['received', 'unsure']
/** The states a message the inbox watches is in: open, or handled with work still open. */
const LEFT_WATCHED_STATES = ['received', 'unsure', 'handled', 'replied']
/** A message closed for good (a person's own close here archives the mail there). */
const CLOSED_STATES = ['handled', 'excluded']
const TASK_FINAL = ['done', 'cancelled']
const REPLY_FINAL = ['closed', 'dropped']
/** The note when the mail left the inbox (「Gmail ではアーカイブ済み」) and when ACB archived it there. */
export const leftInboxNote = (label: string) => `${label} ではアーカイブ済み`
export const archivedThereNote = (label: string) => `${label} でもアーカイブしました`
export const unarchiveFailedNote = (label: string) => `${label} の受信トレイに戻せませんでした`
const DEFAULT_MAILBOX_LABEL = 'メール'
/** How far back a member's unthreaded chat message counts as the reply to the last message of that DM (B4). */
const DM_REPLY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export interface InboxDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  writer: Pick<ServiceRecordWriter, 'create' | 'transition' | 'retitle'>
  /** 名寄せ (identity.md): the 相手 an address is, as that member may see it. */
  resolveAddress: (member: Member, address: string) => Outcome<{ person: string[]; company: string[] }>
  roleOf: (companyId: string, userId: string) => string | null
  /** The members' own addresses (mail is matched to members by them). */
  memberAddresses: (companyId: string) => Array<{ userId: string; email: string }>
  /** The task settings: the reply 目安 and the company's holidays (task-settings.ts). */
  taskSettings: (companyId: string) => TaskSettings
  /** Which connector serves a core role now (services/connector-roles.ts); absent until lane A wires it. */
  roles?: { resolve(companyId: string, role: ConnectorRole, operation?: string | null): Promise<RoleResolution> }
  /**
   * Whether the member's own grant of a core connector reads now (Slack: active, its 読む on):
   * a per-member notifier (notification-senders.ts `perMember`) counts only then. Absent: never.
   */
  connectorReadsFor?: (companyId: string, userId: string, connectorId: string) => boolean
  /** The notification senders that installed, on connector plugins declare (`notification_senders`). Absent: none. */
  pluginNotifiers?: (companyId: string) => Promise<ConnectedNotifier[]>
  /**
   * Whether the member's own 自動で進める is on (`tasks.md` "Each member's switches"): after their own
   * reply, tasks made from the message become their AI's check only then (else a note on each).
   * Absent: on (the company default).
   */
  autoRunFor?: (companyId: string, userId: string) => boolean
}

/** A message we sent first and wait an answer to (outbound-mail.md "Waiting for their answer"). */
export interface OwnMessageAwaiting {
  companyId: string
  /** The sender: the 返事のお願い's assignee. */
  userId: string
  /** The interaction the mail service recorded for the sent mail. */
  interactionId: string
  channel: InboxChannel
  /** Our message's id in the inbox's terms (mail: the Message-ID we gave it). */
  messageId: string
  sourceRef: string
  occurredAt: string
  /** 返事の見込み (`wait_until`): the day the member picked, its morning. */
  waitUntil: string
  title: string
  /** 待っているもの: 「〇〇さんからの返事」. */
  waitingOn: string
  /** The first To address (名寄せ when the interaction has no 相手). */
  to: string | null
  /** The task the mail came from, when there is one. */
  taskId: string | null
}

/** What a 返事のお願い for a mail we sent first ends on (the AI checks their answer against it). */
export const AWAITED_END_CONDITION = '送ったメールに相手から返事が来て、こちらがすることがなくなったら終わり（返事の中身で、次にすることがあれば担当に渡す）'

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g
const oneLine = (s: string, max: number) => s.normalize('NFC').replace(CONTROL_RE, ' ').trim().slice(0, max)

function fieldsOf(handle: CompanyData, id: string): { state: string | null; version: number; fields: Record<string, LedgerValue> } {
  const s = handle.records.states([id])[0]
  let fields: Record<string, LedgerValue> = {}
  try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
  return { state: s?.state ?? null, version: s?.version ?? 0, fields }
}

/** A message as the connector sent it, checked; null when it is not one (logged as a count only). */
function readMessage(m: unknown): IncomingMessage | null {
  if (!isObject(m)) return null
  if (!INBOX_CHANNELS.includes(m.channel as InboxChannel)) return null
  if (typeof m.messageId !== 'string' || m.messageId === '' || m.messageId.length > INBOX_LIMITS.messageId) return null
  if (typeof m.sourceRef !== 'string' || m.sourceRef === '' || m.sourceRef.length > INBOX_LIMITS.sourceRef) return null
  if (typeof m.occurredAt !== 'string' || Number.isNaN(Date.parse(m.occurredAt))) return null
  const party = (p: unknown): IncomingParty | null => (isObject(p) && typeof p.address === 'string' && p.address !== '' && p.address.length <= 320
    ? { address: p.address, memberId: str(p.memberId), name: typeof p.name === 'string' ? p.name : null } : null)
  const from = party(m.from)
  if (!from) return null
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, INBOX_LIMITS.parties).map(party).filter((p): p is IncomingParty => p !== null) : [])
  return {
    channel: m.channel as InboxChannel,
    messageId: m.messageId,
    references: Array.isArray(m.references) ? m.references.filter((r): r is string => typeof r === 'string' && r !== '' && r.length <= INBOX_LIMITS.messageId).slice(-INBOX_LIMITS.references) : [],
    threadRef: typeof m.threadRef === 'string' && m.threadRef.length <= INBOX_LIMITS.sourceRef ? m.threadRef : null,
    sourceRef: m.sourceRef,
    occurredAt: new Date(m.occurredAt).toISOString(),
    subject: typeof m.subject === 'string' ? m.subject : null,
    from,
    senderAddress: typeof m.senderAddress === 'string' && m.senderAddress.length <= 320 ? m.senderAddress : null,
    to: list(m.to),
    cc: list(m.cc),
    outgoing: m.outgoing === true,
    bulk: m.bulk === true,
    automated: m.automated === true,
    spam: m.spam === true,
  }
}

export function createInboxService(deps: InboxDeps) {
  const { companyData, clock } = deps
  const sources = new Map<string, InboxSource>()
  const handleOf = (companyId: string) => companyData.forCompany(companyId)
  const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
  const disabled = () => refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })

  /** The settings in force (a stored document that no longer validates reads as the defaults). */
  function settingsOf(companyId: string): IntakeSettings {
    const stored = handleOf(companyId).inbox.settings()
    if (!stored) return defaultIntakeSettings()
    let raw: unknown
    try { raw = JSON.parse(stored.settings) } catch { raw = null }
    const r = parseIntakeSettings(raw)
    if ('error' in r) {
      console.warn(`[inbox] stored intake settings of company ${companyId} are invalid; using the defaults`)
      return defaultIntakeSettings()
    }
    return r.value
  }

  /** A member as their own record reader sees them; null when they are no member. */
  function memberOf(companyId: string, userId: string): Member | null {
    const role = deps.roleOf(companyId, userId)
    return role === null ? null : { companyId, userId, role }
  }

  /** A live record of `type` the member reads, or null (missing, unreadable, another type: one answer). */
  function readable(member: Member, recordId: unknown, type: string): { handle: CompanyData; row: RecordRow } | null {
    if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return null
    const handle = handleOf(member.companyId)
    const row = handle.records.byIds([recordId])[0]
    if (!row || row.removedAt !== null || row.type !== type) return null
    if (!recordReader(member, handle.scopes.listWithRules()).record(row)) return null
    return { handle, row }
  }

  /** Parties with the member each is (the connector's word when it is a member here, else by address). */
  function matchParties(companyId: string, parties: readonly IncomingParty[], byEmail: Map<string, string>): RoutedParty[] {
    return parties.map(p => {
      const given = p.memberId && deps.roleOf(companyId, p.memberId) !== null ? p.memberId : null
      const email = normalizeEmail(p.address)
      return { address: email ?? p.address, memberId: given ?? (email ? byEmail.get(email) ?? null : null) }
    })
  }

  /** The 相手 to link: the one person by address, else the one company by its domain, as the owner may see them. */
  function counterpartOf(owner: Member, address: string | null): string[] {
    if (!address) return []
    const r = deps.resolveAddress(owner, address)
    if (!r.ok) return []
    if (r.value.person.length === 1) return [r.value.person[0]]
    if (r.value.company.length === 1) return [r.value.company[0]]
    return []
  }

  const addressList = (parties: readonly RoutedParty[]): string | null => {
    const kept = parties.slice(0, INBOX_LIMITS.keptAddresses).map(p => p.address).filter((a): a is string => !!a)
    if (kept.length === 0) return null
    const text = JSON.stringify(parties.length > kept.length ? [...kept, `+${parties.length - kept.length}`] : kept)
    return text.length <= 500 ? text : JSON.stringify(kept.slice(0, 5))
  }

  /** The non-final reply requests of an interaction (any reader: the service acts for the inbox). */
  function replyRequestsOf(handle: CompanyData, interactionId: string): Array<{ id: string; state: string | null; version: number; fields: Record<string, LedgerValue> }> {
    return handle.records.candidates({ types: ['reply_request'], link: { name: 'interaction', id: interactionId } }, 50)
      .map(r => ({ id: r.id, ...fieldsOf(handle, r.id) }))
      .filter(r => r.state !== 'closed' && r.state !== 'dropped')
  }

  /** The assignee of the task a 返事のお願い came from (its `task` link: a mail we sent first from a task), if any. */
  function taskAssigneeOf(handle: CompanyData, replyRequestId: string): string[] {
    const task = handle.records.linksFrom([replyRequestId]).find(l => l.name === 'task' && l.targetId)?.targetId
    if (!task) return []
    const assignee = fieldsOf(handle, task).fields.assignee
    return typeof assignee === 'string' && assignee !== '' ? [assignee] : []
  }

  /**
   * The tasks the member's own reply may have finished (owner FB #19): made from this message (its
   * `interaction` link), the member's (assignee), readable by them, open and theirs to work on
   * (`REPLY_CHECK_TASK_STATES`). Never another's task.
   */
  function replyCheckTasks(member: Member, handle: CompanyData, interactionId: string) {
    const reader = recordReader(member, handle.scopes.listWithRules())
    const ids = handle.records.candidates({ types: ['task'], link: { name: 'interaction', id: interactionId } }, 50).map(r => r.id)
    return handle.records.byIds(ids)
      .filter(r => r.type === 'task' && r.removedAt === null && reader.record(r))
      .map(r => ({ row: r, ...fieldsOf(handle, r.id) }))
      .filter(t => t.fields.assignee === member.userId && REPLY_CHECK_TASK_STATES.includes(t.state ?? ''))
      .map(t => ({ id: t.row.id, title: t.row.title, state: t.state, version: t.version, canComplete: t.fields.when_done !== 'check' }))
  }

  /**
   * The member's own reply was seen in the thread (owner FB #19): tasks made from the message that are
   * still theirs to do become their AI's check — the interaction goes to 「返事のあとを確かめる」
   * (`replied`, an AI turn on their PC, run when the app opens) — or, with their 自動で進める off,
   * each gets the note 「返事は済み」 and the member decides. Only the interaction's own assignee's
   * reply, only from 対応済み.
   */
  function afterOwnReply(companyId: string, handle: CompanyData, interactionId: string, replierId: string, channel: InboxChannel): void {
    const cur = fieldsOf(handle, interactionId)
    if (cur.state !== 'handled' || cur.fields.assignee !== replierId) return
    const member = memberOf(companyId, replierId)
    if (!member) return
    const tasks = replyCheckTasks(member, handle, interactionId)
    if (tasks.length === 0) return
    if (deps.autoRunFor?.(companyId, replierId) ?? true) {
      logFailure('reply check', deps.writer.transition(companyId, {
        recordId: interactionId, action: INBOX_ACTIONS.replySeen, expectedVersion: cur.version, to: 'replied',
        actor: INBOX_ACTOR, note: REPLIED_THERE[channel], quiet: true,
      }))
      return
    }
    for (const t of tasks) {
      logFailure('reply noted', deps.writer.transition(companyId, {
        recordId: t.id, action: INBOX_ACTIONS.replyNoted, expectedVersion: t.version, to: null, actor: INBOX_ACTOR,
        note: `${REPLY_NOTED}（${REPLIED_THERE[channel]}）`, quiet: true,
      }))
    }
  }

  /** The interaction itself, or a 返事のお願い's interaction — both read by the member; else null. */
  function interactionFor(member: Member, handle: CompanyData, recordId: string): RecordRow | null {
    const own = readable(member, recordId, 'interaction')
    if (own) return own.row
    const request = readable(member, recordId, 'reply_request')
    if (!request) return null
    const linked = handle.records.linksFrom([request.row.id]).find(l => l.name === 'interaction' && l.targetId)
    return linked ? readable(member, linked.targetId, 'interaction')?.row ?? null : null
  }

  /** What the AI sees of an interaction: pointers, its state, what was made for it — only what the member reads. */
  function itemView(member: Member, handle: CompanyData, row: RecordRow): InboxItemView {
    const { state, version, fields } = fieldsOf(handle, row.id)
    const reader = recordReader(member, handle.scopes.listWithRules())
    const live = (ids: string[]) => handle.records.byIds(ids).filter(r => r.removedAt === null && reader.record(r))
    const tasks = live(handle.records.candidates({ types: ['task'], link: { name: 'interaction', id: row.id } }, 20).map(r => r.id))
    const requests = replyRequestsOf(handle, row.id)
    const readableRequests = new Set(live(requests.map(r => r.id)).map(r => r.id))
    const cp = handle.records.linksFrom([row.id]).find(l => l.name === 'counterpart' && l.targetId)
    const counterpart = cp ? live([cp.targetId as string])[0] ?? null : null
    return {
      recordId: row.id, channel: str(fields.channel), threadRef: str(fields.thread_ref), sourceRef: str(fields.source_ref),
      messages: handle.inbox.messagesOf(row.id).map(m => ({ messageId: m.messageId, direction: m.direction, occurredAt: m.occurredAt })),
      state, version, title: row.title,
      replyRequests: requests.filter(r => readableRequests.has(r.id)).map(r => ({ id: r.id, state: r.state })),
      tasks: tasks.map(t => ({ id: t.id, title: t.title })),
      counterpart: counterpart ? { id: counterpart.id, title: counterpart.title } : null,
      ...(state === 'replied' ? { replyCheck: { tasks: replyCheckTasks(member, handle, row.id) } } : {}),
    }
  }

  /** The clock moved it out of 返事待ち (WAIT_OVER) and it has not gone back to waiting since: a follow-up (B5). */
  function followingUp(handle: CompanyData, replyRequestId: string): boolean {
    const ledger = handle.records.ledger(replyRequestId)
    const lastOver = ledger.map(e => e.action).lastIndexOf(WAIT_OVER_ACTION)
    const lastWait = ledger.map(e => e.toState).lastIndexOf('waiting_reply')
    return lastOver >= 0 && lastOver > lastWait
  }

  /** What a 返事のお願い is in the AI's turn for (B5): the item view tells the PC's AI. */
  function requestView(handle: CompanyData, id: string): NonNullable<InboxItemView['request']> {
    const { state, version, fields } = fieldsOf(handle, id)
    const purpose = state === 'checking' ? 'check_reply' : state === 'preparing' ? (followingUp(handle, id) ? 'follow_up' : 'draft') : 'none'
    return {
      id, state, version, purpose, waitUntil: str(fields.wait_until), due: str(fields.due), endCondition: str(fields.end_condition), triggerKind: str(fields.trigger_kind),
    }
  }

  /**
   * The 返事のお願い's prepared drafts still in 下書き — and, with `alsoThread`, every reply draft to its
   * 連絡 (the card's own, outbound-mail.md "Replies") — discarded: the reply went out elsewhere, so
   * none is offered to send a second time.
   */
  function discardDrafts(companyId: string, handle: CompanyData, replyRequestId: string, note: string, alsoThread = false): void {
    const links = handle.records.linksFrom([replyRequestId])
    const ids = new Set(links.filter(l => l.name === 'prepared' && l.targetId).map(l => l.targetId as string))
    const interactionId = links.find(l => l.name === 'interaction' && l.targetId)?.targetId
    if (alsoThread && interactionId) {
      for (const r of handle.records.candidates({ types: ['outbound_message'], link: { name: 'interaction', id: interactionId } }, 50)) ids.add(r.id)
    }
    for (const row of handle.records.byIds([...ids])) {
      if (row.type !== 'outbound_message' || row.removedAt !== null) continue
      const cur = fieldsOf(handle, row.id)
      if (cur.state !== 'draft') continue
      logFailure('draft discarded', deps.writer.transition(companyId, {
        recordId: row.id, action: INBOX_ACTIONS.memberReplied, expectedVersion: cur.version, to: 'discarded',
        actor: INBOX_ACTOR, note, quiet: true,
      }))
    }
  }

  function logFailure(what: string, r: ServiceWriteResult) {
    if (!r.ok) console.warn(`[inbox] ${what} not written: ${r.reason}`)
  }

  /** The thread went on: a message answering one the interaction already has. */
  function continueThread(companyId: string, handle: CompanyData, interaction: RecordRow, msg: IncomingMessage, fromMember: string | null, outgoing: boolean, reporterId: string): void {
    const at = clock.now()
    handle.inbox.insertMessage({
      channel: msg.channel, messageId: msg.messageId, interactionId: interaction.id, direction: outgoing ? 'out' : 'in', occurredAt: msg.occurredAt, seenAt: at,
      sourceRef: msg.sourceRef, reporterId,
    })
    const replies = replyRequestsOf(handle, interaction.id)
    if (outgoing) {
      // Someone of the company replied in the thread (spec §7-3: 返事と終わりは別 — the AI checks, or the setting ends it).
      const close = settingsOf(companyId).memberReply === 'close'
      // Who replied is named only when they can read the record (someone's own record never names another reader).
      const replier = memberOf(companyId, fromMember ?? reporterId)
      const mayName = (id: string) => {
        const row = handle.records.byIds([id])[0]
        return !!replier && !!row && recordReader(replier, handle.scopes.listWithRules()).record(row)
      }
      for (const r of replies) {
        const to = close ? 'closed' : (r.state === 'preparing' || r.state === 'open' ? 'checking' : null)
        if (to === null) continue
        const moved = deps.writer.transition(companyId, {
          recordId: r.id, action: INBOX_ACTIONS.memberReplied, expectedVersion: r.version, to,
          fields: { trigger_kind: 'our_reply', trigger_ref: msg.sourceRef, ...(replier && mayName(r.id) ? { replied_by: replier.userId } : {}) },
          actor: INBOX_ACTOR, note: REPLIED_THERE[msg.channel], quiet: to === 'checking',
        })
        logFailure('member reply', moved)
        // The reply went out there: a draft made for it is never offered to send.
        if (moved.ok) discardDrafts(companyId, handle, r.id, REPLIED_THERE[msg.channel], true)
      }
      // Not judged yet (or 確認待ち): the member answered it themselves — nothing is left to do.
      const cur = fieldsOf(handle, interaction.id)
      if (replies.length === 0 && (cur.state === 'received' || cur.state === 'unsure')) {
        logFailure('replied before judged', deps.writer.transition(companyId, {
          recordId: interaction.id, action: INBOX_ACTIONS.memberReplied, expectedVersion: cur.version, to: 'handled',
          fields: { needs_reply: false }, actor: INBOX_ACTOR, note: REPLIED_THERE[msg.channel], quiet: true,
        }))
      }
      // Tasks made from the message: did the reply finish them? (Their AI checks; owner FB #19.)
      afterOwnReply(companyId, handle, interaction.id, fromMember ?? reporterId, msg.channel)
      return
    }
    // An automatic reply is no reply (spec §7-3).
    if (msg.automated || msg.bulk) return
    // 返事待ち, or a nudge being drafted or handed over after 返事の見込み passed (B5): the reply came.
    const waiting = replies.filter(r => r.state === 'waiting_reply' || ((r.state === 'preparing' || r.state === 'open') && followingUp(handle, r.id)))
    for (const r of waiting) {
      const moved = deps.writer.transition(companyId, {
        recordId: r.id, action: INBOX_ACTIONS.replyArrived, expectedVersion: r.version, to: 'checking',
        fields: { trigger_kind: 'their_reply', trigger_ref: msg.sourceRef }, actor: INBOX_ACTOR, note: '',
        // The assignee hears 「返事が来た」 (notice `reply_arrived`); the AI's check is their AI's turn.
        // A mail we sent first from a task: that task's assignee hears it too (a notice reaches only a reader).
        notify: [...(typeof r.fields.assignee === 'string' ? [r.fields.assignee] : []), ...taskAssigneeOf(handle, r.id)],
      })
      logFailure('reply arrived', moved)
      // A nudge drafted for it is no longer wanted: never offered to send.
      if (moved.ok && r.state !== 'waiting_reply') discardDrafts(companyId, handle, r.id, '相手から返事が来ました')
    }
    if (replies.length > 0) return
    // Nothing open about it: a handled interaction is the AI's to judge again — and no longer the
    // member's 「済んだ」 (`settled_by`, interaction 6: what 今日終わったこと lists).
    const cur = fieldsOf(handle, interaction.id)
    if (cur.state === 'handled' && typeof cur.fields.assignee === 'string') {
      logFailure('continued', deps.writer.transition(companyId, {
        recordId: interaction.id, action: INBOX_ACTIONS.continued, expectedVersion: cur.version, to: 'received', actor: INBOX_ACTOR, note: '', quiet: true,
        ...(cur.fields.settled_by ? { fields: { settled_by: null } } : {}),
      }))
    }
  }

  /** One message (inbox.md "Receiving"): never throws; the outcome is a word, nothing of the message. */
  function receive(companyId: string, reporterId: string, raw: unknown): IntakeOutcome {
    const msg = readMessage(raw)
    if (!msg) { console.warn('[inbox] a message without the required pointers was skipped'); return 'skipped' }
    const handle = handleOf(companyId)
    if (!handle.records.settings().enabled) return 'skipped'
    if (deps.roleOf(companyId, reporterId) === null) return 'skipped'
    if (handle.inbox.message(msg.channel, msg.messageId)) return 'duplicate'
    const settings = settingsOf(companyId)
    const members = deps.memberAddresses(companyId)
    const byEmail = new Map<string, string>()
    for (const m of members) { const e = normalizeEmail(m.email); if (e && !byEmail.has(e)) byEmail.set(e, m.userId) }
    const [from] = matchParties(companyId, [msg.from], byEmail)
    const to = matchParties(companyId, msg.to, byEmail)
    const cc = matchParties(companyId, msg.cc ?? [], byEmail)
    const outgoing = msg.outgoing === true || from.memberId !== null

    // A thread the company already has: the same interaction — when it concerns its owner.
    const reporterAndRecipients = new Set([reporterId, ...[...to, ...cc].map(p => p.memberId).filter((m): m is string => !!m)])
    const reporter = memberOf(companyId, reporterId)
    const reporterReads = (row: RecordRow) => !!reporter && recordReader(reporter, handle.scopes.listWithRules()).record(row)
    for (const id of handle.inbox.interactionsOf(msg.channel, msg.references ?? [])) {
      const row = handle.records.byIds([id])[0]
      if (!row || row.removedAt !== null || row.type !== 'interaction') continue
      // Someone's own interaction takes the other side's message only when it reached its owner
      // (a reply that went to another member alone is not the owner's to hear of).
      if (!outgoing && row.personalOwner !== null && !reporterAndRecipients.has(row.personalOwner)) continue
      // A members-only one only when it reached someone on its list (never as if it were the company's).
      if (row.members !== null && !row.members.some(u => reporterAndRecipients.has(u))) continue
      // The reporter's own message (their Sent mail, their own chat message) touches only a record
      // they read: another member's sent mail never moves someone else's records. Nothing is kept,
      // so the copy that reached the owner (their inbox) is still taken when it comes.
      if (msg.outgoing === true && !reporterReads(row)) continue
      continueThread(companyId, handle, row, msg, from.memberId, outgoing, reporterId)
      return 'continued'
    }
    // A member's plain (unthreaded) message in a chat DM answers the latest message they got there
    // within DM_REPLY_WINDOW_MS (Slack DMs are seldom threaded).
    if (outgoing && msg.channel === 'chat' && (msg.references ?? []).length === 0) {
      const dm = /^(D[A-Z0-9]{1,40}):/.exec(msg.messageId)
      const since = new Date(Date.parse(msg.occurredAt) - DM_REPLY_WINDOW_MS).toISOString()
      const last = dm ? handle.inbox.latestIncoming('chat', `${dm[1]}:`, since, msg.occurredAt) : null
      const row = last ? handle.records.byIds([last.interactionId])[0] : undefined
      if (row && row.removedAt === null && row.type === 'interaction' && (row.personalOwner === null || row.personalOwner === reporterId)
        && (row.members === null || row.members.includes(reporterId))) {
        continueThread(companyId, handle, row, msg, from.memberId, outgoing, reporterId)
        return 'continued'
      }
    }
    // What the company sends is not intake (a sent mail's receipt is the mail service's).
    if (outgoing) return 'skipped'

    const decision = routeIncoming(settings, {
      from, to, cc, reporterId, bulk: msg.bulk === true, automated: msg.automated === true, spam: msg.spam === true,
      // 社内どうし is mail's rule: a colleague's Slack DM or mention to the member is what chat intake is for.
      internalDomains: msg.channel === 'email' ? companyDomains(settings, members.map(m => m.email)) : [],
    })
    if (decision.kind === 'skip') return 'skipped'

    const title = oneLine(msg.subject ?? '', INBOX_LIMITS.title) || SUBJECT_NONE
    const owner = decision.kind === 'member' ? memberOf(companyId, decision.owner) : null
    if (decision.kind === 'member' && !owner) return 'skipped'
    const fields: Record<string, LedgerValue> = {
      occurred_at: msg.occurredAt,
      channel: msg.channel === 'email' ? 'email' : 'chat',
      // Chat: the sender's name only (the app shows 「<name> から」; a Slack user id says nothing to a member).
      counterpart_text: msg.channel === 'chat'
        ? oneLine(msg.from.name ?? '', 200) || null
        : oneLine(msg.from.name ? `${msg.from.name} <${from.address ?? ''}>` : from.address ?? '', 200) || null,
      source_ref: msg.sourceRef,
      message_id: msg.messageId.slice(0, 500),
      thread_ref: msg.threadRef ?? null,
      from_address: (from.address ?? '').slice(0, 320) || null,
      to_addresses: addressList(to),
      cc_addresses: addressList(cc),
      intake_reason: decision.reason,
    }
    if (owner) { fields.assignee = owner.userId; fields.next_actor = owner.userId }
    const state = decision.kind === 'member' ? decision.state : 'unclaimed'
    const made = deps.writer.create(companyId, {
      type: 'interaction', title,
      ...(owner ? { personalOwner: owner.userId } : { folder: decision.kind === 'department' ? decision.folder : null }),
      fields,
      links: owner ? { counterpart: counterpartOf(owner, from.address) } : {},
      actor: INBOX_ACTOR,
      state,
      // 「届いた」 is the AI's turn and 「やることにしなかった」 nobody's: no notice. 確認待ち tells its owner (`intake_unsure`).
      quiet: state !== 'unsure',
    })
    if (!made.ok) { logFailure('interaction', made); return 'skipped' }
    handle.inbox.insertMessage({
      channel: msg.channel, messageId: msg.messageId, interactionId: made.record.id, direction: 'in', occurredAt: msg.occurredAt, seenAt: clock.now(),
      sourceRef: msg.sourceRef, reporterId,
    })
    return 'created'
  }

  /**
   * We sent first and wait for their answer (outbound-mail.md "Waiting for their answer"): our own
   * message joins the interaction the mail service recorded for it (its id is what their reply
   * references), and a 返事のお願い starts in 返事待ち until `waitUntil` for the sender — placed like
   * the interaction, linked to it, its まとまり, the 相手 (the interaction's, else 名寄せ of `to`) and
   * the task the mail came from. From here the machinery is the usual one: their reply → `checking`,
   * silence past `waitUntil` → the clock's follow-up (B5). Never throws; null when nothing was made.
   */
  function awaitOwnMessage(input: OwnMessageAwaiting): string | null {
    const { companyId, userId } = input
    const handle = handleOf(companyId)
    if (!handle.records.settings().enabled) return null
    const member = memberOf(companyId, userId)
    if (!member) return null
    const interaction = handle.records.byIds([input.interactionId])[0]
    if (!interaction || interaction.removedAt !== null || interaction.type !== 'interaction') return null
    if (handle.inbox.message(input.channel, input.messageId)) return null
    handle.inbox.insertMessage({
      channel: input.channel, messageId: input.messageId, interactionId: interaction.id, direction: 'out', occurredAt: input.occurredAt, seenAt: clock.now(),
      sourceRef: input.sourceRef, reporterId: userId,
    })
    const links = handle.records.linksFrom([interaction.id])
    const linked = (name: string) => links.filter(l => l.name === name && l.targetId).map(l => l.targetId as string).slice(0, 1)
    const counterpart = linked('counterpart').length > 0 ? linked('counterpart') : counterpartOf(member, input.to)
    // The task only when the sender reads it (the mail service checked; checked again here).
    const task = input.taskId ? readable(member, input.taskId, 'task') : null
    const made = deps.writer.create(companyId, {
      type: 'reply_request', title: oneLine(input.title, INBOX_LIMITS.title) || SUBJECT_NONE,
      ...placeOfRow(interaction),
      fields: {
        assignee: userId, occurred_at: input.occurredAt, wait_until: input.waitUntil,
        waiting_on: oneLine(input.waitingOn, 200) || null, end_condition: AWAITED_END_CONDITION,
      },
      links: { interaction: [interaction.id], counterpart, bundle: linked('bundle'), ...(task ? { task: [task.row.id] } : {}) },
      actor: { id: userId, kind: 'human', source: null }, state: 'waiting_reply',
      // The sender chose it on the send screen: nobody else's turn, nothing to tell.
      quiet: true,
    })
    if (!made.ok) { logFailure('awaited reply request', made); return null }
    return made.record.id
  }

  /**
   * The connected services whose notification mails the member's mail intake leaves out (owner FB
   * #18, inbox.md "Notification mails of connected services"): a built-in connector's senders while
   * it serves the role whose own intake brings the thing in (Slack's only for a member whose grant
   * reads), and what installed, on connector plugins declare. A failing lookup leaves that one out
   * (the mail is then taken in as before: never lost).
   */
  async function notifiersFor(companyId: string, userId: string): Promise<ConnectedNotifier[]> {
    const out: ConnectedNotifier[] = []
    if (deps.roles) {
      for (const [connectorId, entries] of Object.entries(BUILTIN_NOTIFICATION_SENDERS)) {
        for (const e of entries) {
          const r = await deps.roles.resolve(companyId, e.role, e.operation).catch(() => null)
          if (!r?.ok || r.connectorId !== connectorId) continue
          if (e.perMember && !deps.connectorReadsFor?.(companyId, userId, connectorId)) continue
          out.push({ service: e.service, from: e.from, sender: e.sender })
        }
      }
    }
    if (deps.pluginNotifiers) out.push(...await deps.pluginNotifiers(companyId).catch(() => []))
    return out
  }

  // -------------------------------------------------------------------------------------------
  // Mail archived in the mailbox (owner decision 2026-11-05, inbox.md "Mail archived in the mailbox").

  /** Records already checked at a cursor the poll could not finish in one look (memory only: a restart checks again). */
  const checkedAt = new Map<string, Set<string>>()
  /** Interactions whose mailbox follow-up is running: a second one at once does nothing (one call, one notice). */
  const inFlight = new Set<string>()

  /** Archive calls still running (afterAct cannot wait for Google): tests and shutdown wait on them. */
  const running = new Set<Promise<void>>()
  const track = (p: Promise<void>) => {
    const done = p.catch(e => { console.warn(`[inbox] mailbox follow-up failed: ${e instanceof Error ? e.name : 'error'}`) }).finally(() => { running.delete(done) })
    running.add(done)
  }

  /**
   * The mailbox an email interaction's pointer is in, when it is its owner's own: the record is
   * someone's own (`personal_owner`), its first message was reported by that same member (their
   * poll read it from their mailbox), and it has a thread pointer. Anything else (a department's
   * mail, mail read from another member's mailbox, rows from before the reporter was kept): null —
   * never another member's permission.
   */
  function ownMailbox(handle: CompanyData, row: RecordRow): { owner: string; threadRef: string; fields: Record<string, LedgerValue>; state: string | null; version: number } | null {
    if (row.type !== 'interaction' || row.removedAt !== null || row.personalOwner === null) return null
    const cur = fieldsOf(handle, row.id)
    const threadRef = str(cur.fields.thread_ref)
    if (cur.fields.channel !== 'email' || !threadRef || cur.fields.assignee !== row.personalOwner) return null
    const first = handle.inbox.messagesOf(row.id).find(m => m.sourceRef !== null && m.sourceRef === cur.fields.source_ref)
    if (!first || first.reporterId !== row.personalOwner) return null
    return { owner: row.personalOwner, threadRef, fields: cur.fields, state: cur.state, version: cur.version }
  }

  /** Work still open about a message: a task made from it not finished, or a 返事のお願い not ended. */
  function openWork(handle: CompanyData, interactionId: string): { tasks: number; replies: number } {
    const taskIds = handle.records.candidates({ types: ['task'], link: { name: 'interaction', id: interactionId } }, 50).map(r => r.id)
    const states = handle.records.byIds(taskIds).filter(r => r.removedAt === null).map(r => fieldsOf(handle, r.id).state ?? '')
    const replies = replyRequestsOf(handle, interactionId).filter(r => !REPLY_FINAL.includes(r.state ?? '')).length
    return { tasks: states.filter(st => !TASK_FINAL.includes(st)).length, replies }
  }

  /** When the newest message of the thread was seen (later entries are about what is there now). */
  const lastSeenOf = (handle: CompanyData, id: string) => handle.inbox.messagesOf(id).map(m => m.seenAt).sort().at(-1) ?? ''

  /** ACB archived it there since the thread's newest message (`archived_there`). */
  const archivedByUsSince = (handle: CompanyData, id: string) => {
    const since = lastSeenOf(handle, id)
    return handle.records.ledger(id).some(e => e.action === INBOX_ACTIONS.archivedThere && e.at >= since)
  }

  /** The member undid an entry with this action since the thread's newest message: they want it as it is. */
  function undoneSince(handle: CompanyData, id: string, action: string): boolean {
    const ledger = handle.records.ledger(id)
    const since = lastSeenOf(handle, id)
    return ledger.some(e => e.action === 'undo' && e.at >= since && ledger.find(x => x.version === e.reversesVersion)?.action === action)
  }

  /**
   * Gmail → ACB: the member's mail left their mailbox inbox (archived, trashed, deleted there). Nothing
   * was made from it → closed (`left_inbox`, as the inbox — never the member; `settled_by` untouched)
   * and its owner told with ［元に戻す］; a task or 返事のお願い still open → only the note
   * 「Gmail ではアーカイブ済み」 (people who keep an empty inbox archive mail that still needs work).
   */
  function mailLeftInbox(companyId: string, handle: CompanyData, row: RecordRow, label: string): 'closed' | 'noted' | 'none' {
    const mine = ownMailbox(handle, row)
    if (!mine) return 'none'
    // ACB took it out of the mailbox itself (the member closed it here, then may have taken that
    // back): the mailbox's change is ours — never a reason to close or note it again.
    if (archivedByUsSince(handle, row.id)) return 'none'
    const work = openWork(handle, row.id)
    const note = leftInboxNote(label)
    if (work.tasks > 0 || work.replies > 0) {
      const since = lastSeenOf(handle, row.id)
      if (handle.records.ledger(row.id).some(e => e.action === INBOX_ACTIONS.leftInboxNoted && e.at >= since)) return 'none'
      const r = deps.writer.transition(companyId, { recordId: row.id, action: INBOX_ACTIONS.leftInboxNoted, expectedVersion: mine.version, to: null, actor: INBOX_ACTOR, note, quiet: true })
      logFailure('left inbox noted', r)
      return r.ok ? 'noted' : 'none'
    }
    if (!LEFT_CLOSES_FROM.includes(mine.state ?? '')) return 'none'
    // The member took a close like this back: it stays open until the thread goes on.
    if (undoneSince(handle, row.id, INBOX_ACTIONS.leftInbox)) return 'none'
    const r = deps.writer.transition(companyId, {
      recordId: row.id, action: INBOX_ACTIONS.leftInbox, expectedVersion: mine.version, to: 'handled', actor: INBOX_ACTOR, note,
      // Its owner hears it, with ［元に戻す］ (the undo of this entry, UNDO_BY_ASSIGNEE).
      notify: [mine.owner],
    })
    logFailure('left inbox', r)
    return r.ok ? 'closed' : 'none'
  }

  /** The member's own email interactions worth checking: what a left inbox would close or note. */
  function leftWatched(handle: CompanyData, userId: string, threadRefs: string[] | null): Array<{ row: RecordRow; threadRef: string }> {
    const rows = handle.records.byIds(handle.records.candidates({
      types: ['interaction'], states: LEFT_WATCHED_STATES,
      fields: [{ name: 'assignee', values: [userId] }, ...(threadRefs ? [{ name: 'thread_ref', values: threadRefs.slice(0, 500) }] : [])],
    }, 200).map(r => r.id))
    const out: Array<{ row: RecordRow; threadRef: string }> = []
    for (const row of rows) {
      const mine = ownMailbox(handle, row)
      if (!mine || mine.owner !== userId) continue
      if (archivedByUsSince(handle, row.id)) continue
      const work = openWork(handle, row.id)
      const open = work.tasks > 0 || work.replies > 0
      if (!open && !LEFT_CLOSES_FROM.includes(mine.state ?? '')) continue
      // Noted already for this thread state: nothing more to do with it.
      if (open && handle.records.ledger(row.id).some(e => e.action === INBOX_ACTIONS.leftInboxNoted && e.at >= lastSeenOf(handle, row.id))) continue
      out.push({ row, threadRef: mine.threadRef })
    }
    return out
  }

  /**
   * One member's look at what left their mailbox inbox (the poll, after reading new mail): the
   * source's change log since the stored cursor names the conversations; only the member's own
   * watched records among them are checked (`inInbox`, at most LEFT_CHECK_MAX). Without a cursor (or
   * one too old) the watched records themselves are checked, newest first, within the same limit.
   * The cursor moves only after a successful look.
   */
  async function syncLeft(companyId: string, userId: string, source: InboxSource): Promise<number> {
    if (!source.leftSince || !source.inInbox) return 0
    const handle = handleOf(companyId)
    const conn = handle.inbox.connection(userId, 'email')
    if (!conn) return 0
    const look = await source.leftSince(companyId, userId, conn.leftCursor ?? null).catch(() => 'not-connected' as const)
    if (look === 'not-connected') return 0
    const watched = (look.threadRefs === null || look.threadRefs.length > 0) ? leftWatched(handle, userId, look.threadRefs) : []
    // More than one look checks: the ones not checked yet at this starting point go first, and the
    // cursor stays until every one was checked (the next polls go on), so none is skipped.
    const key = `${companyId}|${userId}|${conn.leftCursor ?? ''}`
    const seen = checkedAt.get(key) ?? new Set<string>()
    const pending = watched.filter(w => !seen.has(w.row.id))
    const checked = (pending.length > 0 ? pending : watched).slice(0, LEFT_CHECK_MAX)
    const finished = pending.length <= LEFT_CHECK_MAX
    let changed = 0
    if (checked.length > 0) {
      const state = await source.inInbox(companyId, userId, [...new Set(checked.map(c => c.threadRef))]).catch(() => 'not-connected' as const)
      if (state === 'not-connected') return 0
      for (const c of checked) {
        if (state[c.threadRef] !== false) continue
        if (mailLeftInbox(companyId, handle, c.row, source.label ?? DEFAULT_MAILBOX_LABEL) !== 'none') changed++
      }
    }
    if (!finished) {
      for (const c of checked) seen.add(c.row.id)
      checkedAt.set(key, seen)
      console.info(`[inbox] mail left the inbox: ${pending.length - checked.length} left for the next look`)
      return changed
    }
    checkedAt.delete(key)
    handle.inbox.setLeftCursor(userId, 'email', look.cursor)
    return changed
  }

  /**
   * ACB → Gmail (owner decision 2026-11-05, opt-in): a message its owner closed here — their own
   * 「済んだ」, 「取り込まない」 or another action of theirs into 対応済み / やることにしなかった, or every
   * task made from it finished — is archived in their own mailbox with their own permission (the
   * source refuses without it: `not-allowed`, nothing sent). Never when work is still open, never
   * when the inbox closed it because the mailbox had already archived it (no loop), never twice
   * for the same thread state, never another member's mailbox.
   */
  async function archiveThere(companyId: string, interactionId: string): Promise<void> {
    const flight = `${companyId}|${interactionId}`
    if (inFlight.has(flight)) return
    inFlight.add(flight)
    try { await archiveThereOnce(companyId, interactionId) } finally { inFlight.delete(flight) }
  }

  /** The owner's own messages of an interaction ACB took in (their pointers): what is archived there, never more. */
  const knownRefs = (handle: CompanyData, interactionId: string, owner: string) =>
    handle.inbox.messagesOf(interactionId).filter(m => m.reporterId === owner && m.sourceRef !== null).map(m => m.sourceRef as string)

  async function archiveThereOnce(companyId: string, interactionId: string): Promise<void> {
    const handle = handleOf(companyId)
    const row = handle.records.byIds([interactionId])[0]
    if (!row) return
    const mine = ownMailbox(handle, row)
    if (!mine || !CLOSED_STATES.includes(mine.state ?? '')) return
    const work = openWork(handle, interactionId)
    if (work.tasks > 0 || work.replies > 0) return
    const ledger = handle.records.ledger(interactionId)
    const since = lastSeenOf(handle, interactionId)
    // The mailbox had archived it already (the inbox closed or noted it for that): nothing to do
    // there — and no loop. Once per thread state: archived since its newest message, or put back.
    const already = [INBOX_ACTIONS.leftInbox, INBOX_ACTIONS.leftInboxNoted, INBOX_ACTIONS.archivedThere] as string[]
    if (ledger.some(e => already.includes(e.action) && e.at >= since)) return
    const source = await sourceFor(companyId)
    if (!source?.archive) return
    // Only the messages ACB took in: a reply that came since the last poll stays in the inbox (and is read next).
    const done = await source.archive(companyId, mine.owner, knownRefs(handle, interactionId, mine.owner), false)
    if (done !== 'done') {
      if (done !== 'not-allowed') console.warn(`[inbox] archiving in the mailbox did not work: ${done}`)
      return
    }
    // Written meanwhile (another follow-up of the same close): one entry, one notice.
    const after = lastSeenOf(handle, interactionId)
    if (handle.records.ledger(interactionId).some(e => e.action === INBOX_ACTIONS.archivedThere && e.at >= after)) return
    const now = fieldsOf(handle, interactionId)
    logFailure('archived there', deps.writer.transition(companyId, {
      recordId: interactionId, action: INBOX_ACTIONS.archivedThere, expectedVersion: now.version, to: null, actor: INBOX_ACTOR,
      note: archivedThereNote(source.label ?? DEFAULT_MAILBOX_LABEL),
      // Its owner hears it, with ［元に戻す］: the undo of this entry puts the mail back (afterAct).
      notify: [mine.owner],
    }))
  }

  /** ［元に戻す］ of 「Gmail でもアーカイブしました」: the conversation back in its owner's mailbox inbox. */
  async function unarchiveThere(companyId: string, interactionId: string): Promise<void> {
    const handle = handleOf(companyId)
    const row = handle.records.byIds([interactionId])[0]
    const mine = row ? ownMailbox(handle, row) : null
    const source = mine ? await sourceFor(companyId) : null
    if (!mine || !source?.archive) return
    const done = await source.archive(companyId, mine.owner, knownRefs(handle, interactionId, mine.owner), true)
    if (done === 'done') return
    console.warn(`[inbox] putting the mail back in the mailbox did not work: ${done}`)
    const now = fieldsOf(handle, interactionId)
    logFailure('unarchive failed', deps.writer.transition(companyId, {
      recordId: interactionId, action: INBOX_ACTIONS.unarchiveFailed, expectedVersion: now.version, to: null, actor: INBOX_ACTOR,
      note: unarchiveFailedNote(source.label ?? DEFAULT_MAILBOX_LABEL), quiet: true,
    }))
  }

  /**
   * Which closes archive the mail there (afterAct): on an interaction, its owner's own action (a
   * person — never the AI's judgement, the inbox or the clock) into 対応済み / やることにしなかった;
   * on a task made from a message, reaching 完了 (its message is then checked: closed, every task
   * finished, at least one done). The undo of 「…でもアーカイブしました」 puts it back.
   */
  function mailboxFollowUp(companyId: string, change: { type: string; entry: { recordId: string; action: string; actorId: string; actorKind: string; fromState: string | null; toState: string | null; reversesVersion?: number | null } }): void {
    const { type, entry } = change
    const handle = handleOf(companyId)
    if (type === 'interaction') {
      if (entry.action === 'undo') {
        const reversed = handle.records.ledger(entry.recordId).find(e => e.version === entry.reversesVersion)
        if (reversed?.action === INBOX_ACTIONS.archivedThere) track(unarchiveThere(companyId, entry.recordId))
        return
      }
      const row = handle.records.byIds([entry.recordId])[0]
      if (!row || entry.actorKind !== 'human' || entry.actorId !== row.personalOwner) return
      if (entry.toState === null || entry.toState === entry.fromState || !CLOSED_STATES.includes(entry.toState)) return
      track(archiveThere(companyId, entry.recordId))
      return
    }
    // A task a person completed (the AI's own completion — the reply check — is not the member's say).
    if (type === 'task' && entry.toState === 'done' && entry.fromState !== 'done' && entry.action !== 'undo' && entry.actorKind === 'human') {
      for (const l of handle.records.linksFrom([entry.recordId])) {
        if (l.name === 'interaction' && l.targetId) track(archiveThere(companyId, l.targetId))
      }
    }
  }

  /** The role's connector for the inbox's channel, or why there is none. */
  async function sourceFor(companyId: string): Promise<InboxSource | null> {
    if (!deps.roles) return null
    const r = await deps.roles.resolve(companyId, 'mail', 'read')
    return r.ok ? sources.get(r.connectorId) ?? null : null
  }

  function status(member: Member): InboxStatus {
    const inbox = handleOf(member.companyId).inbox
    return {
      connections: inbox.connections(member.userId).map(c => ({ channel: c.channel, connectedAt: c.connectedAt, checkedUntil: c.checkedUntil })),
      gaps: inbox.gaps(member.userId).map(g => ({ channel: g.channel, from: g.from, to: g.to })),
    }
  }

  function view(member: Member): InboxSettingsView {
    const stored = handleOf(member.companyId).inbox.settings()
    return { settings: settingsOf(member.companyId), canEdit: hasFullAccess(member.role), updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null }
  }

  /**
   * One poll of one member's mail (the server clock): the window from where
   * the last one got to, at most 7 days back — a longer break is kept as an
   * unchecked gap, shown to the member, never silently skipped.
   */
  async function poll(companyId: string, userId: string): Promise<{ read: number; outcome: 'done' | 'not-connected' | 'no-source' }> {
    const handle = handleOf(companyId)
    const conn = handle.inbox.connection(userId, 'email')
    if (!conn) return { read: 0, outcome: 'not-connected' }
    const source = await sourceFor(companyId)
    if (!source) return { read: 0, outcome: 'no-source' }
    const startedMs = clock.nowMs()
    const window = pollWindow(conn.checkedUntil, startedMs)
    // A little before the window too (mail listed late keeps its earlier time; seen ones are
    // `duplicate`), never before the connection unless the window itself is (「過去7日を見直す」).
    const fromMs = Date.parse(window.from)
    const since = new Date(Math.max(fromMs - INBOX_POLL_OVERLAP_MS, Math.min(fromMs, Date.parse(conn.connectedAt)))).toISOString()
    let listed: Awaited<ReturnType<InboxSource['listSince']>>
    try {
      listed = await source.listSince(companyId, userId, since)
    } catch {
      return { read: 0, outcome: 'not-connected' }
    }
    if (listed === 'not-connected') return { read: 0, outcome: 'not-connected' }
    const messages = Array.isArray(listed) ? listed : listed.messages
    if (window.gap) handle.inbox.addGap({ userId, channel: 'email', from: window.gap.from, to: window.gap.to, notedAt: clock.now() })
    // The source stopped at its limit: what came before its oldest is an unchecked gap, never skipped silently.
    if (!Array.isArray(listed) && Date.parse(listed.readFrom) > fromMs) {
      handle.inbox.addGap({ userId, channel: 'email', from: window.from, to: new Date(Date.parse(listed.readFrom)).toISOString(), notedAt: clock.now() })
    }
    // A connected service's notification mail (a Meet note, a calendar invitation, a Slack mention
    // digest, a plugin service's notice) is not taken in: that service's own intake brings it in.
    // Decided from From / Sender only; nothing is written, and only counts are logged.
    const notifiers = messages.length > 0 ? await notifiersFor(companyId, userId) : []
    const left = new Map<string, number>()
    for (const m of messages) {
      const parsed = notifiers.length > 0 ? readMessage(m) : null
      const service = parsed?.channel === 'email' ? notificationServiceOf({ from: parsed.from.address, sender: parsed.senderAddress }, notifiers) : null
      if (service) { left.set(service, (left.get(service) ?? 0) + 1); continue }
      receive(companyId, userId, m)
    }
    if (left.size > 0) console.info(`[inbox] notification mails of connected services left out: ${[...left].map(([k, n]) => `${k}=${n}`).join(' ')}`)
    handle.inbox.setCheckedUntil(userId, 'email', new Date(startedMs).toISOString())
    // What left the mailbox inbox since the last look (owner decision 2026-11-05): closed or noted here.
    await syncLeft(companyId, userId, source).catch(() => 0)
    return { read: messages.length, outcome: 'done' }
  }

  /**
   * The member can be read (the poll, when the source says they are ready): a first
   * connection starts now (no reading back: spec §7-1); a reconnection keeps where the
   * last poll got to, so the next poll reads back up to 7 days.
   */
  function connect(companyId: string, userId: string, channel: InboxChannel): void {
    const now = clock.now()
    const existing = handleOf(companyId).inbox.connection(userId, channel)
    handleOf(companyId).inbox.putConnection({ userId, channel, connectedAt: now, checkedUntil: existing?.checkedUntil ?? now })
  }

  return {
    settingsOf,

    /** A core connector that serves the `mail` role's `read` registers how to list a member's messages. */
    registerSource(connectorId: string, source: InboxSource): void {
      if (sources.has(connectorId)) throw new Error(`Inbox source registered twice: ${connectorId}`)
      sources.set(connectorId, source)
    },

    receive,

    awaitOwnMessage,

    /**
     * The engine wrote an action (composition.ts `afterAct`): the person's 「もう返した」 (a reply ACB
     * cannot see) drops every reply draft for that 返事のお願い, as a reply seen in the thread does.
     */
    afterAct(companyId: string, change: { type: string; entry: { recordId: string; action: string; actorId: string; actorKind: string; fromState: string | null; toState: string | null; reversesVersion?: number | null } }): void {
      // A close by the mailbox's owner archives the mail there too, when they allowed it (2026-11-05).
      try { mailboxFollowUp(companyId, change) } catch { /* the action stands */ }
      if (change.type !== 'reply_request' || change.entry.action !== 'replied_elsewhere') return
      discardDrafts(companyId, handleOf(companyId), change.entry.recordId, 'ほかの経路で返信済み（もう返した）', true)
    },

    /** The mailbox follow-ups still running (archive / put back): tests wait for them. */
    async whenIdle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running])
    },

    connect,

    poll,

    /**
     * Every connected member's mail of one company (the server clock's job). A member the
     * source can read now but not yet connected (they granted, 受信を読む on) is connected
     * first: their first window starts at this run. `between` lets the event loop serve
     * requests between members (the clock's yield).
     */
    async pollCompany(companyId: string, between: () => Promise<void> = async () => {}): Promise<number> {
      const source = await sourceFor(companyId)
      if (source?.ready) {
        for (const { userId } of deps.memberAddresses(companyId)) {
          if (handleOf(companyId).inbox.connection(userId, 'email')) continue
          if (await source.ready(companyId, userId).catch(() => false)) connect(companyId, userId, 'email')
        }
      }
      let read = 0
      for (const c of handleOf(companyId).inbox.connected('email')) {
        read += (await poll(companyId, c.userId)).read
        await between()
      }
      return read
    },

    /** The member's own connections and unchecked gaps (GET /inbox/status). */
    status,

    /** 「過去7日を見直す」: the member's next poll reads the last 7 days again (already seen messages are skipped). */
    backfill(member: Member, body: unknown): Outcome<InboxStatus> {
      const channel = isObject(body) ? body.channel : null
      if (!INBOX_CHANNELS.includes(channel as InboxChannel)) return refuse('bad-request', 'channel は email か chat です', { code: 'BAD_REQUEST' })
      const inbox = handleOf(member.companyId).inbox
      const conn = inbox.connection(member.userId, channel as InboxChannel)
      if (!conn) return refuse('not-found', INBOX_NOT_CONNECTED.error, { code: INBOX_NOT_CONNECTED.code })
      const back = new Date(clock.nowMs() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString()
      if (back < conn.checkedUntil) inbox.setCheckedUntil(member.userId, channel as InboxChannel, back)
      return ok(status(member))
    },

    /** 「やることにしなかった一覧」: the member's own left-out messages they can read, newest first. */
    setAside(member: Member): Outcome<SetAsideList> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const rows = handle.records.candidates({ types: ['interaction'], states: ['excluded'], fields: [{ name: 'assignee', values: [member.userId] }] }, 500)
        .filter(r => reader.record(r))
      const full = handle.records.byIds(rows.map(r => r.id))
      const items: SetAsideItem[] = full.map(row => {
        const { fields } = fieldsOf(handle, row.id)
        const last = [...handle.records.ledger(row.id)].reverse().find(e => e.toState === 'excluded')
        const by: SetAsideItem['by'] = last?.actorKind === 'ai' ? 'ai' : last?.actorKind === 'human' ? 'human' : 'intake'
        return {
          recordId: row.id, title: row.title, channel: str(fields.channel), from: str(fields.from_address), occurredAt: str(fields.occurred_at),
          reason: by === 'intake' ? str(fields.intake_reason) : (last?.note || null), by,
        }
      }).sort((a, b) => ((b.occurredAt ?? '') < (a.occurredAt ?? '') ? -1 : (b.occurredAt ?? '') > (a.occurredAt ?? '') ? 1 : 0))
      return ok({ items: items.slice(0, INBOX_LIMITS.setAsideList) })
    },

    /** 部署の番: messages to a shared address the member can read that nobody took yet. */
    department(member: Member): Outcome<{ records: RecordSummary[] }> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const rows = handle.records.candidates({ types: ['interaction'], states: ['unclaimed'] }, 500).filter(r => reader.record(r))
      const sums = recordSummaries(handle.records, handle.records.byIds(rows.map(r => r.id)))
      return ok({ records: rows.map(r => sums.get(r.id)).filter((s): s is RecordSummary => !!s).slice(0, 200) })
    },

    /** 引き受ける: a member who reads a department's message takes it (it becomes their AI's turn). */
    claim(member: Member, recordId: string, body: unknown): Outcome<{ record: RecordSummary }> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      const found = readable(member, recordId, 'interaction')
      if (!found) return notFound()
      const cur = fieldsOf(handle, recordId)
      const expected = isObject(body) ? body.expectedVersion : undefined
      if (typeof expected !== 'number' || !Number.isInteger(expected)) return refuse('bad-request', 'expectedVersion が要ります', { code: 'BAD_REQUEST' })
      if (cur.state !== 'unclaimed') return refuse('conflict', NOT_UNCLAIMED.error, { code: NOT_UNCLAIMED.code })
      if (expected !== cur.version) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code, version: cur.version })
      const r = deps.writer.transition(member.companyId, {
        recordId, action: INBOX_ACTIONS.claimed, expectedVersion: expected, to: 'received',
        fields: { assignee: member.userId, next_actor: member.userId }, actor: { id: member.userId, kind: 'human', source: null }, quiet: true,
      })
      if (!r.ok) return r.reason === 'stale' ? refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code }) : refuse('conflict', NOT_UNCLAIMED.error, { code: NOT_UNCLAIMED.code })
      return ok({ record: r.record })
    },

    /** What the AI judges by (no body; the thread itself is A4's `GET /api/records-ai/threads/:recordId`). */
    item(member: Member, recordId: string): Outcome<InboxItemView> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      // The interaction itself, or a 返事のお願い and its interaction (B5: with why it is the AI's turn).
      const row = interactionFor(member, handle, recordId)
      if (!row) return notFound()
      const view = itemView(member, handle, row)
      return ok(row.id !== recordId ? { ...view, request: requestView(handle, recordId) } : view)
    },

    /**
     * The AI's judgement of an interaction in its turn (records-ai-inbox):
     * a 返事のお願い (with its end condition and due — the message's own
     * deadline, else the company's 目安), handled, やることにしない (never
     * over a person's 「やることにする」), or 確認待ち.
     */
    judge(member: Member, actor: ServiceActor, recordId: string, body: unknown): Outcome<InboxJudgementResult> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      const found = readable(member, recordId, 'interaction')
      if (!found) return notFound()
      const bad = (error: string) => refuse('bad-request', error, { code: 'BAD_REQUEST' })
      if (!isObject(body)) return bad('本文の形が正しくありません')
      const outcome = body.outcome
      if (outcome !== 'reply' && outcome !== 'no_reply' && outcome !== 'set_aside' && outcome !== 'unsure' && outcome !== 'task') {
        return bad('outcome は reply / no_reply / set_aside / unsure / task のどれかです')
      }
      if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) return bad('expectedVersion が要ります')
      const reason = typeof body.reason === 'string' ? oneLine(body.reason, INBOX_LIMITS.reason) : ''
      if (reason === '') return bad('reason（判断のわけ）が要ります')
      const endCondition = typeof body.endCondition === 'string' ? body.endCondition.normalize('NFC').trim().slice(0, INBOX_LIMITS.endCondition) : ''
      if (body.deadline !== undefined && !isDateValue(body.deadline)) return bad('deadline は YYYY-MM-DD か YYYY-MM-DDTHH:MM です')
      const title = typeof body.title === 'string' ? oneLine(body.title, INBOX_LIMITS.title) : ''
      const deadlineNote = typeof body.deadlineNote === 'string' ? oneLine(body.deadlineNote, INBOX_LIMITS.deadlineNote) : ''

      const cur = fieldsOf(handle, recordId)
      if (cur.state !== 'received' || cur.fields.assignee !== member.userId) return refuse('conflict', NOT_AI_TURN.error, { code: NOT_AI_TURN.code })
      if (body.expectedVersion !== cur.version) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code, version: cur.version })
      // task: the AI made it (records_create, owner-only) and it names this message as its もとの連絡.
      let taskId: string | null = null
      if (outcome === 'task') {
        const task = readable(member, body.taskId, 'task')
        const links = task ? handle.records.linksFrom([task.row.id]) : []
        if (!task || !links.some(l => l.name === 'interaction' && l.targetId === recordId)) {
          return bad('taskId には、この連絡を「もとの連絡」（interaction）につないだタスクを指定してください')
        }
        taskId = task.row.id
      }
      if (outcome === 'set_aside') {
        // A person's 「やることにする」 / 「自分の担当にする」 wins over the AI (the latest move into 届いた).
        const into = [...handle.records.ledger(recordId)].reverse().find(e => e.toState === 'received' && e.fromState !== 'received')
        if (into && into.actorKind === 'human' && into.action !== INBOX_ACTIONS.claimed) return refuse('conflict', PERSON_DECIDED.error, { code: PERSON_DECIDED.code })
      }

      // The member already answered in the thread (the newest message is ours): no 返事のお願い.
      const seen = handle.inbox.messagesOf(recordId)
      const alreadyReplied = outcome === 'reply' && seen.length > 0 && seen[seen.length - 1].direction === 'out'
      let replyRequestId: string | null = null
      if (outcome === 'reply' && !alreadyReplied) {
        const existing = replyRequestsOf(handle, recordId)[0]
        if (existing) {
          replyRequestId = existing.id
        } else {
          const settings = deps.taskSettings(member.companyId)
          const occurred = str(cur.fields.occurred_at) ?? clock.now()
          const guideline = replyTarget(occurred, settings.reply, settings.companyHolidays.map(h => h.date)).date
          const links = handle.records.linksFrom([recordId])
          const linked = (name: string) => links.filter(l => l.name === name && l.targetId).map(l => l.targetId as string).slice(0, 1)
          // 名寄せ again: a 相手 made since the message came is found now (identity.md resolveAddress).
          const counterpart = linked('counterpart').length > 0 ? linked('counterpart') : counterpartOf(member, str(cur.fields.from_address))
          const made = deps.writer.create(member.companyId, {
            type: 'reply_request', title: title || found.row.title,
            ...placeOfRow(found.row),
            fields: {
              assignee: member.userId, occurred_at: occurred, end_condition: endCondition || null,
              due: typeof body.deadline === 'string' ? body.deadline : guideline, guideline_due: guideline, due_note: deadlineNote || null,
            },
            links: { interaction: [recordId], counterpart, bundle: linked('bundle') },
            actor, note: reason,
            // 「準備中」 is the AI's turn (the reply's draft): the person hears of it when it is handed over.
            quiet: true,
          })
          if (!made.ok) return refuse('conflict', '返事のお願いを作れませんでした', { code: 'NOT_CREATED', reason: made.reason })
          replyRequestId = made.record.id
        }
      }
      const handled = outcome === 'reply' || outcome === 'no_reply' || outcome === 'task'
      const to = handled ? 'handled' : outcome === 'set_aside' ? 'excluded' : 'unsure'
      const moved = deps.writer.transition(member.companyId, {
        recordId, action: INBOX_ACTIONS.judged, expectedVersion: cur.version, to, actor,
        note: alreadyReplied ? `${reason}（${REPLIED_THERE[cur.fields.channel === 'chat' ? 'chat' : 'email']}）` : reason,
        fields: handled ? { needs_reply: outcome === 'reply' && !alreadyReplied } : {},
        quiet: to !== 'unsure',
      })
      if (!moved.ok) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code })
      // A message without a subject gets the owner's AI's short title — never over a subject it came with.
      const aiTitle = title.slice(0, INBOX_LIMITS.aiTitle).trim()
      if (aiTitle !== '' && found.row.title === SUBJECT_NONE && found.row.personalOwner === member.userId) {
        deps.writer.retitle(member.companyId, recordId, SUBJECT_NONE, aiTitle)
      }
      return ok({ interactionId: recordId, state: to, replyRequestId, taskId, ...(alreadyReplied ? { alreadyReplied: true } : {}) })
    },

    /**
     * The member's AI after their own reply (owner FB #19, records-ai-inbox `reply-check`): each task
     * made from this message is completed (`done`: the reply finished it; the member is told
     * 「返事をしたので完了にしました」 and may undo it, the entry being their AI's) or keeps a note
     * (`open`: 「返事は済み」). Server-side guard: only on an interaction in 「返事のあとを確かめる」 whose
     * assignee is the member, only the tasks `replyCheckTasks` lists — anything else refuses the
     * whole request before anything is written. Completes, never archives; then the message is
     * handled again.
     */
    replyCheck(member: Member, actor: ServiceActor, recordId: string, body: unknown): Outcome<InboxReplyCheckResult> {
      const handle = handleOf(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      const found = readable(member, recordId, 'interaction')
      if (!found) return notFound()
      const bad = (error: string) => refuse('bad-request', error, { code: 'BAD_REQUEST' })
      if (!isObject(body) || !Array.isArray(body.tasks)) return bad('tasks（タスクごとの判断）が要ります')
      if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) return bad('expectedVersion が要ります')
      if (body.tasks.length > REPLY_CHECK_MAX) return bad(`一度に決められるのは ${REPLY_CHECK_MAX} 件までです`)
      const decisions: Array<{ taskId: string; outcome: 'done' | 'open'; note: string }> = []
      for (const d of body.tasks as unknown[]) {
        if (!isObject(d) || typeof d.taskId !== 'string' || (d.outcome !== 'done' && d.outcome !== 'open')) return bad('tasks の各項目は { taskId, outcome: done | open } です')
        const taskId = d.taskId
        if (decisions.some(x => x.taskId === taskId)) return bad('同じタスクが二度あります')
        decisions.push({ taskId, outcome: d.outcome, note: typeof d.note === 'string' ? oneLine(d.note, INBOX_LIMITS.reason) : '' })
      }
      const cur = fieldsOf(handle, recordId)
      if (cur.state !== 'replied' || cur.fields.assignee !== member.userId) return refuse('conflict', NOT_AI_TURN.error, { code: NOT_AI_TURN.code })
      if (body.expectedVersion !== cur.version) return refuse('conflict', VERSION_CONFLICT.error, { code: VERSION_CONFLICT.code, version: cur.version })
      // The guard: the member's own open tasks from this very message — nothing else, checked before any write.
      const eligible = new Map(replyCheckTasks(member, handle, recordId).map(t => [t.id, t]))
      for (const d of decisions) {
        const t = eligible.get(d.taskId)
        if (!t) return refuse('conflict', NOT_FROM_THIS_REPLY.error, { code: NOT_FROM_THIS_REPLY.code })
        if (d.outcome === 'done' && !t.canComplete) return refuse('conflict', NEEDS_CHECK.error, { code: NEEDS_CHECK.code })
      }
      const results: InboxReplyCheckResult['tasks'] = []
      for (const d of decisions) {
        const t = eligible.get(d.taskId)!
        const r = d.outcome === 'done'
          ? deps.writer.transition(member.companyId, {
            recordId: t.id, action: INBOX_ACTIONS.repliedDone, expectedVersion: t.version, to: 'done', actor,
            note: d.note ? `${REPLIED_DONE}（${d.note}）` : REPLIED_DONE,
            // Her own AI did it: she is told (「返事をしたので完了にしました」, with ［元に戻す］).
            notify: [member.userId],
          })
          : deps.writer.transition(member.companyId, {
            recordId: t.id, action: INBOX_ACTIONS.replyNoted, expectedVersion: t.version, to: null, actor,
            note: d.note ? `${REPLY_NOTED}（${d.note}）` : REPLY_NOTED, quiet: true,
          })
        logFailure('reply check task', r)
        results.push({ taskId: t.id, outcome: d.outcome, ok: r.ok, ...(r.ok ? { version: r.entry.version } : {}) })
      }
      const moved = deps.writer.transition(member.companyId, {
        recordId, action: INBOX_ACTIONS.replyChecked, expectedVersion: cur.version, to: 'handled', actor, quiet: true,
      })
      logFailure('reply checked', moved)
      // Not archived there: the AI completed those tasks (owner: the AI's judgement alone never archives).
      // The member's own close (自分で確かめる, a task they complete) does.
      return ok({ interactionId: recordId, state: moved.ok ? 'handled' : 'replied', tasks: results })
    },

    /** The settings view (GET /inbox-settings): every member reads them; owners and admins change them. */
    view,

    update(member: Member, body: unknown): Outcome<InboxSettingsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', INBOX_SETTINGS_FORBIDDEN)
      const r = parseIntakeSettings(body)
      if ('error' in r) return refuse('bad-request', r.error, { code: 'BAD_SETTINGS' })
      // A shared address's mail is read by its folder's readers: never a private folder (its name never leaks).
      const scopes = handleOf(member.companyId).scopes.listWithRules()
      if (r.value.sharedAddresses.some(s => findPrivateScope(scopes, s.folder))) {
        return refuse('bad-request', '共有の受付アドレスの部署には、非公開のフォルダを選べません', { code: 'BAD_SETTINGS' })
      }
      handleOf(member.companyId).inbox.saveSettings(JSON.stringify(r.value), clock.now(), member.userId)
      return ok(view(member))
    },
  }
}

export type InboxService = ReturnType<typeof createInboxService>
