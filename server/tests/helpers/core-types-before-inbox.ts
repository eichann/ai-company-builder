/**
 * The core `task` (version 7) and `interaction` (version 4) definitions as
 * they were before the inbox (stage 3 B2), kept so tests can show that task
 * version 8 and interaction version 5 only add to them: records made under
 * them stay valid.
 */
export const TASK_V7_TEXT = `---
label: タスク
version: 7
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
  accepted_by:  { label: 引き受けた人, kind: person, source: server }
links:
  files:        { label: 関係するファイル, target: file, cardinality: many }
  related:      { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: tasks }
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: tasks }
  prepared:     { label: AIが用意したもの, interface: prepared, cardinality: many, inverse: tasks }
  meeting:      { label: もとの会議, target: meeting, cardinality: one, inverse: tasks }
states: [todo, in_progress, review, waiting, done, cancelled, preparing, declined, awaiting_acceptance]
initial: todo
create_states: [preparing]
final: [done, cancelled]
actions:
  start:          { label: 着手する, from: [todo, waiting], to: in_progress, who: [assignee, ai], hand_to: assignee }
  request_review: { label: レビューを依頼する, from: [in_progress], to: review, who: [assignee, ai], args: { reviewer: person }, notify: reviewer, attach: [files], note: optional, hand_to: reviewer }
  send_back:      { label: 差し戻す, from: [review], to: in_progress, who: [reviewer], notify: assignee, note: required, decision: true, hand_to: assignee }
  assign:         { label: 担当を替える, from: [todo, in_progress, review, waiting, declined, awaiting_acceptance], who: [assignee, requested_by, dept_manager, admin, ai], args: { assignee: person }, notify: assignee, note: required, approval: undoable, decision: true, hand_to: assignee }
  wait:           { label: 返事待ちにする, from: [todo, in_progress], to: waiting, who: [assignee, ai], args: { waiting_on: text }, note: optional }
  set_due:        { label: 期限を変える, who: [requested_by, assignee, ai], args: { due: date }, notify: requested_by, note: optional, approval: undoable }
  complete:       { label: 完了にする, from: [in_progress, review], to: done, who: [requested_by, reviewer], ok_from: [assignee], notify: [requested_by, ok_by], attach: [files], note: optional, decision: true }
  cancel:         { label: 中止する, from: [todo, in_progress, review, waiting, preparing, declined, awaiting_acceptance], to: cancelled, who: [requested_by, admin], notify: assignee, note: required, decision: true }
  reopen:         { label: やり直す, from: [done, cancelled, declined], to: in_progress, who: [requested_by, ok_by, admin], notify: assignee, note: optional, hand_to: assignee }
  finish_prep:    { label: 用意ができた, from: [preparing], to: todo, who: [ai], args: { prep_summary: long_text }, links: [prepared], notify: assignee, hand_to: assignee }
  hand_over:      { label: 先に渡す, from: [preparing], to: todo, who: [ai], links: [prepared], notify: assignee, note: required, hand_to: assignee }
  take_over:      { label: 自分で進める, from: [preparing], to: todo, who: [assignee, requested_by], notify: assignee, note: optional, hand_to: assignee }
  accept:         { label: 引き受ける, from: [awaiting_acceptance], to: todo, who: [assignee], notify: requested_by, note: optional, hand_to: assignee }
  decline:        { label: 受けられない, from: [todo, in_progress, waiting, awaiting_acceptance], to: declined, who: [assignee], notify: requested_by, note: required, hand_to: requested_by }
  set_tags:       { label: タグを付ける, who: [requested_by, assignee, ai], args: { tags: tags } }
  set_wait_until: { label: 見込みの日時を決める, who: [requested_by, assignee, ai], args: { wait_until: date }, note: optional }
  set_bundle:     { label: まとまりに入れる, who: [requested_by, assignee, ai], links: [bundle], note: optional }
---
# タスク

ACB に最初からある「依頼」の形。記録はサーバーだけが持ちます（ファイルにはしません）。見積や計画などの中身はふつうのファイルに書き、「関係するファイル」でつなぎます。
「準備中」は AI の番です。AI が下ごしらえ（確かめたこと・下書き）を済ませて「用意ができた」で担当に渡します。期限が近い・うまくいかなかった・情報が足りないときは、AI が理由を添えて「先に渡す」で早めに渡します。担当と頼んだ人は「自分で進める」でいつでも引き取れます。担当は「受けられない」で頼んだ人に返せます（ひとことの理由つき）。
お客さまなどの相手は「まとまり」（案件など）からたどります。まとまりに入らないタスクだけ、「相手」を直接つなぎます。
ほかの部署の人に頼んだタスクは「引き受け待ち」になり、担当が「引き受ける」と担当の番になります（どんなときに自動で引き受けたことになるかは会社の設定で決めます）。
`

export const INTERACTION_V4_TEXT = `---
label: やりとり
version: 4
implements: [outside_event]
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
`
