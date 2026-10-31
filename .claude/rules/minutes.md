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
  - "client/src/features/chat/components/MinutesDealChoiceCard.tsx"
  - "client/tests/minutes-app.test.ts"
  - "client/tests/ui/minutes.spec.ts"
---

# Minutes intake (milestone 4 G7)

After a sales meeting, Google Meet saves notes (Gemini) and a transcript in the organizer's Drive.
ACB notices them when the member's app asks, keeps a `minutes` record (server only, no text), and
hands the text — marked as outside text — to the member's normal consultation AI, which makes
the outputs with the typed tools. Design: 節目4 §1-2, §3-1, §3-7, §9 q5/q14/q15 and the owner's
§11: **no separate tool-less reader AI**; the safety is in the server's gates (approval for prior
fields, a person presses send, fields that are off stay off), not in AI-side extra layers. Google
access itself: `google-connector.md` (G3).

## Flow

1. **Discovery** — `POST /api/companies/:id/me/minutes/check` (session). The app calls it at
   start, every 10 minutes and on a button (q5: no server timer; a closed app finds them next
   time). Only the member's **own** grant is used (`googleClient.request`, so every Google switch
   applies from the next call). Steps (`services/minutes.ts` `check`, Google calls in
   `services/google-meetings.ts`):
   - calendar events of the last 3 days → now (`singleEvents`, by start time, ≤ 4 pages);
   - keep events with a Meet conference (`conferenceData` `hangoutsMeet`) and **at least one
     attendee outside the company's Google domain** (the G3 client's `domain`, `isExternalAddress`).
     Internal-only meetings are never read further — not even their Meet record (design §1-2;
     HR meetings and the like);
   - the conference record by meeting code near the event's time; its smart notes and transcripts
     with `FILE_GENERATED` and `docsDestination.document`; each document's Drive `version`;
   - one record per **conference**: id `minutes-<sha256("minutes:" + conference id)[:24]>`, so two
     members (or two calls at once) make one record (`exists` → counted `existing`);
   - assignee (q15): the organizer when they are a member who can read the minutes folder, else
     the member who found it; attendees = members whose ACB email is on the event.
   Answer `MinutesCheckResult`: `{ checked, reason?, message?, meetings, internalOnly, created:
   [ids], existing, waiting, stale: [ids] }` — counts and ids only, never text. `stale`: the
   member's own records in `reading` for > 30 minutes; the app runs the type's `retry` on them.
