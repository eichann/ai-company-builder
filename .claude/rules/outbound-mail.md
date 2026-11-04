---
paths:
  - "shared/core/mail.ts"
  - "shared/types/outbound-mail.ts"
  - "server/src/services/outbound-mail.ts"
  - "server/src/routes/outbound-mail.ts"
  - "server/src/ports/outbound-mail.ts"
  - "server/src/adapters/sqlite/outbound-mail.ts"
  - "server/src/lib/mail-message.ts"
  - "server/src/lib/mail-body-retention.ts"
  - "server/tests/integration/outbound-mail.test.ts"
  - "server/tests/unit/mail-message.test.ts"
  - "client/shared/outbound-mail.ts"
  - "client/electron/features/outbound-mail/**"
  - "client/src/features/chat/components/MailDraftCard.tsx"
  - "client/tests/outbound-mail-tools.test.ts"
  - "client/tests/mail-draft-card-ui.*"
  - "client/tests/ui/mail-draft-card.spec.ts"
  - "server/src/services/threads.ts"
  - "server/src/routes/threads.ts"
  - "shared/types/threads.ts"
  - "server/src/ports/chat.ts"
  - "server/tests/integration/threads.test.ts"
  - "client/shared/threads.ts"
  - "client/electron/features/threads/**"
  - "client/src/features/threads/**"
  - "client/src/app/recordSource.tsx"
  - "client/tests/threads-ipc.test.ts"
  - "client/tests/record-thread-ui.*"
  - "client/tests/ui/record-thread.spec.ts"
---

# Outbound mail (milestone 4 G8: お礼メールを確かめて送る; the type is 「送るもの」)

The member's AI drafts a mail in the consultation; the app draws the draft as a card; the member
presses 「確かめて送る」, sees everything once more and sends it from their own Gmail. Design 節目4
§1-6, §3-5, §3-7, §4-2 … §4-5, §5-2 (`gmail.send` only), §9 q8 / q9, §11 (no reader AI: the
consultation AI drafts through a tool). Sending reaches outside and cannot be undone, so the
server is the gate: **only a person's session sends, only the version shown, only to addresses
still at their source**.

## Verified recipients (`services/outbound-mail.ts` `collect`)

A draft is about a meeting record (`meetingId`) and/or a まとまり (`bundleId`: a record of any type
implementing `bundle`, e.g. a 案件) the member may read (a meeting's `bundle` link is taken along).
The core names no business type (records.md "Core interfaces"). Its recipients come only from,
read fresh on every call:

| source | where | label |
|---|---|---|
| `calendar` | the meeting's attendees outside the company's domain (`minutes.meetingAttendees`, the minutes' calendar event re-read from Google with the member's own permission — only for the minutes' assignee or an attendee, `minutes.md`; internal = the Google client's domain + the author's) | カレンダーの参加者 |
| `hubspot` | the まとまり's contacts in its outside system: the connector's declared `get` of the linked object with `associations=contacts`, then each contact's `get` (`plugin-import.ts` `recordContacts`; object `contact` in the declaration, HubSpot's `email` / `firstname` / `lastname`). Only for a deal the member may read, imported through the current connection, by a member in the connection's read scope (`plugins.readAllowed`). Nothing is stored | HubSpot の連絡先 |
| `member` | the company's members (for CC), the author left out | ACB のメンバー |
| `typed` | an address a **person** typed for this draft (`POST …/recipients`, session only; `normalizeEmail`, a name without line breaks or `<>"`) | あなたが入力 |

Each is offered as a `ref` = `r` + 24 hex of sha256(author | minutes | deal | source | address)
(`typed|<draft>` for typed ones): stable for the draft's context, meaningless elsewhere. A draft
names recipients by ref only; a ref resolves only to an address a source offers now (or one already
in the current version, for an edit that keeps it). The AI's tools take refs only (the schema
refuses an address field), so **an address the AI wrote is never offered** (400
`RECIPIENT_NOT_OFFERED`). A source that cannot be read is reported (`unreadable`) and offers
nothing. 「この宛先に送るのは初めてです」 = an external address whose domain no earlier *sent* mail
of the company went to (`outbound.sentDomains()`).

