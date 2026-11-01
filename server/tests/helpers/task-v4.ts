/**
 * The core task definition as it was at version 4 (before stage 2 S2), kept
 * so tests can show that later versions only add to it: tasks made under it
 * stay valid.
 */
export const TASK_V4_TEXT = `---
label: タスク
version: 4
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
  set_due:        { label: 期限を変える, who: [requested_by, assignee, ai], args: { due: date }, notify: requested_by, note: optional, approval: undoable }
  complete:       { label: 完了にする, from: [in_progress, review], to: done, who: [requested_by, reviewer], ok_from: [assignee], notify: [requested_by, ok_by], attach: [files], note: optional, decision: true }
  cancel:         { label: 中止する, from: [todo, in_progress, review, waiting], to: cancelled, who: [requested_by, admin], notify: assignee, note: required, decision: true }
  reopen:         { label: やり直す, from: [done, cancelled], to: in_progress, who: [requested_by, ok_by, admin], notify: assignee, note: optional, hand_to: assignee }
---
`
