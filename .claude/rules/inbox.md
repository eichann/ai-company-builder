---
paths:
  - "server/src/services/inbox.ts"
  - "server/src/routes/inbox.ts"
  - "server/src/routes/records-ai-inbox.ts"
  - "server/src/ports/inbox.ts"
  - "server/src/adapters/sqlite/inbox.ts"
  - "server/src/composition/inbox.ts"
  - "shared/core/intake-settings.ts"
  - "shared/core/notification-senders.ts"
  - "server/tests/unit/notification-senders.test.ts"
  - "shared/types/inbox.ts"
  - "server/src/db/schema/inbox.ts"
  - "server/tests/unit/inbox.test.ts"
  - "server/tests/unit/intake-core.test.ts"
  - "server/tests/unit/inbox-archive.test.ts"
  - "server/tests/integration/google-inbox-archive.test.ts"
  - "admin/src/components/advanced/intake-settings.tsx"
  - "client/electron/features/inbox/**"
  - "client/shared/ai-turn-steps/inbox-triage.ts"
  - "client/shared/ai-turn-steps/follow-up.ts"
  - "client/shared/ai-turn-steps/reply-check.ts"
---

# Incoming messages (来た連絡, stage 3, lane B: B2)

Owner decisions: 節目5 §11-20/28/30/35, spec §7 (統合版), 棚卸し §3-① / §5-2. **Noticing is the
server's job, judging the member's PC's.** Mail and chat messages are noticed on the server
through the core roles (`connector-roles.md`), never by a service name; the AI that judges one is
the owner's PC's AI turn (B4). **No body is ever stored** — ids, pointers, times, and on the
owner's own record the subject, the sender and the To / CC addresses (≤ 20 each).

## Receiving (`services/inbox.ts`)

- **One entry point**: `inbox.receive(companyId, reporterId, message)` (`IncomingMessage`,
  `shared/types/inbox.ts`): channel `email` | `chat`, `messageId` (RFC Message-ID; chat
  `<channel>:<ts>`), `references` (In-Reply-To / References; a chat thread's root), `sourceRef` /
  `threadRef` (the connector's opaque pointers), `occurredAt`, `subject`, `from` / `to` / `cc`
  (address, optional `memberId` when the connector knows it — Slack), `outgoing`, `bulk`,
  `automated`, `spam`. Slack (A3) calls it from its events; Gmail (A1) registers an
  `InboxSource` (`ports/inbox.ts`, `listSince`) with `inbox.registerSource(<connector id>)` and
  the server clock runs `inbox.pollCompany` — the inbox resolves the `mail` role's `read` and
  uses that connector's source (no role resolved → nothing read, the window stays). A malformed
  message is skipped (logged without content); never throws.
- **A message id once per company and channel** (`inbox_messages`): a second reporter gets
  `duplicate`. **One interaction per thread**: a message whose `references` hold a known message
  joins that interaction (`continued`) — unless it is the other side's message to someone else
  than the interaction's owner (an owner-only interaction takes it only when its owner was the
  reporter, in To or in CC; a members-only one only when someone on its list was — for any
  message; otherwise it is routed as new: never told to someone it did not reach).
  **The reporter's own message** (`outgoing: true`: their Sent mail, their own Slack message) joins
  only an interaction the reporter reads (owner FB #19): another member's sent mail never moves
  someone else's records — except a reply whose To / CC (of the sender's own Sent mail) names the
  record's owner: they did send it to her, so it counts in her own thread. Otherwise it is
  `skipped` with nothing written — not even its id.
  **Ours only from the connector** (audit B-M3, 2026-11-05): `outgoing` comes only from the
  member's own Sent label (Gmail), their own Slack message (the event's own user id) or a mail ACB
  sent — **never from a From header matching a member's address**. A message in someone's inbox
  whose From names a member (forwarded, spoofed) is neither ours nor theirs: `skipped`, nothing
  written, so it can never close a 返事のお願い, discard a draft or mark a message handled; the
  sender's own Sent copy, reported by that member, is still taken when it comes. Guard:
  `inbox.test.ts` "a mail that only claims a member's name …".
- **Routing a new message** (`shared/core/intake-settings.ts` `routeIncoming`, in this order):
  spam → nothing; internal (sender is a member, or of the company's domains — the settings'
  plus the members' own, never free mail; mail only — a colleague's Slack DM or mention is what
  chat intake is for) → nothing (`excludeInternal`); a member in To → **that
  member's own record** (`personal_owner`, 持ち主だけ: nobody else, owners and admins neither),
  the first member in To when several (`multipleTo: unsure` → 確認待ち), newsletters / automatic
  mail → `excluded` (`excludeBulk`: 「やることにしなかった一覧」); a shared address in To or CC
  → **the department's turn** (`unclaimed`, readers of its folder — never a private folder);
  a member only in CC → nothing (`ccOnly: unsure` → 確認待ち for that CC member when they
  reported it). **CC is never told when someone is in To.** Our own sent mail is not intake.
