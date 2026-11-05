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

/** reply_request version 1 (B2), before B4 added 「もう返した」. */
export const REPLY_REQUEST_V1_TEXT = `---
label: 返事のお願い
version: 1
implements: [request, prepared, outside_event]
storage: server
fields:
  requested_by:  { label: 作った人, kind: person, source: server }
  assignee:      { label: 担当, kind: person, source: server }
  next_actor:    { label: 次に動く人, kind: person, source: server }
  waiting_on:    { label: 待っているもの, kind: text, source: server }
  due:           { label: 期限, kind: date, source: server }
  guideline_due: { label: 返事の目安, kind: date, source: server }
  due_note:      { label: 期限のもと, kind: text, source: server }
  occurred_at:   { label: 連絡が来た日時, kind: datetime, source: server }
  end_condition: { label: 終わりの条件, kind: long_text, source: server }
  wait_until:    { label: 返事の見込み, kind: date, source: server }
  prep_summary:  { label: AIが用意したこと, kind: long_text, source: server }
  close_reason:  { label: 終わりにしたわけ, kind: long_text, source: server }
  trigger_kind:  { label: きっかけ, kind: choice, options: [their_reply, our_reply], option_labels: { their_reply: 相手から返事が来た, our_reply: こちらから返信した }, source: server }
  trigger_ref:   { label: きっかけの連絡への目印, kind: text, source: server }
  replied_by:    { label: 返信した人, kind: person, source: server }
links:
  interaction:   { label: もとの連絡, target: interaction, cardinality: one, inverse: reply_requests }
  bundle:        { label: まとまり, interface: bundle, cardinality: one, inverse: reply_requests }
  counterpart:   { label: 相手, interface: counterpart, cardinality: one, inverse: reply_requests }
  prepared:      { label: AIが用意したもの, interface: prepared, cardinality: many, inverse: reply_requests }
states: [preparing, open, waiting_reply, checking, closed, dropped]
initial: preparing
final: [closed, dropped]
actions:
  finish_prep:   { label: 用意ができた, from: [preparing], to: open, who: [ai], args: { prep_summary: long_text }, links: [prepared], notify: assignee, hand_to: assignee }
  hand_over:     { label: 先に渡す, from: [preparing, checking], to: open, who: [ai], links: [prepared], notify: assignee, note: required, hand_to: assignee }
  ai_close:      { label: AI が判断して終わりにする, from: [preparing, checking], to: closed, who: [ai], args: { close_reason: long_text }, note: optional }
  take_over:     { label: 自分で進める, from: [preparing, checking], to: open, who: [assignee], note: optional, hand_to: assignee }
  await_reply:   { label: 相手の返事待ちにする, from: [open, checking], to: waiting_reply, who: [assignee, ai], args: { waiting_on: text }, note: optional }
  resume:        { label: 自分の番に戻す, from: [waiting_reply], to: open, who: [assignee], note: optional, hand_to: assignee }
  close:         { label: 終わりにする, from: [open, waiting_reply], to: closed, who: [assignee], note: optional }
  drop:          { label: 返事をしない, from: [preparing, open, waiting_reply, checking], to: dropped, who: [assignee], note: required }
  reopen:        { label: やり直す, from: [closed, dropped], to: open, who: [assignee], note: optional, hand_to: assignee }
  set_end_condition: { label: 終わりの条件を決める, who: [assignee, ai], args: { end_condition: long_text }, note: optional }
  set_due:       { label: 期限を変える, who: [assignee, ai], args: { due: date }, note: optional }
  set_wait_until: { label: 返事の見込みを決める, who: [assignee, ai], args: { wait_until: date }, note: optional }
---
# 返事のお願い

来た連絡から生まれる「返事をする」仕事。ふつうのやることとは別の型で、終わりの条件を持ちます（返事が来れば・日程が決まれば など。AI が作るときに入れ、人が直せます）。
「準備中」と「確かめ中」は AI の番です。AI が返事の下書きを用意して担当に渡し、返事が来たとき・こちらが返信したときは、終わりの条件と照らして終わりにするか（「AI が判断して終わりにする」）、相手の返事待ちにするか、担当の番に戻すかを決めます。この型の中でだけ、AI が終わりにできます（やり直せます）。
期限は、連絡に締切が書いてあればそれ、なければ会社の「返事の目安」です。目安で入れた期限は「目安」と分かるように出します。
`

/**
 * interaction version 5 as it was before 「済んだ」 (owner FB #20): version 6 only adds the
 * assignee's `settle` and its `settled_by` field.
 */
