// What a meeting's or a 来た連絡's own screen shows beyond the common card (新しい画面のデモ F, J):
// built by main from the record's fields, which hold pointers only — never the minutes or the
// message body. Links out go to Google / Slack, where the member's own permission decides. Pure.
import type { RecordSummary } from '../../shared/types/records'
import type { TypeDefinition } from '../../shared/core/record-types'
import type { ViewersLabel } from '../../shared/types/viewers'

export interface OpenLink {
  label: string
  url: string
  kind: 'transcript' | 'notes' | 'calendar' | 'gmail' | 'slack'
}

/** 会議の記録: the summary as the body, the people on one thin line, the documents to open. */
export interface MeetingDetailView {
  kind: 'meeting'
  /** `YYYY-MM-DDTHH:MM…` */
  at: string | null
  assignee: string | null
  /** Members who attended, by name. */
  attendees: string[]
  externalCount: number
  summary: string | null
  opens: OpenLink[]
}

/** 来た連絡: ACB keeps no body — the summary, where it came from, and a way to open the original. */
export interface IncomingDetailView {
  kind: 'incoming'
  channel: 'email' | 'slack' | 'other'
  at: string | null
  /** The sender as written (「鈴木様（A社）」), when known. */
  from: string | null
  summary: string
  needsReply: boolean
  open: OpenLink | null
  /**
   * What the member does with it here (owner FB #20, interaction version 6): `settle` — a 確認待ち
   * message that is theirs (assignee): ［済んだ］ (`settle`) as the main button, ［取り込まない］
   * (`drop`) in 「…」; `settled` — one they closed with ［済んだ］ (`settled_by`): 「済んだ」 and
   * ［元に戻す］ (the generic undo). null: nothing (the AI's turn, the department's, judged, someone
   * else's). The server still decides each press.
   */
  close: 'settle' | 'settled' | null
}

/** One of a bundle's やること, by whose turn it is (「みんなのやること」). */
export interface BundleTaskRow {
  id: string
  title: string
  /** 「あなたの番」「田中さんの番」「AI の番」「田中さんが返事待ち」…; null when finished. */
  turn: string | null
  due: string | null
}

/** A 案件・プロジェクト: what for, who is responsible, how far, everyone's やること by turn. */
export interface BundleDetailView {
  kind: 'bundle'
  purpose: string | null
  owner: string | null
  groups: Array<{ title: string; tasks: BundleTaskRow[] }>
  done: number
  total: number
  /** Approval requests of it still waiting (drawn by the screen with the approval card). */
  pendingApprovals: string[]
}

/**
 * 返事のお願い (owner report 2026-11-05: one sat in 「AI が確かめている」 after the member's reply, with
 * nothing to press): `close` — its assignee may end it here (［終わりにする］, the type's `close`,
 * in every open state the server's type allows it from, the AI's turn included). The server still
 * decides the press.
 */
export interface ReplyRequestDetailView {
  kind: 'reply'
  close: boolean
  /** ［もう返した］ (`replied_elsewhere`, in 「…」): a reply ACB cannot see; its drafts are dropped. */
  repliedElsewhere: boolean
}

export type RecordDetailView = MeetingDetailView | IncomingDetailView | BundleDetailView | ReplyRequestDetailView

