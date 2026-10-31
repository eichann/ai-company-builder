import type { ApprovalState, ApprovalView } from '../../shared/types/approvals'

/**
 * The chat's approval card (承認のお願い, milestone 4 G6, `.claude/rules/approvals.md`).
 * The card is drawn by the app itself — never by a plugin or by the AI's
 * text: the message stores only a reference (`data-approval`, kept with the
 * message as `approvals`), and the card fetches the request by id with the
 * member's session (IPC `approvals:get`) every time it is shown, so its state,
 * the fixed content's hash and whether the viewer may approve come from the
 * server. 「承認」 sends back the hash the card shows.
 */
export const APPROVAL_PART_TYPE = 'data-approval'

export interface ApprovalCardRef {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  approvalId: string
  /** Why the card is in this conversation: the request was made here, or the member asked to see it. */
  origin: 'requested' | 'shown'
  at: string
}

const APPROVAL_ID_RE = /^approval-[0-9a-z]{6,32}$/
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored / streamed reference, validated (undefined when malformed). */
export function readApprovalCardRef(data: unknown): ApprovalCardRef | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 200) || !str(d.companyId, 200) || !str(d.approvalId, 80) || !APPROVAL_ID_RE.test(d.approvalId) || !str(d.at, 40)) return undefined
  return {
    id: d.id, companyId: d.companyId, conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null,
    approvalId: d.approvalId, origin: d.origin === 'shown' ? 'shown' : 'requested', at: d.at,
  }
}

export const APPROVALS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは承認のお願いを開けません（オフラインの可能性があります）。'

/** The answer of the card's IPC calls (`approvals:*`), made with the member's session in main. */
export type ApprovalResult =
  | { success: true; approval: ApprovalView; names: Record<string, string> }
  | { success: false; offline: boolean; code: string | null; error: string; approval?: ApprovalView; names?: Record<string, string> }

/** A member by name (from the app's member list), else a neutral word — never an id on screen. */
export const nameOf = (names: Record<string, string>, userId: string | null | undefined) =>
  (userId && names[userId]) || 'メンバー'

/** 「+25%」「-12.5%」 */
export function percentText(p: number | null): string | null {
  if (p === null) return null
  return `${p > 0 ? '+' : ''}${p}%`
}

/** The card's status line for each state (names from the app's member list). */
export function stateLine(v: ApprovalView, names: Record<string, string>): string {
  const first = v.changes[0]
  switch (v.state as ApprovalState) {
    case 'pending': return `承認待ち：${nameOf(names, v.approver)}さんにお願いしました`
    case 'approved': return first
      ? `承認されました。${v.systemLabel} の${first.label}も ${first.afterShown} になりました`
      : `承認されました。${v.systemLabel} に反映しました`
    case 'sent_back': return `差し戻されました：${v.outcome?.note ?? ''}`
    case 'stale': return `${v.systemLabel} 側で変わっています。もう一度お願いし直してください`
    case 'withdrawn': return '取り下げられました'
    case 'failed': return `${v.systemLabel} に書けたか確かめられませんでした。${v.systemLabel} の画面で確かめてください（自動で送り直すことはしません）`
  }
}

/** The ids a view names (for the names lookup). */
export function namedMembers(v: ApprovalView): string[] {
  return [...new Set([v.requestedBy, v.approver, v.outcome?.by].filter((x): x is string => typeof x === 'string' && x.length > 0))]
}

/** What the AI is told when its request became an approval request (it must not claim the change happened). */
export function approvalSummaryForAi(v: ApprovalView, existing: boolean): Record<string, unknown> {
  return {
    outcome: 'approval-requested',
    instruction: (existing ? 'The same request was already waiting; nothing new was made. ' : '') +
      'NOT written yet: a person must approve it first. Tell the member it is waiting for approval (the card in the chat shows to whom). ' +
      'You cannot approve, send back or withdraw it. Do not say it was updated.',
    approvalId: v.id, recordTitle: v.recordTitle, state: v.state,
    changes: v.changes.map(c => ({ label: c.label, beforeShown: c.beforeShown, afterShown: c.afterShown, changePercent: c.changePercent })),
  }
}
