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
version: 1
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
states: [received, handled]
initial: received
final: [handled]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
`,
}

/** The core definitions, parsed (throws if one is invalid: a build error, caught by the tests). */
export function coreTypeDefinitions(): TypeDefinition[] {
  return Object.entries(CORE_TYPE_FILES).map(([name, text]) => {
    const r = parseTypeFile(name, text)
    if (!r.ok) throw new Error(`core type ${name}: ${r.errors.join(' / ')}`)
    return r.definition
  })
}