export const INTERACTION_V5_TEXT = `---
label: やりとり
version: 5
implements: [outside_event, request]
storage: server
fields:
  occurred_at:  { label: いつ, kind: datetime, source: server }
  channel:      { label: 経路, kind: choice, options: [email, slack, line, phone, meeting, other, chat], option_labels: { email: メール, slack: Slack, line: LINE, phone: 電話, meeting: 会議, other: そのほか, chat: チャット }, source: server }
  counterpart_text: { label: 相手（書いてあるまま）, kind: text, source: server }
  source_ref:   { label: 元への目印, kind: text, source: server }
  needs_reply:  { label: 返事が要る, kind: boolean, source: server }
  message_id:   { label: メッセージの印, kind: text, source: server }
  thread_ref:   { label: スレッドへの目印, kind: text, source: server }
  from_address: { label: 送り主, kind: text, source: server }
  to_addresses: { label: 宛先（To）, kind: text, source: server }
  cc_addresses: { label: CC, kind: text, source: server }
  requested_by: { label: 頼んだ人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  intake_reason: { label: 受け取ったわけ, kind: choice, options: [to, multiple_to, shared, cc, bulk, automated], option_labels: { to: 宛先（To）があなた, multiple_to: 宛先（To）が何人も, shared: 共有の受付アドレス, cc: CC だけ, bulk: メルマガ・一斉送信, automated: 自動で送られたもの }, source: server }
links:
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: interactions }
  tasks:        { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: interactions }
states: [received, handled, unsure, unclaimed, excluded]
initial: received
final: [handled, excluded]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
  set_aside:    { label: やることにしない, from: [received], to: excluded, who: [ai], note: required }
  ask_person:   { label: 確認待ちにする, from: [received], to: unsure, who: [ai], note: required, hand_to: assignee }
  confirm:      { label: 自分の担当にする, from: [unsure], to: received, who: [assignee], note: optional, hand_to: assignee }
  drop:         { label: やることにしない（自分で決める）, from: [unsure], to: excluded, who: [assignee], note: optional }
  take_up:      { label: やることにする, from: [excluded], to: received, who: [assignee], note: optional, hand_to: assignee }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
来た連絡（メール・チャット）は、宛先（To）の人の「持ち主だけ」の記録になります（CC の人には出しません）。「届いた」は AI の番で、AI が返事が要るかを判断して「返事のお願い」を作るか、「やることにしない」にします。決めきれないものは「確認待ち」で担当の人の番、共有の受付アドレスに来たものは「部署の番」で、誰かが引き受けます。
`

/**
 * interaction version 6 as it was before 「返事のあとを確かめる」 (owner FB #19): version 7 only adds
 * the state `replied` and its two actions (the AI's `finish_reply_check`, the assignee's `check_myself`).
 */
export const INTERACTION_V6_TEXT = `---
label: やりとり
version: 6
implements: [outside_event, request]
storage: server
fields:
  occurred_at:  { label: いつ, kind: datetime, source: server }
  channel:      { label: 経路, kind: choice, options: [email, slack, line, phone, meeting, other, chat], option_labels: { email: メール, slack: Slack, line: LINE, phone: 電話, meeting: 会議, other: そのほか, chat: チャット }, source: server }
  counterpart_text: { label: 相手（書いてあるまま）, kind: text, source: server }
  source_ref:   { label: 元への目印, kind: text, source: server }
  needs_reply:  { label: 返事が要る, kind: boolean, source: server }
  message_id:   { label: メッセージの印, kind: text, source: server }
  thread_ref:   { label: スレッドへの目印, kind: text, source: server }
  from_address: { label: 送り主, kind: text, source: server }
  to_addresses: { label: 宛先（To）, kind: text, source: server }
  cc_addresses: { label: CC, kind: text, source: server }
  requested_by: { label: 頼んだ人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  intake_reason: { label: 受け取ったわけ, kind: choice, options: [to, multiple_to, shared, cc, bulk, automated], option_labels: { to: 宛先（To）があなた, multiple_to: 宛先（To）が何人も, shared: 共有の受付アドレス, cc: CC だけ, bulk: メルマガ・一斉送信, automated: 自動で送られたもの }, source: server }
  settled_by:   { label: 済んだとした人, kind: person, source: server }
links:
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: interactions }
  tasks:        { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: interactions }
states: [received, handled, unsure, unclaimed, excluded]
initial: received
final: [handled, excluded]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
  set_aside:    { label: やることにしない, from: [received], to: excluded, who: [ai], note: required }
  ask_person:   { label: 確認待ちにする, from: [received], to: unsure, who: [ai], note: required, hand_to: assignee }
  confirm:      { label: 自分の担当にする, from: [unsure], to: received, who: [assignee], note: optional, hand_to: assignee }
  drop:         { label: やることにしない（自分で決める）, from: [unsure], to: excluded, who: [assignee], note: optional }
  take_up:      { label: やることにする, from: [excluded], to: received, who: [assignee], note: optional, hand_to: assignee }
  settle:       { label: 済んだ, from: [unsure], to: handled, who: [assignee], args: { settled_by: person }, note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
来た連絡（メール・チャット）は、宛先（To）の人の「持ち主だけ」の記録になります（CC の人には出しません）。「届いた」は AI の番で、AI が返事が要るかを判断して「返事のお願い」を作るか、「やることにしない」にします。決めきれないものは「確認待ち」で担当の人の番、共有の受付アドレスに来たものは「部署の番」で、誰かが引き受けます。
`

