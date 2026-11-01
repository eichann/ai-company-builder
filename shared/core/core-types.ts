/**
 * The core types every company has (stage 4-5, ontology 0.3-7): `task` and
 * `interaction`, written in the same format as `.acb/types/<name>.md` and
 * validated by the same parser. The server stores them per company (source
 * `core`) when the company map is turned on; a company may extend one with
 * its own `.acb/types/<name>.md` (a higher version that only adds).
 *
 * task (タスク): the first type implementing `request` (依頼). Server only
 * (owner decision 2026-11-01: record data lives only on the server; what
 * people write — a quote, a plan — stays an ordinary file the task links to).
 * Version 1 was storage `either` (a file once it had content, 0.6-1).
 * Version 3 (2026-11-01): `set_due` (「延ばす」) tells the requester. The due
 * may carry a time of day (kind `date` takes `YYYY-MM-DD[THH:MM]`,
 * shared/core/record-types.ts `isDateValue`) — the kind itself is unchanged.
 * Version 4 (2026-11-01): the assignee may complete too, saying whose OK it
 * was (`ok_from: [assignee]` → `ok_by` a member, or `ok_note` for an OK from
 * outside ACB); the OK-giver is told and may reopen (「取り消す」). The
 * requester / reviewer complete as before; the AI never.
 * Version 5 (stage 2 S2, 2026-11-01): tags, `wait_until` (when a reply or
 * delivery is expected — what 追いかけ looks at), a `bundle` link (まとまり),
 * 「AI が用意したもの」 (`prep_summary` + `prepared` links to the mail drafts /
 * approval requests the AI made). State `preparing` is the AI's turn
 * (`create_states`: a create may start there; `finish_prep`, AI only, hands
 * it to the assignee), so an AI-prepared task reaches the person only when
 * ready — but never hidden: `hand_over` (AI only, a reason required: due
 * soon, the preparation failed, information is missing) hands it to the
 * assignee early with whatever is ready, and `take_over` lets the assignee or
 * requester take it from the AI at any time. `decline` (受けられない): the assignee only, with a note, hands it
 * back to the requester, who reassigns, cancels or reopens it from
 * `declined` (not final: it is the requester's turn). The AI never
 * completes or declines.
 *
 * Version 6 (core interfaces, owner decision 2026-11-01 night): the `customer`
 * link is gone — a task reaches its customer through its `bundle` — and a
 * task with no bundle may name its `counterpart` (相手) instead.
 *
 * interaction (やりとり): the common receipt for what comes from outside
 * (mail, Slack, LINE…). Server only, no body — a summary and a pointer to the
 * original (0.23-2). Version 3 links `bundle` and `counterpart`.
 *
 * Milestone 4 (after a sales meeting): `meeting` (会議 — version 1 of what was
 * the `minutes` type; the 議事録 is the meeting's content, read where it is),
 * `approval` (承認のお願い), `outbound_message` (送るもの) and `decision`
 * (決めたこと). Their records are made only by the server's own services
 * (`SERVICE_OWNED_TYPES`); `approval` and `outbound_message` change state only
 * through those services too (`SERVICE_STATE_TYPES`, `SERVICE_TRANSITIONS`),
 * because approving checks a content hash and runs an operation, and sending
 * reaches outside.
 *
 * **The core never names a business plugin's type** (owner decision
 * 2026-11-01 night): what work belongs to links to the `bundle` interface
 * (まとまり: a 案件, a 企画, a 取り組み), whom it is with to the `counterpart`
 * interface (相手: a 顧客, a guest, an applicant). A link target that is a type
 * is always a core type (`server/tests/unit/core-types-interfaces.test.ts`).
 */
import { parseTypeFile, type TypeDefinition } from './record-types'