/** Fields each screen already shows in its own place (not repeated under 「ほかの項目」). */
export const DETAIL_FIELDS: Record<string, ReadonlySet<string>> = {
  meeting: new Set(['meeting_at', 'occurred_at', 'assignee', 'external_count', 'summary_text']),
  bundle: new Set(['purpose', 'owner']),
  interaction: new Set(['occurred_at', 'channel', 'counterpart_text', 'needs_reply', 'from_address', 'to_addresses', 'cc_addresses', 'message_id', 'thread_ref', 'source_ref']),
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const GOOGLE_ID = /^[A-Za-z0-9_-]{10,200}$/
const SLACK_ID = /^[A-Z0-9]{6,20}$/
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/
const GMAIL_ID = /^[A-Za-z0-9]{8,64}$/

/** A meeting's Google documents from its pointer (`source_ref`: ids only); anything malformed is left out. */
function meetingOpens(sourceRef: unknown, at: string | null): OpenLink[] {
  const out: OpenLink[] = []
  try {
    const ref = typeof sourceRef === 'string' ? JSON.parse(sourceRef) as { docs?: Array<{ kind?: unknown; id?: unknown }> } : null
    for (const kind of ['transcript', 'notes'] as const) {
      const doc = ref?.docs?.find(d => d?.kind === kind && typeof d.id === 'string' && GOOGLE_ID.test(d.id))
      if (doc) out.push({ kind, label: kind === 'transcript' ? '文字起こしを開く' : 'Gemini のメモを開く', url: `https://docs.google.com/document/d/${doc.id as string}/edit` })
    }
  } catch { /* a malformed pointer opens nothing */ }
  // The event's own link needs the organizer's calendar id, which ACB does not keep: the day opens instead.
  const day = at?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (day) out.push({ kind: 'calendar', label: 'カレンダーの予定を開く', url: `https://calendar.google.com/calendar/r/day/${day[1]}/${Number(day[2])}/${Number(day[3])}` })
  return out
}

/** The original message: Gmail by its id, Slack by channel and timestamp (`source_ref`). */
function incomingOpen(sourceRef: unknown): OpenLink | null {
  const ref = str(sourceRef)
  const slack = ref?.match(/^slack:([^:]+):([^:]+)$/)
  if (slack && SLACK_ID.test(slack[1]) && SLACK_TS.test(slack[2])) {
    return { kind: 'slack', label: 'Slack で開く', url: `https://slack.com/archives/${slack[1]}/p${slack[2].replace('.', '')}` }
  }
  const gmail = ref?.match(/^gmail:(.+)$/)
  if (gmail && GMAIL_ID.test(gmail[1])) return { kind: 'gmail', label: 'Gmail で開く', url: `https://mail.google.com/mail/u/0/#all/${gmail[1]}` }
  return null
}

function memberIds(raw: unknown): string[] {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) as unknown : null
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Whose turn a task of a bundle is, in a row's words (the state itself shows only on its own card). */
function taskTurn(t: RecordSummary, me: string | null, people: Record<string, string>): { group: 'mine' | 'ai' | 'others' | 'done'; turn: string | null } {
  const who = (field: string) => { const id = str(t.fields[field]); return id ? { id, name: id === me ? 'あなた' : people[id] ? `${people[id]}さん` : 'メンバー' } : null }
  const assignee = who('assignee')
  switch (t.state) {
    case 'done': case 'cancelled': return { group: 'done', turn: null }
    case 'preparing': return { group: 'ai', turn: 'AI の番' }
    case 'review': { const r = who('reviewer') ?? who('requested_by'); return { group: r?.id === me ? 'mine' : 'others', turn: `${r?.name ?? '確かめる人'}の番` } }
    case 'declined': { const r = who('requested_by'); return { group: r?.id === me ? 'mine' : 'others', turn: `${r?.name ?? '頼んだ人'}の番` } }
    case 'waiting': return { group: 'others', turn: `${assignee?.name ?? '担当'}が返事待ち` }
    case 'awaiting_acceptance': return { group: assignee?.id === me ? 'mine' : 'others', turn: `${assignee?.name ?? '担当'}の引き受け待ち` }
    default: return { group: assignee?.id === me ? 'mine' : 'others', turn: `${assignee?.name ?? '担当'}の番` }
  }
}

const GROUP_TITLES = { mine: 'あなたの番', ai: 'AI の番', others: 'ほかの人の番・返事待ち', done: '終わったこと' } as const

export function bundleDetailOf(r: Pick<RecordSummary, 'fields'>, linked: RecordSummary[], me: string | null, people: Record<string, string>): BundleDetailView {
  const owner = str(r.fields.owner) ?? str(r.fields.assignee)
  const groups: Record<keyof typeof GROUP_TITLES, BundleTaskRow[]> = { mine: [], ai: [], others: [], done: [] }
  for (const t of linked.filter(x => x.type === 'task')) {
    const { group, turn } = taskTurn(t, me, people)
    groups[group].push({ id: t.id, title: t.title || '（名前なし）', turn, due: str(t.fields.due) })
  }
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0)
  return {
    kind: 'bundle', purpose: str(r.fields.purpose), owner: owner ? people[owner] ?? null : null,
    groups: (Object.keys(GROUP_TITLES) as Array<keyof typeof GROUP_TITLES>).filter(k => groups[k].length > 0).map(k => ({ title: GROUP_TITLES[k], tasks: groups[k] })),
    done: groups.done.length, total,
    pendingApprovals: linked.filter(x => x.type === 'approval' && x.state === 'pending').map(x => x.id),
  }
}