/**
 * interaction version 7 as it was before 「受信トレイから外れた」 (owner decision 2026-11-05): version 8
 * only adds the action `left_inbox` (`who: [system]`: the inbox alone).
 */
export const INTERACTION_V7_TEXT = `---
label: やりとり
version: 7
implements: [outside_event, request]
storage: server
fields:
  occurred_at:  { label: いつ, kind: datetime, source: server }
  channel:      { label: 経路, kind: choice, options: [email, slack, line, phone, meeting, other, chat], option_labels: { email: メール, slack: Slack, line: LINE, phone: 電話, meeting: 会議, other: そのほか, chat: チャット }, source: server }
  counterpart_text: { label: 相手（書いてあるまま）, kind: text, source: server }
  source_ref:   { label: 元への目印, kind: text, source: server }
  needs_reply:  { label: 返事が要る, kind: boolean, source: server }
  message_id:   { label: メッセージの印, kind: text, source: server }
  thread_ref:   { label: スレッドへの目印, kind: text, source: server }
  from_address: { label: 送り主, kind: text, source: server }
  to_addresses: { label: 宛先（To）, kind: text, source: server }
  cc_addresses: { label: CC, kind: text, source: server }
  requested_by: { label: 頼んだ人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
  intake_reason: { label: 受け取ったわけ, kind: choice, options: [to, multiple_to, shared, cc, bulk, automated], option_labels: { to: 宛先（To）があなた, multiple_to: 宛先（To）が何人も, shared: 共有の受付アドレス, cc: CC だけ, bulk: メルマガ・一斉送信, automated: 自動で送られたもの }, source: server }
  settled_by:   { label: 済んだとした人, kind: person, source: server }
links:
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: interactions }
  tasks:        { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: interactions }
states: [received, handled, unsure, unclaimed, excluded, replied]
initial: received
final: [handled, excluded]
actions:
  handle:       { label: 対応済みにする, from: [received], to: handled, who: [anyone], note: optional }
  set_aside:    { label: やることにしない, from: [received], to: excluded, who: [ai], note: required }
  ask_person:   { label: 確認待ちにする, from: [received], to: unsure, who: [ai], note: required, hand_to: assignee }
  confirm:      { label: 自分の担当にする, from: [unsure], to: received, who: [assignee], note: optional, hand_to: assignee }
  drop:         { label: やることにしない（自分で決める）, from: [unsure], to: excluded, who: [assignee], note: optional }
  take_up:      { label: やることにする, from: [excluded], to: received, who: [assignee], note: optional, hand_to: assignee }
  settle:       { label: 済んだ, from: [unsure], to: handled, who: [assignee], args: { settled_by: person }, note: optional }
  finish_reply_check: { label: 返事のあとを確かめた, from: [replied], to: handled, who: [ai], note: optional }
  check_myself: { label: 自分で確かめる, from: [replied], to: handled, who: [assignee], note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
来た連絡（メール・チャット）は、宛先（To）の人の「持ち主だけ」の記録になります（CC の人には出しません）。「届いた」は AI の番で、AI が返事が要るかを判断して「返事のお願い」を作るか、「やることにしない」にします。決めきれないものは「確認待ち」で担当の人の番、共有の受付アドレスに来たものは「部署の番」で、誰かが引き受けます。
確認待ちの連絡は、話がもう決着していれば担当が「済んだ」で終わりにでき（今日終わったことに出て、すぐなら取り消せます）、取り込まないなら「やることにしない（自分で決める）」でやることにしなかった一覧に移します。
担当がスマホや Slack・Gmail で自分で返事をしたとき、この連絡から作ったタスクが残っていれば「返事のあとを確かめる」（AI の番）になります。AI が返事でタスクが済んだかを見て、済んでいれば完了にして知らせ（取り消せます）、まだなら「返事は済み」と書き残します。
`
