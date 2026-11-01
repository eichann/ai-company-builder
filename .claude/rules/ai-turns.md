---
paths:
  - "client/shared/ai-turns.ts"
  - "client/electron/features/ai-turns/**"
  - "client/src/features/chat/aiTurns.ts"
  - "client/src/features/chat/aiTurns.test.ts"
  - "client/src/features/chat/hooks/useAiTurnRunner.ts"
  - "client/src/features/chat/components/AiTurnNotice.tsx"
  - "client/tests/ai-turn-claims.test.ts"
  - "client/tests/ai-turn-unattended.test.ts"
  - "client/tests/ui/ai-turns.spec.ts"
  - "client/src/features/minutes/components/MinutesNotices.tsx"
---

# 「AI の番」 run automatically (stage 2 S10)

A record whose current state has an action with `who` exactly `[ai]` is 「AI の番」 (`records.md`).
Without a person pressing anything, the member's app runs it **on the member's own PC, in the main
window's renderer**, as a hidden consultation that goes through the normal chat pipeline and the
normal history saving (owner decisions 2026-11-01, 節目5 §3–§7). There is **no** AI on the server
and **no** history-writing path in main. Today the one kind is minutes 「読む」 (received → reading →
read, `minutes.md`); the 「議事録が届きました」 notice stays as the fallback (removing it is S11).

## Where it runs

- Only while the main window is open — any tab, any consultation shown, behind other apps or
  minimized: the main window has `backgroundThrottling: false` (`electron-adapter.ts`
  `createMainWindowHost`; consultation windows keep the default, `tests/ipc-chat-windows.test.ts`).
  A closed window or a quit app runs nothing (the renderer is gone; main's claim also checks the
  window); reopened, it continues: an interrupted run stays 「読んでいる」 and the existing 30-minute
  rule (`minutes.md` `stale` → `retry`) gives it back.
- The runner is `useAiTurnRunner` (`src/features/chat/hooks/`), called in `ChatPanel.tsx` for the
  pane AppShell hands `aiTurnQueue` to (the main window's main pane; the queue is main's received
  minutes, `minutes:notices`). It ticks every 3 s; the rules are pure in
  `src/features/chat/aiTurns.ts`.
- One run = a new tab **behind** the shown one (`useChatTabs` `openBackgroundTab`, never activated),
  handed `ChatInputRequest` `{ kind: 'aiTurn', step, message, title, minutesId, claim }` through
  `inputRequest` (the only request a tab takes while not shown). The tab calls `claim(its own
  conversation id)`; only when that wins does it set the title (「<件名> のあと（M/D）」, kept),
  store `minutesId` and send the first message (`minutesFirstMessage` wrapped by
  `autoMinutesFirstMessage`: the app started it, the start is already marked, end with
  finish / fail). It is listed in 「AIへの相談」 like any open tab (working → 新着).
- **Only the step's tools** (owner decision 2026-11-01, binding): the automatic send carries
  `aiTurnStep` (`ChatRequestOptions`, consumed by that one request — `chatRequestBody.ts`; the
  member's own later messages in that consultation are normal turns). The chat server then gives
  no references, company files, review, web research, choice prompts, steering or suggestions,
  and only the record tools the step declares (`AI_TURN_STEPS` in `client/shared/ai-turns.ts`:
  minutes reading = `minutes_read`, `minutes_link_deal`, the three minutes actions,
  `records_create`, `decisions_record`, `mail_recipients`, `mail_draft_create` / `update` /
  `show`, and a business plugin's `…__update_deal` / `…__log_meeting`; anything else is filtered
  out and refused if called). Claude Code runs it with `settingSources: []` and
  `strictMcpConfig: true` (none of the member's settings, MCP servers, hooks or plugins, like the
  hand-off agent), `tools: <the step's builtinTools>` (minutes reading: `[]`), a flag-settings deny
  of `CLAUDE_UNATTENDED_DENIED_TOOLS` (shell, web, file writes, subagents) unless declared, and a
  `canUseTool` that refuses — never asks — anything else (`unattended` on `createChatModel`,
  `agents/connection.ts`). Codex and the API-key mode throw on `unattended`, and the chat server
  answers 400 `AI_TURN_NOT_SUPPORTED` for an agent without `recordActions`: a restriction is never
  assumed in force when it is not. Normal consultations are unchanged.
- A run ends when the tab's status (`consultationStatusStore`) leaves working (an approval or a
  question keeps it running); then `aiTurns:settle`.

