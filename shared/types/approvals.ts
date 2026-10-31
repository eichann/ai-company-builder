/**
 * Approval requests (承認のお願い, milestone 4 G6, `.claude/rules/approvals.md`):
 * the API contract between the server (`routes/approvals.ts`) and the app's
 * core-drawn card (`client/src/features/chat/components/ApprovalCard.tsx`).
 * People are named by member id; the app shows their display names from its
 * own member list.
 */
import type { ApproverRule } from '../core/approvals'
import type { PluginFieldValue } from './plugins'

export type ApprovalState = 'pending' | 'approved' | 'sent_back' | 'stale' | 'withdrawn' | 'failed'

/** One field of the fixed content, in ACB's words (labels and shown values from the record's type). */
export interface ApprovalFieldView {
  field: string
  label: string
  before: PluginFieldValue
  after: PluginFieldValue
  /** A choice by its label (「A（高）」), else the value as text. */
  beforeShown: string
  afterShown: string
  /** For two numbers with a non-zero before: the change in percent, rounded to one decimal (+25, -12.5). */
  changePercent: number | null
}

/** An earlier approval of the same kind in the same department (前例), as far as the viewer may read. */
export interface ApprovalPrecedent {
  approvalId: string
  /** When it was decided (approved / sent back / …). */
  at: string
  state: ApprovalState
  fields: Array<{ label: string; beforeShown: string; afterShown: string }>
  /** The approver's (or sender-back's) reason. */
  reason: string | null
  /** What the record holds now for those fields (その後), when the viewer may read it. */
  nowShown: Array<{ label: string; shown: string }> | null
}

/** A reference shown with the request (材料), re-checked for the viewer's access every time. */
export interface ApprovalMaterial {
  kind: 'record' | 'minutes'
  recordId: string
  title: string
  /** The record's version the request was made on (record), else null. */
  version: number | null
}

export interface ApprovalView {
  id: string
  state: ApprovalState
  /** The approval record's version (informational; the server compares its own). */
  recordVersion: number
  pluginId: string
  operation: string
  /** The operation by its label (「案件の欄を書き換える」), else its name. */
  operationLabel: string
  /** The outside system's name (HubSpot). */
  systemLabel: string
  /** The record the request is about (null for a create of a new record). */
  recordId: string | null
  recordTitle: string | null
  changes: ApprovalFieldView[]
  /** A create: what would be made. */
  create: { title: string; fields: Array<{ label: string; shown: string }> } | null
  /** A create of a record: similar records already in ACB that the viewer may read (design §6-3), so a duplicate is noticed before approving; null when not a create or HubSpot could not be asked. */
  similar: Array<{ recordId: string; title: string | null }> | null
  /** Where the request came from: the minutes' quote (when the viewer may read the minutes, its title too). */
  basis: { minutesId: string | null; minutesTitle: string | null; quote: string | null }
  precedents: { total: number; items: ApprovalPrecedent[] }
  materials: ApprovalMaterial[]
  /** The AI's (or requester's) proposed reason: a draft for the approver, not authority. */
  proposedReason: string | null
  requestedBy: string
  /** Whether the request came from the requester's AI. */
  requestedByAi: boolean
  /** The person asked to approve (member id). */
  approver: string | null
  approverRule: ApproverRule
  approverRuleLabel: string
  /** The fixed content's hash and version: the approve button sends this hash back. */
  hash: string
  version: number
  createdAt: string
  /** The viewer may approve or send back now (a person who qualifies, state pending). */
  viewerMayApprove: boolean
  /** The viewer asked for it (may withdraw while pending or sent back). */
  viewerIsRequester: boolean
  /** How it ended (state other than pending). */
  outcome: { at: string; by: string; note: string | null; resultOperationId: string | null } | null
}

export interface ApprovalListItem {
  id: string
  state: ApprovalState
  operationLabel: string
  recordTitle: string | null
  /** One line: 「金額 120万円 → 150万円」. */
  summary: string
  requestedBy: string
  approver: string | null
  createdAt: string
  viewerMayApprove: boolean
}

/** The answer of a plugin operation that needed approval: the request was made (202). */
export interface ApprovalRequested {
  outcome: 'approval-requested'
  approval: ApprovalView
  /** true when an identical pending request already existed (nothing new was made). */
  existing: boolean
}

/** The words the card shows when the fixed content changed before approving (409 CONTENT_CHANGED). */
export const CONTENT_CHANGED_TEXT = '内容が変わりました。もう一度確かめてください'
/** The card's line under the buttons. */
export const APPROVE_HASH_NOTE = '中身が変わっていないことを確かめて承認します'
