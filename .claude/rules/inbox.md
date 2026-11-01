---
paths:
  - "server/src/services/inbox.ts"
  - "server/src/routes/inbox.ts"
  - "server/src/routes/records-ai-inbox.ts"
  - "server/src/ports/inbox.ts"
  - "server/src/adapters/sqlite/inbox.ts"
  - "server/src/composition/inbox.ts"
  - "shared/core/intake-settings.ts"
  - "shared/types/inbox.ts"
  - "server/src/db/schema/inbox.ts"
  - "server/tests/unit/inbox.test.ts"
  - "server/tests/unit/intake-core.test.ts"
  - "admin/src/app/companies/*/task-list/intake-settings.tsx"
  - "client/electron/features/inbox/**"
  - "client/shared/ai-turn-steps/inbox-triage.ts"
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
  reporter, in To or in CC; otherwise it is routed as new: never told to someone it did not reach).
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
- The new interaction: title = subject (≤ 200, 「（件名なし）」), fields `occurred_at`, `channel`,
  `counterpart_text`, `source_ref`, `message_id`, `thread_ref`, `from_address`, `to_addresses`,
  `cc_addresses`, `assignee` / `next_actor` (the owner), `intake_reason`; the `counterpart` link
  when 名寄せ (`identity.md` `resolveAddress`, as the owner may see) finds exactly one person, else
  exactly one company. Created by the service writer as `INBOX_ACTOR` (`acb:inbox`, external)
  directly in its state (`state`); 届いた (the AI's turn) and やることにしなかった tell nobody
  (`quiet`, signal only); 確認待ち tells its owner (`intake_unsure`).
- **Each message keeps its pointer** (`inbox_messages.source_ref`, B4; rows from before it fall
  back to the interaction's `source_ref` for the first message): the AI reads the thread by them.
- **The member's own reply** (B4). Slack sends the member's own message in a DM or a thread as an
  `own` signal (`slack-events.ts`; `slackSignalMessage` makes it `outgoing`). A Slack DM is seldom
  threaded: an outgoing chat message with no reference in a DM channel (`D…`) answers the newest
  incoming message of that DM within `DM_REPLY_WINDOW_MS` (3 days; `latestIncoming`), never
  another DM's or older. When the member's reply is seen: each open reply request moves as below
  with the note 「メールで返信済み」/「チャット（Slack）で返信済み」 and its prepared
  `outbound_message` drafts still in `draft` are **discarded** (never offered to send); an
  interaction not judged yet (`received`, or `unsure`) becomes `handled` (`needs_reply: false`).
  A judgement `reply` on a thread whose newest message is ours makes no reply request
  (`alreadyReplied: true`, handled). A reply ACB cannot see (the phone, another channel): the
  assignee's 「もう返した」 (`replied_elsewhere`, reply_request v2).
- **The thread went on**: their reply (not `automated` / `bulk`: an automatic reply is no reply)
  moves each 返事待ち reply request to `checking` (ledger `reply_arrived`, the assignee told:
  notice `reply_arrived`); with no open reply request a `handled` interaction goes back to
  `received` (the AI judges again). A reply of the company (`outgoing`, or a member sender) moves
  open / preparing reply requests to `checking` (`member_replied`, `memberReply: ai_checks`,
  default — spec §7-3: the reply's content decides) or ends them (`close`); `replied_by` is named
  only when that member can read the record.

## Connections (reconnecting, spec §7-5)

`inbox.connect(companyId, userId, channel)` (the connector, when the member grants): a first
connection reads from now (no reading back); a reconnection keeps `checked_until`. Each poll
reads from `checked_until` but at most `BACKFILL_DAYS` (7) back (`pollWindow`); a longer break
leaves the span before as an **unchecked gap** (`inbox_gaps`), shown in `GET /inbox/status` to
that member only. `checked_until` moves only after a successful read (`not-connected` / a throw
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
interaction → `handled`. `no_reply` → `handled`; `set_aside` → `excluded` — refused (409
`PERSON_DECIDED`) when a person's 「やることにする」 / 「自分の担当にする」 put it back into
`received`; `unsure` → 確認待ち. `GET /items/:recordId` (read) answers the pointers the PC reads the
thread by (channel, `thread_ref`, `source_ref`, the message ids) — never a body — plus its
state and version, the tasks and open reply requests made for it and its 相手 (only what the
member reads). `task` (B4) → `handled`: `taskId` must be a task the member reads whose
`interaction` link is this message (the AI makes it with `records_create`, owner-only); a second
run sees it in the view and reuses it. `reply` links the 相手 found now by 名寄せ when the message
had none.

`GET /items/:recordId/thread` (read; B4): the thread read **now** through the role with the
member's own permission — mail: `mailReader.getMessage` per message pointer (`mailIdOf`: the part
after the connector prefix), at most `THREAD_READ_MAX` (5) newest; chat: the `chat` role's reader
(`InboxChatReader`, structurally lane A's `ChatReader`; until A4 wires it a chat thread reads
`stopped`) by `chatThreadOf(thread_ref)`. A 返事のお願い's id reads its interaction's thread.
Answers `InboxThreadView`: `read` (`ok` or the role's failure word, never guessed around), the
messages between `THREAD_TEXT_HEADER` / `FOOTER` (outside text: data, not instructions) and the
instruction-like flags. **Nothing of it is stored or logged.** A business plugin's run may use it
only when its step declares the `mail` / `chat` role (`connectorRoleRefusal`).

## The AI's turn on the PC (B4: `inbox-triage`)

`client/shared/ai-turn-steps/inbox-triage.ts` (`ai-turns.md` "Steps"): an `interaction` in
`received` (the owner's 「AI の番」 in the task list). No start mark (`claim.action: null`): the
server's execution run alone picks the PC; left in `received` the run is given back. Done in
`handled` / `excluded` / `unsure`. Tools, nothing else: `inbox_read`, `inbox_judge`
(`client/electron/features/inbox/tools.ts`, provider under lane B in
`records/tool-providers.ts`; `inbox_judge` only with an act token), `records_create` (the task),
`reply_request__finish_prep` (the reply's draft as `prep_summary`, the other side's text not
quoted) and `reply_request__hand_over`. It never sends. Tests: `client/tests/ai-turn-steps.test.ts`,
`client/tests/ai-turn-claims.test.ts` (no start mark).

## Member routes (`routes/inbox.ts`, session, `/api/companies/:companyId`)

`GET|PUT /inbox-settings` (any member reads; owner/admin change — 403; a shared address on a
private folder → 400, the folder never named), `GET /inbox/status`, `POST /inbox/backfill`,
`GET /inbox/set-aside` (the member's own excluded interactions, newest first, why and by whom),
`GET /inbox/department` (unclaimed messages the member reads), `POST /inbox/items/:recordId/claim
{ expectedVersion }` (引き受ける: a reader of it; unreadable → the missing 404 before 409
`NOT_UNCLAIMED`). Admin: 「来た連絡」 card on the やることの一覧 page
(`admin/src/app/companies/[id]/task-list/intake-settings.tsx`).

## Core types (`shared/core/core-types.ts`, reserved versions)

- `interaction` v5 (additive over 4): implements `request` too (確認待ち is a person's turn in
  「あなたの番」); fields above plus `requested_by`, `waiting_on`, `due`; `channel` adds `chat`;
  states `unsure` (確認待ち), `unclaimed` (部署の番), `excluded` (やることにしなかった, final);
  actions `set_aside` / `ask_person` (`who: [ai]` — `received` is the AI's turn), `confirm`,
  `drop`, `take_up` (the assignee). `SERVICE_TRANSITIONS` rows for the inbox's moves.
- `reply_request` v1 (返事のお願い): implements `request`, `prepared`, `outside_event`; states
  preparing → open → waiting_reply ↔ checking → closed / dropped. v2 (B4, additive): the
  assignee's 「もう返した」 (`replied_elsewhere`, from every open state → closed). The AI ends one only here
  (`ai_close`, `who: [ai]`, from preparing / checking, `close_reason`); the person's `close`,
  `drop`, `reopen`, `resume` are the assignee's; `await_reply` (assignee or AI). Follow-up on
  `wait_until` is B5.
- `task` v8: link `interaction` (もとの連絡), additive. A promise to wait for uses `waiting` /
  `wait_until` as before.
- The service writer may now create an owner-only record (`personalOwner`, a member; not with a
  folder) directly in a state the initial one may move to (`state`), and stay quiet (`quiet`).

## Tests

`server/tests/unit/inbox.test.ts` (owner-only and unreadable / unlisted / untold for CC, other
members, owner, admin; CC / several To / shared address / internal / free mail / bulk per
setting; once per id; no body stored; thread continuation, automatic reply, a reply to another
member; member reply per setting and never naming a non-reader; judgement: due from the 目安 past
a holiday or the stated deadline, owner-only reply request, only the owner's AI, a person's
「やることにする」 wins; B4: the thread read through the role by the owner alone with nothing kept,
the role's failures said, a reply request reads its message, a task counts only when it names the
message, 名寄せ at judgement, the member's reply discards drafts / handles an unjudged message /
stops a reply request being made, a Slack DM's unthreaded reply within 3 days, 「もう返した」 is
the person's; polling: first connection, 7-day read-back, the gap shown to its member
only, `not-connected` keeps the window, no role → nothing; companies apart),
`server/tests/unit/intake-core.test.ts` (settings validation and defaults, routing order, the
window's 7 / 8 days, the versions additive, only `reply_request` lets the AI end it), permission
matrix rows (lane B) + `CROSS`, `company-scoped-sql.test.ts`, `admin-contract.test.ts`.

## Not yet

- Wired: `roles` = lane A's `connectorRoles`; Slack's signals (`connectorsLane.onSlackSignal`)
  become chat messages through `slackSignalMessage` (`composition/inbox.ts`: ids
  `<channel>:<ts>`, the thread root as reference, no text). Not yet: an `InboxSource` over lane
  A's `mailReader` (it lists header facts newest first; the inbox needs Message-ID / References
  and `outgoing`), the server clock calling `inbox.pollCompany`, and `connect` on a grant.
- 「今後も無視」 per sender, 引き受ける notices to the department, handing an unsure message to
  another To member (moves `personal_owner`), the app's screens (A4), follow-up (B5).
- The reply's draft is text in `prep_summary` until A4's reply draft (`outbound_message` v4,
  replying to the interaction, with the sender as a recipient source) lands; the step then names
  A4's draft tools instead. The chat thread read waits for A4's `ChatReader` (one line in
  `composition.ts`: `chatReader`). 「もう返した」 by the engine does not discard a prepared draft
  yet (the member's reply seen by the inbox does).
- Sent-mail receipts (`outbound-mail.ts`) still start in `received`, now an AI-turn state with no
  assignee (nobody's turn); A4 may create them `handled`.