- **Notification mails of connected services** (owner FB #18, 2026-11-04: Gemini's meeting notes,
  calendar invitations, Slack's mention mails and HubSpot's notices became tasks a second time).
  The mail poll (`poll`, before `receive`; `receive` itself is unchanged) leaves out a mail whose
  From — or Sender, where the entry says so — is a connected service's notification sender
  (`shared/core/notification-senders.ts` `notificationServiceOf`: whole address, or `@domain` with
  its subdomains; never a bare domain, so a person at google.com is still taken in). Header facts
  only (the `format=metadata` read), never the body. Nothing is written (like spam: no record, not
  `excluded`); one log line per poll with counts by service (`google_meet=1 slack=2`), nothing of a
  message. Connected (`notifiersFor`, decided per poll):
  - built-in, listed in one place (`BUILTIN_NOTIFICATION_SENDERS`): Google Calendar —
    `calendar-notification@google.com` as From or Sender (an invitation comes From its organizer
    "via Google Calendar") — while the `calendar` role's `read` resolves to `google`; Gemini / Meet —
    `gemini-notes@`, `meetings-noreply@`, `meet-recordings-noreply@google.com` — while `meetings`
    resolves to `google`; Slack — `notification@slack.com`, `feedback@slack.com` (not
    `no-reply@slack.com`: sign-in and account mail) — while `chat`'s `receive` resolves to `slack`
    **and** the member's own Slack grant reads (active, 読む on, their 受信を読む on: composition's
    `connectorReadsFor`); without it the mail is how they hear of a mention, so it is taken in;
  - a connector plugin's declared `notification_senders` (`plugins.md`), while the company has it
    installed and on, its package unchanged and not stopped (`composition/inbox.ts`
    `pluginNotifiersOf`). HubSpot's addresses belong in its (private) package's declaration.
  A failing lookup leaves that service out: the mail is then taken in, never lost.
