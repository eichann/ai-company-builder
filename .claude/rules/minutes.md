---
paths:
  - "server/src/services/minutes.ts"
  - "server/src/services/google-meetings.ts"
  - "server/src/routes/minutes.ts"
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

### A まとまり chosen later (meeting version 3, owner 2026-11-02)

**What a まとまり gets from a meeting is not the core's** (coordinator decision 2026-11-02; the core
names no business operation): the reading has no business plugin's tool, and the server refuses a
core step's run any business plugin operation but a read (`plugin-operation-checks.ts`). When the
meeting becomes `read` (`finish_reading`, or `finish_bundle_work` below) the server moves its
まとまり to the business plugin's `ai_turn` step for it (`plugin-steps.md` "After a meeting is
read", e.g. 「会議を案件に反映する」: the deal's fields and the meeting log), which runs as its own
AI turn.

Read without a まとまり, the AI leaves the まとまり's part. When a
person then chooses one (`POST …/minutes/…/bundle` on a `read` meeting that had **no** `bundle`
link), the same transition moves it `read → bundle_waiting` (`SERVICE_TRANSITIONS.meeting`): 「AI
の番」 again, for that part only. The app's step `minutes-bundle` (`ai-turns.md` "Steps") claims
the run (`step: 'minutes-bundle'`, one run per record and step), starts it with
`start_bundle_work` (→ `bundle_working`) and has only `minutes_read`, the plugin's
`finish_bundle_work` / `fail_bundle_work` (both → `read`;
the reason in the ledger's note). `retry_bundle_work` (bundle_working → bundle_waiting) is the
put-back — after a failed run (`afterFailedRun`) and in the 30-minute rule — and
`skip_bundle_work` (bundle_waiting → read) a person's 「しない」. **Once**: choosing again when a
まとまり was already linked changes only the link; a finished part leaves the meeting `read` (not
an AI turn, so no run can be claimed); the run's operation keys keep a redo within one run from a
second effect. Test: `server/tests/integration/minutes.test.ts` 「read without a まとまり, one chosen
afterwards…」, `client/tests/ai-turn-steps.test.ts`, `ai-turn-claims.test.ts`.

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
  `MINUTES_HAS_BUNDLE`. A まとまり can still be chosen later (same `…/bundle`, the まとまり's part
  follows as in "A まとまり chosen later").
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
