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
 * Version 7 (acceptance, owner decision 2026-11-01): 「頼んだ」 and
 * 「引き受けた」 are told apart. State `awaiting_acceptance` (引き受け待ち)
 * and the assignee's `accept` (引き受ける — a person, never the AI; their
 * delegate during an absence); `accepted_by` keeps who accepted. Whether a
 * request waits is the company's setting (`ACCEPTANCE` below, task settings);
 * a `meeting` link says which meeting a task is homework of.
 *
 * Version 9 (owner decision 2026-11-02 「着手しないで完了にできる」): 完了 from any state but
 * 準備中 (the AI's turn: 「自分で進める」 first); 着手 is optional (「進めている印をつける」) and
 * no start is ever made up. `when_done` (終わったら): `notify` (知らせるだけ — empty means the
 * same, the default when asking) lets the assignee complete, the requester told and able to
 * reopen (やり直す); `check` (確かめてから) takes the assignee out of `complete`'s `who`
 * (`who_unless`) — they hand it to the checker (`reviewer`, 確かめる人) with 「終わったので
 * 見てもらう」 and the checker's OK completes it, or they complete stating the checker's OK given
 * elsewhere (version 4's `ok_from`: the one place an OK statement is still asked). Completing
 * from 引き受け待ち by the assignee also records the acceptance (`ACCEPTANCE.finishes`).
 * Tasks of earlier versions are moved to 9 at startup (`TASK_VERSION`).
 *
 * Version 11 (owner decision 2026-11-02, plan F 「AI のタスクの案」「議事録を確認する」): state
 * `proposed` (案) — `proposal_states`: nobody's turn, nobody told, out of every list — and
 * `dismissed` (要らない: final, kept, never deleted; `propose_again` brings it back). A person
 * takes a proposal up with `adopt` (足す → todo, acceptance applies as for any request) or puts it
 * away with `dismiss` (also a task the AI made at once, not started yet: 「要らない」 everywhere); never the AI. The AI's homework of a meeting starts as a proposal when the
 * company says 「案として出す」 (`PROPOSALS`, TaskSettings.meetingTasks). Field `task_kind`
 * `minutes_review` marks 「議事録を確認する」, the one task per meeting the server makes for the
 * meeting's assignee when it is read (services/minutes-review.ts).
 *
 * Version 13 (owner decision 2026-11-06 「出どころの枠」 §10, additive): a meeting's proposals belong to
 * everyone who reads the meeting — `adopt` / `dismiss` / `propose_again` add the who-entry
 * `link:meeting` (a reader of the linked meeting; never the AI). Fields `basis` (the minutes quote a
 * proposal rests on: its identity in the meeting's slot, server/src/services/source-slot-candidates.ts),
 * `similar_to` (an earlier proposal of the same meeting whose title is close: 「似ている案があります」)
 * and `apart_by` (who said 「別のもの」: action `keep_apart`, filled with the person acting, ACTOR_ARGS).
 *
 * Version 10 (owner decision 2026-11-02, つなぐ・外す): the links that say where a task came
 * from — `meeting`, `interaction`, `prepared` — are marked `origin` (出どころ) and are never
 * linked or removed by hand; the others (bundle, counterpart, related, files) are filing and
 * can be (records.md "Linking records later"). `decision` v5 marks `meeting` / `approval`,
 * `reply_request` v3 `interaction` / `prepared` the same way.
 *
 * Version 12 (owner decision 2026-11-03 「②」 返事待ちに見込みを): 「返事待ちにする」 (`wait`) also
 * says until when — its args gain `wait_until`, set in the same entry. Left out (an app released
 * before, or the AI not giving one), the engine fills it: 3 business days after the company's
 * today (`ARG_DEFAULTS`). When it passes the server clock gives the task back (`WAIT_OVER`), and
 * `waitCameBack` tells a task given back so from any other 未着手.
 *
 * We send first (owner decision 2026-11-03 「①」, outbound-mail.md "Waiting for their answer"):
 * `outbound_message` v5 adds `expects_reply` (the drafting AI's mark: pre-ticks 「返事を待つ」),
 * `reply_wait_until` (the day the member picked at 確かめて送る) and the link `task` (the やること the
 * mail was drafted for); `reply_request` v4 adds the origin link `task`, and the service writer
 * may create a 返事のお願い straight in 返事待ち (`SERVICE_TRANSITIONS`). Both additive.
 * `reply_request` v5 (owner report 2026-11-05: a request sat in 確かめ中 after the member's reply with
 * nothing to press): the assignee's 「終わりにする」 (`close`) also from 準備中 / 確かめ中 — the AI's turn —
 * so the member can always end it; the AI's later writes are refused by state and version. Additive.
 *
 * interaction (やりとり): the common receipt for what comes from outside
 * (mail, Slack, LINE…). Server only, no body — a summary and a pointer to the
 * original (0.23-2). Version 3 links `bundle` and `counterpart`. Version 4
 * implements `outside_event` (its `occurred_at` was there from the start).
 * Version 6 (owner FB #20, additive): the assignee's 「済んだ」 (`settle`, 確認待ち → handled) and
 * the field `settled_by` the engine fills with them (`ACTOR_ARGS`); the inbox clears it when the
 * thread goes on.
 * Version 7 (owner FB #19, additive): 「返事のあとを確かめる」 (`replied`) — the member's own reply was seen
 * (sent from the phone, or in Slack / Gmail itself) and tasks made from the message are still open:
 * the member's AI checks whether the reply finished them (`finish_reply_check`, `who: [ai]`; the
 * inbox's reply-check route completes them), or the assignee looks themselves (`check_myself`).
 * Version 8 (owner decision 2026-11-05, additive): 「受信トレイから外れた」 (`left_inbox`, 届いた /
 * 確認待ち → handled, `who: [system]`: only the inbox, never a member nor their AI) — the mail left the
 * member's own mailbox inbox (archived, trashed, deleted there) and nothing was made from it; the
 * assignee may undo that entry (`UNDO_BY_ASSIGNEE`). inbox.md "Mail archived in the mailbox".
 *
 * Outside time (owner decision 2026-11-01 「流れを測れる記録」): every core type
 * of a thing that happened outside implements `outside_event` — `occurred_at`
 * is when it happened there; when ACB learned of it is the `create` entry's
 * `at`. `meeting` version 2 adds `occurred_at` (= `meeting_at`, which stays for
 * compatibility; the intake writes both, older meetings are carried over at
 * startup with a ledger entry, `OUTSIDE_TIME_ACTION`). `outbound_message` is
 * not one (ACB makes it; `sent_at` stays) — the sent mail's `interaction` is.
 * `meeting` version 4 drops version 3's まとまり's part (bundle_waiting /
 * bundle_working and their five actions): a まとまり chosen after the reading is
 * only linked; meetings left there are moved back to `read` at startup
 * (`BUNDLE_PART_ENDED_ACTION`). `meeting` version 5 (owner decision 2026-11-04,
 * meetings for their attendees) adds the initial state `arrived` (議事録が届いた: nobody's
 * turn); an attendee's ［AI に読ませる］ / ［読まない］ move it (minutes service only).
 * Meetings made before stay where they are.
 *
 * Milestone 4 (after a sales meeting): `meeting` (会議 — version 1 of what was
 * the `minutes` type; the 議事録 is the meeting's content, read where it is),
 * `approval` (承認のお願い), `outbound_message` (送るもの) and `decision`
 * (決めたこと). `decision` version 6 (owner decision 2026-11-07 「決めたことを人が確かめる」,
 * additive): what the AI records is 「決めたことの案」 until a person confirms it. Fields `said_by`
 * (who said it, as the minutes name them: outside text) and `objection` (反対なし / 反対あり /
 * 分からない), sent by the AI. Who confirms (`confirm` 決めたことにする — the app's ［そうです］, `reject`
 * 違う with an optional note while unconfirmed, `retract` 取り消す of a confirmed one with a note) is the
 * 責任者 of the linked まとまり (`link:bundle.owner`: the `bundle` interface's `owner`), a department
 * manager or an admin; with no 責任者 who reads the decision, `who_fallback`: every reader of its
 * meeting (`link:meeting`), else whoever recorded it (`owner`, now 残した人: only set without a
 * meeting). The meeting's assignee has no part of it any more. `decided_by` is the confirmer
 * (`ACTOR_ARGS`), null until then.
 * Their records are made only by the server's own services
 * (`SERVICE_OWNED_TYPES`); `approval` and `outbound_message` change state only
 * through those services too (`SERVICE_STATE_TYPES`, `SERVICE_TRANSITIONS`),
 * because approving checks a content hash and runs an operation, and sending
 * reaches outside.
 *
 * project (束ねる種類, owner decision 2026-11-02): the core's ordinary `bundle` — what a
 * department with no business plugin's bundle kind makes (records.md "Bundle kinds"). Its name on
 * screen is the company's (`TaskSettings.bundleName`, default 「プロジェクト」); its `label` is
 * only the fallback. Anyone may create one (no service owns it).
 *
 * **The core never names a business plugin's type** (owner decision
 * 2026-11-01 night): what work belongs to links to the `bundle` interface
 * (まとまり: a 案件, a 企画, a 取り組み), whom it is with to the `counterpart`
 * interface (相手: a 顧客, a guest, an applicant). A link target that is a type
 * is always a core type (`server/tests/unit/core-types-interfaces.test.ts`).
 */
import { addBusinessDays } from './business-days'
import { parseTypeFile, type TypeDefinition } from './record-types'

export const CORE_TYPE_FILES: Record<string, string> = {
  task: `---
label: タスク
version: 13
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
  reviewer:     { label: 確かめる人, kind: person, source: server }
  ok_by:        { label: OKした人, kind: person, source: server }
  ok_note:      { label: OKのいきさつ, kind: text, source: server }
  tags:         { label: タグ, kind: tags, source: server }
  wait_until:   { label: 返事・届く見込み, kind: date, source: server }
  prep_summary: { label: AIが用意したこと, kind: long_text, source: server }
  accepted_by:  { label: 引き受けた人, kind: person, source: server }
  when_done:    { label: 終わったら, kind: choice, options: [notify, check], option_labels: { notify: 知らせるだけ, check: 確かめてから }, source: server }
  task_kind:    { label: 種類, kind: choice, options: [minutes_review], option_labels: { minutes_review: 議事録を確認する }, source: server }
  basis:        { label: 根拠（議事録の引用）, kind: long_text, source: server }
  similar_to:   { label: 似ている案, kind: record, target: task, source: server }
  apart_by:     { label: 別のものとした人, kind: person, source: server }
links:
  files:        { label: 関係するファイル, target: file, cardinality: many }
  related:      { label: 関係するタスク, target: task, cardinality: many }
  bundle:       { label: まとまり, interface: bundle, cardinality: one, inverse: tasks }
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: tasks }
  prepared:     { label: AIが用意したもの, interface: prepared, cardinality: many, inverse: tasks, origin: true }
  meeting:      { label: もとの会議, target: meeting, cardinality: one, inverse: tasks, origin: true }
  interaction:  { label: もとの連絡, target: interaction, cardinality: one, inverse: tasks, origin: true }
states: [todo, in_progress, review, waiting, done, cancelled, preparing, declined, awaiting_acceptance, proposed, dismissed]
initial: todo
create_states: [preparing, proposed]
proposal_states: [proposed]
final: [done, cancelled, dismissed]
actions:
  start:          { label: 進めている印をつける, from: [todo, waiting], to: in_progress, who: [assignee, ai], hand_to: assignee }
  request_review: { label: 終わったので見てもらう, from: [todo, in_progress, waiting, awaiting_acceptance], to: review, who: [assignee, ai], args: { reviewer: person }, notify: reviewer, attach: [files], note: optional, hand_to: reviewer }
  send_back:      { label: 差し戻す, from: [review], to: in_progress, who: [reviewer], notify: assignee, note: required, decision: true, hand_to: assignee }
  assign:         { label: 担当を替える, from: [todo, in_progress, review, waiting, declined, awaiting_acceptance], who: [assignee, requested_by, dept_manager, admin, ai], args: { assignee: person }, notify: assignee, note: required, approval: undoable, decision: true, hand_to: assignee }
  wait:           { label: 返事待ちにする, from: [todo, in_progress], to: waiting, who: [assignee, ai], args: { waiting_on: text, wait_until: date }, note: optional }
  set_due:        { label: 期限を変える, who: [requested_by, assignee, ai], args: { due: date }, notify: requested_by, note: optional, approval: undoable }
  complete:       { label: 完了にする, from: [todo, in_progress, review, waiting, awaiting_acceptance, declined], to: done, who: [assignee, requested_by, reviewer], who_unless: { assignee: { when_done: check } }, ok_from: [assignee], notify: [requested_by, reviewer, ok_by], attach: [files], note: optional, decision: true }
  cancel:         { label: 中止する, from: [todo, in_progress, review, waiting, preparing, declined, awaiting_acceptance], to: cancelled, who: [requested_by, admin], notify: assignee, note: required, decision: true }
  reopen:         { label: やり直す, from: [done, cancelled, declined], to: in_progress, who: [requested_by, reviewer, ok_by, admin], notify: assignee, note: optional, hand_to: assignee }
  finish_prep:    { label: 用意ができた, from: [preparing], to: todo, who: [ai], args: { prep_summary: long_text }, links: [prepared], notify: assignee, hand_to: assignee }
  hand_over:      { label: 先に渡す, from: [preparing], to: todo, who: [ai], links: [prepared], notify: assignee, note: required, hand_to: assignee }
  take_over:      { label: 自分で進める, from: [preparing], to: todo, who: [assignee, requested_by], notify: assignee, note: optional, hand_to: assignee }
  accept:         { label: 引き受ける, from: [awaiting_acceptance], to: todo, who: [assignee], notify: requested_by, note: optional, hand_to: assignee }
  decline:        { label: 受けられない, from: [todo, in_progress, waiting, awaiting_acceptance], to: declined, who: [assignee], notify: requested_by, note: required, hand_to: requested_by }
  set_tags:       { label: タグを付ける, who: [requested_by, assignee, ai], args: { tags: tags } }
  set_wait_until: { label: 見込みの日時を決める, who: [requested_by, assignee, ai], args: { wait_until: date }, note: optional }
  set_bundle:     { label: まとまりに入れる, who: [requested_by, assignee, ai], links: [bundle], note: optional }
  set_when_done:  { label: 終わったらを決める, from: [todo, in_progress, waiting, preparing, declined, awaiting_acceptance], who: [requested_by, admin], args: { when_done: choice }, notify: assignee, note: optional }
  set_reviewer:   { label: 確かめる人を決める, from: [todo, in_progress, waiting, preparing, declined, awaiting_acceptance], who: [requested_by, admin], args: { reviewer: person }, notify: reviewer, note: optional }
  adopt:          { label: 足す, from: [proposed], to: todo, who: [requested_by, dept_manager, admin, link:meeting], notify: assignee, note: optional, hand_to: assignee }
  dismiss:        { label: 要らない, from: [proposed, todo, awaiting_acceptance], to: dismissed, who: [requested_by, dept_manager, admin, link:meeting], note: optional }
  propose_again:  { label: 案に戻す, from: [dismissed], to: proposed, who: [requested_by, dept_manager, admin, link:meeting], note: optional }
  keep_apart:     { label: 別のもの, from: [proposed], who: [requested_by, dept_manager, admin, link:meeting], args: { apart_by: person }, note: optional }
---
# タスク

ACB に最初からある「依頼」の形。記録はサーバーだけが持ちます（ファイルにはしません）。見積や計画などの中身はふつうのファイルに書き、「関係するファイル」でつなぎます。
「準備中」は AI の番です。AI が下ごしらえ（確かめたこと・下書き）を済ませて「用意ができた」で担当に渡します。期限が近い・うまくいかなかった・情報が足りないときは、AI が理由を添えて「先に渡す」で早めに渡します。担当と頼んだ人は「自分で進める」でいつでも引き取れます。担当は「受けられない」で頼んだ人に返せます（ひとことの理由つき）。
お客さまなどの相手は「まとまり」（案件など）からたどります。まとまりに入らないタスクだけ、「相手」を直接つなぎます。
ほかの部署の人に頼んだタスクは「引き受け待ち」になり、担当が「引き受ける」と担当の番になります（どんなときに自動で引き受けたことになるかは会社の設定で決めます）。
完了はどの状態からでもできます（準備中だけは先に「自分で進める」）。「終わったら」が「知らせるだけ」（初めはこれ）なら担当が完了にし、頼んだ人に知らせます（頼んだ人は「やり直す」で戻せます）。「確かめてから」なら担当は「終わったので見てもらう」で確かめる人に渡し、確かめる人の OK で完了します（確かめる人が ACB の外で OK したときは、担当がそのいきさつを書いて完了にできます）。
「返事待ち」にするときは、いつごろ来そうか（返事の見込み）も決めます。決めなければ 3 営業日後です。見込みを過ぎても返事待ちのままなら、担当の番に戻ります（自動で進めるなら、AI が催促の下書きを用意します）。
会議から AI が作る宿題は、会社の設定が「案として出す」（初めはこれ）なら「案」になります。案はだれの番でもなく、一覧にも出ません。「議事録を確認する」やることの中で、人が「足す」とふつうのやることに、「要らない」でしまいます（消しません。「案に戻す」で戻せます）。
会議の案は、その会議を読める人ならだれでも「足す」「要らない」「案に戻す」ができます。AI は案ごとに根拠になった議事録の文を添え、同じ根拠の案は1つにまとまります。件名が似ている案は「似ている案があります」と並び、人が「同じ」（新しいほうを要らないに）か「別のもの」を選びます。
`,
  interaction: `---
label: やりとり
version: 8
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
  left_inbox:   { label: 受信トレイから外れた（自動）, from: [received, unsure], to: handled, who: [system], note: optional }
---
# やりとり

外から来たもの（メール・Slack など）の受付票。本文は持たず、要約と元への目印だけを持ちます。
来た連絡（メール・チャット）は、宛先（To）の人の「持ち主だけ」の記録になります（CC の人には出しません）。「届いた」は AI の番で、AI が返事が要るかを判断して「返事のお願い」を作るか、「やることにしない」にします。決めきれないものは「確認待ち」で担当の人の番、共有の受付アドレスに来たものは「部署の番」で、誰かが引き受けます。
確認待ちの連絡は、話がもう決着していれば担当が「済んだ」で終わりにでき（今日終わったことに出て、すぐなら取り消せます）、取り込まないなら「やることにしない（自分で決める）」でやることにしなかった一覧に移します。
担当がスマホや Slack・Gmail で自分で返事をしたとき、この連絡から作ったタスクが残っていれば「返事のあとを確かめる」（AI の番）になります。AI が返事でタスクが済んだかを見て、済んでいれば完了にして知らせ（取り消せます）、まだなら「返事は済み」と書き残します。
`,
  meeting: `---
label: 会議
version: 5
implements: [outside_event]
storage: server
fields:
  meeting_at:     { label: 会議の日時, kind: datetime, source: server }
  occurred_at:    { label: 外で起きた日時, kind: datetime, source: server }
  assignee:       { label: 担当, kind: person, source: server }
  attendees:      { label: 出席したメンバー, kind: text, source: server }
  external_count: { label: 社外の参加者の数, kind: number, source: server }
  source_ref:     { label: 議事録への目印, kind: text, source: server }
  doc_version:    { label: 議事録の版, kind: text, source: server }
  summary_text:   { label: 要約, kind: long_text, source: server }
links:
  bundle:         { label: まとまり, interface: bundle, cardinality: one, inverse: meetings }
  counterpart:    { label: 相手, interface: counterpart, cardinality: one, inverse: meetings }
states: [arrived, received, reading, read, skipped, failed]
initial: arrived
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
会議の記録を見られるのは、その会議に出たメンバーだけです（会社の持ち主・管理者も、出ていなければ見えません）。カレンダーで非公開にした予定は記録しません。
「議事録が届いた」は誰の番でもありません。出た人が［AI に読ませる］を押すと、その人の AI の番（「届いた」）になり、AI が議事録を読んで、やることや決めたことにします。［読まない］を押すと、もう誰にも聞きません。
まとまり（案件など）が決まらないまま読んだ会議は、あとで人がまとまりを選ぶと、そのまとまりにつながります（会議は「読んだ」のまま）。まとまりへの反映は、そのまとまりの業務の手順が受け持ちます。
`,
  approval: `---
label: 承認のお願い
version: 5
implements: [request, prepared]
storage: server
fields:
  requested_by:        { label: 頼んだ人, kind: person, source: server }
  assignee:            { label: 承認する人, kind: person, source: server }
  next_actor:          { label: 次に動く人, kind: person, source: server }
  waiting_on:          { label: 待っているもの, kind: text, source: server }
  due:                 { label: 期限, kind: date, source: server }
  approver_rule:       { label: 承認する人の決まり, kind: choice, options: [self, dept_manager, admin, role], source: server }
  approver_role:       { label: 承認する役割, kind: text, source: server }
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
version: 5
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
  slack_thread:        { label: Slack のスレッド, kind: text, source: server }
  expects_reply:       { label: 返事が来るはず, kind: boolean, source: server }
  reply_wait_until:    { label: 返事を待つ日, kind: date, source: server }
links:
  bundle:              { label: まとまり, interface: bundle, cardinality: one, inverse: messages }
  meeting:             { label: 会議, target: meeting, cardinality: one, inverse: messages }
  interaction:         { label: 返事をする連絡, target: interaction, cardinality: one, inverse: replies }
  task:                { label: もとのタスク, target: task, cardinality: one, inverse: messages }
states: [draft, sent, unknown, discarded]
initial: draft
final: [sent, discarded]
---
# 送るもの

社外に送るもの（メール、Slack の返事）の下書き。送るのは作った人本人だけで、送る画面から行います（AI は送れません）。
来た連絡への返事は「返事をする連絡」につながり、同じスレッドに返します（メールは同じスレッドへの返信、Slack はスレッドへの返事）。
`,
  decision: `---
label: 決めたこと
version: 6
storage: server
fields:
  title:       { label: 件名, kind: text, source: file }
  why:         { label: なぜ, kind: long_text, source: server }
  source:      { label: 元, kind: text, source: server }
  recorded_by: { label: 記録したもの, kind: choice, options: [ai, human], source: server }
  important:   { label: 大事, kind: boolean, source: server }
  exception:   { label: 例外（この件だけ）, kind: boolean, source: server }
  decided_by:  { label: 決めた人, kind: person, source: server }
  owner:       { label: 残した人, kind: person, source: server }
  source_key:  { label: 元の項目の目印, kind: text, source: server }
  said_by:     { label: 言った人（議事録から）, kind: text, source: server }
  objection:   { label: 反対, kind: choice, options: [none, raised, unknown], option_labels: { none: 反対なし, raised: 反対あり, unknown: 分からない }, source: server }
links:
  bundle:      { label: まとまり, interface: bundle, cardinality: one, inverse: decisions }
  meeting:     { label: 会議, target: meeting, cardinality: one, inverse: decisions, origin: true }
  approval:    { label: 承認のお願い, target: approval, cardinality: one, inverse: decisions, origin: true }
states: [unconfirmed, confirmed, retracted]
initial: unconfirmed
final: [confirmed, retracted]
actions:
  confirm: { label: 決めたことにする, from: [unconfirmed], to: confirmed, who: [link:bundle.owner, dept_manager, admin], who_fallback: [link:meeting, owner], args: { decided_by: person }, note: optional, decision: true }
  reject:  { label: 違う, from: [unconfirmed], to: retracted, who: [link:bundle.owner, dept_manager, admin], who_fallback: [link:meeting, owner], note: optional, decision: true }
  retract: { label: 取り消す, from: [confirmed], to: retracted, who: [link:bundle.owner, dept_manager, admin], who_fallback: [link:meeting, owner], note: required, decision: true }
  set_exception: { label: 例外（この件だけ）を切り替える, from: [unconfirmed, confirmed], who: [link:bundle.owner, dept_manager, admin], who_fallback: [link:meeting, owner], args: { exception: boolean }, note: optional }
---
# 決めたこと

会議などで決まったことの記録。サーバーだけが持ち（ファイルにはしません）、置いた部署のフォルダを読める人だけが見られます（出席者だけの会議からのものは、その会議の人だけ）。
AI が残したものは「決めたことの案」です。決める立場の人が「そうです」と確かめるまでは決めたことではなく、前例にもしません。
確かめるのは、つながっているまとまり（案件・プロジェクト）の責任者・部署の管理役・管理者です。まとまりがない・責任者がいない・責任者がこの記録を見られないときは、その会議を読める人（会議がなければ残した人）が確かめます。
「例外（この件だけ）」の決めたことは、つながった件だけの判断です（例「今回の見積は特別に20%値引きしてよい」）。ほかの件の前例にはしません。
`,
  reply_request: `---
label: 返事のお願い
version: 5
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
  interaction:   { label: もとの連絡, target: interaction, cardinality: one, inverse: reply_requests, origin: true }
  bundle:        { label: まとまり, interface: bundle, cardinality: one, inverse: reply_requests }
  counterpart:   { label: 相手, interface: counterpart, cardinality: one, inverse: reply_requests }
  prepared:      { label: AIが用意したもの, interface: prepared, cardinality: many, inverse: reply_requests, origin: true }
  task:          { label: もとのタスク, target: task, cardinality: one, inverse: reply_requests, origin: true }
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
  close:         { label: 終わりにする, from: [preparing, open, waiting_reply, checking], to: closed, who: [assignee], note: optional }
  drop:          { label: 返事をしない, from: [preparing, open, waiting_reply, checking], to: dropped, who: [assignee], note: required }
  reopen:        { label: やり直す, from: [closed, dropped], to: open, who: [assignee], note: optional, hand_to: assignee }
  replied_elsewhere: { label: もう返した, from: [preparing, open, waiting_reply, checking], to: closed, who: [assignee], note: optional }
  set_end_condition: { label: 終わりの条件を決める, who: [assignee, ai], args: { end_condition: long_text }, note: optional }
  set_due:       { label: 期限を変える, who: [assignee, ai], args: { due: date }, note: optional }
  set_wait_until: { label: 返事の見込みを決める, who: [assignee, ai], args: { wait_until: date }, note: optional }
---
# 返事のお願い

来た連絡から生まれる「返事をする」仕事。ふつうのやることとは別の型で、終わりの条件を持ちます（返事が来れば・日程が決まれば など。AI が作るときに入れ、人が直せます）。
「準備中」と「確かめ中」は AI の番です。AI が返事の下書きを用意して担当に渡し、返事が来たとき・こちらが返信したときは、終わりの条件と照らして終わりにするか（「AI が判断して終わりにする」）、相手の返事待ちにするか、担当の番に戻すかを決めます。この型の中でだけ、AI が終わりにできます（やり直せます）。
電話や別の経路で返したときなど、ACB から見えない返事は、担当が「もう返した」で終わりにします。
担当は「終わりにする」で、AI が用意している間や確かめている間でも、いつでも終わりにできます。
期限は、連絡に締切が書いてあればそれ、なければ会社の「返事の目安」です。目安で入れた期限は「目安」と分かるように出します。
`,
  project: `---
label: プロジェクト
version: 1
implements: [bundle]
storage: server
fields:
  owner:        { label: 責任者, kind: person, source: server }
  purpose:      { label: なんのため, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
links:
  counterpart:  { label: 相手, interface: counterpart, cardinality: one, inverse: projects }
  files:        { label: 関係するファイル, target: file, cardinality: many }
states: [active, done, cancelled]
initial: active
final: [done, cancelled]
actions:
  finish:       { label: 終える, from: [active], to: done, who: [owner, admin, dept_manager], note: optional }
  cancel:       { label: やめる, from: [active], to: cancelled, who: [owner, admin, dept_manager], note: optional }
  reopen:       { label: もう一度始める, from: [done, cancelled], to: active, who: [owner, admin, dept_manager], note: optional }
  set_owner:    { label: 責任者を替える, from: [active], who: [owner, admin, dept_manager], args: { owner: person }, note: optional }
  set_purpose:  { label: なんのためを書く, from: [active], who: [owner, admin, dept_manager], args: { purpose: text }, note: optional }
  set_due:      { label: 期限を変える, from: [active], who: [owner, admin, dept_manager], args: { due: date }, note: optional }
---
# プロジェクト

本体のふつうの「束ねるもの」。業務プラグインの種類（案件・番組など）がない部署で、やること・会議の記録・決めたことなどを束ねます。
画面での名前は会社の設定で決めます（初めは「プロジェクト」）。
`,
}

/**
 * Core types whose records only the server's own services create (meeting
 * intake, approvals, outbound mail, decisions): the generic create
 * (`POST /records/item`, the AI's `records_create`) refuses them with
 * `TYPE_CREATED_BY_SERVICE`.
 */
export const SERVICE_OWNED_TYPES: readonly string[] = ['meeting', 'approval', 'outbound_message', 'decision', 'reply_request']

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
 * Core types a server service makes for a person besides those (minutes.md "The review task":
 * 「議事録を確認する」 for the meeting's assignee). Only the services composition.ts hands the
 * writer reach this; they stay creatable by the generic routes too.
 */
export const SERVICE_MADE_TYPES: readonly string[] = ['task']

/**
 * The state changes the service writer (server/src/services/record-engine.ts
 * `createServiceRecordWriter`) may make, per type: from one of `from` to `to`.
 * A change of fields that keeps the state is always allowed.
 */
export const SERVICE_TRANSITIONS: Readonly<Record<string, ReadonlyArray<{ from: readonly string[]; to: string }>>> = {
  meeting: [
    // Meetings for their attendees (minutes.md): ［AI に読ませる］ (also again after 読まない or a failed
    // reading, by another attendee) and ［読まない］ — the minutes service with the attendee's session.
    { from: ['arrived', 'skipped'], to: 'received' },
    { from: ['arrived'], to: 'skipped' },
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
  // The inbox (inbox.md): judging (the AI's judgement route), intake states (a create may start in
  // one of these: the service writer's `state`), a department's mail claimed, a thread continued.
  interaction: [
    { from: ['received'], to: 'handled' },
    { from: ['received'], to: 'excluded' },
    { from: ['received'], to: 'unsure' },
    { from: ['received'], to: 'unclaimed' },
    { from: ['unclaimed'], to: 'received' },
    { from: ['handled'], to: 'received' },
    // The member replied in the thread before it was judged (B4): nothing is left to do.
    { from: ['unsure'], to: 'handled' },
    // The member's own reply was seen and tasks made from the message are open (owner FB #19):
    // their AI checks them (the reply-check route), then it is handled again.
    { from: ['handled'], to: 'replied' },
    { from: ['replied'], to: 'handled' },
  ],
  reply_request: [
    // Their reply came (not an automatic one): the AI checks it against the end condition.
    { from: ['waiting_reply'], to: 'checking' },
    // Someone of the company replied in the thread: the AI checks the reply, or (company setting) it is over.
    { from: ['preparing', 'open'], to: 'checking' },
    { from: ['preparing', 'open', 'waiting_reply'], to: 'closed' },
    // The server clock's 「見込みの日時が過ぎた」 (WAIT_OVER, B5): the AI's nudge draft, or the assignee.
    { from: ['waiting_reply'], to: 'preparing' },
    { from: ['waiting_reply'], to: 'open' },
    // We sent first and wait for their answer (outbound-mail.md "Waiting for their answer"): the inbox
    // creates the 返事のお願い straight in 返事待ち (a create's `state`; no service moves one there).
    { from: ['preparing'], to: 'waiting_reply' },
  ],
  // Not service-owned: only the server clock's 「見込みの日時が過ぎた」 (WAIT_OVER below), a state
  // change only — the writer refuses a field-only change of a type that is not service-owned.
  task: [
    { from: ['waiting'], to: 'preparing' },
    { from: ['waiting'], to: 'todo' },
    // The member's reply finished a task made from that message (owner FB #19, inbox.md "Tasks made
    // from that message"): their AI's check through the inbox, which allows only the member's own
    // task from that message, never one waiting for a check (確かめてから) or another's turn.
    { from: ['todo', 'in_progress', 'waiting'], to: 'done' },
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
  // 追いかけ (B5): their reply did not come by 返事の見込み — the AI drafts the nudge (準備中), never before.
  reply_request: { field: 'wait_until', from: 'waiting_reply', aiTurn: 'preparing', personTurn: 'open' },
}

/**
 * Acceptance (引き受け, records.md "Acceptance"; owner decision 2026-11-01):
 * a request someone else is asked to do reaches the assignee in `state`
 * (引き受け待ち) until they accept — unless the company's setting says it is
 * accepted by itself (server/src/services/task-acceptance.ts). The engine
 * applies it to records of the type from `since` on:
 *
 * - whenever a create or an action would leave the record in one of `working`
 *   (or in `state` itself) with an `assignee` other than `acceptedBy`: a
 *   person acting as the assignee (themselves, or their delegate during an
 *   absence) accepts by doing so; else the company's setting decides
 *   (accepted → `acceptedBy` = the assignee, and `state` becomes `into`;
 *   not → `state`, the assignee's turn). The asker is the actor when the
 *   action changed the assignee, else `requester`.
 * - leaving `state` straight into one of `finishes` (完了 from 引き受け待ち, task version 9) by a
 *   person acting as the assignee records the acceptance in the same entry (`acceptedBy` = the
 *   assignee): 「引き受けた」 is in the history with the 完了; anyone else finishing it does not.
 * - entering one of `releases` (受けられない) forgets the acceptance; an
 *   assignee changed there is asked like a new request (`into`).
 * - `origin` / `attendees`: the meeting a task is homework of, and its field
 *   listing who attended (JSON array of member ids).
 * - owner-only records never wait (only their owner is ever in them).
 */
export const ACCEPTANCE: Readonly<Record<string, {
  since: number; state: string; into: string; working: readonly string[]; releases: readonly string[]; finishes: readonly string[]
  assignee: string; acceptedBy: string; requester: string; origin: string; attendees: string
}>> = {
  task: {
    since: 7, state: 'awaiting_acceptance', into: 'todo', working: ['todo', 'in_progress', 'review', 'waiting'], releases: ['declined'], finishes: ['done'],
    assignee: 'assignee', acceptedBy: 'accepted_by', requester: 'requested_by', origin: 'meeting', attendees: 'attendees',
  },
}

/**
 * The task version every task is moved to at startup (the core task version; records.md "Task version 9"; adapters/sqlite/records.ts
 * `migrateCompanyTaskVersion`): the core definition of that version is stored first, then each task's
 * index row says it (no value changes, so no ledger entry).
 */
export const TASK_VERSION = 13

/**
 * The decision version every decision is moved to at startup (decision version 6, the
 * `TASK_VERSION` mechanism: adapters/sqlite/records.ts `migrateCompanyCoreTypeVersion`). Additive.
 */
export const DECISION_VERSION = 6

/**
 * Proposals (案, task version 11): a record of `type` that the member's **AI** creates with its
 * `origin` link set (the meeting it is homework of) starts in `state` when the company proposes
 * (TaskSettings.meetingTasks `propose`, the default), else as before (`create`). A person's
 * create never does; nothing else changes it. Made once per meeting and item as every output
 * (minutes.md "Outputs made once": a dismissed proposal stays the answer, it is not proposed
 * again).
 */
export const PROPOSALS: Readonly<Record<string, { state: string; origin: string }>> = {
  task: { state: 'proposed', origin: 'meeting' },
}

/**
 * The slot fields of a type's candidates (task version 13, owner decision 2026-11-06 「出どころの枠」):
 * `basis` — the source quote the AI gave (written by the create from its `quote`); `similarTo` — an
 * earlier candidate whose title is close (the server's, never a body's); `apartBy` — who said
 * 「別のもの」 (its action's ACTOR_ARGS). A type without these fields simply has none of them.
 */
export const SLOT_FIELDS = { basis: 'basis', similarTo: 'similar_to', apartBy: 'apart_by' } as const

/** The proposal rule of a type, or undefined. */
export function proposalOf(type: string) {
  return Object.prototype.hasOwnProperty.call(PROPOSALS, type) ? PROPOSALS[type] : undefined
}

/** `task_kind` of 「議事録を確認する」 (minutes.md "The review task"). */
export const MINUTES_REVIEW_KIND = 'minutes_review'

/** The item key of a meeting's review task (its id is derived from it, `meetingOutputId`: one per meeting). */
export const MINUTES_REVIEW_KEY = 'minutes-review'

/** The minutes intake as a ledger actor (kind `external`, an `acb:` id → cause `system`). */
export const MINUTES_ACTOR = Object.freeze({ id: 'acb:minutes', kind: 'external' as const, source: 'ACB の議事録の受付' })

/** The acceptance rule of a type, or undefined. */
export function acceptanceOf(type: string) {
  return Object.prototype.hasOwnProperty.call(ACCEPTANCE, type) ? ACCEPTANCE[type] : undefined
}

/**
 * The inbox's own ledger actions (no action of the types: nobody else can run
 * them; `services/inbox.ts`, inbox.md). `reply_arrived` and an interaction
 * entering `unsure` are the notices `reply_arrived` / `intake_unsure`.
 */
const INBOX_ACTIONS_LEFT = 'left_inbox'
const INBOX_ACTIONS_ARCHIVED = 'archived_there'

export const INBOX_ACTIONS = Object.freeze({
  /** A reply_request: their reply came (waiting_reply → checking). */
  replyArrived: 'reply_arrived',
  /** A reply_request: someone of the company replied in the thread. */
  memberReplied: 'member_replied',
  /** An interaction: the AI's judgement (route records-ai-inbox). */
  judged: 'judge',
  /** An interaction: a department's mail taken by a member (引き受ける). */
  claimed: 'claim',
  /** An interaction: the thread went on after it was handled. */
  continued: 'continued',
  /** An interaction: the member's own reply was seen and tasks made from it are open (handled → replied). */
  replySeen: 'reply_seen',
  /** An interaction: the member's AI checked those tasks (replied → handled). */
  replyChecked: 'reply_checked',
  /** A task: the member's reply finished it (the notice `replied_done`, undone like any entry). */
  repliedDone: 'replied_done',
  /** A task: the member replied, but work remains (a note only: 「返事は済み」). */
  replyNoted: 'reply_noted',
  /**
   * An interaction: the mail left the owner's mailbox inbox and nothing was made from it — closed
   * (届いた / 確認待ち → handled; the type's `left_inbox`, `who: [system]`). Its assignee may undo it.
   */
  leftInbox: INBOX_ACTIONS_LEFT,
  /** An interaction: the mail left the inbox but a task or 返事のお願い is open (a note only: 「Gmail ではアーカイブ済み」). */
  leftInboxNoted: 'left_inbox_noted',
  /** An interaction: ACB took the mail out of the owner's mailbox inbox after they closed it (a note; undo = put back). */
  archivedThere: INBOX_ACTIONS_ARCHIVED,
  /** An interaction: putting it back did not work (a note only). */
  unarchiveFailed: 'unarchive_failed',
})

/**
 * The system's entries a record's assignee may undo although they are not its actor (the engine's
 * undo, records.md "The state engine"): the inbox closing a message because it left the mailbox
 * inbox, and taking it out of the mailbox inbox — each with a notice and ［元に戻す］ (owner decision
 * 2026-11-05: actions on things run automatically, with a notice and an undo). Only an entry whose
 * actor is a server service (an `acb:` id, kind `external`). Core rules only.
 */
export const UNDO_BY_ASSIGNEE: Readonly<Record<string, readonly string[]>> = {
  interaction: [INBOX_ACTIONS_LEFT, INBOX_ACTIONS_ARCHIVED],
}

/** The inbox as a ledger actor (kind `external`, an `acb:` id → cause `system`). */
export const INBOX_ACTOR = Object.freeze({ id: 'acb:inbox', kind: 'external' as const, source: 'ACB の受付' })

/** The type a message is recorded as (来た連絡, inbox.md). */
export const MESSAGE_TYPE = 'interaction'

/**
 * The origin links of a type that point at a message (`origin: true`, target `interaction`: a
 * task's もとの連絡): a record made with one was made from that message (inbox.md "A task from a
 * message": its due is never empty, and the member's own AI making it tells them).
 */
export function messageOriginLinks(def: { links: Record<string, { target: string; origin?: true; targetIsInterface?: true }> }): string[] {
  return Object.entries(def.links).filter(([, l]) => l.origin === true && !l.targetIsInterface && l.target === MESSAGE_TYPE).map(([name]) => name)
}

/** The interaction state that asks its assignee to decide (確認待ち): the `intake_unsure` notice. */
export const INTAKE_UNSURE_STATE = 'unsure'

/** The ledger action of the clock's move (no action of the type: nobody else can run it). */
export const WAIT_OVER_ACTION = 'wait_over'

/**
 * The server clock as a ledger actor: kind `external` (server-side, never a
 * member, never the AI), this id, and a source the history shows as is.
 */
export const CLOCK_ACTOR = Object.freeze({ id: 'acb:clock', kind: 'external' as const, source: 'ACB の時計' })

/**
 * Whether a record is in its current state because the clock's 「見込みの日時が過ぎた」 put it
 * there: its newest state change (oldest → newest ledger) is the clock's `wait_over`. A later
 * field-only entry (tags, a new 見込み) keeps it; any later move ends it. The PC's step for a
 * task's wait that is over (`TASK_WAIT_OVER_STEP`) runs only such a task — a task a consultation
 * created in 準備中 is that consultation's to prepare, never this step's.
 */
export function enteredByWaitOver(ledger: ReadonlyArray<{ action: string; actorId: string; fromState: string | null; toState: string | null }>): boolean {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i]
    if (e.toState === null || e.toState === e.fromState) continue
    return e.action === WAIT_OVER_ACTION && e.actorId === CLOCK_ACTOR.id
  }
  return false
}

/**
 * The PC's AI-turn step for a task whose wait is over (`client/shared/ai-turn-steps/task-wait-over.ts`):
 * the server lets it be claimed only for a task `enteredByWaitOver` (services/records.ts `aiTurnOf`).
 */
export const TASK_WAIT_OVER_STEP = 'task-wait-over'

/**
 * Defaults for an action argument left out (task version 12, owner decision 2026-11-03 「②」):
 * type → action → argument → the rule. `businessDays`: that many business days after the
 * company's today (weekends, Japanese public holidays and the company's own holidays skipped:
 * business-days.ts `addBusinessDays`). The engine applies it when the argument is absent or null
 * (an app released before version 12 sends none), so a 返事待ち always has a 見込み the clock
 * follows. A company's own type file cannot say this: only the core's rules.
 */
export const ARG_DEFAULTS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { businessDays: number }>>>>>> = {
  task: { wait: { wait_until: { businessDays: 3 } } },
}

/**
 * The value an argument left out gets (`ARG_DEFAULTS`): a 見込み still ahead of `now` stays (an app
 * that set it first with `set_wait_until`, then `wait`), anything else — none, or one that already
 * passed (「もう少し待つ」 after the clock gave it back) — becomes `businessDays` after today.
 * `now`: the company's `YYYY-MM-DDTHH:MM`.
 */
export function argDefaultValue(rule: { businessDays: number }, current: unknown, now: string, companyHolidays: Iterable<string> = []): string {
  const today = now.slice(0, 10)
  if (typeof current === 'string' && /^\d{4}-\d{2}-\d{2}/.test(current)) {
    const day = current.slice(0, 10)
    if (day > today || (day === today && (current.length === 10 || current.slice(0, 16) > now.slice(0, 16)))) return current
  }
  return addBusinessDays(today, rule.businessDays, companyHolidays)
}

/**
 * Arguments the engine fills with the person acting (interaction version 6: `settle`'s `settled_by`,
 * 「済んだ」, so 今日終わったこと lists what the member closed, never what the AI judged): type →
 * action → argument names. The app may leave it out; a value naming anyone else is refused. Only the
 * core's rules (a company's own type file cannot say this).
 */
export const ACTOR_ARGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  interaction: { settle: ['settled_by'] },
  // Task version 13: 「別のもの」 on a proposal marked similar records who said so.
  task: { keep_apart: ['apart_by'] },
  // Decision version 6: 「決めた人」 is the person who confirmed it (owner decision 2026-11-07).
  decision: { confirm: ['decided_by'] },
}

/** Whether the engine fills this argument with the person acting (`ACTOR_ARGS`). */
export function isActorArg(type: string, action: string, arg: string): boolean {
  const byType = Object.prototype.hasOwnProperty.call(ACTOR_ARGS, type) ? ACTOR_ARGS[type] : undefined
  const names = byType && Object.prototype.hasOwnProperty.call(byType, action) ? byType[action] : undefined
  return names?.includes(arg) ?? false
}

/** The default rule of one argument, or undefined. */
export function argDefaultOf(type: string, action: string, arg: string): { businessDays: number } | undefined {
  const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
  return own(own(own(ARG_DEFAULTS, type), action), arg)
}

/**
 * A record the server clock gave back to its person because its wait was over (task version 12,
 * 「先方からの返事が来ていません」): the clock's `wait_over` is its newest state change, or the only
 * later ones went through the AI's turn back to the person (`WAIT_OVER[type].aiTurn` →
 * `personTurn`: the AI drafted the nudge). `waitedSince`: when it began to wait (the `at` of the
 * newest entry into `from` before that), null when the ledger does not say. Null for anything
 * else — a wait ended by a person, a record of a type with no clock. The caller checks that the
 * record is still in `personTurn`.
 */
export function waitCameBack(type: string, ledger: ReadonlyArray<{ action: string; actorId: string; at: string; fromState: string | null; toState: string | null }>): { waitedSince: string | null; overAt: string } | null {
  const rule = Object.prototype.hasOwnProperty.call(WAIT_OVER, type) ? WAIT_OVER[type] : undefined
  if (!rule) return null
  let i = ledger.length - 1
  for (; i >= 0; i--) {
    const e = ledger[i]
    if (e.toState === null || e.toState === e.fromState) continue
    if (e.action === WAIT_OVER_ACTION && e.actorId === CLOCK_ACTOR.id) break
    if (e.fromState === rule.aiTurn && e.toState === rule.personTurn) continue
    return null
  }
  if (i < 0) return null
  const overAt = ledger[i].at
  for (let j = i - 1; j >= 0; j--) {
    const e = ledger[j]
    if (e.toState === rule.from && e.fromState !== rule.from) return { waitedSince: e.at, overAt }
  }
  return { waitedSince: null, overAt }
}

/**
 * The ledger action of the startup carry-over of a meeting's outside time
 * (`meeting_at` → `occurred_at`, meeting version 2): no action of the type.
 */
export const OUTSIDE_TIME_ACTION = 'carry_outside_time'

/**
 * The ledger action of the startup move of a meeting left in `bundle_waiting` / `bundle_working`
 * (meeting version 3's まとまり's part, gone in version 4: choosing a まとまり later only links it,
 * minutes.md "A まとまり chosen later") back to `read`: no action of the type.
 */
export const BUNDLE_PART_ENDED_ACTION = 'end_bundle_part'

/** The server's own migration as a ledger actor (kind `external`, an `acb:` id → cause `system`). */
export const MIGRATION_ACTOR = Object.freeze({ id: 'acb:migration', kind: 'external' as const, source: 'ACB' })

/** May the service writer move a record of `type` from `from` to `to`? */
export function serviceTransitionAllowed(type: string, from: string | null, to: string): boolean {
  const table = Object.prototype.hasOwnProperty.call(SERVICE_TRANSITIONS, type) ? SERVICE_TRANSITIONS[type] : undefined
  return !!table && from !== null && table.some(t => t.to === to && t.from.includes(from))
}

/** The core's ordinary 束ねるもの (records.md "Bundle kinds"): what a department with no business plugin's kind makes. */
export const CORE_BUNDLE_TYPE = 'project'

/** The core definitions, parsed (throws if one is invalid: a build error, caught by the tests). */
export function coreTypeDefinitions(): TypeDefinition[] {
  return Object.entries(CORE_TYPE_FILES).map(([name, text]) => {
    const r = parseTypeFile(name, text)
    if (!r.ok) throw new Error(`core type ${name}: ${r.errors.join(' / ')}`)
    return r.definition
  })
}

/** Whether `member` may undo this entry as the record's assignee (`UNDO_BY_ASSIGNEE`). */
export function undoableByAssignee(type: string, entry: { action: string; actorId: string; actorKind: string }, assignee: unknown, userId: string): boolean {
  const actions = Object.prototype.hasOwnProperty.call(UNDO_BY_ASSIGNEE, type) ? UNDO_BY_ASSIGNEE[type] : undefined
  return !!actions && actions.includes(entry.action) && entry.actorKind === 'external' && entry.actorId.startsWith('acb:')
    && typeof assignee === 'string' && assignee !== '' && assignee === userId
}