- The new interaction: title = subject (≤ 200, 「（件名なし）」 `INBOX_NO_SUBJECT` until the owner's AI
  names it: "The AI's judgement"), fields `occurred_at`, `channel`,
  `counterpart_text` (mail: 「name <address>」; chat: the sender's name only — Slack's `senderName`,
  `slack-connector.md` "Names" — else none, never a Slack id: the card's 「<name> から」), `source_ref`, `message_id`, `thread_ref`, `from_address`, `to_addresses`,
  `cc_addresses`, `assignee` / `next_actor` (the owner), `intake_reason`; the `counterpart` link
  when 名寄せ (`identity.md` `resolveAddress`, as the owner may see) finds exactly one person, else
  exactly one company. Created by the service writer as `INBOX_ACTOR` (`acb:inbox`, external)
  directly in its state (`state`); 届いた (the AI's turn) and やることにしなかった tell nobody
  (`quiet`, signal only); 確認待ち tells its owner (`intake_unsure`).
- **Each message keeps its pointer** (`inbox_messages.source_ref`, B4; null for rows from before
  it): pointers only, for later reads by message.
- **The member's own reply** (B4). Slack sends the member's own message in a DM or a thread as an
  `own` signal (`slack-events.ts`; `slackSignalMessage` makes it `outgoing`). Gmail (owner FB #19:
  a reply sent from the phone, or in Gmail itself): the poll also lists the member's **Sent** label in
  the same window (`googleMailInboxSource`: header facts only — Message-ID, In-Reply-To, References,
  To / CC, date; never the body), each as `outgoing`; one cap for both lists (the newest
  `INBOX_POLL_MAX`, a cut list's edge a gap like any), a message in both labels once (ours), seen
  ones `duplicate` by Message-ID. A Slack DM is seldom
  threaded: an outgoing chat message with no reference in a DM channel (`D…`) answers the newest
  incoming message of that DM within `DM_REPLY_WINDOW_MS` (3 days; `latestIncoming`), never
  another DM's or older, and only when the member reads it (owner-only: theirs; members-only: they
  are on the list). When the member's reply is seen: each open reply request moves as below
  with the note 「メールで返信済み」/「チャット（Slack）で返信済み」 and its reply drafts still in
  `draft` — the prepared ones and the card's own replies to that 連絡 (`interaction` link) — are
  **discarded** (never offered to send); an
  interaction not judged yet (`received`, or `unsure`) becomes `handled` (`needs_reply: false`).
  A judgement `reply` on a thread whose newest message is ours makes no reply request
  (`alreadyReplied: true`, handled). A reply ACB cannot see (the phone, another channel): the
  assignee's 「もう返した」 (`replied_elsewhere`, reply_request v2; v3 marks `interaction` /
  `prepared` as origin links, `records.md` "Linking records later"), which discards the same drafts
  (the engine's `afterAct` hook → `inbox.afterAct`, note 「ほかの経路で返信済み（もう返した）」), so
  the card offers no second reply.
- **The thread went on**: their reply (not `automated` / `bulk`: an automatic reply is no reply)
  moves each 返事待ち reply request to `checking` (ledger `reply_arrived`, the assignee told:
  notice `reply_arrived`); with no open reply request a `handled` interaction goes back to
  `received` (the AI judges again). A reply of the company (`outgoing` only, see above) moves
  open / preparing reply requests to `checking` (`member_replied`, `memberReply: ai_checks`,
  default — spec §7-3: the reply's content decides) or ends them (`close`); `replied_by` is named
  only when that member can read the record. A 返事のお願い with a `task` link (a mail we sent
  first from a task) also tells that task's assignee (`reply_arrived`; a notice reaches readers only).
- **We sent first** (`awaitOwnMessage`, owner decision 2026-11-03; `outbound-mail.md` "Waiting for
  their answer"): a new mail sent with 「返事を待つ」 registers our message in its interaction's
  thread (once per message id) and makes a 返事のお願い straight in 返事待ち (the service writer's
  `state`; `SERVICE_TRANSITIONS` preparing → waiting_reply for that create only — no service moves
  one there), the sender's, until the picked morning. Their reply / silence then work as above and
  in "Following up", unchanged.

## Mail archived in the mailbox (owner decision 2026-11-05)

Actions on things run automatically, with a notice and ［元に戻す］ (2026-11-04); only what reaches
people, moves money or cannot be undone is approved first. Both directions use **only the mailbox
owner's own Google permission**: an interaction counts only when it is someone's own
(`personal_owner`) and its first message was reported by that same member (`inbox_messages.reporter_id`,
2026-11-05; `ownMailbox`). A mail read from another member's mailbox (a CC reporter's copy routed to
the To member), a department's mail and rows from before the column are never closed by a mailbox
nor archived in one.

- **Gmail → ACB** (`gmail.readonly`, no new permission). After each member's poll (`poll` →
  `syncLeft`, same 5-minute clock) the source's change log is read from the connection's
  `left_cursor` (`InboxSource.leftSince`; Gmail: `users.history.list` of `labelRemoved` /
  `messageDeleted`, at most `HISTORY_PAGES_MAX` (5) pages of 500, the rest on the next poll); without
  a cursor or with one Gmail no longer keeps (404, about a week) it starts from now (`users.getProfile`)
  and checks the member's own watched records directly. Watched: their own email interactions in
  届いた / 確認待ち, or with open work (a task not done / cancelled, a 返事のお願い not closed / dropped),
  in 届いた / 確認待ち / 対応済み / 返事のあとを確かめる. Of the conversations named, only watched ones
  are confirmed (`inInbox`: `threads.get?format=minimal`, labels only — no message in INBOX, or gone),
  at most `LEFT_CHECK_MAX` (20) per member and poll. With more, the ones not checked yet at that
  cursor go first and **the cursor stays** until every one was checked (`checkedAt`, memory only: a
  restart checks again); records already noted, or archived by ACB itself, are not watched. The cursor
  moves only after a successful look.
  - **ACB's own archive is never a reason** (review of #607): a record with `archived_there` since the
    thread's newest message is neither closed nor noted — the member closed it here, and if they took
    that close back (undo of 「済んだ」) it stays open; the same on a fresh start (no cursor).
  - **Nothing made from it** (no open task, no open 返事のお願い) and in 届いた / 確認待ち → closed:
    `left_inbox` (interaction v8, `who: [system]`) to 対応済み, actor `INBOX_ACTOR` — never the member;
    `settled_by` stays empty (「済んだ」 is the person's) — note 「Gmail ではアーカイブ済み」, the owner told
    (`mail_left_inbox`, `notifications.md`) with ［元に戻す］: the generic undo of that entry, which its
    assignee may run (`UNDO_BY_ASSIGNEE`, `records.md`). An undone close is not closed again until the
    thread brings a new message.
  - **A task or a 返事のお願い still open** → nothing closes; the note 「Gmail ではアーカイブ済み」
    (`left_inbox_noted`, a ledger entry changing nothing, quiet), once per thread state (people who keep
    an empty inbox archive mail that still needs work).
- **ACB → Gmail** (opt-in: `inbox_archive`, `gmail.modify`, `google-connector.md` "Archiving in
  Gmail"). The engine's `afterAct` (`mailboxFollowUp`) starts `archiveThere`, which takes **only the
  incoming messages ACB took in from the owner's own mailbox** (`inbox_messages` rows of the record,
  direction `in`, `reporter_id` = the owner — never their own Sent mail; the newest
  `ARCHIVE_MESSAGES_MAX` (50)) out of the inbox, one at a time, and of those **only the ones in the
  inbox now** (`InboxSource.archive`: Gmail `messages.get?format=minimal`, then `messages.modify`
  `removeLabelIds: ['INBOX']`; one the member archived themselves is left alone) — never the whole conversation, so a reply that came
  after the last poll stays in the inbox and is taken in next (review of #607: a thread archive lost
  it, since intake lists `labelIds=INBOX`), and another record of the same conversation keeps its
  message there. The source answers `not-allowed` without the permission, the company's switch or the
  member's own, and nothing is sent. One follow-up per record at a time (`inFlight`), and the entry is
  written once (checked again after Google answers): a double close calls once and tells once. Which
  closes count, and why:
  - **The owner's own action into 対応済み / やることにしなかった** — 「済んだ」 (`settle`), 「取り込まない」
    (`drop`), `handle`, 「自分で確かめる」 (`check_myself`): a person (actor kind `human`) who is the
    record's owner. The member decided it is done.
  - **Every task made from it done by a person** (a task reaching 完了 through the engine, actor kind
    `human`), the interaction itself closed and no task or 返事のお願い open — the work the mail asked
    for is over. The reply check's `replied_done` (the member's own AI completing tasks) archives
    nothing: the AI's judgement alone never archives (owner); the member's 「自分で確かめる」 or their
    own completion does.
  - **Not**: the AI's judgement (`handled` / `excluded` by the triage AI, its `set_aside`, the reply
    check: the member may not have seen the mail), the member's reply seen in the thread (replying does not archive in Gmail either), the
    clock or the inbox's own moves, anything with open work, and `left_inbox` itself.
  - **No loop**: nothing is archived when the ledger has `left_inbox`, `left_inbox_noted` or
    `archived_there` since the thread's newest message (the mailbox archived it already, or ACB did,
    or the member put it back).
  - At least one message changed → the note 「Gmail でもアーカイブしました」 (`archived_there`, actor
    `INBOX_ACTOR`; 「（一部はできませんでした）」 when it stopped partway — Google refused, a switch turned
    off meanwhile — or more than 50 were left), the owner told (`mail_archived`) with ［元に戻す］, and
    **the pointers it changed** kept under that entry's version (`inbox_archived`). Its undo (the
    assignee's, `UNDO_BY_ASSIGNEE`) reaches the inbox through `afterAct` (also run after an undo), which
    puts back exactly those (`addLabelIds: ['INBOX']`) — never the Sent mail or what the member
    archived themselves. When no entry can be written (a lost race), what was taken out is put back at
    once: nothing stays archived without a notice and an undo. When the undo fails, the quiet note 「Gmail の受信トレイに戻せませんでした」
    (`unarchive_failed`). Calls run after the action's answer (`whenIdle` in tests).
