---
paths:
  - "server/src/services/minutes.ts"
  - "server/src/services/google-meetings.ts"
  - "server/src/routes/minutes.ts"
  - "server/src/services/meeting-outputs.ts"
  - "server/src/services/source-slot-candidates.ts"
  - "shared/core/source-slot-candidates.ts"
  - "shared/core/meeting-outputs.ts"
  - "shared/types/meeting-outputs.ts"
  - "admin/src/app/companies/[[]id]/task-list/meeting-duplicates.tsx"
  - "server/tests/integration/minutes.test.ts"
  - "server/tests/integration/meeting-attendees.test.ts"
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
  - "client/src/app/meetingCard.tsx"
  - "client/src/app/RecordBundleFieldBox.tsx"
  - "client/tests/meetings-app.test.ts"
  - "client/tests/meetings-ui.*"
  - "client/tests/ui/meetings.spec.ts"
---

# Minutes intake (milestone 4 G7)

After a meeting, Google Meet saves notes (Gemini) and a transcript in the organizer's Drive.
ACB notices them on the server clock, keeps a `meeting` record (会議, server only, seen by its
attendees only — "Meetings for their attendees" below — no text —
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

1. **Discovery** — on the server clock (every 5 minutes, `pollCompany`, "Meetings for their
   attendees" below) for every member, and for one member when an older app calls
   `POST /api/companies/:id/me/minutes/check` (session; same code, plus the stale put-back). Only
   the member's **own** grant is used (`googleClient.request`, so every Google switch applies from
   the next call; a member without a usable grant is refused locally, nothing leaves ACB). Steps
   (`services/minutes.ts` `discover`, Google calls in `services/google-meetings.ts`, reached through
   the role 会議の記録を読む — `ports/meeting-records.ts`, `connector-roles.md`; no usable connector →
   `GOOGLE_STOPPED`, 予定と議事録を読む turned off by the member → `GOOGLE_NOT_CONNECTED` with its own
   sentence):
   - calendar events of the last 3 days → now (`singleEvents`, ≤ 4 pages), **newest first**, at most 50;
   - keep events with a Meet conference (`conferenceData` `hangoutsMeet`) **not marked private in
     anyone's copy** (`visibility` private / confidential): the clock first reads every member's
     events and marks such an event in `meeting_events` (key = digest of the event id), so no
     member's run records it — not recorded, its Meet record never looked up, counted
     `internalOnly` (the field's old name). A meeting recorded before it turned private is kept
     (nothing deleted) and gets no one added or told any more. A calendar whose *default* is private
     cannot be told from the events list (not handled). Internal and external meetings alike (owner
     decision 2026-11-04: what is sensitive only the attendees know; "Which meetings" no longer gates);
   - **Google calls** (`meeting_events`): an event already recorded is known without a Meet call; a
     meeting not ended yet is not looked up; no conference / no generated minutes → looked for again
     after 5, 15, 30, 60, 120, 240 minutes (shared by every attendee's run); at most
     `MEETING_CALLS_PER_RUN` (300) calls per company and clock run (100 per app check), the rest the
     next run, a different member first each run; a 429 stops that member until the next run. The
     clock polls meetings after every company's moves and notices (`server-clock.ts`);
   - the conference record by meeting code from 15 minutes before the event's start to its end (a
     reused personal Meet link must not hand one meeting's record to the next); its smart notes and transcripts
     with `FILE_GENERATED` and `docsDestination.document`; each document's Drive `version`;
   - one record per **conference**: id `meeting-<sha256("minutes:" + conference id)[:24]>`, so two
     members (or two calls at once) make one record (`exists` → counted `existing`); a record made
     before the rename keeps its `minutes-<same hash>` id and counts as existing;
   - **members-only** (`records.md` "Members-only records"): the list = attendees on the event's
     list who are members **by an address Google verified for them** — the `account_email` of their
     active Google grant (`verifiedMembers`), never the ACB account's email (chosen at sign-up,
     unverified: someone registered with a colleague's address must not join their meetings) —
     never one who declined (`responseStatus` declined), never an organizer who is not on the
     attendee list. Members without a Google grant are not added (an attendee invites them); another
     address or a mailing list is not matched (design §4-4, later). No member attending → no record.
   - **one event, one meeting**: only the event a record was made from (`source_ref.event`) is that
     meeting; another event on the same Meet (a copied event, a reused link) never adds attendees or
     renames it (`meeting_events` maps only that event to the record).
     No folder, no assignee: the record starts `arrived` (below).
   Answer `MinutesCheckResult`: `{ checked, reason?, message?, meetings, internalOnly, created:
   [ids], existing, waiting, stale: [ids] }` — counts and ids only, never text (`reason` is no longer
   answered: no folder is needed). `stale`: the
   member's own records in `reading` for > 30 minutes, which the check (and the clock, for every
   member, before their discovery) puts back to
   `received` (the type's `retry` through the service writer, actor the server clock
   `CLOCK_ACTOR`: ledger cause `system`, never the member); an older app's `retry` on them finds
   nothing to do.
2. **まとまり** (mechanical, design §1-2 step 3; whatever its type — the core names no business
   type): unfinished records of any type implementing `bundle` (a 案件, a 企画…) readable by the
   reader that link to a 相手 (a record of a type implementing `counterpart`) whose `domain` is an
   outside attendee's domain; when several, those whose title appears in the meeting title (or the
   reverse) if any. With no domain match, title matches only. **Never linked at intake** (since
   2026-11-04: linking shows part of the meeting to the まとまり's department — an attendee's choice,
   design §2/§5); the outside participants' company (名寄せ, with the finder's reading) is still its
   `counterpart`. `candidates` (with each one's `typeLabel`) in the text answer; a person or their AI chooses with
   `POST …/minutes/…/bundle { bundleId, expectedVersion? }` (assignee or owner/admin; only a
   まとまり the member reads — anything else, missing or unreadable, one 400 `BAD_LINK`; the service
   writer's `links`, ledger `link_bundle`). Nothing is written to the outside system by this.
3. **Reading** — the AI (tool `minutes_read`) or the app reads the text (below), runs
   `meeting__start_reading`, makes the outputs with the existing tools (`records_create` task —
   assignee = attending member ids, due within a year —, `decisions_record` linking meeting /
   bundle, the mail draft (G8)), each citing the minutes text it rests on, then
   `meeting__finish_reading` with a ≤ 300-character summary. Those three actions are `who: [ai]`
   (「AI の番」); `retry` / `skip` are the assignee's / an admin's. The basis quote is checked by the
   app against the minutes its turn read (`quoteAppearsIn`, "Outputs made once" below); the server
   does not read Google at create time.

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

## Outputs made once: the meeting's slot (owner FB 29, 2026-11-02; 出どころの枠 §10, 2026-11-06)

Reading a meeting again (「もう一度読む」, a retry, a rerun) made the same task five times; FB 29's fix
keyed outputs by the AI's serial number (`task:1`), and a second reading — or another attendee's
consultation — reusing `task:1` for a **different** item got the earlier record back and the new one
silently disappeared. Now (owner decision 2026-11-06 「出どころの枠」 §10: **when an AI makes something
shared, it goes through the source's slot; what a person does is free**): **what an AI makes from a
meeting is a candidate in that meeting's slot**, decided in one place,
`services/source-slot-candidates.ts` `decideSlot` (pure half `shared/core/source-slot-candidates.ts`;
generic shape: source record id + kind + key, so it can join its sibling `services/source-slots.ts` —
a source's outside acts: one send per source, one pending create per source, `outbound-mail.md`,
`approvals.md` — later). `server/tests/unit/source-slot-one-place.test.ts` fails when the engine's create
or the decision service stops calling it, or another module uses the older per-meeting helpers.

- **Identity = (meeting, kind, normalized quote).** The AI gives the minutes text its output rests
  on: `quote` on `POST /records-ai/item` / `records_create` and `decisions_record` (6–300 characters
  after folding spaces, `slotQuote`; else 400 `BAD_QUOTE`; only with `links.meeting`, else 400
  `QUOTE_NEEDS_MEETING`). Its key is `outputTitleKey` of the quote (NFKC, A–Z folded, no spaces /
  brackets / punctuation: `【】` and `〔〕` alike), digested into the id (`slotCandidateId`), so the same
  quote is the same candidate whoever's AI gives it, in any reading, two calls at once included. A
  task stores it in `basis` (task version 13).
- **The same quote** → the existing candidate, 200 `{ record, entry: null, reused: true, note:
  「同じ根拠の案がもうあります（<title>）…」 }`, nothing written — **only when the caller reads it**.
  Held by a record the caller cannot read (an AI narrowed its candidate's members) → a candidate of
  its own under a fresh id, nothing said. **A different quote** → a new candidate.
- **「似ている案があります」**: a new candidate whose title is close to a live candidate the caller
  reads (`slotTitlesClose`: the same after `outputTitleKey`, or one inside the other, the shorter ≥ 2
  characters) is kept and marked: task field `similar_to` = the oldest such (the answer adds
  `similar: { id, title }` and a note). **Never merged on title alone.** The review card offers ［同じ］
  (`dismiss` of the newer, note 「「…」と同じ案のため」) and ［別のもの］ (`keep_apart`).
- **Visibility** (§9 rule 4): compared and answered only within what the caller reads; owner-only
  records (「あなただけ」) are never compared or mentioned — an owner-only create does not enter the
  slot at all, and an owner-only record is never an answer. Candidates follow the meeting's 見える範囲
  (members-only, "Meetings for their attendees").
- **Only the AI's creates.** A person's create (session) is free: never a candidate, never refused or
  answered with another (§10). **「似ているやることがあります」** (§10 step 4, owner decision 2026-11-06) is
  the person's only hint: a person's create with `links.meeting` (not owner-only), and a person's
  `share` of an owner-only / members-only task linked to a meeting, answer `similar: { id, title }` —
  the oldest live item of that meeting's slot the caller reads whose title is close (`similarInSlot`,
  the same rows and `slotTitlesClose` as `similarTo`; put-away ones and the shared item itself left
  out; only when the caller reads the meeting). Nothing is written (no `similar_to`, no mark): the
  answer only. Someone's owner-only item is never compared or named; a members-only one only when
  the caller is listed. **Same source = the same meeting** for now: tasks made from a 連絡 (`interaction`)
  are §10's step 5 (later). The app: `tasks-ui.md` "Similar items".
- **An older app** (only the serial `key`, no quote): a serial key counts only inside the same run or
  consultation (the slot key `key:<run, else conversation>:<serial>`), and so does the exact title
  (`outputTitleKey`, the create entry's run / conversation). A second reading's `task:1` is a new
  candidate (with `similar_to` when its title is close) — nothing is lost; at worst a person presses
  ［同じ］. `key` is still accepted (≤ 200, one line, only with `links.meeting`, else 400
  `KEY_NEEDS_MEETING`); `KEY_TAKEN` is gone.
- **Decision** (`decisions_record`): an AI's decision with a meeting link takes the same identity
  (meeting, quote) through `decideSlot` (`source_key` keeps `<meeting id>:<slot key>`); no similar
  mark (decisions have no proposal list). A person's decision keeps the key rule (`<meeting id>:<key>`;
  without a meeting, company-wide as before).
- **Where the quote is checked**: the server cannot read the minutes at create time (it reads Google
  only with the member's grant, in an async call, and never keeps the text), so the **app** checks
  it: `records_create` / `decisions_record` with `links.meeting` and a `quote` whose meeting this turn
  read with `minutes_read` (`minutesKept`) is refused locally when `quoteAppearsIn` does not find it
  (`QUOTE_NOT_IN_MINUTES`: 「議事録の文を、言い換えずにそのまま写してください」); minutes not read in the
  turn are not checked. A made-up quote only makes a separate candidate: it can never take another's.
- The first message (`minutesFirstMessage`), `minutes_read`'s description and the tools' schemas ask
  for `links.meeting` + `quote`, never a serial key (`records_create` no longer offers `key`), and say
  what `reused` / `similar` mean.
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
- Test: `server/tests/unit/source-slot-candidates.test.ts` (a second reading's reused `task:1` is made;
  one candidate per quote from two attendees' AIs, told only when readable; a close title kept and
  marked; owner-only never compared or mentioned; a person's create free and only told 「似ている」 — about
  a readable item, never someone's owner-only or an unlisted members-only one, never itself on a share,
  never a put-away one; ［まとめる］'s `dismiss` with its note and undo; decisions by quote; who may
  act; `link:` parsing; the v13 migration once — each guard mutation-checked),
  `source-slot-one-place.test.ts` (the one place; the person's hint from `similarInSlot` in create and
  share, and `slotTitlesClose` in no other server module), `server/tests/integration/minutes.test.ts`
  「made once (FB 29)」 (an older app: reused inside its consultation, another reading's `task:1` made,
  a same title marked similar; another meeting is unaffected; decisions; the duplicates list and
  merge), `outbound-mail.test.ts` 「the meeting's mail is made once」, `client/tests/records-tools.test.ts`
  (the quote checked against the turn's minutes, no serial key offered),
  `client/tests/outbound-mail-tools.test.ts` (the AI told), `minutes-app.test.ts` (the first message).

## The AI's proposals and 「議事録を確認する」 (owner decision 2026-11-02, plan F)

- **Proposals (案)**: the homework the AI makes while reading (`records_create` with
  `links.meeting`) starts as a proposal when the company's 「会議から AI が作るやること」 is
  「案として出す」 (default; `tasks.md` `meetingTasks`), as a task at once when 「自動で作る」.
  A proposal is nobody's turn; a person adds it (`adopt`) or puts it away (`dismiss`, kept,
  `propose_again` brings it back) — records.md "Task version 11". **Everyone who reads the meeting**
  may (task version 13's `link:meeting`, records.md "Task version 13"): attendees, invited members,
  not only who pressed ［AI に読ませる］; the AI never. The first message tells the AI to leave
  proposals as they are.
- **The review task** (`services/minutes-review.ts`, wired as the engine's `afterAct`): when a
  meeting becomes `read` — internal or external — its assignee gets one task
  「議事録を確認する：<meeting title>」 (`task_kind: minutes_review`; requested_by = assignee, so
  it is their own; the meeting's folder; `meeting` link = its origin). Its id is derived from the
  meeting (`meetingOutputId`, key `MINUTES_REVIEW_KEY`): never two, also for a second reading or
  two at once. Ledger actor `MINUTES_ACTOR` (`acb:minutes`, cause system). Nothing completes it by
  itself — handling every proposal leaves it open; the assignee completes it. A meeting without an
  assignee gets none; a failure is logged and never changes the reading.
- The app: `tasks:proposals (companyId, meetingId)` lists the meeting's proposals (proposed and put
  away, `TaskProposal`: each with its `basis`, whose AI added it — `addedBy` = `requested_by` —,
  `similarTo` while nobody said 別のもの, and `may` from the type's `who` via `proposalMay`) and
  `readerId` / `readerName` (the meeting's assignee); 足す / 要らない / 案に戻す / 別のもの are `tasks:act`
  with `adopt` / `dismiss` / `propose_again` / `keep_apart`. The card: `tasks-ui.md` "The minutes
  review card".
- Test: `server/tests/unit/meeting-proposals.test.ts`; `minutes.test.ts`'s output counts leave the
  review task out.

## Meetings for their attendees (owner decision 2026-11-04, design 会議の記録と「参加した人だけ」の見え方 §2/§4/§5)

- **Seen by its attendees only** (members-only, `records.md`): not the owner, admins or department
  managers unless they attended; for anyone else the meeting does not exist (404). What is made from
  it inherits the list (`record-engine/members.ts`): tasks (+ their assignee), decisions, the review
  task. Attendees the calendar **adds later** join the list on the next discovery (service writer
  `addMembers`, ledger `attendees_joined` = `MEETING_ATTENDEES_ACTION` by `google`, `place.members`
  before / after, told while still `arrived`); attendees **removed** stay; who declined never joins.
  The text, `meetingAttendees` and the buttons judge "one of its people" by the list (also an invited
  member: Google then decides whether they may open the minutes); the まとまり (`…/bundle`,
  `…/no-bundle`, `bundle-question`'s `canChoose`) may be chosen by anyone on the list, also while
  `arrived`. The creation's ledger note is neutral (「カレンダーの予定から見つけました」).
- **Approvals from such a meeting** (`approvals.ts` `request`): the request lives in the まとまり's
  folder as before (its approver must read it) and does **not** link the meeting (a link would make it
  the attendees' only, failing `bad-place`); the meeting stays unseen by the others (the approval's
  materials name it only to its readers). The basis quote travels with the request: asking is the
  attendee's own act of showing that part to the department (design §2/§5).
- **States** (core `meeting` version 5, additive): new initial `arrived` (議事録が届いた) — nobody's
  turn, no AI turn, no assignee. Meetings made before stay where they are (`received` etc.).
- **［AI に読ませる］**: `POST /me/minutes/item/:recordId/read-request { expectedVersion? }` (session;
  one of the meeting's people — on its list, its assignee or `attendees`, else 403
  `MINUTES_NOT_YOURS`; not readable → 404). From `arrived`, `skipped` or `failed`: first the reading
  itself is tried with **the presser's own Google** (`readDocuments`, what `text` does, 200 characters,
  thrown away: a failure shows at the press, not after a failed AI turn) — not shared with them →
  403 `MINUTES_NO_ACCESS` 「…ほかの出席者が［AI に読ませる］を押すと、その人の AI が読めます」 and
  nothing changes (reader rotation, design §4-3); shared but nothing readable → the answers of "When
  Google refuses the text" below, nothing changes; then → `received` with **assignee = the presser**
  (`request_reading` = `MEETING_READ_REQUEST_ACTION`, quiet): the AI's turn on their PC (`ai-turn`,
  the existing reading, `text` with their grant). Same member while it waits for their AI → the same
  answer, nothing written on the record; `reading` / `read` / someone else's `received` → 409
  `MEETING_NOT_WAITING`. **The press is a fresh attempt** (production 2026-11-05: a press after a
  failed reading answered 200 and nothing ran): both answers also give back an earlier run of the
  reading that stopped for a person, whoever's it was (`readingAskedAgain` → `aiRuns.askedAgain`,
  `ai-turns.md` "Asked again"); the app drops its own hand-off there too.
- **［読まない］**: `POST /me/minutes/item/:recordId/skip { expectedVersion? }` — any of its people
  from `arrived` / `failed`, the assignee alone from `received` (「今回だけ読まない」); → `skipped`
  (ledger `skip`, the person as actor, note 「読まない」, quiet): nobody is asked again, the record is
  kept, `arrivals` says who. A later ［AI に読ませる］ still works. Twice → the first answer.
- **「この定例は次から自動で読む」**: `PUT /me/minutes/item/:recordId/auto-series { auto }` (one of its
  people; a meeting of no series → 409 `MEETING_NOT_SERIES`) — the caller's own choice per recurring
  series (`meeting_auto_series`, key = digest of the calendar's `recurringEventId`, kept in
  `source_ref.series`). When **that member's** discovery finds a meeting of the series (new, or still
  `arrived`) it is asked to be read for them as above (actor `CLOCK_ACTOR`, note
  「この定例は自動で読む設定のため、AI に読ませました」); not shared → it stays `arrived`. Only this call sets
  it (the card's button, or 元に戻す after 「次から自動で読まない」): never a press of ［AI に読ませる］, discovery or
  a default. It is per series, so one press shows on every meeting of that series.
- **「議事録が届きました」**: `GET /me/minutes/arrivals` → `MeetingArrivals { days, items }` — the
  meetings whose list names the caller (`listedRecordIds`, no company-wide scan) that took place in the last `MEETING_ARRIVED_DAYS` (3) days, newest
  first: `status` (arrived / asked / reading / read / skipped / failed), `attendeeCount`, `by` (the
  reader, or who chose 読まない), `byYou`, `series`, `autoSeries`. Older ones leave it and stay openable
  and readable (the card's ［AI に読ませる］). Ids, titles, times, counts, member names only.
- **Notice**: each attendee gets `minutes_arrived` 「議事録が届きました：「…」」 once per meeting
  (`notifications.md`), never a non-attendee.
- **The minutes folder and "which meetings"** are no longer used: `GET|PUT /google/minutes-folder`
  still answers and stores them for older admin consoles (harmless); `bundleQuestionDays` is still
  used. The admin home no longer lists 「議事録の置き場所を選ぶ」; the admin's Google page shows 「会議の
  記録」 with a note (recorded for their attendees, private events skipped) and only the days setting
  (`minutes-folder.tsx`, `admin/tests/integrations.test.tsx`).
- Tests: `server/tests/integration/meeting-attendees.test.ts` (each mutation-checked).

### In the app (design §4-5, demo `demo/minutes-arrived`)

- **Main** (`client/electron/features/minutes/meetings.ts`, session only; channels in `ipc.ts`):
  `minutes:arrivals` → `MeetingArrivalsResult { available, items }` — the server's arrivals, each
  checked field by field; a `read` one carries `made { decisions, proposals }` counted from the
  meeting's links (decisions not retracted; tasks linked to it except the review task and archived
  ones), looked up once per version. **An older server** (no route: any non-200) → `available:
  false`: no banner, and `minutes:meeting` answers a failure with an empty error: the card shows no
  new buttons (quietly). `minutes:meeting` (the card: the record's state and version now, the
  arrival's series / by when listed, `review` = `reviewOf` once read), `minutes:requestReading` /
  `minutes:skipReading` (at the version shown; 403 `MINUTES_NO_ACCESS` → `MEETING_NO_ACCESS_TEXT`
  「…ほかの参加者が［AI に読ませる］を押すと、その人の AI が読めます。」, `noAccess: true`; a request
  accepted re-reads the received minutes at once, `onReadRequested` → `minutes.recordsSignal`),
  `minutes:autoSeries`, `minutes:invite` (`POST /records/item/:id/members`, any members-only record;
  member ids checked, de-duplicated). Malformed ids never reach a URL.
- **The banner** (`src/features/minutes/components/MeetingBanners.tsx`, the words in `model.ts`
  `meetingBanner`): at the top of やること (AppShell wraps `TaskListPanel`; `useMeetingArrivals`: at
  mount, on `minutes:changed` / `records:changed` / `notifications:changed`, every 2 minutes, after a
  press). **It never takes the pane** (first discovery brings many meetings at once, 2026-11-05): one
  block of at most 45% of the pane with the heading 「議事録が届きました」 and `MEETING_ROWS_SHOWN` (2)
  one-line rows (`meetingRowWords` 「<title>・今日 12:00」, cut with the whole text as the tooltip, small
  buttons); the rest behind 「ほか N 件」, opened in an area of its own height that scrolls; the list
  below keeps the rest and scrolls. Opened, ［まとめて読まない］ skips the folded meetings still
  arrived (`skippableMeetings`), toast 「N件を読まないにしました」 with one 元に戻す for all of them. **No
  count on a row**: `attendeeCount` is the members ACB matched, not who attended (the card says
  what it counts). Per meeting: ［AI に読ませる］［読まない］
  (also after a failed reading, 「前回読めず」); after ［AI に読ませる］ only the line changes to 「AI が読んでいます…」
  — nothing opens; the member's AI reads it as their 「AI の番」 (below) — with ［読まない］ (今回だけ)
  while it waits for their own AI, 「〇〇さんの AI が読んでいます…」 when another attendee pressed it,
  and the runner's reason instead of the spinner when this PC cannot start it (Codex, not signed in,
  failed; 「もう一度」). The member's own automatic series: 「自動で読む定例です。AI が読んでいます…」 with
  ［次から自動で読まない］ (toast with 元に戻す). Read: 「読み終わりました　<title>：決めたことN・やることの案N」
  ［見る］ (opens the card) and ×, closed per PC (localStorage `meeting-banners-closed:<company>`).
  ［読まない］: the line goes at once, toast 「「…」は読まないにしました」 with 元に戻す = the generic undo of
  that entry (`tasks:undo` at the skip's version); the other attendees see 「〇〇さんが読まないにしました」
  (no buttons). The server drops a meeting after 3 days.
- **AI turn**: a meeting the arrivals answer as `asked` by the member (`byYou`) is queued with
  `asked` (`aiTurnQueue`) and runs even while 「自動で進める」 is off — the press is the start
  (`ai-turns.md`). No consultation opens; the hidden run is the existing reading.
- **The card** (`MeetingPanel.tsx` through `RecordCard`'s `renderMeeting`, which hands it the card's
  parts — `MeetingCardParts` — composed in `src/app/meetingCard.tsx` with the tasks feature's
  `MinutesReview`, `onMeetingCard`: no second summary). **Each thing once, in this order** (owner
  2026-11-05, 「ごちゃついてるな」): title, when, people (+ 見られる人); 要約; 決めたこと and **one list**
  「やることの案」 (「やること」 with no proposal left: the proposals with their buttons, put-away ones with
  ［戻す］, then the other tasks made from the meeting, each once; its 「議事録を確認する」 only on the
  right; under it 「＋ やることを足す」 — a task of the meeting made by hand, `tasks-ui.md` "Similar items"), the one-time offer below; ［AI に読ませる］ while arrived / skipped / failed, ［この会議について相談する］ (`chat.consultAbout`;
  the only thing here that opens a consultation), ［招待する］ (`InviteDialog`: choose members; 「招待した人は
  会議の記録と要約・決めたこと・やることを見られます。Google の議事録そのものは、Google で共有されていないと読めません。
  一度招待すると、取り消すことはできません。」) and the 案件 field; then 「つながっているもの」 (the documents
  and the calendar day: 「Google で開く」), 経緯. The offer comes once per meeting (localStorage
  `meeting-auto-offered:<company>`) for a series: 「この定例は次から自動で読みますか？」. No band 「AI が反映
  しました」 here: the chip says it. An older server (no card state): no buttons, plain lists. 見られる人:
  `meetingSeenWords` 「参加者のうち ACB の人 N人・招待した人 N人」 (another place keeps the server's phrase).
- **Linking a 案件** (`src/app/RecordBundleFieldBox.tsx`): one element. While none is linked and the
  server says the member may choose, the field itself asks 「どの〇〇の会議ですか？」 (or 「『…』の会議ですか？」
  with ［はい］［ちがう／選ぶ］), with ［新しい〇〇にする］ and ［〇〇はない（社内の会議など）］; otherwise
  「〇〇 なし」. On a meeting, every way of choosing or making a 案件 here first asks 「〇〇につなぐと、この会議の内容の一部（次のアクションなど）が<その案件の見られる人>に見えます。」
  (`meetingLinkSentence` over `viewers:get` of the 案件); nothing is linked or made before ［つなぐ］.
  Not yet: the list's and the title bar's 「どの〇〇の会議ですか？」 chooser links without this sentence.
- Not built from the demo: the consultation's first answer as the AI's summary; ［部署に出す］ on the card.
- Tests: `client/tests/meetings-app.test.ts` (older server quiet, counts, the card's decisions, the
  press with the session and the runner re-read, NO_ACCESS words, malformed input never sent, the
  words), `src/features/minutes/model.test.ts` (each banner state), `src/features/chat/aiTurns.test.ts`
  (an asked meeting runs while off, nothing else), `client/tests/ui/meetings.spec.ts`
  (`tests/meetings-ui.html`: read → reading → finished → 見る; 読まない + 元に戻す; another attendee's
  view; NO_ACCESS; invite words and the press; consult; the 案件 sentence before the link, ［はい］ too;
  the card's order wide and narrow, each thing once; `?flood=12`:
  two rows, the fold's own scroll, the list's height and scroll also in a short window, ［まとめて読まない］ and its 元に戻す),
  `record-card.spec.ts` (「新しいプロジェクトにする」 on a meeting asks first).

## The text

`GET /api/records-ai/minutes/:recordId/text` (record token, read or act) and the session twin
`GET /api/companies/:id/me/minutes/item/:recordId/text` → `MinutesText`: `{ recordId, version (the
meeting record's version now: the `expectedVersion` of its next action — an unattended run has no
`records_get`), header:
MINUTES_TEXT_HEADER, text, footer, truncated, docVersion, meeting: { title, at }, folder (null for a members-only meeting: its decisions take its list), attendees:
[{ memberId, displayName }], externalAttendees (count only), bundle: { id, type, typeLabel, title,
state, fields, version } | null, candidates: [{ id, title, typeLabel }], instructionLike: [{ label, words }] }`.

- Only for a meeting record the member may read (else the same 404 as a missing record — another
  company's id included) **and** where the member is the assignee or an attendee (else 403
  `MINUTES_NOT_YOURS`).
- Read **now** from Google with the requesting member's own grant: notes first, then the
  transcript, under 「■ 会議メモ」/「■ 文字起こし」; BOM removed, CRLF → LF, NFC; at most
  `MINUTES_TEXT_MAX` characters with a notice. No grant / no access → a clear refusal.
  (`readDocuments`, shared with ［AI に読ませる］'s try.)
- `instructionLike`: `findInstructionLikeText` (`shared/core/instruction-like.ts`, the same copy
  「Web で調べる」 uses; it also flags a line addressed to an AI, 「AI へ：…」). A flag, nothing
  removed. The app's tool puts the header above and the footer below the text, then the
  warning and the structured parts (`minutesReadText`, `client/electron/records/tools.ts`).
- **The block cannot be closed from inside** (`shared/core/outside-text.ts`): the server answers
  `text` with `【】` → `〔〕` (an older app is covered too) and `instructionLike` from
  `outsideTextFlags` (+ `wrapper-spoof` when the text spells a block's marker); the app neutralizes
  again (idempotent, for an older server). `quoteAppearsIn` treats `【】` and `〔〕` alike. Tests:
  `server/tests/integration/minutes.test.ts` (the seeded follow-up notes spell the footer),
  `client/tests/outside-text-entry-points.test.ts`.
- `Cache-Control: no-store`.

### Long minutes (owner report 2026-11-05)

Seen: a 1on1 of about 60,000 characters (1,661 lines) went to 「読めなかった」. One tool result over
Claude Code's `MAX_MCP_OUTPUT_TOKENS` (25,000 tokens by default; Japanese is about one token a
character) is moved to a file, and the unattended run has no tool to open it.

- **The app hands the text on in parts** (`minutes_read { id, part? }`, `minutesReadText`,
  `client/electron/records/tools.ts`): `minutesParts` (`shared/core/minutes.ts`) cuts it on line ends
  into parts of at most `MINUTES_PART_CHARS` (12,000; a line longer than that alone is cut inside).
  Each part is its own block (the server's header and footer, `wrapOutsideText`); the first carries
  the meeting's details (`version`, attendees, candidates…) and the warning over the whole text, a
  later one the warning over its own text; every answer ends with `{ part, parts, more }`. The parts
  come from one read of the turn (kept with the turn's tools, at most `MINUTES_KEPT` meetings; a later
  part asked first reads it again); the まとまり card comes with the first part only. A part past the
  last → an error naming how many. No `part` = the first (and for short minutes the only) part.
- **Longer for such an app**: it asks `GET …/text?paged=1`, and the server answers up to
  `MINUTES_TEXT_PAGED_MAX` (200,000); a document longer than its room keeps its **beginning and its
  end** (`keepHeadAndTail`, `shared/core/minutes.ts`: three quarters head, a quarter tail, cut on line
  ends) with one line in place of the middle saying how much and where
  (「（……ここで N 字（全体のおよそ 40%〜85% のところ）は、長いため省きました……）」). Google sends the whole
  export either way (an answer is at most 12 MB, `google-client.ts`), so this reads no more from
  Google; only Meet's own record (the stand-in transcript) still stops at its bound (its pages are
  read in order). Without `paged` — an older app — `MINUTES_TEXT_MAX` (60,000) as before, end cut, in
  one answer (an older app's own step prompt is its own; nothing changes for it).
- **What the AI is handed depends on its model** (`largeContext` on `createRecordTools`, from
  `modelHasLargeContext` in `client/shared/agents/registry.ts`: the model's `context`; no model = the
  chat default; Sonnet, Haiku, Codex's live catalog and any unknown id count as standard). The text is
  cut once more, the same way, to `MINUTES_READ_CHARS_LARGE` (200,000) on a 1M-token model or
  `MINUTES_READ_CHARS_STANDARD` (60,000) otherwise, before it is split into parts. Why these numbers:
  - The AI turn runs on the member's chosen model (`useAiTurnRunner` → the tab's `modelId`), default
    Opus 5.5 with 1M tokens, but Sonnet / Haiku run as CLI aliases with a 200,000-token window. Every
    part stays in the conversation (the CLI drops nothing until it auto-compacts near the window,
    which would summarise the minutes away mid-reading), so the minutes should stay under about 40%
    of the window: Claude Code's own prompt and the tools, the thinking and every output with its
    quote need the rest. Japanese is up to about 1.3 tokens a character on the newer tokenizers.
  - Standard: 60,000 × 1.3 ≈ 78,000 tokens ≈ 39% of 200,000 (five parts).
  - 1M: the window is not the limit, time and the member's Claude usage are. Each part is one more
    request that re-reads everything before it (cached), and every output after it re-reads the whole
    reading: 200,000 characters ≈ 260,000 tokens (a quarter of the window), ~17 parts, roughly 6
    million cached input tokens a run (about $2–3 at API prices on Opus 5.5) and some ten minutes —
    inside the 30-minute `MINUTES_READING_STALE_MS` with room. Doubling it would roughly triple the
    cost (the re-reading grows with the square) for meetings that do not exist: 200,000 characters
    is over ten hours of talk (about 300 characters a minute), a full-day workshop with its notes fits.
  - The server's bound is the largest an AI is handed, so a longer document's end reaches every model.
- **What could not be read is said, and where**: a skipped middle (the mark, the server's or the
  app's) → the answer tells the AI to make the outputs from what it read and write 「議事録が長すぎて、途中
  （全体のおよそ ◯%〜◯% のところ）を読めませんでした」 with the mark's place in the summary and its request to
  the member; the end cut by the server without a mark (an older server, Meet's record) → 「議事録が長すぎて、
  最後まで読めませんでした」 as before. `truncated` is true in both. A two-pass reading with running notes
  was not chosen: the parts stay in the conversation anyway, so notes save nothing before the CLI
  compacts, and compaction mid-run is the failure this avoids.
- The first message (`minutesFirstMessage`) and the automatic run's rules
  (`autoMinutesFirstMessage`) say to read every part before deciding; the step's tool list is
  unchanged (`minutes_read` with a `part` is the same tool).
- **A meeting that went to 「読めなかった」 before** (`failed`) is read again from its card or the
  banner's row (［AI に読ませる］, 「前回読めず」, "Meetings for their attendees" above) once the app has
  this.
- Tests: `client/tests/records-tools.test.ts` (`minutesParts` boundaries; a 60,000-character text in
  parts, each block on its own and below the limit, one read, the card once, every line once; short
  minutes one part; cut minutes; the step's words; `keepHeadAndTail` (end kept, one mark, line ends,
  the bounds against the windows); a 130,000-character text whole on a 1M model, head + end with the
  skipped part named on a standard one; `modelHasLargeContext`), `server/tests/integration/minutes.test.ts`
  「long minutes」 (`?paged=1` longer, an older app the old bound; past the paged bound the end kept
  with the mark, an older app the beginning only).

### When Google refuses the text (production, 2026-11-05)

Seen: `drive.files.get` answers, `drive.files.export` of the Gemini notes answers 403, for a doc the
owner can download by hand in every format — so not sharing, not a download limit. `files.export`
lists `drive.meet.readonly` among its scopes and Google's announcement says the scope reads and
downloads "files created or edited by Google Meet", but a third party reports Gemini's notes Docs
fail with it (「The user has not granted the app … read access to the file」, `appNotAuthorizedToFile`)
while transcripts work. Confirmed in production (2026-11-05): `appNotAuthorizedToFile` for both documents. Meet's entries
were too rough to stand in (no speaker separation, many mis-conversions), so the Docs API comes first.

- **Three ways, in this order** (`google-meetings.ts` `docText`, owner decision 2026-11-05):
  1. **The Docs API** (`documents.get`, `includeTabsContent`, `documents.readonly`) when the grant has
     the scope; `docsBodyText` makes the body plain text: headings, list items, smart chips, tables
     (cells apart by a tab), every tab and child tab (under 「【タブ名】」 when there are several). `max`
     holds; nothing stored or logged. A Google refusal, no scope, an answer too big or no text → the export.
     Google asking to wait or a 5xx stops the reading (tried later), so it never quietly reads less.
  2. **Drive's export**, the only way before; everything below still applies.
  3. **Meet's record**, the last fallback, under the rule below.
- **The copy block comes before the Docs API**, which does not answer to it as the export does:
  `drive.files.get` asks `copyRequiresWriterPermission` and `capabilities.canDownload`. Set, and the member
  cannot download → refused here as `cannotDownloadFile`. A writer may read. Not said → the export decides,
  never the Docs API on a guess. A block that only the export reports (an admin's rule) cannot be seen
  from the Docs side: `copyRequiresWriterPermission` is the file's own setting.
- **`documents.readonly` reaches any Doc the member can open**: `docText` uses it only for a meeting's
  documents, after `docVersion` (`drive.files.get` under `drive.meet.readonly`) opened them, so 「共有されて
  いません」 stays what it was.
- **A grant without the scope** keeps working by ways 2-3 and the card and 設定 → Google say
  「Google の許可をし直すと、メモも読めるようになります」 (`MyGoogle.renew`, `google-connector.md`).

- **The log**: every refused Google call prints `[google] call refused: … companyId= operation= status=
  reason=` (`google-client.ts`; Google's short code, never its message, which can name the file).
- **`files.get` refused** → 「共有されていません」 as before. Meet's record is never a way around
  sharing: it is tried only for a document Drive opened.
- **One document's export refused** (403/404) does not stop the others: the notes refused, the
  transcript document is still read; the part refused says so in the text (「■ 会議メモ」
  「（Google が文章の取り出しを断ったため…）」), so the AI knows it reads only part.
- **Meet's record stands in only for what ACB is not allowed** (owner decision 2026-11-05): every
  refusal among the documents must be `appNotAuthorizedToFile` / `insufficientPermissions` /
  `insufficientScopes` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (`MEET_RECORD_REASONS`). A copy block
  (`cannotExportFile`, `cannotDownload…`) is the file's owner saying no: one such document, and Meet's
  record is not asked at all, nor for any other reason (an unknown one, the size limit). A document Google
  does export is still read (a block is per file).
- **No transcript came through**, and the rule above allows it → Meet's own record (`transcriptText`, `conferenceRecords.transcripts`
  + `.entries` + `.participants`, `meetings.space.readonly`, already granted; every transcript not
  `STARTED`, also one without a document; 100 entries a page) under 「■ 文字起こし（Google Meet の記録から）」
  as `<name>: <words>`. Kept by Google 30 days after the meeting, may differ a little from the
  document; handed over like the rest, never stored. **Smart notes have no such way**: the Meet API
  gives their metadata and the document's id only.
- **Nothing readable** → `textRefusal`, by reason, a copy block first when the documents differ:
  `exportSizeLimitExceeded` → `MINUTES_TOO_LARGE`; `cannotExportFile` / `cannotDownload…` →
  `MINUTES_TEXT_REFUSED` (「ファイルの持ち主がコピーやダウンロードを止めているため、AI は読めません」); `appNotAuthorizedToFile`
  / `insufficientPermissions` / `insufficientScopes` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` → the same code
  (「いま ACB に許可している範囲では」); anything else the same code, generic. Never 「共有されていません」.
  403 with `rateLimitExceeded` / `userRateLimitExceeded` / `dailyLimitExceeded` → 503 `GOOGLE_UNAVAILABLE`;
  `domainPolicy` / `accessNotConfigured` / `SERVICE_DISABLED` → `GOOGLE_STOPPED` (these two groups in
  `googleRefusal`, for `files.get` too). The app passes the server's sentence on (`memberText`).
- **Not done without the owner**: a wider Drive scope. `drive`, `drive.readonly` stay `GOOGLE_NEVER_SCOPES`.
- Tests: `meeting-attendees.test.ts` 「Drive opens the minutes but refuses their text」 (each
  mutation-checked; fake Google `faults.refuseExport`, `SeedArtifact.entries`), with 「copying blocked by
  the file's owner」 and 「Meet's record stands in only for what ACB is not allowed」; its 「the minutes'
  documents by the Docs API」 (order, fallback, a grant from before, copy block, sharing, switches);
  `server/tests/unit/google-docs-text.test.ts` (the text, each way's choice, the scope's place);
  `minutes.test.ts` 「a reading the AI could not do, then ［AI に読ませる］」 (mutation-checked).

## What is stored, and what never

Stored (the record, server only, members-only — its list in `record_viewers`; meetings made before
2026-11-04 keep the minutes folder): title = the event's title, fields
`meeting_at` and `occurred_at` (the same start time; `occurred_at` is the common outside time,
`records.md` "Outside time"), `assignee` (the reader, once someone asked), `attendees` (JSON of member ids, ≤ 500 characters), `external_count`,
`source_ref` (JSON of Google ids only: conference, event, documents, the recurring series), `doc_version`
(`notes:7,transcript:7`), `summary_text` (the AI's ≤ 300 at the end); links `bundle`, `counterpart`.
Ledger actor of the creation: external `google` (note: which member's calendar).
**Never** stored, logged or answered elsewhere: the notes / transcript text, attendees' email
addresses and names (they are read again from the calendar when needed), Google's tokens.
Log nothing about meetings (titles, emails, text): `logError` only, without them.

## The minutes folder (q14) — no longer used (2026-11-04)

Kept only so older admin consoles keep working; nothing reads it since meetings are seen by their
attendees.

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

## Which meetings (a company setting, owner decision 2026-11-01 night) — no longer gating (2026-11-04)

Still answered and stored; every Meet meeting not marked private is recorded whatever it says.

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
  that opens. The meeting's card (its 案件 field, `RecordBundleFieldBox`, `minutes:bundleQuestion`) offers both while
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
- Meetings are members-only since 2026-11-04 ("Meetings for their attendees"): the intake passes no
  folder, the review task and decisions take the meeting's list, the text answers `folder: null`.
  The app still finds received minutes in 「AI の番」; the banner and the card's buttons: "In the app"
  above.

## Tests

`server/tests/integration/meeting-attendees.test.ts` (the clock finds meetings, one members-only
record per conference, declined / not invited / owner / admin / another company see nothing on any
route, attendees added later join and are told, a private event is never recorded, ［AI に読ませる］ by
an attendee only with reader rotation, ［読まない］, the auto series, the 3-day window, no minutes text
anywhere, the older check and folder route harmless) and
`server/tests/integration/minutes.test.ts` against the fake Google and the fake HubSpot (practice
redirect): every meeting recorded, internal ones too; one
record for two members, the presser assignee; no まとまり linked at intake (one or two candidates), its 相手 is,
only a まとまり can be chosen (a 顧客 is refused); which meetings (owner/admin only, no longer
gating); a meeting made before: only its people press the buttons; the text only
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
