// 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」): what main hands the renderer for one contact —
// the server's view as read (checked, nothing added or left out) — and the answers of 「返した」/「済んだ」 and its
// ［取り消す］. Pure: main checks the server's answer here, the renderer reads the same shapes.
import { RECORD_ID_RE } from '../../shared/core/records'
import type { ContactFinishResult, ContactPartResult, ContactReplyView, ContactUndoResult, ContactView } from '../../shared/types/inbox'

export type { ContactFinishRequest, ContactFinishResult, ContactPartResult, ContactReplyEnd, ContactUndoRequest, ContactUndoResult, ContactView, ContactReplyView } from '../../shared/types/inbox'

/** The contact as the member reads it now, or why not. `gone`: missing or not theirs to read (the server's one 404). */
export type ContactReadResult =
  | { success: true; contact: ContactView }
  | { success: false; gone: true }
  | { success: false; gone: false; offline: boolean; error: string }

/**
 * Which part the server refused (`part` of a 409 / 403), and why. `code` is the server's (`VERSION_CONFLICT`,
 * `NOT_THIS_CONTACT`, `CHANGED_SINCE`, `NOT_A_FINISH`, `FEATURE_OFF`, …): the renderer chooses its words by it.
 */
export interface ContactRefusal {
  success: false
  offline: boolean
  gone: boolean
  code: string | null
  part: 'interaction' | 'replyRequest' | null
  error: string
}

export type ContactFinishAnswer = { success: true; result: ContactFinishResult } | ContactRefusal
export type ContactUndoAnswer = { success: true; result: ContactUndoResult } | ContactRefusal

export const CONTACT_OFFLINE_TEXT = 'サーバーにつながらないため、できませんでした。つながってから、もう一度押してください'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const id = (v: unknown): string | null => (typeof v === 'string' && RECORD_ID_RE.test(v) ? v : null)
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

function replyOf(v: unknown): ContactReplyView | null {
  const r = record(v)
  const may = record(r?.may)
  const rid = id(r?.id)
  const version = int(r?.version)
  if (!r || !may || !rid || version === null || !Array.isArray(r.drafts)) return null
  const drafts: ContactReplyView['drafts'] = []
  for (const d of r.drafts) {
    const dr = record(d)
    const did = id(dr?.id)
    const dv = int(dr?.version)
    if (did && dv !== null) drafts.push({ id: did, version: dv })
  }
  return {
    id: rid, title: str(r.title) ?? '', state: str(r.state), version, assignee: str(r.assignee),
    due: str(r.due), guidelineDue: str(r.guidelineDue), waitUntil: str(r.waitUntil), drafts,
    // Only an explicit true is a button: anything else is not offered.
    may: { replied_elsewhere: may.replied_elsewhere === true, close: may.close === true, drop: may.drop === true },
  }
}

/** The server's `ContactView`, checked; anything malformed → null (shown as 「読めませんでした」, never guessed). */
export function readContactView(v: unknown): ContactView | null {
  const c = record(v)
  const it = record(c?.interaction)
  const iid = id(it?.id)
  const iv = int(it?.version)
  if (!c || !it || !iid || iv === null || !Array.isArray(c.replyRequests) || !Array.isArray(c.tasks)) return null
  const replyRequests: ContactReplyView[] = []
  for (const r of c.replyRequests) {
    const one = replyOf(r)
    if (!one) return null
    replyRequests.push(one)
  }
  const tasks: ContactView['tasks'] = []
  for (const t of c.tasks) {
    const tr = record(t)
    const tid = id(tr?.id)
    const tv = int(tr?.version)
    if (!tr || !tid || tv === null) return null
    tasks.push({ id: tid, title: str(tr.title) ?? '', state: str(tr.state), version: tv, assignee: str(tr.assignee) })
  }
  return {
    interaction: { id: iid, title: str(it.title) ?? '', state: str(it.state), version: iv, assignee: str(it.assignee), maySettle: it.maySettle === true },
    replyRequests, tasks, ...(c.truncated === true ? { truncated: true as const } : {}),
  }
}

function partOf(v: unknown): ContactPartResult | null {
  const p = record(v)
  const rid = id(p?.recordId)
  const rv = int(p?.recordVersion)
  const outcome = p?.outcome
  if (!p || !rid || rv === null || (outcome !== 'done' && outcome !== 'already' && outcome !== 'unchanged')) return null
  const version = p.version === null ? null : int(p.version)
  if (version === null && p.version !== null) return null
  return { recordId: rid, outcome, state: str(p.state), recordVersion: rv, version }
}

export function readFinishResult(v: unknown): ContactFinishResult | null {
  const r = record(v)
  const interaction = partOf(r?.interaction)
  const replyRequest = partOf(r?.replyRequest)
  return interaction && replyRequest ? { interaction, replyRequest } : null
}

export function readUndoResult(v: unknown): ContactUndoResult | null {
  const r = record(v)
  const replyRequest = partOf(r?.replyRequest)
  if (!r || !replyRequest) return null
  if (r.interaction === null || r.interaction === undefined) return { interaction: null, replyRequest }
  const interaction = partOf(r.interaction)
  return interaction ? { interaction, replyRequest } : null
}