- Tests: `server/tests/unit/inbox-archive.test.ts` (close as the inbox with the owner's undo, nobody
  runs `left_inbox`, task / 返事のお願い → the note once, another member's mailbox never, no cursor →
  the open records within the limit; ACB → Gmail on settle / drop, not when not allowed, not the AI's
  judgement nor its `set_aside`, open work, every task done, no loop, never another mailbox) and
  `server/tests/integration/google-inbox-archive.test.ts` (end to end against the fake Google: the
  switches, the one Gmail guard, the clock closing what Sato archived with GETs only, Sato's 「済んだ」
  archiving his message and not Tanaka's copy, the undo, the member's and the company's switch; review
  of #607: H1 a reply not read yet stays in the inbox and is taken in, P1 his 「済んだ」 taken back is not
  closed again, C1 the other record of the conversation stays open) — mutation-checked. Unit also:
  only the known messages, the undone 済んだ on both paths, a double follow-up once, the reply check
  archives nothing, the cursor waits past the limit.

## In the app without mail or chat (owner decision 2026-11-03)

A company with no usable connector for the `mail` and `chat` roles sees no mail / chat parts
(`GET /me/work-switches` `channels`; `tasks-ui.md` "Without mail or chat"); records already made
stay listed until finished.

## Connections (reconnecting, spec §7-5)

`inbox.connect(companyId, userId, channel)`: a first connection reads from now (no reading
back); a reconnection keeps `checked_until`. `pollCompany` first connects every member the
role's source reports `ready` (`InboxSource.ready`: a read works now; Gmail: granted, their
受信を読む and the company's switches on — refused locally, no call to Google, otherwise), so a
grant becomes a connection within one clock run; it is pulled from stored state rather than
pushed on the grant, because the switches change elsewhere too. A member turned off later keeps
their connection (their reads are `not-connected`). Each poll reads from `checked_until` but
at most `BACKFILL_DAYS` (7) back (`pollWindow`), and lists `INBOX_POLL_OVERLAP_MS` (10 min)
before it, never before the connection unless the window is (mail listed late keeps its
earlier time; seen ones are `duplicate`); a longer break leaves the span before as an
**unchecked gap** (`inbox_gaps`), shown in `GET /inbox/status` to that member only. A source
that stops at its limit answers `{ messages, readFrom }` (Gmail keeps the newest
`INBOX_POLL_MAX`, 1000): the span before `readFrom` is a gap too, never skipped silently. `checked_until` moves only after a successful read (`not-connected` / a throw
keeps it). 「過去7日を見直す」 (`POST /inbox/backfill`) moves the member's own window 7 days back;
messages already seen are not taken twice.

## The AI's judgement (`routes/records-ai-inbox.ts`, record token)

