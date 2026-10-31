/**
 * The core types every company has (stage 4-5, ontology 0.3-7): `task` and
 * `interaction`, written in the same format as `.acb/types/<name>.md` and
 * validated by the same parser. The server stores them per company (source
 * `core`) when the company map is turned on; a company may extend one with
 * its own `.acb/types/<name>.md` (a higher version that only adds).
 *
 * task (タスク): the first type implementing `request` (依頼). Small tasks
 * live on the server only; one gets a file once it has content worth keeping
 * (storage `either`, 0.6-1).
 *
 * interaction (やりとり): the common receipt for what comes from outside
 * (mail, Slack, LINE…). Server only, no body — a summary and a pointer to the
 * original (0.23-2). Defined now; used from stage 8.
 *
 * Milestone 4 (after a sales meeting): `minutes` (議事録), `approval`
 * (承認のお願い), `outbound_message` (送るメール) and `decision` (決めたこと).
 * Their records are made only by the server's own services
 * (`SERVICE_OWNED_TYPES`); `approval` and `outbound_message` change state only
 * through those services too (`SERVICE_STATE_TYPES`, `SERVICE_TRANSITIONS`),
 * because approving checks a content hash and runs an operation, and sending
 * reaches outside. Links to `deal` / `customer` name types a plugin brings (a
 * link's target type is a label: nothing requires it to exist).
 */
import { parseTypeFile, type TypeDefinition } from './record-types'