## Drafts and versions

- Record `outbound_message` (「送るもの」, version 5; server only, `records.md`), created / changed
  only through the service writer; folder = the まとまり's (else the meeting's, the 連絡's, the
  task's) folder — but an owner-only or members-only 連絡 / meeting / task keeps its own place
  whatever the まとまり (`placeOf` → `placeOfRow`, `records.md` "Members-only records");
  `requested_by` / `assignee` = the author; fields `subject`, `payload_hash`, `payload_version`,
  `channel: email` | `slack` (one type for every channel; Slack replies: "Replies" below),
  `slack_thread`, `expects_reply`, `reply_wait_until` ("Waiting for their answer"); links
  `bundle`, `meeting`, `interaction` (the 連絡 it answers), `task`. The outbound
  tables keep their column names `minutes_id` / `deal_id` (the port calls them `meetingId` /
  `bundleId`).
- Every change is a new version: the canonical content (`mailContentCanonical` — From = the
  member's ACB email, which G3 requires the Google account to be; To / CC addresses, subject,
  body; NFC, `\n`; nothing trimmed) in `fixed_payloads` (owner kind `outbound_message`,
  `services/fixed-payloads.ts` `fix`, its hash), its recipients (ref, address, name, source) in
  `outbound_mail_versions`, the record's fields — in one transaction (all or nothing).
  `mailContentProblems` decides what is refused (400 `MAIL_INVALID` + `problems`). Plain text, no
  attachments.
- Only the author sees or changes a draft: anyone else, another company's id or a missing one
  answer the same 404 `MAIL_NOT_FOUND`. A stale `expectedVersion` → 409 `VERSION_CONFLICT`.

## Sending (`POST /outbound/:id/send { hash }`, a person's session only)

In this order, nothing sent unless all pass:
1. records on, the author's own draft, state `draft` (else 409 `NOT_DRAFT`);
2. the hash equals the current version's (record and fixed payload), else 409 `CONTENT_CHANGED`
   「内容が変わりました。もう一度確かめてください。」 with the current draft;
3. through the role メールを送る (`MailSender.senderAccount`, `connector-roles.md`): the member's
   Google grant is active with `gmail.send` and メールを送る not turned off (409
   `GOOGLE_FEATURE_OFF` `feature: mail`; no usable connector → 503 `GOOGLE_UNAVAILABLE`
   `no-connector`) (else 409 `GOOGLE_CONSENT_NEEDED`,
   `needsGoogleConsent: 'mail'` — the card offers 「メールを送る許可」 = G3's
   `google:connect(['mail'])`), and its account is the draft's From (else 409 `FROM_CHANGED`);
4. every recipient is still at its source right now (only the sources the version uses are
   read): unreadable → 409 `RECIPIENTS_UNVERIFIABLE` 「…確かめられないため送れません…」;
   gone → 409 `RECIPIENT_GONE` + `goneRefs`;
5. the send row (`outbound_sends`, outcome `sending`) is written **before** Gmail is called — at
   most one live send per draft (`startSend`), else 409 `SEND_IN_PROGRESS`;
6. the RFC 2822 message (`lib/mail-message.ts`: UTF-8, RFC 2047 subject words ≤ 60 characters,
   base64 body, From = the version's, To / Cc from the version; it throws on anything that is not
   one plain address or a subject with a control character — no header injection) →
   `googleClient.request` Gmail `POST /gmail/v1/users/me/messages/send { raw }`, **never retried**
   (G3: writes are not retried; every Google switch is checked there: operator stop, company
   client off, vault, membership, grant, scope);
