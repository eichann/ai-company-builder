---
paths:
  - "server/src/services/minutes.ts"
  - "server/src/services/google-meetings.ts"
  - "server/src/routes/minutes.ts"
  - "server/src/services/meeting-outputs.ts"
  - "shared/core/meeting-outputs.ts"
  - "shared/types/meeting-outputs.ts"
  - "admin/src/app/companies/[[]id]/task-list/meeting-duplicates.tsx"
  - "server/tests/integration/minutes.test.ts"
  - "shared/types/minutes.ts"
  - "shared/core/minutes.ts"
  - "shared/core/instruction-like.ts"
  - "admin/src/app/companies/[[]id]/integrations/minutes-folder.tsx"
  - "client/electron/features/minutes/**"
  - "client/src/features/minutes/**"
  - "client/shared/minutes-app.ts"
  - "client/src/features/chat/components/MinutesBundleChoiceCard.tsx"
  - "client/tests/minutes-app.test.ts"
  - "client/tests/ui/minutes.spec.ts"
---

# Minutes intake (milestone 4 G7)

After a meeting, Google Meet saves notes (Gemini) and a transcript in the organizer's Drive.
ACB notices them when the member's app asks, keeps a `meeting` record (会議, server only, no text —
the 議事録 is the meeting's content, read where it is; the type was called `minutes` before the
core interfaces, records.md "Core interfaces"), and hands the text — marked as outside text — to
the member's normal consultation AI, which makes the outputs with the typed tools.
Meetings stay their own type (not an `interaction`); the "AI reads what arrived and turns it into
tasks / decisions" pipeline (the AI turn, `minutes_read`-style outside text, the まとまり choice) is
what stage 3's mail / Slack intake reuses. Design: 節目4 §1-2, §3-1, §3-7, §9 q5/q14/q15 and the owner's
§11: **no separate tool-less reader AI**; the safety is in the server's gates (approval for prior
fields, a person presses send, fields that are off stay off), not in AI-side extra layers. Google
access itself: `google-connector.md` (G3).

## Flow