/** A 来た連絡's ［済んだ］ / ［元に戻す］ for `me` (`IncomingDetailView.close`). */
export function incomingClose(state: string | null, f: RecordSummary['fields'], me: string | null): IncomingDetailView['close'] {
  if (!me) return null
  if (state === 'unsure' && f.assignee === me) return 'settle'
  if (state === 'handled' && f.settled_by === me) return 'settled'
  return null
}

/**
 * A 返事のお願い's action `action` for `me`: its assignee, in a state the type's action (who: the
 * assignee) starts from — read from the server's definition, so an older server (`close` only from
 * 返事をする / 返事待ち) shows ［終わりにする］ only there.
 */
export function replyRequestMay(action: 'close' | 'replied_elsewhere', state: string | null, f: RecordSummary['fields'], me: string | null, def?: Pick<TypeDefinition, 'actions'>): boolean {
  const a = def?.actions[action]
  return !!me && !!state && f.assignee === me && !!a && a.who.includes('assignee') && (a.from ?? []).includes(state)
}

/** `me`: the member reading it (a 来た連絡's ［済んだ］ is its assignee's); unknown → nothing to press. */
export function recordDetailOf(r: Pick<RecordSummary, 'type' | 'fields' | 'summary'> & { state?: string | null }, people: Record<string, string>, me: string | null = null, def?: Pick<TypeDefinition, 'actions'>): RecordDetailView | null {
  const f = r.fields
  if (r.type === 'reply_request') {
    const may = (action: 'close' | 'replied_elsewhere') => replyRequestMay(action, r.state ?? null, f, me, def)
    return { kind: 'reply', close: may('close'), repliedElsewhere: may('replied_elsewhere') }
  }
  if (r.type === 'meeting') {
    const at = str(f.meeting_at) ?? str(f.occurred_at)
    const assignee = str(f.assignee)
    return {
      kind: 'meeting', at,
      assignee: assignee ? people[assignee] ?? null : null,
      attendees: memberIds(f.attendees).flatMap(id => (people[id] ? [people[id]] : [])),
      externalCount: typeof f.external_count === 'number' ? f.external_count : Number(f.external_count) || 0,
      summary: str(f.summary_text),
      opens: meetingOpens(f.source_ref, at),
    }
  }
  if (r.type === 'interaction') {
    // The inbox keeps a Slack message as channel `chat` with a `slack:` pointer (inbox.md).
    const slack = f.channel === 'slack' || (f.channel === 'chat' && (str(f.source_ref) ?? '').startsWith('slack:'))
    const channel = f.channel === 'email' ? 'email' : slack ? 'slack' : 'other'
    return {
      kind: 'incoming', channel, at: str(f.occurred_at), from: str(f.counterpart_text) ?? (str(f.from_address)?.includes('@') ? str(f.from_address) : null),
      summary: r.summary, needsReply: f.needs_reply === true || f.needs_reply === 'true',
      open: incomingOpen(f.source_ref),
      close: incomingClose(r.state ?? null, f, me),
    }
  }
  return null
}

/**
 * A members-only meeting's 見られる人 (design §3): the attendees ACB could match to a member — not
 * everyone who attended, so it says so — and who was invited besides (the server's count minus
 * them). A meeting seen another way (one made before 2026-11-04, in a folder; shared to a
 * department) keeps the server's own phrase.
 */
export function meetingSeenWords(attendees: number, label: ViewersLabel): string {
  if (label.kind === 'company' || label.kind === 'department' || label.kind === 'private-folder' || attendees <= 0) return label.text
  const invited = label.count - attendees
  return `参加者のうち ACB の人 ${attendees}人${invited > 0 ? `・招待した人 ${invited}人` : ''}`
}
