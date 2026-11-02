// What a meeting's or a 来た連絡's own screen shows beyond the common card (新しい画面のデモ F, J):
// built by main from the record's fields, which hold pointers only — never the minutes or the
// message body. Links out go to Google / Slack, where the member's own permission decides. Pure.
import type { RecordSummary } from '../../shared/types/records'

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
}

export type RecordDetailView = MeetingDetailView | IncomingDetailView

/** Fields each screen already shows in its own place (not repeated under 「ほかの項目」). */
export const DETAIL_FIELDS: Record<string, ReadonlySet<string>> = {
  meeting: new Set(['meeting_at', 'occurred_at', 'assignee', 'external_count', 'summary_text']),
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

export function recordDetailOf(r: Pick<RecordSummary, 'type' | 'fields' | 'summary'>, people: Record<string, string>): RecordDetailView | null {
  const f = r.fields
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
    const channel = f.channel === 'email' ? 'email' : f.channel === 'slack' ? 'slack' : 'other'
    return {
      kind: 'incoming', channel, at: str(f.occurred_at), from: str(f.counterpart_text) ?? (str(f.from_address)?.includes('@') ? str(f.from_address) : null),
      summary: r.summary, needsReply: f.needs_reply === true || f.needs_reply === 'true',
      open: incomingOpen(f.source_ref),
    }
  }
  return null
}
