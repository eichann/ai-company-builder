---
paths:
  - "client/shared/ai-turns.ts"
  - "client/shared/ai-turn-steps/**"
  - "client/electron/records/tool-providers.ts"
  - "client/tests/ai-turn-steps.test.ts"
  - "client/electron/features/ai-turns/**"
  - "client/src/features/chat/aiTurns.ts"
  - "client/src/features/chat/aiTurns.test.ts"
  - "client/src/features/chat/hooks/useAiTurnRunner.ts"
  - "client/src/features/chat/components/AiTurnNotice.tsx"
  - "client/tests/ai-turn-claims.test.ts"
  - "client/tests/ai-turn-unattended.test.ts"
  - "client/tests/ui/ai-turns.spec.ts"
  - "client/src/features/minutes/startReading.ts"
  - "client/electron/records/runs.ts"
  - "client/src/features/plugin-steps/**"
  - "client/tests/plugin-step-turns.test.ts"
  - "client/electron/features/ai-turns/task-wait-tools.ts"
---

# 「AI の番」 run automatically (stage 2 S10)

A record whose current state has an action with `who` exactly `[ai]` is 「AI の番」 (`records.md`).
Without a person pressing anything, the member's app runs it **on the member's own PC, in the main
window's renderer**, as a hidden consultation that goes through the normal chat pipeline and the
normal history saving (owner decisions 2026-11-01, 節目5 §3–§7). There is **no** AI on the server
and **no** history-writing path in main. Today the one kind is reading a meeting's minutes (a
`meeting` record: received → reading → read, `minutes.md`). There is no 「議事録が届きました」 banner
any more (S11): a received meeting is a row in the task list's 「AI の番」 with its state and, when the
AI has not started it, the person's 「自分で読み取る」 / 「今は読まない」 (`tasks-ui.md` "Minutes and AI
turns").

## Where it runs

- Only while the main window is open — any tab, any consultation shown, behind other apps or
  minimized: the main window has `backgroundThrottling: false` (`electron-adapter.ts`
  `createMainWindowHost`; consultation windows keep the default, `tests/ipc-chat-windows.test.ts`).
  A closed window or a quit app runs nothing (the renderer is gone; main's claim also checks the
  window); reopened, it continues: an interrupted run stays 「読んでいる」 and the existing 30-minute
  rule (`minutes.md` `stale` → `retry`) gives it back.