`POST /api/records-ai/inbox/items/:recordId/judgement { expectedVersion, outcome, reason, title?,
endCondition?, deadline?, deadlineNote? }` (act; `Idempotency-Key` inside a run): only on an
interaction the member reads, in `received` with them as assignee (else 409 `NOT_AI_TURN`; one
they cannot read: the missing record's 404). `reply` → a **返事のお願い** (`reply_request`, made by
the inbox only: service-owned) — owner-only like its interaction (or the interaction's folder),
state `preparing` (the AI's turn: the reply's draft), `due` = the message's own deadline else the
company's 目安 (`task-settings.ts` `replyTarget`: 翌営業日 / 当日中 + cutoff, holidays),
`guideline_due` always the 目安 (the app shows 「目安：」 when they are equal), `due_note` the
sentence it came from, `end_condition`, links `interaction`, `counterpart`, `bundle`; the
interaction → `handled`. **`title`** (owner FB 2026-11-04: a Slack mention's card read
「（件名なし）」): with any outcome, the message's title becomes the AI's (one line, ≤ 60,
`INBOX_AI_TITLE_MAX`) only when it is still 「（件名なし）」 (a chat message, a mail without a subject:
never over a subject, nor over a title the AI gave on an earlier run) and the interaction is the
judging member's own (`personal_owner`; a department's message keeps its title). The service
writer's `retitle` compares-and-sets the title (receipt types only; version and ledger unchanged).
The triage prompt asks for it when the title is 「（件名なし）」; `reply` also names the 返事のお願い by it. `no_reply` → `handled`; `set_aside` → `excluded` — refused (409
`PERSON_DECIDED`) when a person's 「やることにする」 / 「自分の担当にする」 put it back into
`received`; `unsure` → 確認待ち. `GET /items/:recordId` (read) answers — for an interaction, or a
返事のお願い and its interaction — the pointers (channel, `thread_ref`, `source_ref`, the message
ids; never a body), its state and version, the tasks and open reply requests made for it and its 相手 (only what the
member reads), and for a 返事のお願い `request` (its state, version and `purpose`, B5). `task` (B4) → `handled`: `taskId` must be a task the member reads whose
`interaction` link is this message (the AI makes it with `records_create`, owner-only); a second
run sees it in the view and reuses it. `reply` links the 相手 found now by 名寄せ when the message
had none.

**A task from a message** (owner FB #13, 2026-11-04: a MoneyForward mail asking the owner to approve
an expense became their task, but with no notice and no due it sat unseen under 「いつか」):
- **Due**: `recordEngine.createByAi` (`record-engine/create.ts` `messageDue`) gives a request the AI
  makes with an origin link to a message (`messageOriginLinks` in `core-types.ts`: a task's
  `interaction`) a `due` when the AI sent none (or null): the 目安 from the message's `occurred_at`
  (engine dep `replyGuideline`, composition.ts: `replyTarget` with the task settings' rule and
  company holidays — the rule a 返事のお願い uses; without the dep the default settings). A due the AI
  read in the message (`fields.due`; the triage prompt asks for it) is kept. Enforced on the server,
  so a task from a message never lands without a due; a person changes it afterwards like any
  due. A person's own create gets none.
- **Notice**: the member's own AI making it their turn tells them (`from_message`,
  `notifications.md`), although their AI was the actor.

**Tasks made from that message** (owner FB #19, 2026-11-04: a reply from the phone or in Slack / Gmail
left its task open). When the member's own reply is seen in the thread (`continueThread`, outgoing,
the replier being the interaction's assignee, the interaction 対応済み) and tasks made from the message
are still theirs to do (`replyCheckTasks`: `interaction` link to it, assignee = the member, readable,
state `todo` / `in_progress` / `waiting`):
- with their 自動で進める on (`autoRunFor`, composition: `workSwitches` `autoRun`; absent = on) the
  interaction goes to **「返事のあとを確かめる」** (`replied`, interaction v7, ledger `reply_seen`,
  quiet) — their AI's turn on their PC (the `reply-check` step below), run when the app opens if it is
  closed; else each task gets the note 「返事は済み（メールで返信済み）」 (`reply_noted`, a ledger entry
  changing nothing) and stays the member's.
- `GET /items/:recordId` answers `replyCheck.tasks` (id, title, state, version, `canComplete` —
  false for 確かめてから) in that state. `POST /items/:recordId/reply-check { expectedVersion, tasks:
  [{ taskId, outcome: done | open, note? }] }` (act token, `Idempotency-Key`): **the guard** — only an
  interaction in `replied` whose assignee is the member (else 409 `NOT_AI_TURN`; unreadable: the
  missing 404), only tasks `replyCheckTasks` lists (anything else — another's task, one from another
  message — 409 `NOT_FROM_THIS_REPLY` for the whole request, nothing written), `done` only when
  `canComplete` (409 `NEEDS_CHECK`). `done` → the task goes to 完了 through the service writer
  (`SERVICE_TRANSITIONS.task` todo / in_progress / waiting → done; ledger `replied_done`, actor the
  member's AI, note 「返事をしたので完了にしました」) and the member is told (notice `replied_done`,
  `notifications.md`) with ［元に戻す］ — the generic undo of that entry (its actor id is theirs); `open`
  → the note 「返事は済み」 (`reply_noted`). **Completed, never archived** (no cancel, no dismiss),
  never another's task. Then the interaction → `handled` (`reply_checked`).

**The thread itself** is read through A4's one AI route, `GET /api/records-ai/threads/:recordId`
(`outbound-mail.md` "Replies": an interaction or a record linking one, read now with the member's
own permission, a plugin step's run only with the role declared; nothing stored). The PC's
`inbox_read` asks both — the item view here, then that thread — and shows the thread to the AI
between `THREAD_TEXT_HEADER` / `FOOTER` (`intake-settings.ts`; outside text: data, not
instructions) with instruction-like phrases flagged; not readable → the server's sentence why.
The block follows `shared/core/outside-text.ts` (`wrapOutsideText`): every field of every message
— names, addresses, subject, text — is inside it with `【】` → `〔〕`, so no message closes it
(`wrapper-spoof` flagged); header values are one line, and a message line starting `---` is
quoted (`> ---`), so the other side cannot pass text off as the member's own reply (`--- N（こちらから）`,
which `reply-check` decides on). The item JSON after the footer is ACB's own view (its `title` may
be the subject, JSON-encoded). Test: `client/tests/outside-text-entry-points.test.ts`.