7. 2xx → record `sent` (`sent_at`, `provider_message_id` = Gmail's id), the retention clock starts,
   and an `interaction` (やりとり) on the まとまり (`SERVICE_RECEIPT_TYPES`: channel `email`, title /
   summary = subject, `counterpart_text` = recipient **domains** only, `source_ref` `gmail:<id>`,
   folder = the まとまり's; links `bundle` and, when the まとまり links a 相手, `counterpart`). 4xx / 429 / not sent → stays `draft` (409 `SEND_REFUSED` / 503
   `GOOGLE_UNAVAILABLE`). A lost answer or a 5xx → `unknown`
   「届いたか分かりません。Gmail の送信済みを確かめてください。」; ACB does not look in Gmail's sent mail (受信を読む
   reads the inbox only, and only for a member who allowed it), so the person answers `POST …/resolve { sent }`: true → `sent`, false →
   `draft` (sending again is a new 「確かめて送る」).

The AI emergency stop does not block a person's send (design §4-5); the Google stops do. It
does stop the AI's drafting: every record token is refused while the company's AI is stopped
(403 `ACB_STOPPED`, `records.md`).
`POST …/discard` (draft / unknown → `discarded`) is the person's too.

## Replies into the same thread (stage 3 A4)

A 来た連絡 (`interaction`, `inbox.md`) is answered where it came from, and its thread is shown on
the card without the server keeping it.