export const CORE_TYPE_FILES: Record<string, string> = {
  task: `---
label: タスク
version: 6
implements: [request]
storage: server
fields:
  title:        { label: 件名, kind: text, source: file }
  purpose:      { label: 目的, kind: long_text, source: server }
  requested_by: { label: 依頼した人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  reviewer:     { label: レビューする人, kind: person, source: server }
  ok_by:        { label: OKした人, kind: person, source: server }
  ok_note:      { label: OKのいきさつ, kind: text, source: server }
  tags:         { label: タグ, kind: tags, source: server }
  wait_until:   { label: 返事・届く見込み, kind: date, source: server }
  prep_summary: { label: AIが用意したこと, kind: long_text, source: server }
links:
  files:        { label: 関係するファイル, target: file, cardinality: many }
  related:      { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: tasks }
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: tasks }
  prepared:     { label: AIが用意したもの, interface: prepared, cardinality: many, inverse: tasks }
states: [todo, in_progress, review, waiting, done, cancelled, preparing, declined]
initial: todo
create_states: [preparing]
final: [done, cancelled]
actions:
  start:          { label: 着手する, from: [todo, waiting], to: in_progress, who: [assignee, ai], hand_to: assignee }
  request_review: { label: レビューを依頼する, from: [in_progress], to: review, who: [assignee, ai], args: { reviewer: person }, notify: reviewer, attach: [files], note: optional, hand_to: reviewer }
  send_back:      { label: 差し戻す, from: [review], to: in_progress, who: [reviewer], notify: assignee, note: required, decision: true, hand_to: assignee }
  assign:         { label: 担当を替える, from: [todo, in_progress, review, waiting, declined], who: [assignee, requested_by, dept_manager, admin, ai], args: { assignee: person }, notify: assignee, note: required, approval: undoable, decision: true, hand_to: assignee }
  wait:           { label: 返事待ちにする, from: [todo, in_progress], to: waiting, who: [assignee, ai], args: { waiting_on: text }, note: optional }
  set_due:        { label: 期限を変える, who: [requested_by, assignee, ai], args: { due: date }, notify: requested_by, note: optional, approval: undoable }
  complete:       { label: 完了にする, from: [in_progress, review], to: done, who: [requested_by, reviewer], ok_from: [assignee], notify: [requested_by, ok_by], attach: [files], note: optional, decision: true }
  cancel:         { label: 中止する, from: [todo, in_progress, review, waiting, preparing, declined], to: cancelled, who: [requested_by, admin], notify: assignee, note: required, decision: true }
  reopen:         { label: やり直す, from: [done, cancelled, declined], to: in_progress, who: [requested_by, ok_by, admin], notify: assignee, note: optional, hand_to: assignee }
  finish_prep:    { label: 用意ができた, from: [preparing], to: todo, who: [ai], args: { prep_summary: long_text }, links: [prepared], notify: assignee, hand_to: assignee }
  hand_over:      { label: 先に渡す, from: [preparing], to: todo, who: [ai], links: [prepared], notify: assignee, note: required, hand_to: assignee }
  take_over:      { label: 自分で進める, from: [preparing], to: todo, who: [assignee, requested_by], notify: assignee, note: optional, hand_to: assignee }
  decline:        { label: 受けられない, from: [todo, in_progress, waiting], to: declined, who: [assignee], notify: requested_by, note: required, hand_to: requested_by }
  set_tags:       { label: タグを付ける, who: [requested_by, assignee, ai], args: { tags: tags } }
  set_wait_until: { label: 見込みの日時を決める, who: [requested_by, assignee, ai], args: { wait_until: date }, note: optional }
  set_bundle:     { label: まとまりに入れる, who: [requested_by, assignee, ai], links: [bundle], note: optional }
---
# タスク

ACB に最初からある「依頼」の形。記録はサーバーだけが持ちます（ファイルにはしません）。見積や計画などの中身はふつうのファイルに書き、「関係するファイル」でつなぎます。
「準備中」は AI の番です。AI が下ごしらえ（確かめたこと・下書き）を済ませて「用意ができた」で担当に渡します。期限が近い・うまくいかなかった・情報が足りないときは、AI が理由を添えて「先に渡す」で早めに渡します。担当と頼んだ人は「自分で進める」でいつでも引き取れます。担当は「受けられない」で頼んだ人に返せます（ひとことの理由つき）。
お客さまなどの相手は「まとまり」（案件など）からたどります。まとまりに入らないタスクだけ、「相手」を直接つなぎます。
`,
  interaction: `---
label: やりとり
version: 3
storage: server
fields:
  occurred_at:  { label: いつ, kind: datetime, source: server }
  channel:      { label: 経路, kind: choice, options: [email, slack, line, phone, meeting, other], source: server }
  counterpart_text: { label: 相手（書いてあるまま）, kind: text, source: server }
  source_ref:   { label: 元への目印, kind: text, source: server }
  needs_reply:  { label: 返事が要る, kind: boolean, source: server }
links:
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: interactions }
  tasks:        { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: interactions }
states: [received, handled]
initial: received
final: [handled]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
`,
  meeting: `---
label: 会議
version: 1
storage: server
fields:
  meeting_at:     { label: 会議の日時, kind: datetime, source: server }
  assignee:       { label: 担当, kind: person, source: server }
  attendees:      { label: 出席したメンバー, kind: text, source: server }
  external_count: { label: 社外の参加者の数, kind: number, source: server }
  source_ref:     { label: 議事録への目印, kind: text, source: server }
  doc_version:    { label: 議事録の版, kind: text, source: server }
  summary_text:   { label: 要約, kind: long_text, source: server }
links:
  bundle:         { label: まとまり, interface: bundle, cardinality: one, inverse: meetings }
  counterpart:    { label: 相手, interface: counterpart, cardinality: one, inverse: meetings }
states: [received, reading, read, skipped, failed]
initial: received
final: [read, skipped]
actions:
  start_reading:  { label: 議事録を読み始める, from: [received], to: reading, who: [ai] }
  finish_reading: { label: 議事録を読み終える, from: [reading], to: read, who: [ai], args: { summary_text: long_text } }
  fail_reading:   { label: 議事録を読めなかった, from: [reading], to: failed, who: [ai], note: optional }
  retry:          { label: もう一度読む, from: [reading, failed], to: received, who: [assignee, admin], note: optional }
  skip:           { label: 読まない, from: [received, failed], to: skipped, who: [assignee, admin], note: optional }
---
# 会議

社内・社外の会議の記録（日時・出席したメンバー・社外の参加者の数）。議事録は会議の中身で、元の文書に置いたまま（本文は持たず、議事録への目印と要約だけを持ちます）。
「届いた」は AI の番です（AI が議事録を読んで、タスクや決めたことにします）。どの会議を読むかは会社の設定で決まります（最初は社外の人が出た会議だけ）。
`,
  approval: `---
label: 承認のお願い
version: 4
implements: [request, prepared]
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
  bundle:              { label: まとまり, interface: bundle, cardinality: one, inverse: approvals }
  meeting:             { label: 会議, target: meeting, cardinality: one, inverse: approvals }
states: [pending, approved, sent_back, stale, withdrawn, failed]
initial: pending
final: [approved, stale, withdrawn, failed]
---
# 承認のお願い

固定した中身（内容の印つき）を承認する人に確かめてもらう依頼。承認・差し戻しは人だけが、承認の画面からします（AI はできません）。
`,
  outbound_message: `---
label: 送るもの
version: 3
implements: [prepared]
storage: server
fields:
  requested_by:        { label: 作った人, kind: person, source: server }
  assignee:            { label: 担当, kind: person, source: server }
  subject:             { label: 件名, kind: text, source: server }
  payload_hash:        { label: 内容の印, kind: text, source: server }
  payload_version:     { label: 中身の版, kind: number, source: server }
  sent_at:             { label: 送った日時, kind: datetime, source: server }
  provider_message_id: { label: 送った先での番号, kind: text, source: server }
  channel:             { label: 経路, kind: choice, options: [email, slack], option_labels: { email: メール, slack: Slack }, source: server }
links:
  bundle:              { label: まとまり, interface: bundle, cardinality: one, inverse: messages }
  meeting:             { label: 会議, target: meeting, cardinality: one, inverse: messages }
states: [draft, sent, unknown, discarded]
initial: draft
final: [sent, discarded]
---
# 送るもの

社外に送るもの（メール、のちに Slack の返事）の下書き。送るのは作った人本人だけで、送る画面から行います（AI は送れません）。
`,
  decision: `---
label: 決めたこと
version: 4
storage: server
fields:
  title:       { label: 件名, kind: text, source: file }
  why:         { label: なぜ, kind: long_text, source: server }
  source:      { label: 元, kind: text, source: server }
  recorded_by: { label: 記録したもの, kind: choice, options: [ai, human], source: server }
  important:   { label: 大事, kind: boolean, source: server }
  exception:   { label: 例外（この件だけ）, kind: boolean, source: server }
  decided_by:  { label: 決めた人, kind: person, source: server }
  owner:       { label: 確かめる人, kind: person, source: server }
  source_key:  { label: 元の項目の目印, kind: text, source: server }
links:
  bundle:      { label: まとまり, interface: bundle, cardinality: one, inverse: decisions }
  meeting:     { label: 会議, target: meeting, cardinality: one, inverse: decisions }
  approval:    { label: 承認のお願い, target: approval, cardinality: one, inverse: decisions }
states: [unconfirmed, confirmed, retracted]
initial: unconfirmed
final: [confirmed, retracted]
actions:
  confirm: { label: 確かめる, from: [unconfirmed], to: confirmed, who: [owner, dept_manager, admin], note: optional, decision: true }
  retract: { label: 取り消す, from: [unconfirmed, confirmed], to: retracted, who: [owner, dept_manager, admin], note: required, decision: true }
  set_exception: { label: 例外（この件だけ）を切り替える, from: [unconfirmed, confirmed], who: [owner, dept_manager, admin], args: { exception: boolean }, note: optional }
---
# 決めたこと

商談などで決まったことの記録。サーバーだけが持ち（ファイルにはしません）、置いた部署のフォルダを読める人だけが見られます。
「例外（この件だけ）」の決めたことは、つながった件だけの判断です（例「今回の見積は特別に20%値引きしてよい」）。ほかの件の前例にはしません。
`,
}