export const CORE_TYPE_FILES: Record<string, string> = {
  task: `---
label: タスク
version: 1
implements: [request]
storage: either
fields:
  title:        { label: 件名, kind: text, source: file }
  purpose:      { label: 目的, kind: long_text, source: file }
  requested_by: { label: 依頼した人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  reviewer:     { label: レビューする人, kind: person, source: server }
links:
  customer:     { label: 顧客, target: customer, cardinality: one, inverse: tasks }
  files:        { label: 関係するファイル, target: file, cardinality: many }
  related:      { label: 関係するタスク, target: task, cardinality: many }
states: [todo, in_progress, review, waiting, done, cancelled]
initial: todo
final: [done, cancelled]
actions:
  start:          { label: 着手する, from: [todo, waiting], to: in_progress, who: [assignee, ai], hand_to: assignee }
  request_review: { label: レビューを依頼する, from: [in_progress], to: review, who: [assignee, ai], args: { reviewer: person }, notify: reviewer, attach: [files], note: optional, hand_to: reviewer }
  send_back:      { label: 差し戻す, from: [review], to: in_progress, who: [reviewer], notify: assignee, note: required, decision: true, hand_to: assignee }
  assign:         { label: 担当を替える, from: [todo, in_progress, review, waiting], who: [assignee, requested_by, dept_manager, admin, ai], args: { assignee: person }, notify: assignee, note: required, approval: undoable, decision: true, hand_to: assignee }
  wait:           { label: 返事待ちにする, from: [todo, in_progress], to: waiting, who: [assignee, ai], args: { waiting_on: text }, note: optional }
  set_due:        { label: 期限を変える, who: [requested_by, assignee, ai], args: { due: date }, note: optional, approval: undoable }
  complete:       { label: 完了にする, from: [in_progress, review], to: done, who: [requested_by, reviewer], notify: requested_by, attach: [files], note: optional, history_line: true, decision: true }
  cancel:         { label: 中止する, from: [todo, in_progress, review, waiting], to: cancelled, who: [requested_by, admin], notify: assignee, note: required, history_line: true, decision: true }
  reopen:         { label: やり直す, from: [done, cancelled], to: in_progress, who: [requested_by, admin], notify: assignee, note: optional, hand_to: assignee }
---
# タスク

ACB に最初からある「依頼」の形。状態・担当・期限はサーバーが持ち、ファイルには書きません。
`,
  interaction: `---
label: やりとり
version: 2
storage: server
fields:
  occurred_at:  { label: いつ, kind: datetime, source: server }
  channel:      { label: 経路, kind: choice, options: [email, slack, line, phone, meeting, other], source: server }
  counterpart:  { label: 相手, kind: text, source: server }
  source_ref:   { label: 元への目印, kind: text, source: server }
  needs_reply:  { label: 返事が要る, kind: boolean, source: server }
links:
  customer:     { label: 顧客, target: customer, cardinality: one, inverse: interactions }
  tasks:        { label: 関係するタスク, target: task, cardinality: many }
  deal:         { label: 案件, target: deal, cardinality: one, inverse: interactions }
states: [received, handled]
initial: received
final: [handled]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
`,
  minutes: `---
label: 議事録
version: 1
storage: server
fields:
  meeting_at:     { label: 会議の日時, kind: datetime, source: server }
  assignee:       { label: 担当, kind: person, source: server }
  attendees:      { label: 出席したメンバー, kind: text, source: server }
  external_count: { label: 外の参加者の数, kind: number, source: server }
  source_ref:     { label: 元への目印, kind: text, source: server }
  doc_version:    { label: 文書の版, kind: text, source: server }
  summary_text:   { label: 要約, kind: long_text, source: server }
links:
  deal:           { label: 案件, target: deal, cardinality: one, inverse: minutes }
  customer:       { label: 顧客, target: customer, cardinality: one, inverse: minutes }
states: [received, reading, read, skipped, failed]
initial: received
final: [read, skipped]
actions:
  start_reading:  { label: 読み始める, from: [received], to: reading, who: [ai] }
  finish_reading: { label: 読み終える, from: [reading], to: read, who: [ai], args: { summary_text: long_text } }
  fail_reading:   { label: 読めなかった, from: [reading], to: failed, who: [ai], note: optional }
  retry:          { label: もう一度読む, from: [reading, failed], to: received, who: [assignee, admin], note: optional }
  skip:           { label: 読まない, from: [received, failed], to: skipped, who: [assignee, admin], note: optional }
---
# 議事録

会議の議事録が届いたことの記録。本文は持たず（元の文書に置いたまま）、元への目印と要約だけを持ちます。
「届いた」は AI の番です（AI だけができる操作が残っている状態）。
`,
  approval: `---
label: 承認のお願い
version: 2
implements: [request]
storage: server
fields:
  requested_by:        { label: 頼んだ人, kind: person, source: server }
  assignee:            { label: 承認する人, kind: person, source: server }
  next_actor:          { label: 次に動く人, kind: person, source: server }
  waiting_on:          { label: 待っているもの, kind: text, source: server }
  due:                 { label: 期限, kind: date, source: server }
  approver_rule:       { label: 承認する人の決まり, kind: choice, options: [self, dept_manager, admin], source: server }
  operation:           { label: 操作, kind: text, source: server }
  payload_hash:        { label: 内容の印, kind: text, source: server }
  payload_version:     { label: 中身の版, kind: number, source: server }
  reason:              { label: 理由, kind: long_text, source: server }
  result_operation_id: { label: 操作の控え, kind: text, source: server }
links:
  about:               { label: 対象, target: deal, cardinality: one, inverse: approvals }
  minutes:             { label: 議事録, target: minutes, cardinality: one, inverse: approvals }
states: [pending, approved, sent_back, stale, withdrawn, failed]
initial: pending
final: [approved, stale, withdrawn, failed]
---
# 承認のお願い

固定した中身（内容の印つき）を承認する人に確かめてもらう依頼。承認・差し戻しは人だけが、承認の画面からします（AI はできません）。
`,
  outbound_message: `---
label: 送るメール
version: 1
storage: server
fields:
  requested_by:        { label: 作った人, kind: person, source: server }
  assignee:            { label: 担当, kind: person, source: server }
  subject:             { label: 件名, kind: text, source: server }
  payload_hash:        { label: 内容の印, kind: text, source: server }
  payload_version:     { label: 中身の版, kind: number, source: server }
  sent_at:             { label: 送った日時, kind: datetime, source: server }
  provider_message_id: { label: 送った先での番号, kind: text, source: server }
  channel:             { label: 経路, kind: choice, options: [email], source: server }
links:
  about:               { label: 案件, target: deal, cardinality: one, inverse: messages }
  minutes:             { label: 議事録, target: minutes, cardinality: one, inverse: messages }
states: [draft, sent, unknown, discarded]
initial: draft
final: [sent, discarded]
---
# 送るメール

社外に送るメールの下書き。送るのは作った人本人だけで、送る画面から行います（AI は送れません）。
`,
  decision: `---
label: 決めたこと
version: 1
storage: file
fields:
  title:       { label: 件名, kind: text, source: file }
  recorded_by: { label: 記録したもの, kind: choice, options: [ai, human], source: server }
  important:   { label: 大事, kind: boolean, source: server }
  decided_by:  { label: 決めた人, kind: person, source: server }
  owner:       { label: 確かめる人, kind: person, source: server }
  source_key:  { label: 元の項目の目印, kind: text, source: server }
links:
  deal:        { label: 案件, target: deal, cardinality: one, inverse: decisions }
  minutes:     { label: 議事録, target: minutes, cardinality: one, inverse: decisions }
  approval:    { label: 承認のお願い, target: approval, cardinality: one, inverse: decisions }
states: [unconfirmed, confirmed, retracted]
initial: unconfirmed
final: [confirmed, retracted]
actions:
  confirm: { label: 確かめる, from: [unconfirmed], to: confirmed, who: [owner, dept_manager, admin], note: optional, decision: true }
  retract: { label: 取り消す, from: [unconfirmed, confirmed], to: retracted, who: [owner, dept_manager, admin], note: required, decision: true }
---
# 決めたこと

商談などで決まったことの記録（部署の「意思決定」フォルダのファイル）。件名と本文に人や顧客の名前は書かず、つながり（案件・議事録）で示します。
`,
}