2. **Deal** (mechanical, design §1-2 step 3): open deals readable by the assignee whose customer's
   `domain` (a server field of the imported `customer` type) is an outside attendee's domain;
   when several, those whose title appears in the meeting title (or the reverse) if any. With no
   domain match, title matches only. **Exactly one** → linked (`deal`, and the deal's `customer`);
   0 or ≥ 2 → not linked; `candidates` in the text answer; a person or their AI chooses with
   `POST …/minutes/…/deal { dealId, expectedVersion? }` (assignee or owner/admin; the service
   writer's `links`, ledger `link_deal`). Nothing is written to HubSpot by this.
3. **Reading** — the AI (tool `minutes_read`) or the app reads the text (below), runs
   `minutes__start_reading`, makes the outputs with the existing tools (`records_create` task —
   assignee = attending member ids, due within a year —, `decisions_record` linking minutes /
   deal, `hubspot__update_deal` — prior fields become approval requests (G6) —, the HubSpot
   meeting tool (G5), the mail draft (G8)), each citing the minutes text it rests on, then
   `minutes__finish_reading` with a ≤ 300-character summary. Those three actions are `who: [ai]`
   (「AI の番」); `retry` / `skip` are the assignee's / an admin's. The optional server quote
   check (`quoteAppearsIn`) is not wired (owner §11: optional).

## The text

`GET /api/records-ai/minutes/:recordId/text` (record token, read or act) and the session twin
`GET /api/companies/:id/me/minutes/item/:recordId/text` → `MinutesText`: `{ header:
MINUTES_TEXT_HEADER, text, footer, truncated, docVersion, meeting: { title, at }, attendees:
[{ memberId, displayName }], externalAttendees (count only), deal: { id, title, state, fields,
version } | null, candidates: [{ id, title }], instructionLike: [{ label, words }] }`.

- Only for a minutes record the member may read (else the same 404 as a missing record — another
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
`meeting_at`, `assignee`, `attendees` (JSON of member ids, ≤ 500 characters), `external_count`,
`source_ref` (JSON of Google ids only: conference, event, documents), `doc_version`
(`notes:7,transcript:7`), `summary_text` (the AI's ≤ 300 at the end); links `deal`, `customer`.
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

`services.minutes.meetingAttendees(companyId, userId, role, minutesId)` → `[{ email, name,
organizer, external }]`, read now from the calendar with that member's grant, for the assignee
or an attendee who may read the record: the "calendar attendee" source of verified recipients.

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
  asked or shown** (no error either). With it: `POST /me/minutes/check`, then each `stale` id is
  put back with the type's `retry` at its current version, then the notices are read from
  `GET /records/ai-turn` (type `minutes`, state `received`: id, title, `meeting_at`, version —
  never text). Main sends `minutes:changed { companyId }` when they change; the renderer re-reads
  `minutes:notices`.
- **The records signal** (push channel, `agent-stop.md`): `wireAgentControl`'s `onRecords` →
  `recordsSignal(companyId)`, which only re-reads the received minutes, for the company being
  watched and only while the grant was seen. The signal's content is never used.
- **The notice** (`client/src/features/minutes/components/MinutesNotices.tsx`, under the
  department bar): 「議事録が届きました：<件名> <M/D>」 per received record, with 「読み取る」 and
  「今は読まない」 (`minutes:skip` → the type's `skip` with the session). 「議事録を確かめる」 is an
  icon button in the title bar (`MinutesCheckButton.tsx`), shown only while the grant allows minutes.
- **「読み取る」 = the person starts the reading once** (design §9 q6, §4-7): command
  `chat.newConsultation { message, title, minutesId }` (`commands.md`). The chat starts a new
  consultation titled 「<件名> のあと（M/D）」 (kept, not generated), stores `minutesId` with the
  conversation, and sends the app-composed first message as the member's (`minutesFirstMessage`,
  `client/shared/minutes-app.ts`): read minutes `<id>` with `minutes_read`, mark start / finish /
  fail, make tasks (attending member ids only), decisions (no names), the deal update (approval
  fields become requests), the HubSpot meeting and the thank-you draft (recipients only from
  `mail_recipients`), each with the quoted basis, never claiming a send or an approval. It holds
  the record's id and title only — **the app never has the minutes text**. An agent without
  record actions (registry `recordActions` false: Codex) gets 「議事録の読み取りは Claude Code の相談で
  できます」 and nothing starts.
- **「どの案件の議事録ですか？」** (`MinutesDealChoiceCard.tsx`): when `minutes_read` answers no
  linked deal and 0 or ≥ 2 candidates, the record tool (main) puts the app's card into the reply
  (data part `data-minutes-deal-choice`, `dealChoiceFor`; stored as `minutesDealChoices`) and tells
  the AI not to write to the deal until the member chooses. Choosing calls `minutes:linkDeal` →
  `POST /me/minutes/item/:id/deal { dealId }` with the session; nothing goes to HubSpot.
- The consultation's other cards are the core-drawn ones (operation, approval, mail); they render
  in the order the tools produced them, also after a restart (`cardOrder`, `chat-ui-and-history.md`).
- Not yet: the consultation does not move to the minutes folder's department (the record's folder
  is not in any member-facing answer), so the AI asks where to put decisions when the folder is not
  the current one.

## Tests

`server/tests/integration/minutes.test.ts` against the fake Google and the fake HubSpot (practice
redirect): an internal-only meeting creates nothing and its Meet record is never looked up; one
record for two members, organizer assignee; two candidates not linked, one linked; the text only
for the assignee / attendees, another company's record = missing; no minutes text in any table,
log line or other answer; the folder refusal never naming the place; stale reading; Google
stopped / not connected; records off; `meetingAttendees` — each mutation-checked.
`client/tests/records-tools.test.ts` (the tool's output carries the header above and the footer
below the text), `client/tests/web-research.test.ts` (the addressed-to-AI flag).
`client/tests/minutes-app.test.ts` (no minutes call without the grant — start, tick, signal; the
check's session calls and stale `retry`; a records signal only re-asks, for the watched company;
skip / deal link with the session; the first message names the id and carries no text; the deal
choice card only for 0 / ≥ 2 candidates; cards restored in order), `client/tests/ui/minutes.spec.ts`
(「読み取る」 starts the titled consultation with `minutesId`; the card links the chosen deal;
Codex starts nothing), `client/tests/plugin-tools.test.ts` (「もう一度作る」 with the session, the
server's warning before `confirm`). Permission
matrix rows + `CROSS` for the session routes with a record id.