- The runner is `useAiTurnRunner` (`src/features/chat/hooks/`), called in `ChatPanel.tsx` for the
  pane AppShell hands `aiTurnQueue` to (the main window's main pane; the queue is every waiting record
  whose kind has a step, `aiTurnQueue`, "Steps" below: today main's received minutes). It ticks every 3 s; the rules are pure in
  `src/features/chat/aiTurns.ts`.
- One run = a new tab **behind** the shown one (`useChatTabs` `openBackgroundTab`, never activated),
  handed `ChatInputRequest` `{ kind: 'aiTurn', step, message, title, minutesId, claim }` through
  `inputRequest` (the only request a tab takes while not shown). The tab calls `claim(its own
  conversation id)`; only when that wins does it set the title (「<件名> のあと（M/D）」, kept),
  store `minutesId` and send the first message the claim returns (`minutesFirstMessage` wrapped by
  `autoMinutesFirstMessage`: the app started it, the start is already marked, **the record's
  version after the start** (the claim's `version`), end with finish / fail, retry once with a
  refusal's version). It is listed in 「AIへの相談」 like any open tab (working → 新着).
- **Only the step's tools** (owner decision 2026-11-01, binding): the automatic send carries
  `aiTurnStep` (`ChatRequestOptions`, consumed by that one request — `chatRequestBody.ts`; the
  member's own later messages in that consultation are normal turns). The chat server then gives
  no references, company files, review, web research, choice prompts, steering or suggestions,
  and only the record tools the step declares (its `tools` in `client/shared/ai-turn-steps/<step>.ts`:
  minutes reading = `minutes_read`, `minutes_link_bundle`, the three `meeting__…_reading` actions,
  `records_create`, `decisions_record`, `mail_recipients`, `mail_draft_create` / `update` /
  `show` (long minutes come in parts of one tool, `minutes.md` "Long minutes") — no business plugin's operation: what a まとまり gets from the meeting is the plugin's
  own step, `plugin-steps.md` "After a meeting is read"; anything else is filtered out and refused
  if called). There is deliberately **no `records_get`** (least privilege: the run
  reads only its meeting): the version it acts at comes from the first message, `minutes_read`'s
  answer (`version`), `minutes_link_bundle`'s answer, and a `VERSION_CONFLICT` refusal, which
  carries the record's version now (`refusalForAi`, `records/tools.ts`, for every record tool). Claude Code runs it with `settingSources: []` and
  `strictMcpConfig: true` (none of the member's settings, MCP servers, hooks or plugins, like the
  hand-off agent), `tools: <the step's builtinTools>` (minutes reading: `[]`), a flag-settings deny
  of `CLAUDE_UNATTENDED_DENIED_TOOLS` (shell, web, file writes, subagents) unless declared, and a
  `canUseTool` that refuses — never asks — anything else (`unattended` on `createChatModel`,
  `agents/connection.ts`). Codex and the API-key mode throw on `unattended`, and the chat server
  answers 400 `AI_TURN_NOT_SUPPORTED` for an agent without `recordActions`: a restriction is never
  assumed in force when it is not. Normal consultations are unchanged.
- A run ends when the tab's status (`consultationStatusStore`) leaves working (an approval or a
  question keeps it running); then `aiTurns:settle`.
- **The consultation follows the record's name** (owner FB 2026-11-05): the title is made from the
  record's title when the run starts, and a run may rename its record (a message that came without
  a subject, 「（件名なし）」, gets the AI's short title — `inbox.md`). `aiTurns:settle` answers the
  record's `title` as main last read it; the runner makes the step's title from it and, when it
  differs and the consultation still has the name the runner gave it, renames it through the
  sidebar's 名前を編集 path (`patchChatSession`, `titleAutoGenerated: false`; `retitledConsultation`
  in `aiTurns.ts`). A name the member edited is never overwritten. Every step goes through this;
  today only inbox triage renames its record (follow-up, reply-check and task-wait-over start after
  that, minutes reading keeps the meeting's title). Starting without the placeholder was not chosen:
  the AI's title does not exist before the run reads the thread.

## Steps: one kind per file (`client/shared/ai-turn-steps/`, B3 seam)

- `<step>.ts` declares one kind (`AiTurnStepDefinition`, `types.ts`): the record ids it runs, where
  the runner's queue finds them (`listedBy`: `minutes` = main's received minutes, only while Google
  may read them; `ai-turn` = the task list's 「AI の番」, `turn: 'ai'`), main's `claim` (action, from
  state) and `settle` states (done / couldNot / closed / working, `putBack`), the consultation's
  title and first message (`minutesId` link or not), and its `tools`. Today: `minutes-reading.ts`,
  `inbox-triage.ts` (lane B, B4: an `interaction` in 届いた, `inbox.md`), `follow-up.ts` (lane B,
  B5: a `reply_request` in 準備中 / 確かめ中; `claim.from` may list several states only without a
  start mark, `claimStates`), `reply-check.ts` (lane B, owner FB #19: an `interaction` in
  「返事のあとを確かめる」 after the member's own reply — `inbox_read` and `inbox_reply_check` only,
  `inbox.md`), `task-wait-over.ts` (lane C: a task the clock's 「見込みの日時が過ぎた」 put in 準備中, below). A type with no start mark
  declares `claim.action: null`: the server's execution run is then the only claim (main runs no
  record action and answers the version it read), and `settle.putBack: null` when the working
  state is the claim's own from-state (given back by finishing the run).
- `registry.ts` lists them (one line per step, under the lane markers): `aiTurnStepForRecord(id, state?)`
  (main's claim / settle / retry refuse a record without a step; one kind may have several steps,
  and the record's state — read by main just before the claim and the settle, carried in the
  queue's `state` for the runner — picks the one that starts or works there), `aiTurnStepAllowsRecordTool`
  (the chat server's least-privilege filter), `aiTurnQueue` (AppShell builds the runner's queue
  from the minutes notices and the task list: every waiting record whose kind has a step, once).
  `checkAiTurnSteps` refuses at load a step listed twice, two steps of one kind starting from the
  same state, an id pattern matching any id, or a
  tool that is not one exact tool (an ending must be a whole `__operation`; no wildcard).
- A step gets only its own tools: connectors' tools (`electron/records/tool-providers.ts`, one
  provider per connector, under the lane markers; `createRecordTools` merges them, none
  replacing a record tool or an earlier provider's, a failing one costs only its own; each tool
  declares its plain-Japanese `display`, `chat-ui-and-history.md` 「Tool rows」) reach an
  unattended run only when its step names them. Test: `tests/ai-turn-steps.test.ts`.
- **Outside text in a first message** (`shared/core/outside-text.ts`, the one standard): a record's
  title may be a mail's subject, a Slack message or a calendar invite's title, so every step's first
  message (and `minutesFirstMessage`, `taskConsultFirstMessage`, `taskTopicInstructions`) quotes it
  with `outsideTitle` — one line, `「」` → `『』` and `【】` → `〔〕` inside, ≤ 200 — and says once
  (`OUTSIDE_TITLE_NOTE`) that it is data. Never `「${title}」` by hand. Test:
  `client/tests/outside-text-entry-points.test.ts`.
- **What a step may create** (`CORE_STEP_CREATE_TYPES`, `shared/core/ai-runs.ts`, one copy): inbox
  triage and minutes reading make tasks only; follow-up, reply-check and task-wait-over make
  nothing. The app's filter (`aiTurnStepAllowsRecordCall`, chat server: the step's
  `records_create` schema narrowed by `narrowCreateTypes`, any other type refused before the call)
  and the server (`record-engine/create.ts` `builtInStepRefusal`: an AI token bound to a built-in
  step's run, any other type → 403 `NOT_IN_STEP` before anything is checked) both apply it; a
  business plugin's step keeps its C4 gate. `checkCreateTypes` refuses at load a step missing from
  the table or listing `records_create` against it. Tests: `client/tests/ai-turn-least-privilege.test.ts`,
  `server/tests/integration/plugin-run-gate.test.ts` (mutation-checked).
- **Records read as outside text**: `records_get` / `records_query` / `records_my_turn` /
  `records_ai_turn` (`client/shared/record-outside.ts`) and `task_wait_read` hand a record's title,
  summary and text fields (kind `text` / `long_text`, or unknown) on as `{ outside }`
  (`outsideValue`, `【】` → `〔〕`) with `outsideNote` once and `instructionLike` flags; ids, types,
  states, dates, numbers, choices, people, record links and tags stay plain.
- **Not yet: the server does not scope a built-in step's token to its tools.** Only creates are
  checked there (above); every other records-ai route answers a run-bound token as a
  consultation's, and the app's filter is what keeps a run to its step. Plan: the step lists as
  route ids in `shared/core` (one table the app's steps also read), one records-ai middleware
  mapping each route to its tool id and answering `NOT_IN_STEP` for a run-bound token whose
  built-in step does not list it, and a parity test over every records-ai route.

## Claiming and settling (main, `electron/features/ai-turns/`)

- `aiTurns:claim(companyId, recordId, expectedVersion, conversationId)` — main window only. Main
  first claims the server's **execution run** of the record's step (S10b, below); then it
  opens a record token for **that consultation** (`act`, the configured agent) and runs the type's
  first AI action (its step's `claim.action`: meeting → `start_reading`; a meeting's id is
  `meeting-…`, or `minutes-…` for one made before the type was renamed) at the version **read just
  before** with the session (the notice's `expectedVersion` is only a fallback when unreadable: a
  notice from before a put-back is older than the record, and claiming at it was refused every
  time): the record engine's compare-and-set lets exactly one PC win (`VERSION_CONFLICT` →
  `taken`, never tried again at that version). A record no longer in the claim's from-state
  (`claim.from`: meeting → `received`) is `taken` without claiming a run. When the record
  moved on (that, or a conflict at the start) main re-reads the notices at once
  (`recordMovedOn` → `minutes.recordsSignal`), so this PC stops showing 「AI が読み取る予定です」.
  Answers `{ claimed: true, version }` (the version after the start). The ledger records it as the AI's, pointing at the consultation.
  Refused without a call to the server (`not-allowed`): an agent without `recordActions` (Codex,
  the API key), a closed main window, the emergency stop (`oneShotAiAllowed`), a record kind not
  in the table, a malformed conversation id.
- `aiTurns:settle(companyId, recordId)` — reads the record with the session: `read` → done,
  `failed` / `skipped` → failed, still `reading` → put back to 「AI の番」 so it is not stuck for 30
  minutes: finishing the run as failed does it on the server (`afterFailedRun` in
  `services/ai-runs.ts` → `minutes.putBackAfterRun`, ledger cause `run` with the run's id, never
  the member's); only an older server that leaves it `reading` gets the session's `retry`. It also
  finishes the run (below).
- `aiTurns:retry(companyId, recordId)` — 「もう一度」 also gives the server's run back
  (`POST /ai-runs/:runId/retry`); the runner forgets that it saw the record taken. The runner waits
  for this answer before it clears its hand-off (`giveBack`): a claim that reached the server first
  would be refused and the record marked taken for that version.
- `aiTurns:settings(companyId)` — 「自動で進める」 for **this member** (the AI's turn runs on the
  assignee's PC, owner decision 2026-11-02): their own switch (`GET /me/work-switches`,
  `readOwnAutoRun`; `tasks.md` "Each member's switches") within the company's `autoRun` of S6's
  task settings (`GET /task-settings` with the session: enabled = 使ってよいか, daily limit, stop
  after N failures in a row). `readAutoTurnSettings` checks each value against S6's limits;
  not readable (offline) or missing → **off**: nothing starts on a guess; a server without the
  member's switch (404) → the company's as before. The company default is allowed and each
  member starts on; an admin changes both in the admin console 「やることの一覧」, the member in
  自分の設定.

## Execution runs on the server (S10b, records.md "Execution runs")

The execution state lives on the server; the AI still runs only here.

- **Absence** (`records.md` "Absence and the delegate"): during an absence the server lets the
  delegate's app claim the absentee's AI turns (`aiTurnOf` counts whom the member covers; the run
  uses the delegate's token and permissions, the ledger records `onBehalfOf`). The app's queue
  (`minutes:notices`) does not list the absentee's items yet — not yet wired in the runner.

- **Claim**: `aiTurns:claim` first asks `POST /ai-run-claims { recordId, step:
  <the record's step>, deviceId, conversationId }` (session; the request's
  `X-ACB-Client-Version` names the build, which the server keeps as the run's procedure with the
  plugins on then — `records.md` "Which procedure"). `deviceId` = this app instance
  (`app-<uuid>` per launch, `main.ts`). Another PC holding it, another step of the record holding
  a live claim ("One claim per record" below), or a run waiting for a person or for
  reconciliation → `taken` (the record's action is not run). Then `start_reading` as before; if it
  does not start, the run is finished as temporary (given back for later).
- **The run binds the consultation's tokens**: the claim puts `{ runId, generation }` in the run
  registry (`electron/records/runs.ts`, shared with the records API); `records/api.ts` `openTurn`
  binds every record token of that consultation to the run (the chat server's turns included), so
  the server refuses them once another PC re-claims (fencing, `RUN_SUPERSEDED`). Every write with a
  bound token carries `Idempotency-Key: operationKeyOf(method, path, body)` — the same request
  (a retry, or another PC redoing the step) gets the same key, and the server answers what the
  first one made; the API reads that back (`replayReadPath`: the draft, record, approval or
  plugin operation) so the tools see the same answer, never a second effect.
- **Renewal**: every minute while the run is held (`renewEveryMs`); a 409 (taken over) stops it.
- **Finish** (in `settle`): read → done; the AI's `fail_reading` → `bad-input` (`waiting_person`:
  a person looks); still reading → `temporary` (`UNFINISHED`, retried later; the server sends it
  to a person after three); not readable → temporary. A run with an unknown outside result goes
  to `waiting_reconcile` whatever main says (the server decides).

## The rules (`aiTurns.ts`, per member and company in localStorage `aiTurns:<company>:<user>`)

Checked in this order: setting off → nothing (except a meeting the member asked to be read
themselves: the queue's `asked`, from ［AI に読ませる］ or their own 「次から自動で読む」 series, `minutes.md`
"In the app" — the press is the start; the others' rows still say the setting is off, `autoOff`); nothing waiting → nothing; agent without
`recordActions` → told 「…Claude Code が必要です」 (Codex never starts one); not signed in → told;
stopped after N failures → told, with 「もう一度自動で進める」; Claude's usage limit → paused
until the full window resets (the chat's rate-limit snapshot, `rateLimitsOf('claude-code')`;
not a failure) and told, also with 「もう一度自動で進める」 (owner report 2026-11-05: signed in with
another Claude account, the pause stayed). The pause remembers the time of the snapshot that
caused it (`pauseSeenAt`) and lifts early (`usagePauseLifted`) when a **newer** snapshot is not
rejected (a normal consultation's turn showed room again) or when the chosen AI or its sign-in
changed on this PC; an older snapshot (main's cache, a fetch after a reload) never lifts it. The app
cannot see which Claude account the CLI uses, so a re-login outside the app is noticed through the
next turn's snapshot or the button; a run that hits the limit again simply pauses again. Daily limit → told; one run at a time; at most `AI_TURN_PASS_CAP` (3)
per pass of 10 minutes. Earliest due first, then the oldest meeting. A record is tried at most
twice a day. The notice (`AiTurnNotice.tsx`, top of the chat) is the hook the notifications
foundation (S5) will take over.

## Never silent: each record's state, 「もう一度」 and 「人に渡す」 (owner, 2026-11-01)

Every record waiting in 「AI の番」 has a state with a plain-Japanese reason (`AiTurnItemView` in
`client/shared/ai-turns.ts`, computed by `aiTurnItems`): `running`; `waiting` (its turn, Claude's
usage pause, today's limit, a stop); `not-allowed` (no Claude Code, Codex, not signed in, the
setting off); `failed` (the AI could not finish — handed to the person at once with the reason);
`handed` (given to the person early). The runner reports them through `ChatPanel`'s
`onAiTurnItems` (`AiTurnItemsView`: items + `retry` + `handOver`); AppShell passes them to the
task list's AI-turn rows, which show the state and reason per record (`tasks-ui.md`). Anything stopped offers **「もう一度」** (`retried`: hand-off and today's attempts cleared, a
stop or pause lifted) and **「人に渡す」** (`handedOver`: the AI will not start it; the reason is
kept). Handed early, without waiting for the AI's preparation: a failed run (`recordOutcome`), a
record due within 2 hours that the AI has not started (`handUrgent`), and a running one whose AI
waits for the member's answer (a question or approval: information it lacks). Hand-offs are kept
in the member's log across days until 「もう一度」. For minutes the person is the assignee (the
runner only runs the member's own records), so handing is local: the record stays `received` on
the server and the row's 「自分で読み取る」 is the person's way on — no server-side hand-off action
exists in the minutes type (a type version for it would be a later change).

Sending and approving stay a person's (no change): the AI makes drafts and approval requests only.

### Asked again (production 2026-11-05)

Seen: a meeting whose reading failed (Google refused the text), then ［AI に読ませる］ answered 200 and
the meeting was `received`, but nothing ran and the banner showed the old failure. Two things held
it, each alone enough: this PC's hand-off (kept until 「もう一度」, so `nextAiTurn` never claimed) and
the server's run in `waiting_person` (a claim → `RUN_WAITING` → `taken`).

- **Server** (`aiRuns.askedAgain`, called from the read-request): the reading's open run in
  `waiting_person` / `waiting_setup` / `retry_later` goes to `open`, like 「もう一度」 but whoever's run
  it was (another attendee may press); the same run, so its idempotency keys still answer what was
  made, and the next claim raises the generation. A `running` or `waiting_reconcile` run stays.
- **App** (`askedAgain` in `aiTurns.ts`, each tick): a hand-off from a `failed` outcome whose record
  is back in the queue at a newer version than the run started from (`HandOff.version`) is treated as
  「もう一度」 (`giveBack`). Safe because `failed` means the record left the step's claim states, so
  only a person put it back; the same version is a queue not read again yet, and an `unfinished`
  hand-off (the record never left) still waits for 「もう一度」. A hand-off without a version comes
  from an older build and counts as asked again.
- **An app without this** still shows the old failure after a press; its ［もう一度］ runs the reading.
- **Another turn of the same record** (owner report 2026-11-05: a 返事のお願い sat in 「AI が確かめている」
  for good): a hand-off keeps the record's state it was given in (`HandOff.state`: the run's start state
  in `recordOutcome`, the queue's in `handUrgent`). Back in the queue in **another** state (`movedOn`:
  drafted in 準備中, then the member's reply made it 確かめ中 — a draft run that ended as the reply moved
  it, or one handed for being due soon), it is a new turn and given back (`giveBack`, like 「もう一度」).
  The member's 「人に渡す」 and a hand-off without a state (an older build) stay until 「もう一度」.
- **Due soon, but not this turn's due**: a step may say when the record's due is what its turn races
  (`dueIsTheAisTurn`; absent = always). The queue marks the others `notUrgent` and `handUrgent` never
  hands them early. `follow-up`: only 準備中 not after a wait-over (the first draft) — a check of a reply
  already sent, or a nudge, is past its due by nature and was handed at once.
- **The words**: `FAILED_REASON` no longer says the AI judged (mostly Google refused and the app cannot
  tell); `logForToday` reads the old stored sentence as the new one.

## Tests

`src/features/chat/aiTurns.test.ts` (setting off, Codex, order, one at a time and the pass cap,
daily limit, attempts per record, stop after failures and resume, usage pause, a record whose due is not the turn's never handed early, a hand-off given back when the record waits in another state (never the member's own), the pause resumed by the member and lifted by a newer snapshot or a change of AI but never by an older snapshot, the consultation renamed after its record but never over the member's name, settings values; a meeting asked for again runs, other hand-offs stay; a failure handed with its reason and 「もう一度」, every state has a reason and stopped ones offer both choices, 「人に渡す」, due soon handed early),
`tests/ai-turn-unattended.test.ts` (an unattended run's Claude options: no settings layers, strict
MCP config, no built-in tools, shell / web / write denied, only the record server, everything else
refused even in bypass; a normal turn unchanged; Codex refuses; the minutes step's tool list; the
step rides on one request only), `tests/ai-turn-claims.test.ts` (two PCs → one claim, decided by the server's run, the
winner's token bound to it; writes carry an idempotency key made from the request; a replayed
write is read back, not redone; a run held for a person is not started and 「もう一度」 gives it back;
the run finished with its class; settle answers the record's title; Codex / API key / closed window / stop →
no server call; minutes only; settle puts an unfinished reading back; a notice older than the record
still claims at the version now; a record already finished claims nothing and re-reads the notices;
an unfinished run is put back by the run's finish, not the member's retry), `tests/ai-turn-unattended.test.ts`
also: after earlier put-backs (version > 2) an unattended run finishes without `records_get`
(`minutes_read`'s version, a conflict's version), `tests/ui/ai-turns.spec.ts`
(`chat-header-ui.html?autoturn=1`: claimed with the hidden consultation's id, sent and saved with
its title, `minutesId` and the claim's version in the first message, the shown tab untouched, settled once; `?autoturn=taken` sends nothing;
Codex claims nothing, shows the notice and hands the record over; a failed run shows its reason and 「もう一度」 gives the server's run back and claims again; `?autoturn=asked-again`: an older build's hand-off is given back, the claim after the server's answer).

## A business plugin's steps (plan C5; server side: `plugin-steps.md`)

A step a contract-2 business plugin declares with `start: ai_turn` is a kind made from the server's
answers, not a file of this folder (`client/shared/ai-turn-steps/plugin.ts`: parsers, the tool
ceiling, the first message).

- **Queue**: `usePluginStepTurns` (`src/features/plugin-steps/`) reads `aiTurns:pluginTurns` on
  mount and every minute (main: `GET /me/plugin-step-turns`, remembered per company for the claim);
  AppShell passes them to `aiTurnQueue` (`plugins`), each a candidate with `pluginStep`
  (`<pluginId>__<step>`). An older server or offline: the last list (none at first).
- **Claim** (`claims.ts` `claimPluginStep`): the server's run of `<pluginId>__<step>` is the claim
  (no type action); the claim's `run.procedure.pin` names the pinned procedure; `GET
  /me/plugin-steps/records/:id` gives the step it runs (tools narrowed by the pinned version, the
  procedure file). The text is read on this PC (`procedures.ts`): the pinned package's
  `steps/<name>.md` inside `pluginPackages.folderOf` (only a version this company lists now), or the
  company Skill's `SKILL.md` from the pinned tree (`cat-file blob <tree>:SKILL.md`, no lazy fetch;
  the company folder comes with the claim, validated by `AllowedRoots`). Not on this PC → the run
  is finished `temporary` `PROCEDURE_NOT_HERE` (tried later) and nothing is sent. The claim answers
  `message` (the first message); the runner sends it.
- **Only the step's tools**: main holds the ceiling for that consultation and step
  (`pluginStepTools`); the chat server asks it for a `__` step (`ChatServerConfig.pluginStepTools`)
  and answers 400 `AI_TURN_NOT_SUPPORTED` when main holds none — never unrestricted. The mapping
  (`pluginStepToolAccess`): `records` → the record tools and the record's own type's actions,
  `plugin_operations` → that plugin's operations only, `approvals` / `outbound_draft` → their record
  tools, `web_research` / `files_read` / `files_write` → Claude Code's built-in tools (the rest stay
  denied). The server's C4 gate decides each call too.
- **Settle**: the record left the state it was at when claimed → `done`; still there → `temporary`
  `UNFINISHED` (the server retries later, then a person).
- **A person's start** (`start: person`): a record's card (AppShell, above `RecordCard`) shows
  `PersonStepButtons` (`src/features/plugin-steps/`) for the steps at its state
  (`pluginSteps:onRecord` → `GET /me/plugin-steps/records/:id`, person steps only). Pressing one:
  `pluginSteps:start` (`electron/features/plugin-steps/ipc.ts`; the company folder validated by
  `AllowedRoots` before any server call) → `POST …/start` pins the work's procedure (its first run)
  → main reads the pinned text (`procedures.ts`) → `chat.newConsultation` with that first
  message and `pluginStep`. It is the member's own consultation (their ordinary tools and rights,
  no run), but its plugin power stays the step's: its first request carries `pluginStep`
  (`chatRequestBody.ts`, consumed once) and the chat server has main bind it on the server
  (`bindPluginStep` → `POST /me/plugin-steps/consultations`, `plugin-steps.md`) before any tool
  exists; not bound → 409 `PLUGIN_STEP_NOT_BOUND`, the turn never runs unbound. Not on this PC →
  「まだこの PC にありません」.
- Test: `client/tests/plugin-step-turns.test.ts` (the person steps offered, a person's start's
  message with the pinned procedure, an outside company folder refused before any call, the turns parsed strictly, the claim runs the
  plugin step with the pinned procedure and no type action, the ceiling for that consultation and
  step only, the mapping, a procedure not here gives the run back, the emergency stop calls
  nothing, settle, the procedure file only inside the pinned package / a Skill from the pinned
  tree, the chat server refusing a step main does not hold) — mutation-checked.

## A task's wait that is over (`task-wait-over`, lane C)

- **The clock** (S14, `notifications.md` "The server clock"): a `waiting` task past its
  `wait_until` goes to `preparing` when the assignee's 自動で進める is on, else straight to `todo` (the assignee's
  turn; nothing runs on the PC). Only the first case runs here.
- **Only a task the clock put there**: `enteredByWaitOver` (`shared/core/core-types.ts`: the
  newest state change is the clock's `wait_over`; later field-only entries keep it). The server
  marks such records `waitOver: true` in 「AI の番」 (`records.aiTurn`; the task list's
  `TaskListItem.waitOver`), the step declares `onlyWaitOver` so `aiTurnQueue` skips any other
  準備中 task, and the server's claim of the step `task-wait-over` (`TASK_WAIT_OVER_STEP`) answers
  `NOT_AI_TURN` otherwise (`records.aiTurnOf(member, recordId, step)`). A task a consultation made
  in 準備中 is that consultation's to prepare, never this step's.
- **One claim per record**: a record a business plugin's `ai_turn` step lists (`GET
  /me/plugin-step-turns`) is queued only as that plugin step, never also as a core step
  (`aiTurnQueue`); main's claim already prefers the plugin turn. The server enforces it (the
  authority; the queue is for the experience): `POST /ai-run-claims` refuses while another step of
  the same record holds a live claim (running, lease not expired — `liveOtherStep`,
  `services/ai-runs.ts`), with the plain 409 `RUN_CLAIMED` that names neither that run nor its
  step; once that lease expired the other step may claim. Test: `ai-runs.test.ts` "one run per
  record" (mutation-checked).
- **The run** (no start mark, `claim.from: preparing`; settle `todo` → done, `cancelled` →
  closed, still 準備中 → given back): `task_wait_read` (`electron/features/ai-turns/task-wait-tools.ts`,
  provider under lane C: the task's 待っているもの, 見込み, 期限 and links — `interaction`,
  `counterpart`, `bundle`, `prepared` — only for a task `enteredByWaitOver`; any other record its
  state alone), `inbox_read` on the linked 連絡 (its thread). Then one of: the awaited thing already
  came → `task__finish_prep` saying so; not yet → a nudge as a reply in that thread
  (`mail_recipients` / `mail_draft_create { interactionId }`) and `task__finish_prep` with the draft
  in `links.prepared`; no thread, unreadable, unsure or due soon → `task__hand_over` with a
  one-line note. Its only tools are those six. It never sends; the person checks and sends.
- Tests: `client/tests/ai-turn-steps.test.ts` (queued only with `waitOver`, a plugin step wins,
  the tool list, the first message's three ways, `task_wait_read` in full only after the clock),
  `client/tests/ai-turn-claims.test.ts` (claimed as that step with no record action; settle),
  `server/tests/integration/ai-runs.test.ts` ("a task whose wait is over": listed and claimable
  only after the clock) — mutation-checked.

## Not yet

Other AI-turn kinds (each is one step file, "Steps"); the company setting itself (S6); notifications (S5).