/**
 * Core types whose records only the server's own services create (minutes
 * intake, approvals, outbound mail, decisions): the generic create
 * (`POST /records/item`, the AI's `records_create`) refuses them with
 * `TYPE_CREATED_BY_SERVICE`.
 */
export const SERVICE_OWNED_TYPES: readonly string[] = ['minutes', 'approval', 'outbound_message', 'decision']

/**
 * Of those, the types whose state only those services change: no action or
 * undo through the generic routes, even if a company's own definition adds
 * one (approving checks a content hash and runs an operation; sending reaches
 * outside).
 */
export const SERVICE_STATE_TYPES: readonly string[] = ['approval', 'outbound_message']

/**
 * Types the service writer may also create, besides the service-owned ones:
 * receipts of what a service did outside (a sent mail becomes an `interaction`
 * on its deal, design §1-6 step 19). They stay creatable by the generic
 * routes too.
 */
export const SERVICE_RECEIPT_TYPES: readonly string[] = ['interaction']

/**
 * The state changes the service writer (server/src/services/record-engine.ts
 * `createServiceRecordWriter`) may make, per type: from one of `from` to `to`.
 * A change of fields that keeps the state is always allowed.
 */
export const SERVICE_TRANSITIONS: Readonly<Record<string, ReadonlyArray<{ from: readonly string[]; to: string }>>> = {
  minutes: [
    { from: ['received'], to: 'reading' },
    { from: ['reading'], to: 'read' },
    { from: ['reading'], to: 'failed' },
    { from: ['reading', 'failed'], to: 'received' },
    { from: ['received', 'failed'], to: 'skipped' },
  ],
  approval: [
    { from: ['pending'], to: 'approved' },
    { from: ['pending'], to: 'sent_back' },
    { from: ['pending'], to: 'stale' },
    // Sent back: the request is the requester's turn again until they withdraw it (or ask anew).
    { from: ['pending', 'sent_back'], to: 'withdrawn' },
    // Approved but the operation failed: the approval stays used (one use only).
    { from: ['pending', 'approved'], to: 'failed' },
  ],
  outbound_message: [
    { from: ['draft'], to: 'sent' },
    { from: ['draft'], to: 'unknown' },
    { from: ['draft', 'unknown'], to: 'discarded' },
    // 「送られていた」/「送られていなかった」 after an unknown result.
    { from: ['unknown'], to: 'sent' },
    { from: ['unknown'], to: 'draft' },
  ],
  decision: [
    { from: ['unconfirmed'], to: 'confirmed' },
    { from: ['unconfirmed', 'confirmed'], to: 'retracted' },
  ],
}

/** May the service writer move a record of `type` from `from` to `to`? */
export function serviceTransitionAllowed(type: string, from: string | null, to: string): boolean {
  const table = Object.prototype.hasOwnProperty.call(SERVICE_TRANSITIONS, type) ? SERVICE_TRANSITIONS[type] : undefined
  return !!table && from !== null && table.some(t => t.to === to && t.from.includes(from))
}

/** The core definitions, parsed (throws if one is invalid: a build error, caught by the tests). */
export function coreTypeDefinitions(): TypeDefinition[] {
  return Object.entries(CORE_TYPE_FILES).map(([name, text]) => {
    const r = parseTypeFile(name, text)
    if (!r.ok) throw new Error(`core type ${name}: ${r.errors.join(' / ')}`)
    return r.definition
  })
}