/**
 * Core types whose records only the server's own services create (meeting
 * intake, approvals, outbound mail, decisions): the generic create
 * (`POST /records/item`, the AI's `records_create`) refuses them with
 * `TYPE_CREATED_BY_SERVICE`.
 */
export const SERVICE_OWNED_TYPES: readonly string[] = ['meeting', 'approval', 'outbound_message', 'decision']

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
 * on its bundle, design §1-6 step 19). They stay creatable by the generic
 * routes too.
 */
export const SERVICE_RECEIPT_TYPES: readonly string[] = ['interaction']

/**
 * The state changes the service writer (server/src/services/record-engine.ts
 * `createServiceRecordWriter`) may make, per type: from one of `from` to `to`.
 * A change of fields that keeps the state is always allowed.
 */
export const SERVICE_TRANSITIONS: Readonly<Record<string, ReadonlyArray<{ from: readonly string[]; to: string }>>> = {
  meeting: [
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
  // Not service-owned: only the server clock's 「見込みの日時が過ぎた」 (WAIT_OVER below), a state
  // change only — the writer refuses a field-only change of a type that is not service-owned.
  task: [
    { from: ['waiting'], to: 'preparing' },
    { from: ['waiting'], to: 'todo' },
  ],
}

/**
 * The server clock (server/src/services/server-clock.ts, notifications.md
 * "The server clock"): when a record of `type` is still in `from` after its
 * `field` (a date, day or day + time) has passed — the reply or delivery did
 * not come — the clock moves it so 追いかけ (following up) can happen: to
 * `aiTurn` when the company's 自動で進める is on and that state is an AI turn of
 * the type (the AI drafts the follow-up, then 「用意ができた」 / 「先に渡す」
 * as for any preparation), else to `personTurn` (the assignee's turn), and the
 * assignee is told. The AI never runs on the server: the clock only moves the
 * turn. Each move is one of `SERVICE_TRANSITIONS`.
 */
export const WAIT_OVER: Readonly<Record<string, { field: string; from: string; aiTurn: string; personTurn: string }>> = {
  task: { field: 'wait_until', from: 'waiting', aiTurn: 'preparing', personTurn: 'todo' },
}

/** The ledger action of the clock's move (no action of the type: nobody else can run it). */
export const WAIT_OVER_ACTION = 'wait_over'

/**
 * The server clock as a ledger actor: kind `external` (server-side, never a
 * member, never the AI), this id, and a source the history shows as is.
 */
export const CLOCK_ACTOR = Object.freeze({ id: 'acb:clock', kind: 'external' as const, source: 'ACB の時計' })

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
