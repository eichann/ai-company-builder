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
  `show`, and a business plugin's `…__update_deal` / `…__log_meeting`; anything else is filtered
  out and refused if called). There is deliberately **no `records_get`** (least privilege: the run
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

## Steps: one kind per file (`client/shared/ai-turn-steps/`, B3 seam)

- `<step>.ts` declares one kind (`AiTurnStepDefinition`, `types.ts`): the record ids it runs, where
  the runner's queue finds them (`listedBy`: `minutes` = main's received minutes, only while Google
  may read them; `ai-turn` = the task list's 「AI の番」, `turn: 'ai'`), main's `claim` (action, from
  state) and `settle` states (done / couldNot / closed / working, `putBack`), the consultation's
  title and first message (`minutesId` link or not), and its `tools`. Today: `minutes-reading.ts`,
  `inbox-triage.ts` (lane B, B4: an `interaction` in 届いた, `inbox.md`). A type with no start mark
  declares `claim.action: null`: the server's execution run is then the only claim (main runs no
  record action and answers the version it read), and `settle.putBack: null` when the working
  state is the claim's own from-state (given back by finishing the run).
- `registry.ts` lists them (one line per step, under the lane markers): `aiTurnStepForRecord`
  (main's claim / settle / retry refuse a record without a step), `aiTurnStepAllowsRecordTool`
  (the chat server's least-privilege filter), `aiTurnQueue` (AppShell builds the runner's queue
  from the minutes notices and the task list: every waiting record whose kind has a step, once).
  `checkAiTurnSteps` refuses at load a step listed twice, an id pattern matching any id, or a
  tool that is not one exact tool (an ending must be a whole `__operation`; no wildcard).
- A step gets only its own tools: connectors' tools (`electron/records/tool-providers.ts`, one
  provider per connector, under the lane markers; `createRecordTools` merges them, none
  replacing a record tool or an earlier provider's, a failing one costs only its own) reach an
  unattended run only when its step names them. Test: `tests/ai-turn-steps.test.ts`.

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
  (`POST /ai-runs/:runId/retry`); the runner forgets that it saw the record taken.
- `aiTurns:settings(companyId)` — the company's 「自動で進める」: `autoRun` of S6's task settings
  (`GET /task-settings` with the session; `shared/core/task-settings.ts`: enabled, daily limit,
  stop after N failures in a row). `readAutoTurnSettings` checks each value against S6's limits;
  not readable (offline, an older server) or missing → **off**: nothing starts on a guess. The
  company default is on (owner decision); an admin turns it off in the admin console 「やることの一覧」.

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
  (`app-<uuid>` per launch, `main.ts`). Another PC holding it, or a run waiting for a person or for
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

Checked in this order: setting off → nothing; nothing waiting → nothing; agent without
`recordActions` → told 「…Claude Code が必要です」 (Codex never starts one); not signed in → told;
stopped after N failures → told, with 「もう一度自動で進める」; Claude's usage limit → paused
until the full window resets (the chat's rate-limit snapshot, `rateLimitsOf('claude-code')`;
not a failure) and told; daily limit → told; one run at a time; at most `AI_TURN_PASS_CAP` (3)
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

## Tests

`src/features/chat/aiTurns.test.ts` (setting off, Codex, order, one at a time and the pass cap,
daily limit, attempts per record, stop after failures and resume, usage pause, settings values; a failure handed with its reason and 「もう一度」, every state has a reason and stopped ones offer both choices, 「人に渡す」, due soon handed early),
`tests/ai-turn-unattended.test.ts` (an unattended run's Claude options: no settings layers, strict
MCP config, no built-in tools, shell / web / write denied, only the record server, everything else
refused even in bypass; a normal turn unchanged; Codex refuses; the minutes step's tool list; the
step rides on one request only), `tests/ai-turn-claims.test.ts` (two PCs → one claim, decided by the server's run, the
winner's token bound to it; writes carry an idempotency key made from the request; a replayed
write is read back, not redone; a run held for a person is not started and 「もう一度」 gives it back;
the run finished with its class; Codex / API key / closed window / stop →
no server call; minutes only; settle puts an unfinished reading back; a notice older than the record
still claims at the version now; a record already finished claims nothing and re-reads the notices;
an unfinished run is put back by the run's finish, not the member's retry), `tests/ai-turn-unattended.test.ts`
also: after earlier put-backs (version > 2) an unattended run finishes without `records_get`
(`minutes_read`'s version, a conflict's version), `tests/ui/ai-turns.spec.ts`
(`chat-header-ui.html?autoturn=1`: claimed with the hidden consultation's id, sent and saved with
its title, `minutesId` and the claim's version in the first message, the shown tab untouched, settled once; `?autoturn=taken` sends nothing;
Codex claims nothing, shows the notice and hands the record over; a failed run shows its reason and 「もう一度」 gives the server's run back and claims again).

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
- Test: `client/tests/plugin-step-turns.test.ts` (the turns parsed strictly, the claim runs the
  plugin step with the pinned procedure and no type action, the ceiling for that consultation and
  step only, the mapping, a procedure not here gives the run back, the emergency stop calls
  nothing, settle, the procedure file only inside the pinned package / a Skill from the pinned
  tree, the chat server refusing a step main does not hold) — mutation-checked.

## Not yet

Other AI-turn kinds (each is one step file, "Steps"); the company setting itself (S6); notifications (S5).