## The AI's turn on the PC (B4: `inbox-triage`)

`client/shared/ai-turn-steps/inbox-triage.ts` (`ai-turns.md` "Steps"): an `interaction` in
`received` (the owner's 「AI の番」 in the task list). No start mark (`claim.action: null`): the
server's execution run alone picks the PC; left in `received` the run is given back. Done in
`handled` / `excluded` / `unsure`. Tools, nothing else: `inbox_read`, `inbox_judge`
(`client/electron/features/inbox/tools.ts`, provider under lane B in
`records/tool-providers.ts`; `inbox_judge` only with an act token), `records_create` (the task),
`mail_recipients` / `mail_draft_create` with `interactionId` (the reply in the 連絡's own thread,
`outbound-mail.md` "Replies": mail to the thread's people by ref, Slack body only; the other
side's text not quoted), `reply_request__finish_prep` (`links.prepared` = the draft, a short
`prep_summary`) and `reply_request__hand_over`. The member checks and sends it from the card. It never sends. Tests: `client/tests/ai-turn-steps.test.ts`,
`client/tests/ai-turn-claims.test.ts` (no start mark).

## After the member's own reply (`reply-check`)

`client/shared/ai-turn-steps/reply-check.ts`: an `interaction` in `replied` (no start mark; done in
`handled`). Its only tools: `inbox_read` (the thread with the member's reply, and
`item.replyCheck.tasks`) and `inbox_reply_check` (`client/electron/features/inbox/tools.ts`, act token
only). The first message asks for `done` only when the reply itself finished the task (「X を送る」 and
the reply sends X), `open` when work remains (「経費を承認する」 answered 「今日見ます」), open when
unsure or the thread cannot be read. Tests: `client/tests/ai-turn-steps.test.ts` (the step, its
tools, the tool's route).

## Following up (追いかけ, B5: `follow-up`)

- **The clock**: `WAIT_OVER.reply_request` (`core-types.ts`): a 返事待ち whose `wait_until` (返事の
  見込み: the AI reads a promise, the person sets it, or the 目安) has passed goes to `preparing` (the
  AI drafts the nudge) when the assignee's 自動で進める is on, else to `open` (the assignee). **Never before**: the
  only way out of `waiting_reply` into 準備中 is the clock's `wait_over` after the time (no action of
  the type does it). The person still presses 送る.
- **Their reply ends it** (the reply's content decides): a reply that is not automatic moves a
  返事待ち — or a follow-up still 準備中 / handed over (`open`) after `wait_over` (`followingUp`: a
  `wait_over` newer than the last move into `waiting_reply`) — to `checking`, and the nudge's
  prepared drafts are discarded. A first draft (準備中 not after a `wait_over`) stays.
- **The PC's step** `client/shared/ai-turn-steps/follow-up.ts`: a `reply_request` in `preparing` or
  `checking` (no start mark; `claim.from` lists both). `inbox_read` with the request's id answers
  `item.request.purpose` — `draft`, `follow_up`, `check_reply` — and the AI acts: the draft or nudge as
  a reply in the thread (`mail_draft_create { interactionId }`, linked by `finish_prep`'s
  `links.prepared`), `ai_close` (answered / sent / accepted), `await_reply` (+
  `set_wait_until` for a promise such as 「明日送ります」: the clock follows it up), or `hand_over`
  (still the member's).
- **The check after a reply** (`check_reply`, owner report 2026-11-05): `item.request.triggerKind` says
  whose reply it was — `their_reply` (theirs: answered → `ai_close`, a question back → `hand_over` or
  `await_reply`) or `our_reply` (the member's own, often sent from the card: it met the end condition →
  `ai_close`; waiting on them → `await_reply`; still the member's → `hand_over`). The first message
  makes the run end with exactly one of these (unsure or unreadable → `hand_over`): a run that ends
  with none leaves the request in 確かめ中. The due of a 返事のお願い makes only its first draft urgent
  (`dueIsTheAisTurn`, `ai-turns.md`): a check or a nudge is never handed to the person early for it.
- **A promise in the reply** (「明日送ります」, owner decision 2026-11-02): the same reply request goes
  back to 返事待ち with the promised time as `wait_until` — no separate promise-wait record — and
  the clock follows it up like any 返事の見込み.
- Its only tools: `inbox_read`, `mail_recipients`, `mail_draft_create` and those six
  `reply_request__…` actions.
- Tests: `server/tests/unit/inbox.test.ts` ("B5"), `client/tests/ai-turn-steps.test.ts`,
  `client/tests/ai-turn-claims.test.ts`.

## Member routes (`routes/inbox.ts`, session, `/api/companies/:companyId`)

`GET|PUT /inbox-settings` (any member reads; owner/admin change — 403; a shared address on a
private folder → 400, the folder never named), `GET /inbox/status`, `POST /inbox/backfill`,
`GET /inbox/set-aside` (the member's own excluded interactions, newest first, why and by whom),
`GET /inbox/department` (unclaimed messages the member reads), `POST /inbox/items/:recordId/claim
{ expectedVersion }` (引き受ける: a reader of it; unreadable → the missing 404 before 409
`NOT_UNCLAIMED`). Admin: 「来た連絡」 card on the やることの一覧 page
(`admin/src/components/advanced/intake-settings.tsx`, page 「詳しい設定 › 来た連絡の決まり」 `/advanced/inbox`).

## Core types (`shared/core/core-types.ts`, reserved versions)

- `interaction` v5 (additive over 4): implements `request` too (確認待ち is a person's turn in
  「あなたの番」); fields above plus `requested_by`, `waiting_on`, `due`; `channel` adds `chat`;
  states `unsure` (確認待ち), `unclaimed` (部署の番), `excluded` (やることにしなかった, final);
  actions `set_aside` / `ask_person` (`who: [ai]` — `received` is the AI's turn), `confirm`,
  `drop`, `take_up` (the assignee). `SERVICE_TRANSITIONS` rows for the inbox's moves.
- `interaction` v6 (additive over 5; owner FB #20, 2026-11-04: 「来た連絡で話が決着したらどうする？」 — a
  確認待ち message could not be closed): **「済んだ」** (`settle`, `unsure` → `handled`, `who:
  [assignee]`: never the AI, never another reader; a non-reader gets the missing record's 404) and the
  field `settled_by`, which the engine fills with the person acting (`ACTOR_ARGS`, `records.md`; a
  value naming anyone else → `BAD_VALUE`). It marks what the member closed, so the app's
  今日終わったこと lists it (never what the AI judged); the thread going on (`continued`, handled →
  received) clears it. ［元に戻す］ is the generic undo of that entry (its actor only, nothing changed
  since); `drop` stays the app's ［取り込まない］. Only from 確認待ち: `received` is the AI's turn (it
  judges within minutes; a person's close there would race its 返事のお願い), and 部署の番 has no
  assignee and no screen yet. **An open 返事のお願い is not ended by it** (the engine does no
  cascades; 「もう返した」 is that record's own action, above): the card says so and points there.
  Tests: `inbox.test.ts` 「済んだ」 (who, the mark, undo, cleared when the thread goes on —
  mutation-checked), `intake-core.test.ts` (6 additive over 5: `INTERACTION_V5_TEXT`).
- `interaction` v7 (additive over 6; owner FB #19): state `replied` 「返事のあとを確かめる」 with the AI's
  `finish_reply_check` (`who: [ai]`: what makes it 「AI の番」; the reply-check route makes the move as
  the service) and the assignee's `check_myself` (自分で確かめる: a person's way out); `SERVICE_TRANSITIONS`
  handled → replied → handled. Tests: `intake-core.test.ts` (7 additive over 6: `INTERACTION_V6_TEXT`).
- `interaction` v8 (additive over 7; owner decision 2026-11-05): `left_inbox` 「受信トレイから外れた」
  (届いた / 確認待ち → 対応済み, `who: [system]`: only the inbox, through the service writer — no member,
  admin or AI; "Mail archived in the mailbox"). Its label 「受信トレイから外れた（自動）」 says it is not a
  button: an app released before v8 lists every action in its command palette and may show it there;
  the server refuses it (403 `NOT_ALLOWED` 「この操作をする権限がありません」), nothing changes. Its entry and `archived_there` are undoable by the
  record's assignee (`UNDO_BY_ASSIGNEE`). Tests: `intake-core.test.ts` (8 additive over 7:
  `INTERACTION_V7_TEXT`), `inbox-archive.test.ts`.
- `reply_request` v1 (返事のお願い): implements `request`, `prepared`, `outside_event`; states
  preparing → open → waiting_reply ↔ checking → closed / dropped. v2 (B4, additive): the
  assignee's 「もう返した」 (`replied_elsewhere`, from every open state → closed). The AI ends one only here
  (`ai_close`, `who: [ai]`, from preparing / checking, `close_reason`); the person's `close`,
  `drop`, `reopen`, `resume` are the assignee's; `await_reply` (assignee or AI). Follow-up on
  `wait_until` is B5. v4 (additive): the origin link `task` (もとのタスク: the やること a mail we sent
  first came from). v5 (additive; owner report 2026-11-05: a request sat in 「AI が確かめている」 after the
  member's reply, with nothing to press): the assignee's 「終わりにする」 (`close`) from **every open state**,
  準備中 / 確かめ中 — the AI's turn — included. The AI never has it (`who: [assignee]`); a check that was
  running and writes after the close is refused (its `from` no longer holds, and the version moved).
  ［取り消す］ is the generic undo of that entry. The record card offers it (`tasks-ui.md` 「A 返事のお願い's
  card」). Tests: `inbox.test.ts` 「終わりにする」 (who, the AI's late writes refused, undo, 準備中),
  `intake-core.test.ts` (5 additive over 4) — mutation-checked.
- `task` v8: link `interaction` (もとの連絡), additive. A promise to wait for uses `waiting` /
  `wait_until` as before.
- The service writer may now create an owner-only record (`personalOwner`, a member; not with a
  folder) directly in a state the initial one may move to (`state`), and stay quiet (`quiet`).

## Tests

`server/tests/unit/inbox.test.ts` (notification mails of connected services: each kind left out
only under its condition — Google's only while Google serves the role, an invitation by its Sender,
Slack's only for a member whose grant reads, a plugin's only by declaration — a person at
google.com kept, nothing written, counts only in the log; mutation-checked; owner-only and unreadable / unlisted / untold for CC, other
members, owner, admin; CC / several To / shared address / internal / free mail / bulk per
setting; once per id; no body stored; thread continuation, automatic reply, a reply to another
member; member reply per setting and never naming a non-reader; judgement: due from the 目安 past
a holiday or the stated deadline, owner-only reply request, only the owner's AI, a person's
「やることにする」 wins; the AI's title only over 「（件名なし）」, only on the judging owner's own
message, ≤ 60 (mutation-checked); a chat sender by name only; a task the AI makes from a message always has a due — the stated one kept,
else the 目安 past public and company holidays, none made up for other creates (mutation-checked); B4: the item view is the owner's alone and a reply request answers its
message and purpose, a task counts only when it names the
message, 名寄せ at judgement, the member's reply discards drafts / handles an unjudged message /
stops a reply request being made, a Slack DM's unthreaded reply within 3 days, 「もう返した」 is
the person's; owner FB #19 (mutation-checked): her Sent mail found by the poll moves the 返事のお願い and
drops its draft, another member's sent mail moves nothing unless it went to her (To / CC), a mail only claiming a member's From moves nothing (B-M3), her reply makes
the tasks from that message her AI's check listing only her own open ones, the reply check refuses
anything else before writing and never completes a 確かめてから task, `done` completes as her AI with
her notice and her undo, `open` notes 「返事は済み」, with 自動で進める off the note alone; polling: first connection, 7-day read-back, the gap shown to its member
only, `not-connected` keeps the window, no role → nothing, connected once when ready (a
throwing check holds nobody up), the overlap catches mail listed late, a source's limit is a
gap; companies apart), `server/tests/unit/google-mail-inbox-source.test.ts` (Gmail's pages
oldest first as pointers that `threads.ts` reads, the window's edge, failure = not-connected,
the limit's `readFrom`; the Sent label as `outgoing` with References, once when in both labels, a
failing Sent list = not-connected, one cap across both lists), `server/tests/integration/google-inbox.test.ts` (the server clock
connects a member who allowed 受信を読む and takes only later mail, as `gmail:` pointers, no text),
`server/tests/unit/notification-senders.test.ts` (address / `@domain` match, Sender only where
declared, the plugin declaration's `notification_senders`, only an installed / on / unchanged /
not-stopped connector counts), the Google integration test also delivers a Gemini note and an
invitation via Google Calendar (left out, every read `format=metadata`, nothing stored),
`server/tests/unit/intake-core.test.ts` (settings validation and defaults, routing order, the
window's 7 / 8 days, the versions additive, only `reply_request` lets the AI end it), permission
matrix rows (lane B) + `CROSS`, `company-scoped-sql.test.ts`, `admin-contract.test.ts`.

## Not yet

- Wired: `roles` = lane A's `connectorRoles`; Slack's signals (`connectorsLane.onSlackSignal`)
  become chat messages through `slackSignalMessage` (`composition/inbox.ts`: ids
  `<channel>:<ts>`, the thread root as reference, no text). Gmail: `googleMailInboxSource`
  (`services/google-mail.ts`, registered by `wireCoreConnectors` → `wireInboxLane`) lists the
  INBOX and SENT labels since the window (every page, at most `INBOX_POLL_MAX` per poll across
  both, oldest first; `messageId` = the Message-ID header else `gmail:<id>` (differs per mailbox),
  `references` = References + In-Reply-To, pointers `gmail:<id>` / `gmail:<thread id>`); the server clock (`server-clock.ts`
  `pollInbox`) runs `pollCompany` for each company with records on, yielding between members.
  Not yet: mail a filter files past the inbox (or archived before the next poll) is not seen. The
  history read that closes archived mail ("Mail archived in the mailbox") could also take it in:
  `users.history.list` with `historyTypes=messageAdded` from the same cursor names every message
  added since (also the ones filed past INBOX or archived within the 5 minutes); intake would then
  read each one's metadata as today, decide by its labels (not SPAM / TRASH; a filter's label, not
  only INBOX) instead of `labelIds=INBOX`, and keep `checked_until` only as the fallback when the
  cursor is too old (404) — a wider intake, so not done without the owner (2026-11-05). A Sent mail with neither In-Reply-To
  nor References (a new mail in the same Gmail thread) is not matched by thread. Each Gmail call of the poll is one
  AI-action-log line (`google:gmail.messages.*`), like the member's AI reading mail.
- 「今後も無視」 per sender, 引き受ける notices to the department, handing an unsure message to
  another To member (moves `personal_owner`), the app's screens (A4) beyond the card's ［済んだ］ /
  ［取り込まない］ (`tasks-ui.md`): 部署の番 and 「やることにしなかった一覧」 have no screen in the app yet.
- A task's own wait (`WAIT_OVER.task` → `preparing`) runs as lane C's `task-wait-over` step
  (`ai-turns.md` "A task's wait that is over").
- Sent-mail receipts (`outbound-mail.ts`) still start in `received`, now an AI-turn state with no
  assignee (nobody's turn); A4 may create them `handled`.