1. **Discovery** — `POST /api/companies/:id/me/minutes/check` (session). The app calls it at
   start, every 10 minutes and on a button (q5: no server timer; a closed app finds them next
   time). Only the member's **own** grant is used (`googleClient.request`, so every Google switch
   applies from the next call). Steps (`services/minutes.ts` `check`, Google calls in
   `services/google-meetings.ts`, reached through the role 会議の記録を読む — `ports/meeting-records.ts`,
   `connector-roles.md`; no usable connector → `GOOGLE_STOPPED`, 予定と議事録を読む turned off by the
   member → `GOOGLE_NOT_CONNECTED` with its own sentence):
   - calendar events of the last 3 days → now (`singleEvents`, by start time, ≤ 4 pages);
   - keep events with a Meet conference (`conferenceData` `hangoutsMeet`) that **the company's
     setting reads** ("Which meetings" below; default: at least one attendee outside the company's
     Google domain — the G3 client's `domain`, `isExternalAddress`). A meeting the setting does not
     read is never read further — not even its Meet record (design §1-2; HR meetings and the like);
   - the conference record by meeting code near the event's time; its smart notes and transcripts
     with `FILE_GENERATED` and `docsDestination.document`; each document's Drive `version`;
   - one record per **conference**: id `meeting-<sha256("minutes:" + conference id)[:24]>`, so two
     members (or two calls at once) make one record (`exists` → counted `existing`); a record made
     before the rename keeps its `minutes-<same hash>` id and counts as existing;
   - assignee (q15): the organizer when they are a member who can read the minutes folder, else
     the member who found it; attendees = members whose ACB email is on the event.
   Answer `MinutesCheckResult`: `{ checked, reason?, message?, meetings, internalOnly, created:
   [ids], existing, waiting, stale: [ids] }` — counts and ids only, never text. `stale`: the
   member's own records in `reading` for > 30 minutes, which the check itself puts back to
   `received` (the type's `retry` through the service writer, actor the server clock
   `CLOCK_ACTOR`: ledger cause `system`, never the member); an older app's `retry` on them finds
   nothing to do.
2. **まとまり** (mechanical, design §1-2 step 3; whatever its type — the core names no business
   type): unfinished records of any type implementing `bundle` (a 案件, a 企画…) readable by the
   assignee that link to a 相手 (a record of a type implementing `counterpart`) whose `domain` is an
   outside attendee's domain; when several, those whose title appears in the meeting title (or the
   reverse) if any. With no domain match, title matches only. **Exactly one** → linked (`bundle`,
   and that まとまり's 相手 as `counterpart`); 0 or ≥ 2 → not linked; `candidates` (with each
   one's `typeLabel`) in the text answer; a person or their AI chooses with
   `POST …/minutes/…/bundle { bundleId, expectedVersion? }` (assignee or owner/admin; only a
   まとまり the member reads — anything else, missing or unreadable, one 400 `BAD_LINK`; the service
   writer's `links`, ledger `link_bundle`). Nothing is written to the outside system by this.
3. **Reading** — the AI (tool `minutes_read`) or the app reads the text (below), runs
   `meeting__start_reading`, makes the outputs with the existing tools (`records_create` task —
   assignee = attending member ids, due within a year —, `decisions_record` linking meeting /
   bundle, the mail draft (G8)), each citing the minutes text it rests on, then
   `meeting__finish_reading` with a ≤ 300-character summary. Those three actions are `who: [ai]`
   (「AI の番」); `retry` / `skip` are the assignee's / an admin's. The optional server quote
   check (`quoteAppearsIn`) is not wired (owner §11: optional).

### A まとまり chosen later (meeting version 4, owner FB 20, 2026-11-02)

**What a まとまり gets from a meeting is not the core's** (coordinator decision 2026-11-02; the core
names no business operation): the reading has no business plugin's tool, and the server refuses a
core step's run any business plugin operation but a read (`plugin-operation-checks.ts`). When the
meeting becomes `read` (`finish_reading`) the server moves its まとまり to the business plugin's
`ai_turn` step for it (`plugin-steps.md` "After a meeting is read", e.g. 「会議を案件に反映する」:
the deal's fields and the meeting log), which runs as its own AI turn.

Read without a まとまり, the AI leaves the まとまり's part. When a person (or their AI) then chooses
one — by hand, the one-click suggestion, or an approval's 「同じ」 — `POST …/minutes/…/bundle` on a
`read` meeting that had **no** `bundle` link only links it (ledger `link_bundle`,
`MEETING_BUNDLE_LINKED_ACTION`): **the meeting stays `read` and no AI run is made** (FB 20: version
3's run for the まとまり's part only confirmed and finished, a wasted run cluttering consultations).
The minutes service then tells the engine's after-action reaction (`afterAction`, the same seam as
`finish_reading`), so the まとまり moves to the plugin's step exactly as after a reading. **Once**:
choosing again when a まとまり was already linked, or linking before the reading (its
`finish_reading` moves it), changes only the link. A failure of the move never changes the answer.

Version 3's `bundle_waiting` / `bundle_working` and their five actions (`start_` / `finish_` /
`fail_` / `retry_` / `skip_bundle_work`) are gone: a meeting left there goes back to `read` at
startup (`migrateBundleParts`, ledger `end_bundle_part` = `BUNDLE_PART_ENDED_ACTION` by the
server's migration actor, cause `system`). An older app's AI calling one of those actions gets 404
`ACTION_NOT_FOUND`, and its claim of step `minutes-bundle` 409 `NOT_AI_TURN`; an older app's link
is the same request and gets the new behaviour. Test: `server/tests/integration/minutes.test.ts`
「read without a まとまり, one chosen afterwards…」 (read, no run, old actions refused),
`plugin-steps.test.ts` 「the まとまり chosen later by a person…」 (the deal at after_meeting, its step
in the turns, once), `server/tests/unit/meeting-bundle-parts.test.ts` (the migration).

## Outputs made once (owner FB 29, 2026-11-02)

Reading a meeting again (「もう一度読む」, a retry, a rerun) made the same task five times. **What a
meeting's reading makes is made once per meeting and item, decided by the server**
(`services/meeting-outputs.ts`, `shared/core/meeting-outputs.ts`):

- **Task** (`POST /records/item`, `records_create`, any type with a `meeting` link to a meeting):
  optional `key` (≤ 200, one line, the AI's item mark `task:1`; only with `links.meeting`, else 400
  `KEY_NEEDS_MEETING`). With a key the id is derived from meeting + type + key (`meetingOutputId`), so
  the same key never makes a second record (one the member cannot read → 409 `KEY_TAKEN`, never
  named). Without a key, or a different one, a record of the same type linked to the same meeting
  whose title is the same after `outputTitleKey` (NFKC, A–Z folded, no spaces / brackets /
  punctuation) is the same item. Found → 200 `{ record, entry: null, reused: true, note }`, nothing
  written; otherwise 201 as before.
- **Decision** (`decisions_record`): with a meeting link the key is the meeting's
  (`<meeting id>:<key>` unless it starts with it), so another meeting's `1` is never this one; the
  same title of the same meeting is the same item too (200 `created: false, reused: true, note`).
- **Mail draft** (`mail_draft_create` / `POST /outbound` with `meetingId`, not a reply): the member's
  own draft of that meeting with the same subject (title key), not discarded (sent included), is
  the answer (200 `reused`); the tool tells the AI (`MEETING_OUTPUT_REUSED_NOTE`).
- Only records the member reads count; other meetings never match. Look-up and write are one
  synchronous stretch (the mail's after its awaits), so two calls at once make one. The minutes
  first message asks for `links.meeting` + `key` on each output and says what `reused` means.
- **Made twice before** (maintenance, owner/admin): `GET /records/meeting-duplicates` → groups of
  the same meeting, type and title key with two or more live records (`keep` = the oldest; cancelled
  / retracted / discarded left out); `POST /records/meeting-duplicates/merge { keepId, duplicateIds }`
  (one listed group only, else 400 `NOT_DUPLICATES`) cancels each task / retracts each decision
  through the engine as that admin, note 「同じ会議から重複して作られたため、こちらは使いません。残したもの：…（id）」
  — nothing is deleted; a mail draft is listed only (`mergeable: false`, its author discards it).
  Admin console: 「やることの一覧」→「同じ会議から重複して作られたもの」 (`meeting-duplicates.tsx`).
- Test: `server/tests/integration/minutes.test.ts` 「made once (FB 29)」 (a second reading reuses by key
  and by reworded title; a different item is made; another meeting is unaffected; decisions; the
  duplicates list and merge), `outbound-mail.test.ts` 「the meeting's mail is made once」,
  `client/tests/outbound-mail-tools.test.ts` (the AI told), `minutes-app.test.ts` (the first message).

## The AI's proposals and 「議事録を確認する」 (owner decision 2026-11-02, plan F)

- **Proposals (案)**: the homework the AI makes while reading (`records_create` with
  `links.meeting`) starts as a proposal when the company's 「会議から AI が作るやること」 is
  「案として出す」 (default; `tasks.md` `meetingTasks`), as a task at once when 「自動で作る」.
  A proposal is nobody's turn; a person adds it (`adopt`) or puts it away (`dismiss`, kept,
  `propose_again` brings it back) — records.md "Task version 11". The first message tells the AI
  to leave proposals as they are.
- **The review task** (`services/minutes-review.ts`, wired as the engine's `afterAct`): when a
  meeting becomes `read` — internal or external — its assignee gets one task
  「議事録を確認する：<meeting title>」 (`task_kind: minutes_review`; requested_by = assignee, so
  it is their own; the meeting's folder; `meeting` link = its origin). Its id is derived from the
  meeting (`meetingOutputId`, key `MINUTES_REVIEW_KEY`): never two, also for a second reading or
  two at once. Ledger actor `MINUTES_ACTOR` (`acb:minutes`, cause system). Nothing completes it by
  itself — handling every proposal leaves it open; the assignee completes it. A meeting without an
  assignee gets none; a failure is logged and never changes the reading.
- The app: `tasks:proposals (companyId, meetingId)` lists the meeting's proposals (proposed and put
  away, `TaskProposal`); 足す / 要らない / 案に戻す are `tasks:act` with `adopt` / `dismiss` /
  `propose_again`.
- Test: `server/tests/unit/meeting-proposals.test.ts`; `minutes.test.ts`'s output counts leave the
  review task out.

## The text

`GET /api/records-ai/minutes/:recordId/text` (record token, read or act) and the session twin
`GET /api/companies/:id/me/minutes/item/:recordId/text` → `MinutesText`: `{ recordId, version (the
meeting record's version now: the `expectedVersion` of its next action — an unattended run has no
`records_get`), header:
MINUTES_TEXT_HEADER, text, footer, truncated, docVersion, meeting: { title, at }, folder (the minutes folder: where its decisions go), attendees:
[{ memberId, displayName }], externalAttendees (count only), bundle: { id, type, typeLabel, title,
state, fields, version } | null, candidates: [{ id, title, typeLabel }], instructionLike: [{ label, words }] }`.

- Only for a meeting record the member may read (else the same 404 as a missing record — another
  company's id included) **and** where the member is the assignee or an attendee (else 403
  `MINUTES_NOT_YOURS`).
- Read **now** from Google with the requesting member's own grant: notes first, then the
  transcript, under 「■ 会議メモ」/「■ 文字起こし」; BOM removed, CRLF → LF, NFC; at most
  `MINUTES_TEXT_MAX` characters with a notice. No grant / no access → a clear refusal.
- `instructionLike`: `findInstructionLikeText` (`shared/core/instruction-like.ts`, the same copy
  「Web で調べる」 uses; it also flags a line addressed to an AI, 「AI へ：…」). A flag, nothing
  removed. The app's tool puts the header above and the footer below the text, then the
  warning and the structured parts (`minutesReadText`, `client/electron/records/tools.ts`).
- `Cache-Control: no-store`.

## What is stored, and what never

Stored (the record, server only, folder = the minutes folder): title = the event's title, fields
`meeting_at` and `occurred_at` (the same start time; `occurred_at` is the common outside time,
`records.md` "Outside time"), `assignee`, `attendees` (JSON of member ids, ≤ 500 characters), `external_count`,
`source_ref` (JSON of Google ids only: conference, event, documents), `doc_version`
(`notes:7,transcript:7`), `summary_text` (the AI's ≤ 300 at the end); links `bundle`, `counterpart`.
Ledger actor of the creation: external `google` (note: which member's calendar).
**Never** stored, logged or answered elsewhere: the notes / transcript text, attendees' email
addresses and names (they are read again from the calendar when needed), Google's tokens.
Log nothing about meetings (titles, emails, text): `logError` only, without them.

## The minutes folder (q14)

`GET|PUT /api/companies/:id/google/minutes-folder { folder: string | null }` (owner/admin;
`record_settings.minutes_folder`, additive column): a department folder (`departments.folders()`)
that is not a private folder. A private folder, a place inside one or anything else is refused
with one answer, 400 `MINUTES_FOLDER_REFUSED`, which never names the place; `choices` lists only
usable folders. No folder (or one that stopped being usable) → `check` answers `checked: false`,
`reason: 'no-folder' | 'folder-unusable'` and reads nothing. Admin console: 「つなぎ先」→「Google」→
「議事録の置き場所」 (`minutes-folder.tsx`).

## For the thank-you mail (G8)

`services.minutes.meetingAttendees(companyId, userId, role, meetingId)` → `[{ email, name,
organizer, external }]`, read now from the calendar with that member's grant, for the assignee
or an attendee who may read the record: the "calendar attendee" source of verified recipients.

## Which meetings (a company setting, owner decision 2026-11-01 night)

`GET|PUT /google/minutes-folder` also carries `meetings`: `external` (the default, null stored =
default: only meetings with someone from outside — today's rule) or `all` (internal meetings
too). PUT takes `{ folder?, meetings? }` (at least one; another value → 400); owner/admin only
(`record_settings.meeting_intake`, additive column; `shared/core/minutes.ts` `meetingIsRead`). Admin
console: 「議事録の置き場所」 → 「読む会議」.

## The まとまり question (owner FB 28, 2026-11-02)

**The server decides** which meetings ask 「どのまとまりの会議ですか？」:
`GET /api/companies/:id/me/minutes/bundle-questions` → `MeetingBundleQuestions { days, questions:
[{ recordId, title, version, meetingAt, readAt, group: { key, label } }] }` — meetings the member is
the **assignee** of, in `read`, entered `read` within the company's days, with someone from outside
(`external_count` > 0: an internal meeting never asks, `meetingAsksBundle`), no `bundle` link, the
question not closed, in a company where the member reads some まとまり. The app shows exactly these
(`tasks:list`; an older server without the route asks nothing). `group`: same 相手 (counterpart
link), else the same calendar series (a recurring event's base id), else the same title; the key is
a digest (no calendar id leaves the server).

- **Days**: `record_settings.meeting_bundle_days` (additive), carried by `GET|PUT
  /google/minutes-folder` as `bundleQuestionDays` (1–30, default 7, `meetingBundleDaysOf`);
  owner/admin; admin console 「まとまりを聞く期間」. Past them the item leaves あなたの番.
- **「まとまりはない（社内の会議など）」**: `POST …/minutes/item/:recordId/no-bundle { expectedVersion? }`
  (assignee or owner/admin) — a ledger entry `no_bundle` (`MEETING_NO_BUNDLE_ACTION`, the person as
  actor, note 「まとまりはない（社内の会議など）」, no field, no state, nobody told): never asked
  again (also not by the consultation's card: the text answers `noBundle: true`, `bundleChoiceFor`
  then shows none). A second press writes nothing; a meeting with a まとまり → 409
  `MINUTES_HAS_BUNDLE`. A まとまり can still be chosen later (same `…/bundle`, the まとまり's
  step follows as in "A まとまり chosen later").
- **「『…』の会議ですか？」** (owner 2026-11-02): at intake, a meeting whose まとまり is not linked
  still gets its 相手 when every outside participant who resolves at all resolves (名寄せ,
  `identity.md` `resolveAddress`, with the assignee's reading) to the same company records
  (`participantsCompany`). Each question (and the card's answer) carries `suggested`: that 相手's
  **one** open まとまり of any type implementing `bundle` **the member reads** (0 or ≥ 2, or a 相手
  they do not read → null, the plain question). The app asks 「『<title>』の会議ですか？」 with
  ［はい］ (the same `…/bundle` as choosing by hand, so the まとまり's step follows),
  ［ちがう／選ぶ］ (the chooser) and ［まとまりはない］. **Never linked without the click.**
- **The card**: `GET …/minutes/item/:recordId/bundle-question` → `{ recordId, title, version,
  canChoose (no まとまり linked and the member is the assignee or an admin), noBundle }` for any
  reader of the meeting (else the same 404).
- Test: `server/tests/integration/minutes.test.ts` 「どのまとまりの会議ですか？」 (assignee only,
  internal never, same 相手 one group, days and the setting, 「まとまりはない」 for good and still
  choosable), `client/tests/tasks-list.test.ts` (the server's answer as is, an older server asks
  nothing), `src/features/tasks/model.test.ts` (`listRows`), `tests/ui/tasks-list.spec.ts`.

## Switches

Google (operator stop, the company's switch, vault, grant, scope — `google-connector.md`): both
discovery and the text refuse from the next call: 403 `GOOGLE_STOPPED`, 409
`GOOGLE_NOT_CONNECTED` (no / ended grant), 403 `MINUTES_NO_ACCESS` (Drive refused the
document), 503 `GOOGLE_UNAVAILABLE`. A switch turning off in the middle of a check stops it.
Records off → 404 `RECORDS_DISABLED`. The AI's emergency stop ends record tokens (`agent-stop.md`).

## The app (milestone 4 G9, 「商談のあと」)

- **Checking** (`client/electron/features/minutes/checker.ts`, main; the session stays there):
  the renderer names the company it works in (`minutes:watch`, from `useMinutesNotices` in
  `AppShell`; the subscription's end sends `null`); main then checks at once, every 10 minutes
  (`MINUTES_CHECK_INTERVAL_MS`) and on 「議事録を確かめる」 (`minutes:check`). Each check first asks
  `GET /me/google`: **without an active grant that includes `minutes`, nothing about minutes is
  asked or shown** (no error either). With it: `POST /me/minutes/check` (the server puts stale
  readings back itself; for an older server each `stale` id still in `reading` is put back with the
  type's `retry` at its current version), then the notices are read from
  `GET /records/ai-turn` (type `meeting`, state `received`: id, title, `meeting_at`, version —
  never text). Main sends `minutes:changed { companyId }` when they change; the renderer re-reads
  `minutes:notices`.
- **The records signal** (push channel, `agent-stop.md`): `wireAgentControl`'s `onRecords` →
  `recordsSignal(companyId)`, which only re-reads the received minutes, for the company being
  watched and only while the grant was seen. The signal's content is never used.
- **No banner** (S11, owner decision 2026-11-01): the 「議事録が届きました」 notice under the
  department bar is gone. A received record is a row of the task list's 「AI の番」 (the `ai-turn`
  answer), with the automatic runner's state; while the AI has not started it, the row offers
  「自分で読み取る」 (`src/features/minutes/startReading.ts`) and 「今は読まない」 (`minutes:skip` → the
  type's `skip` with the session) — `tasks-ui.md` "Minutes and AI turns". 「議事録を確かめる」 is an
  icon button in the title bar (`MinutesCheckButton.tsx`), shown only while the grant allows minutes.
- **Automatic reading** (stage 2 S10, `ai-turns.md`): with the company's 「自動で進める」 on and
  Claude Code chosen, the main window reads received minutes by itself in a hidden consultation
  (claimed with `start_reading` at the record's version read just before, then the same first message wrapped by
  `autoMinutesFirstMessage`, `client/shared/ai-turn-steps/minutes-reading.ts`). What it made reaches the member as the task list's items (homework
  tasks), the cards (the meeting's, a task's 「AI が用意したもの」) and notices.
- **「自分で読み取る」 = the person starts the reading once** (design §9 q6, §4-7): command
  `chat.newConsultation { message, title, minutesId }` (`commands.md`). The chat starts a new
  consultation titled 「<件名> のあと（M/D）」 (kept, not generated), stores `minutesId` with the
  conversation, and sends the app-composed first message as the member's (`minutesFirstMessage`,
  `client/shared/minutes-app.ts`): read minutes `<id>` with `minutes_read`, mark start / finish /
  fail, make tasks (attending member ids only), decisions (in the minutes folder), the deal update (approval
  fields become requests), the HubSpot meeting and the thank-you draft (recipients only from
  `mail_recipients`), each with the quoted basis, never claiming a send or an approval. It holds
  the record's id and title only — **the app never has the minutes text**. An agent without
  record actions (registry `recordActions` false: Codex) gets 「議事録の読み取りは Claude Code の相談で
  できます」 and nothing starts.
- **「どのまとまりの会議ですか？」 in 「あなたの番」** (S11; FB 28, "The まとまり question" below):
  the server's `bundle-questions` are items of the task list's あなたの番 with 「まとまりを選ぶ」 (the
  unfinished まとまり the member reads, `tasks:bundles`; choosing calls `minutes:linkBundle`) and
  「まとまりはない」 (`minutes:noBundle`); two or more of one group are one row 「まとまりを選ぶ会議 n件」
  that opens. The meeting's card (`MeetingBundleBar`, `minutes:bundleQuestion`) offers both while
  no まとまり is linked, also after the item left あなたの番; the consultation's card offers
  「まとまりはない」 too. The first message tells the AI to leave the まとまり's fields
  and the meeting log alone and finish the rest when none is linked, so an automatic run never waits
  for a card nobody sees.
- **The card in a consultation** (`MinutesBundleChoiceCard.tsx`): when `minutes_read` answers no
  linked まとまり and 0 or ≥ 2 candidates, the record tool (main) puts the app's card into the reply
  (data part `data-minutes-deal-choice` and the stored key `minutesDealChoices`, kept as named
  before for saved consultations; `bundleChoiceFor`) and tells the AI not to write to it until the
  member chooses. Choosing calls `minutes:linkBundle` → `POST /me/minutes/item/:id/bundle
  { bundleId }` with the session; nothing goes to the outside system.
- The consultation's other cards are the core-drawn ones (operation, approval, mail); they render
  in the order the tools produced them, also after a restart (`cardOrder`, `chat-ui-and-history.md`).
- Not yet: the consultation does not move to the minutes folder's department (the record's folder
  is not in any member-facing answer), so the AI asks where to put decisions when the folder is not
  the current one.
- Not yet (owner decision 2026-11-04, 会議は「参加した人だけ」): meetings are still placed in the
  minutes folder. The core now has members-only records (`records.md` "Members-only records"):
  what is made from a members-only meeting inherits its list, and a service write of such an output
  that also names a folder is refused (`bad-place`) — so when the Google step makes meetings
  members-only, the intake, `minutes-review.ts`, the decisions it records and the answer's `folder`
  must stop passing the minutes folder for them.

## Tests

`server/tests/integration/minutes.test.ts` against the fake Google and the fake HubSpot (practice
redirect): an internal-only meeting creates nothing and its Meet record is never looked up; one
record for two members, organizer assignee; two candidates not linked, one linked with its 相手,
only a まとまり can be chosen (a 顧客 is refused); which meetings are read (owner/admin only, default
external, `all` reads the internal one); the text only
for the assignee / attendees, another company's record = missing; no minutes text in any table,
log line or other answer; the AI's text answer carries the record's version; the folder refusal
never naming the place; stale reading put back by the server as its clock; an unfinished automatic
run put back at its finish as the run's doing (ledger cause `run`); Google
stopped / not connected; records off; `meetingAttendees` — each mutation-checked.
`client/tests/records-tools.test.ts` (the tool's output carries the header above and the footer
below the text), `client/tests/web-research.test.ts` (the addressed-to-AI flag).
`client/tests/minutes-app.test.ts` (no minutes call without the grant — start, tick, signal; the
check's session calls and stale `retry`; a records signal only re-asks, for the watched company;
skip / まとまり link with the session; the first message names the id and carries no text; the まとまり
choice card only for 0 / ≥ 2 candidates; cards restored in order), `client/tests/ui/minutes.spec.ts`
(「読み取る」 starts the titled consultation with `minutesId`; the card links the chosen まとまり;
Codex starts nothing), `client/tests/plugin-tools.test.ts` (「もう一度作る」 with the session, the
server's warning before `confirm`). Permission
matrix rows + `CROSS` for the session routes with a record id.