## Claiming and settling (main, `electron/features/ai-turns/`)

- `aiTurns:claim(companyId, recordId, expectedVersion, conversationId)` — main window only. Main
  opens a record token for **that consultation** (`act`, the configured agent) and runs the type's
  first AI action (`AI_TURN_CLAIM_ACTIONS`: minutes → `start_reading`) at the version the app saw:
  the record engine's compare-and-set lets exactly one PC win (`VERSION_CONFLICT` → `taken`, never
  tried again at that version). The ledger records it as the AI's, pointing at the consultation.
  Refused without a call to the server (`not-allowed`): an agent without `recordActions` (Codex,
  the API key), a closed main window, the emergency stop (`oneShotAiAllowed`), a record kind not
  in the table, a malformed conversation id.
- `aiTurns:settle(companyId, recordId)` — reads the record with the session: `read` → done,
  `failed` / `skipped` → failed, still `reading` → `retry` (the assignee's own action) so it is not
  stuck for 30 minutes.
- `aiTurns:settings(companyId)` — the company's 「自動で進める」: `autoRun` of S6's task settings
  (`GET /task-settings` with the session; `shared/core/task-settings.ts`: enabled, daily limit,
  stop after N failures in a row). `readAutoTurnSettings` checks each value against S6's limits;
  not readable (offline, an older server) or missing → **off**: nothing starts on a guess. S6's
  default is off, so an admin turns it on (admin console 「やることの一覧」).

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
minutes notice, which shows the state and reason per record (the task list will take the same
view). Anything stopped offers **「もう一度」** (`retried`: hand-off and today's attempts cleared, a
stop or pause lifted) and **「人に渡す」** (`handedOver`: the AI will not start it; the reason is
kept). Handed early, without waiting for the AI's preparation: a failed run (`recordOutcome`), a
record due within 2 hours that the AI has not started (`handUrgent`), and a running one whose AI
waits for the member's answer (a question or approval: information it lacks). Hand-offs are kept
in the member's log across days until 「もう一度」. For minutes the person is the assignee (the
runner only runs the member's own records), so handing is local: the record stays `received` on
the server and the notice's 「読み取る」 is the person's way on — no server-side hand-off action
exists in the minutes type (a type version for that is S11 work).

Sending and approving stay a person's (no change): the AI makes drafts and approval requests only.

## Tests

`src/features/chat/aiTurns.test.ts` (setting off, Codex, order, one at a time and the pass cap,
daily limit, attempts per record, stop after failures and resume, usage pause, settings values; a failure handed with its reason and 「もう一度」, every state has a reason and stopped ones offer both choices, 「人に渡す」, due soon handed early),
`tests/ai-turn-unattended.test.ts` (an unattended run's Claude options: no settings layers, strict
MCP config, no built-in tools, shell / web / write denied, only the record server, everything else
refused even in bypass; a normal turn unchanged; Codex refuses; the minutes step's tool list; the
step rides on one request only), `tests/ai-turn-claims.test.ts` (two PCs → one claim; Codex / API key / closed window / stop →
no server call; minutes only; settle puts an unfinished reading back), `tests/ui/ai-turns.spec.ts`
(`chat-header-ui.html?autoturn=1`: claimed with the hidden consultation's id, sent and saved with
its title and `minutesId`, the shown tab untouched, settled once; `?autoturn=taken` sends nothing;
Codex claims nothing, shows the notice and hands the record over; a failed run shows its reason and 「もう一度」 claims again).

## Not yet (S11 and later)

The notice is not removed and the deal choice still waits for the member in the consultation
(S11 moves 「どの案件か」 to あなたの番); other AI-turn kinds (each needs its claim action in
`AI_TURN_CLAIM_ACTIONS` and its first message); the company setting itself (S6); notifications (S5).