- **元のスレッド** (`services/threads.ts`, `routes/threads.ts`, contract `shared/types/threads.ts`):
  `GET /api/companies/:companyId/threads/:recordId` (session, `companyMember`) for an interaction
  or a record linking one (`interaction` link: a 返事のお願い, a task). The member must read the
  record **and** the 連絡 (`recordReader`; an owner-only 連絡 is its owner's — another member, the
  company's owner / admins: the same 404 `THREAD_NOT_FOUND` as a missing record). The pointer is
  the 連絡's `thread_ref` (`gmail:<thread id>`, `slack:<channel>:<thread ts>`), else its
  `source_ref` (`threadPointerOf`). Read now with the **viewer's own** permission through the
  roles: `MailReader.getThread` (Gmail `users.threads.get`, the newest 20, 8,000 characters each)
  or `ChatReader.thread` (`ports/chat.ts`; Slack `conversations.replies` with the member's token,
  `slack-connector.md`; its text plain — mentions as `@name` — and drawn as text with only
  `*bold*` bold). Not readable → `unavailable { reason, text, allow }` (`not-connected` /
  `turned-off` say where to allow it). Also lists the member's own reply drafts to the 連絡.
  **Nothing of a thread is stored or logged** (test: marked texts in no table, no log line).
- **A reply draft**: `POST /outbound { interactionId, … }` (session or the AI's token). The
  interaction must be readable; its まとまり is taken along; link `interaction`. Place: an
  owner-only / members-only 連絡's reply keeps that place, else the まとまり's / meeting's / 連絡's
  folder. No thread pointer → 409 `THREAD_UNKNOWN`.
  - Mail: recipients from the thread (source `thread` 「スレッドの相手」: From / To / CC of its
    messages in the member's own mailbox, the member left out; re-read before sending like every
    source); the reply headers are fixed with the draft (`MailReplyHeaders` in the canonical
    content, so the hash covers them): Gmail `threadId`, `In-Reply-To` = the thread's newest
    Message-ID, `References` (≤ 20, each `MESSAGE_ID_RE`; `lib/mail-message.ts` throws on
    anything else). Thread unreadable at drafting → 409 `THREAD_UNREADABLE`. A draft made before
    replies keeps its canonical text (no `reply` key).
  - Slack (`channel: slack`): body only (≤ 4,000), no recipients (400 if any), no subject; the
    thread (`slack_thread`, `chatReplyCanonical`) fixed with it.
- **Sending** is the same person's 「確かめて送る」 (hash, send row first, never retried, `unknown`
  → 送られていた／送られていなかった). Mail: `MailSender.send(…, { threadId })`, our own
  Message-ID `<acb.<send id>@<domain>>`. Slack: `ChatSender.replierAccount` (返事を送る granted and
  on, else 409 `SLACK_CONSENT_NEEDED` `needsSlackConsent: 'reply'` / `SLACK_FEATURE_OFF`; none →
  503 `SLACK_UNAVAILABLE`), the account still the draft's From (`FROM_CHANGED`), then one
  `chat.postMessage` with `thread_ts` as the member; `provider_message_id` = its ts.
- After a reply leaves, **no new やりとり** (one per thread): `outboundMail.onReplySent` hands the
  inbox the company's own message in that thread (`replyAsIncoming`, `composition/connectors.ts`;
  `outgoing`, references = the 連絡's own message id), which moves its 返事のお願い as for any
  reply of ours (`inbox.md` "The thread went on").
- **The app**: the task card's source slot (`src/app/recordSource.tsx`, lane A) draws
  `RecordThreadPanel` (`src/features/threads/`) for an `interaction`, `reply_request` or `task`:
  `threads:get` (main, `electron/features/threads/ipc.ts`: the session stays in main; anything
  but a record id never leaves; the server's 404 → `none`, the panel draws nothing) — the thread
  (who wrote what, the member's own marked 「あなた」) or why it cannot be read, then each reply
  draft through the mail card (`PreparedMailCard`). The card draws a Slack draft as body only
  (「元の Slack のスレッドに、あなたとして返します。」; editing changes the body only; no recipients
  or subject). The AI's `mail_recipients` / `mail_draft_create` take `interactionId` (`toRefs`
  and `subject` only for a mail).
- **The member's AI** reads the same thread with its record token: `GET /api/records-ai/threads/:recordId`
  (`aiReads`; a read token is enough), the same rules (the member reads the record and its 連絡; the
  same 404). Inside a business plugin step's run the role is asked first (`connectorRoleRefusal`:
  `mail.read` / `chat.receive` by the 連絡's channel); a step that does not declare it → 403
  `NOT_IN_STEP` and nothing is read. The inbox's AI turns (B4) and follow-up (B5) read threads here.

Tests: `server/tests/integration/threads.test.ts` (fake Google + fake Slack: owner-only, the
switch, the Gmail thread / headers / recipients, the Slack thread_ts and 返事を送る off, nothing
stored or logged), `server/tests/unit/mail-message.test.ts` (reply headers, injection, old hashes,
v4 additive), permission matrix + `CROSS`; `client/tests/threads-ipc.test.ts` (ids, the 404 shows
nothing), `client/tests/ui/record-thread.spec.ts` (the thread, a Slack reply body-only, confirm
then the hash shown, an unseen 連絡 shows nothing).

## Waiting for their answer (「返事を待つ」, owner decision 2026-11-03 「①」)

A new mail **we send first** (not a reply to a 連絡, not Slack: `offersAwait`) may wait for the
other side's answer; from then on the inbox's usual machinery (`inbox.md` "The thread went on",
"Following up") catches their reply or their silence. Nothing is sent by itself; the server runs
no AI.

- **The AI's mark**: `mail_draft_create` / `mail_draft_update` take `expectsReply` (field
  `expects_reply`, outbound_message v5; a non-boolean → 400; ignored for a reply). Absent = no:
  drafts of older apps / from before are unticked. `taskId` (a やること the member reads; its まとまり
  is taken along, link `task`) names the task the mail is for (the consultation's task); a task
  whose `prepared` links the draft counts too (`taskOf`).
- **The view** (`awaitReply`, only where offered): `expected` (the mark), `defaultUntil` = the
  3rd business day after now (`shared/core/mail.ts` `awaitReplyDefault`: weekends, Japanese
  holidays, the company's own `companyHolidays`), `chosenUntil` (the day chosen at the send, else
  null). An older server sends no `awaitReply`: the card offers nothing.
- **The card** (`MailDraftCard`, confirm step only): 「返事を待つ（来なければ 〇月〇日（〇）の朝に知らせる）」,
  pre-ticked from `expected`, and 「知らせる日」 (a date input, today at the earliest; a stored card's
  default already past → the member picks). After the send: 「相手の返事を待っています（…）」.
- **The send**: `POST …/send { hash, awaitReply?: { until } }` (IPC `outboundMail:send`'s 4th
  argument; main lets only `{ until: YYYY-MM-DD }` leave). Checked with the body, before
  anything leaves: not offered → 400 `AWAIT_REPLY_NOT_OFFERED`; not a day, before today, more than
  180 days ahead → 400 `AWAIT_REPLY_DATE`. A send that fails waits for nothing. `{ hash }` alone
  (released apps) waits for nothing, as before.
- **After a confirmed send** (or `unknown` → 「送られていた」: the day is kept on the record as
  `reply_wait_until` at `send_unknown`, cleared by 「送られていなかった」): the sent mail's
  `interaction` additionally keeps our Message-ID (`message_id`, `<acb.<send id>@<domain>>`) and
  the Gmail thread (`thread_ref`), is placed like the mail record (not only the まとまり's folder; a
  sent mail without 「返事を待つ」 too when its record is owner-only or members-only — never wider
  than the mail; no record → no receipt),
  is the sender's (`assignee`) and starts `handled` (nobody's turn). Then
  `outboundMail.onAwaitingReply` → `inbox.awaitOwnMessage` (`composition.ts`): our message is
  registered in that interaction's thread (`inbox_messages`, direction out) and a 返事のお願い is made
  straight in 返事待ち: assignee / requester = the sender, `wait_until` = the picked day
  `T09:00` (`awaitReplyWaitUntil`), `waiting_on` 「〇〇さんからの返事」 (the first To's name, else
  「<domain> の方からの返事」: no address on a shared record), a fixed `end_condition`, placed
  like the interaction, links `interaction`, `bundle`, `counterpart` (the まとまり's, else 名寄せ of
  the first To), `task` (reply_request v4, origin; only a task the sender reads).
- **The task** (choice for 「③」): the task is **not** put into 返事待ち (a task's own wait has its
  own clock and follow-up step — two clocks would nudge twice — and the task may be someone
  else's or in a state without `wait`). The 返事のお願い links it: the task card's
  「つながっているもの」 shows it (the inverse link), and when their reply moves it to `checking` the
  task's assignee is told too (`reply_arrived`, only when they can read the 返事のお願い).
- Slack: there is no way to start a Slack message (only replies in a thread), so nothing here.

Tests: `server/tests/integration/outbound-mail.test.ts` 「返事を待つ」 (pre-ticked / unticked
offer, a bad day refused with nothing sent, a failed send waits for nothing, unticked → nothing,
ticked → the 返事のお願い with the day and the task, their reply → checking, `unknown` → 送られていた
starts it), `server/tests/unit/inbox.test.ts` 「we sent first」 (placement, task link only when
readable, the task's assignee told only when a reader, automatic reply ignored, the clock never
before the morning, then follow_up), `server/tests/unit/mail-message.test.ts` (the default day,
the day's range, v5 / v4 additive), `client/tests/outbound-mail-tools.test.ts` (only a day leaves
main, a stored card keeps the offer), `client/tests/ui/mail-draft-card.spec.ts` (unticked old
draft sends nothing to wait for; pre-ticked, the day changed, the send carries it).

## Retention (§9 q9)

`cleanupBodies` at startup + every 24 h (`lib/mail-body-retention.ts`, one run per server, each
company through its handle): a mail `sent` or `discarded` more than 30 days ago loses its body —
the fixed payloads' canonical text (`clearBodies`); the hash, recipients, subject, Gmail id, state
and ledger stay. The view says `bodyDeleted`.

## Routes (contract `shared/types/outbound-mail.ts`)

```
/api/companies/:companyId (session)        /api/records-ai (record token)
POST /outbound-recipients                  POST /outbound-recipients   (read; mail_recipients)
POST /outbound                             POST /outbound              (act; mail_draft_create)
GET|PUT /outbound/:messageId               GET /outbound/:messageId (read; mail_draft_show), PUT (act; mail_draft_update)
GET|POST /outbound/:messageId/recipients   —
POST /outbound/:messageId/send             —   (no route: the AI cannot send; { hash, awaitReply? })
POST /outbound/:messageId/resolve          —
POST /outbound/:messageId/discard          —
```

`/outbound-recipients`, not `/outbound/recipients`: a static segment next to `:messageId` makes
Hono change routers (`records.md`). Permission matrix rows + `CROSS` for every `:messageId` route.

## The app

- Tools on `acb_records` (where the type `outbound_message` exists): `mail_recipients` and
  `mail_draft_show` (read, Codex too) and, with an act token, `mail_draft_create` /
  `mail_draft_update`; there is no send tool. The AI is told the draft is NOT sent
  (`aiMailSummary`, `RECORDS_INSTRUCTIONS`).
- `mail_draft_show { id }` changes nothing: it reads the member's own draft (the same 404 for
  anyone else's) and adds a **new** card with its current version and state at this point of the
  consultation — a sent / discarded mail shows in that state, without 「確かめて送る」. Earlier cards
  stay as they were. The tool descriptions and `RECORDS_INSTRUCTIONS` tell the AI to use it to
  point the member at an earlier draft and never to edit content just to get a new card (seen in
  verification: the AI changed a subject only to re-show a draft far up a long consultation);
  `mail_draft_update` is for changes the member asked for.
- A draft becomes the data part `data-mail-draft` (`MailDraftCard`, stored with the message as
  `mailDrafts`), drawn by `src/features/chat/components/MailDraftCard.tsx`: From, To / CC with
  each source's label, subject, the **whole** body, 「本文にリンクが N つあります」,
  「この宛先に送るのは初めてです」, 直す (a new version), 「確かめて送る」 → a confirm step showing
  everything again with 「中身が変わっていないことを確かめて送ります」 → send with the hash shown;
  states sent / unknown (送られていた／送られていなかった) / discarded. No ハッシュ / OAuth on screen.
- The same card shows a task's draft in the task card's 「AI が用意したもの」
  (`PreparedMailCard.tsx`: `outboundMail:get` reads the latest version, so a draft is checked and
  sent from the task without going back to the consultation; `tasks-ui.md` "The card").
- IPC (main, the session stays there): `outboundMail:get`, `:recipients`, `:update`,
  `:addRecipient`, `:send`, `:resolve`, `:discard` (`client/electron/features/outbound-mail/ipc.ts`;
  ids and hashes checked before anything leaves).

## Logs

Never a subject, body or address: ids and fixed words only (`logError`). Test: the integration
test greps every log line.

## Tests (each guard mutation-checked)

`server/tests/integration/outbound-mail.test.ts` against the fake Google and fake HubSpot: an AI
token reaches no send / resolve / discard / typed path and the session routes refuse it; an
address not from a source (or as a ref) refused; old / malformed hash → nothing sent; no consent
→ `needsGoogleConsent`; header injection through subject or a typed address refused; another
company's / member's draft → the same 404, nothing changed; an attendee removed from the calendar
→ not sent; HubSpot unreadable → not sent; the send (From, To, Cc, subject, body as written; the
interaction with domains only); a lost answer → `unknown`, exactly one mail, no resend, resolve;
no token in any answer, log or table, no content in logs; retention with a fake clock.
`server/tests/unit/mail-message.test.ts` (encoding, no header injection).
`client/tests/outbound-mail-tools.test.ts` (tools, refs only, token not session, the card stored,
showing a draft again = a GET only and a new card,
the send with the session and the shown hash). `client/tests/ui/mail-draft-card.spec.ts` (sources
shown, confirm step, the shown hash sent). Permission matrix + `CROSS`, `company-scoped-sql.test.ts`.
