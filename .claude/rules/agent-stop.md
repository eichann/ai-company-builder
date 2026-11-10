---
paths:
  - "shared/types/agent-stop.ts"
  - "server/src/routes/agent-stops.ts"
  - "server/src/services/agent-stops.ts"
  - "server/src/services/agent-policy.ts"
  - "server/src/services/ai-runs.ts"
  - "server/src/services/record-ai-tokens.ts"
  - "server/src/services/push-channel.ts"
  - "server/src/ports/agent-stops.ts"
  - "server/src/adapters/sqlite/agent-stops.ts"
  - "server/tests/integration/agent-stops.test.ts"
  - "server/tests/integration/broker-stop.test.ts"
  - "client/shared/agent-stop.ts"
  - "client/electron/services/agent-stop.ts"
  - "client/electron/services/agent-push-channel.ts"
  - "client/electron/services/agent-policy-store.ts"
  - "client/tests/agent-stop.test.ts"
  - "admin/src/app/companies/*/advanced/ai-safety/stop/**"
  - "admin/src/components/agent-stop/**"
  - "admin/src/lib/agent-stop.ts"
  - "admin/tests/agent-stop.test.tsx"
---

# Emergency stop (monitoring M2, 「AI の緊急停止」) and the server → app push channel

An owner/admin stops the members' AI in one click: the whole company, one member, or one kind
of tool (command / write / web / external MCP) for everyone or one member. Running conversations
stop at once; new ones are refused. Owner decisions (2026-10-25 / 10-31): only owner/admin stop;
an app that has never received a policy does not stop (it records only), one that has keeps the
last state it received — for conversations, where a person is present. **Runs with no person
present are the opposite** (owner decision 2026-11-09): 「AI の番」 starts only on a stop policy the
server confirmed recently ("No person present" below); the push channel follows 「かもしれない運転」 — the most defensive design,
each rule below with its test. The key broker's 「鍵」 unit stays in 「API キー」
(`POST /broker/stop-all`, `key-broker.md` K5); the stop view shows the keys' state next to it.

## Server

- Tables (`db/schema/agents.ts`, additive): `agent_stops` (id, company, `user_id` NULL = everyone,
  `tool` NULL = the whole AI, reason ≤ 500, stopped at/by, released at/by; never deleted — the
  released rows are the history) and `agent_stop_clients` (company, member → the build of the
  app that last said it follows the stop, when).
- `routes/agent-stops.ts` → `services/agent-stops.ts` → `AgentStopRepository`:
  `GET /agent-stops` (owner/admin) → `{ active, history (≤ 50), unsupported, keys }`;
  `POST /agent-stops { userId?, tool?, reason? }` (owner/admin; the user must be a member; the
  same scope already in force adds nothing); `DELETE /agent-stops/:stopId` (owner/admin;
  releasing a released stop changes nothing). Every stop / release announces on the push channel.
- `GET /me/agent-policy` (`routes/agent-sandbox.ts`, `services/agent-policy.ts`) now carries
  `stop: { all, tools }`, merged for the caller (everyone's stops and their own); the version
  (ETag) hashes sandbox + stop (+ `plugins`, plan C2), so a stop changes it. Sandbox and plugin changes announce too.
- **The key broker** (owner decision 2026-10-31): while a company-wide stop of the whole AI is
  in force (`user_id` NULL, `tool` NULL; `agentStops.companyStopped`), the relay refuses every
  call of that company server-side — so old or modified apps cannot get around it — with 403
  `ACB_STOPPED` 「管理者が AI の利用を一時停止しています。再開されるまで使えません。」, nothing
  forwarded, recorded `stopped`; a release restores it. Narrower stops (a member, a tool kind)
  leave the relay alone; 「すべての鍵を止める」 stays separate. One optional dependency
  (`BrokerRelayDeps.companyStopped`, composed in `composition.ts`), one check after the token is
  validated. Test `server/tests/integration/broker-stop.test.ts` (mutation-checked).
- **A connector's declared reads** (`services/plugin-calls.ts`, `plugins.md` "Contract 3"): an AI's read is
  refused, and ended before its next attempt, by the company's or the member's stop of the whole AI and by a
  stop of the `mcp-external` or `web` kind (`policyFor`), since it reaches a service outside. Test
  `server/tests/integration/plugin-calls.test.ts`.
- **Runs with no person present** (「AI の番」 and a business plugin's `ai_turn` step; `services/ai-runs.ts`,
  `AiRunDeps.aiStops` = `policyFor`): the server is the authority here too, so an app that does not follow
  the stop (older, modified) can neither start one nor go on with one.
  - **Starting**: `POST /ai-run-claims` is refused — before the turn check and the plugin pin, so no record is
    read and nothing is made or pinned (only the member's own open run of that step is looked up, for its
    `refused_stopped` event, once per generation) — while the member's merged policy has the whole AI stopped (the company's or
    theirs) or any of `write` / `web` / `mcp-external` (`STOPS_UNATTENDED_RUN`: each names something an
    unattended run can reach — a plugin step's deliverable files, `web_research`, outside services through
    connectors and plugin operations). Not `command`: no unattended run has a shell (`ai-turns.md`).
  - **A running run is bounded by its token, not its lease.** A run-bound record token's every call is
    refused while the whole AI is stopped for its member (`aiRuns.runStopped`, checked in
    `recordAiTokens.authenticate` after the fence, before any handler — so no write and no idempotency key is
    taken; the run keeps a `refused_stopped` event once per generation, as does the member's own waiting run
    of a refused claim: `ai-turns.md` "Each state change of a run is kept"); the company-wide whole-AI stop already answers 403 `ACB_STOPPED` there first ("Who is acting" in
    `records.md`). The fence itself looks only at state + generation, never the lease's time, and a take-over
    claim is refused during a stop, so the lease bounds nothing here. A **kind** stop does not refuse the
    token: a run's record calls are ACB's own tools (`stoppedKind`: app tools stop only with the whole AI),
    `write` / `web` name tools on the PC that the server never sees, and a connector's read already checks
    `mcp-external` / `web` itself (above); the route table (`shared/core/ai-turn-routes.ts`) does not say
    which route reaches outside, so kind stops are claim-only (a plugin operation's outside write by a run
    started before an `mcp-external` stop is not refused by the server — the app that follows the stop
    refuses that kind in the turn). A consultation's token (no run) is unchanged: someone is present and the
    app stops the conversation.
  - **Renew is not refused**: the lease keeps being extended while stopped, so the PC that holds the run keeps
    it and nobody else (another PC, another step of the record) can claim the record the moment the stop is
    released. Finish, retry and reconcile are never refused (they end or give back). Fencing and the keys are
    unchanged.
  - The answer is **503** `AI_STOPPED` 「管理者が AI の利用を一時停止しています。再開されるまで AI の番は進みません。」
    (no reason, no scope), for the claim and the token alike: released apps read a 5xx claim as
    `unavailable` and try again later, so the record runs by itself once released (a 4xx would mark it
    `taken` at that version until a restart); a record call's 5xx is the tool's failure
    (`SERVER_ERROR`, `client/electron/records/api.ts`), and a run that ends unfinished settles as
    temporary (`UNFINISHED`, tried later).
  - Tests: `server/tests/integration/ai-runs.test.ts` "the emergency stop and runs with no person present"
    (company-wide, one member, the kinds and `command`, the token refused with nothing written or keyed
    while a consultation's token and a kind stop go on, renew extending), `plugin-steps.test.ts` "the
    emergency stop" (a plugin step's claim pins nothing) — mutation-checked (the check after the pin, the
    claim check, the token check, the token check without a run or with kinds, a refused renew, the kinds,
    `command`, the status, `all` ignored).
- **Apps that do not follow the stop** (「停止に対応していないアプリ」): an app that follows it
  sends `X-ACB-Agent-Stop: 1` on `/me/agent-policy` and `/me/events`, recorded with its
  `X-ACB-Client-Version`. A member is counted when `client_activity` has a build for them and it
  is not the build recorded as following (never used the desktop app → not counted; back on an
  old build → counted again). A member with two PCs on different builds may flip; the count is a
  prompt to update, not a guarantee.

## The push channel (`GET /me/events`, text/event-stream)

- Frames: `event: policy` + `data: {"kind":"policy","version":"<32 hex>"}`, sent once at
  connect (the current version, so an app that missed one while disconnected learns it) and on
  every change; `:` heartbeat comments every 25 s (`PUSH_HEARTBEAT_MS`). Since the state engine
  (`records.md`): `event: records` + `{"kind":"records","version":"<fresh 32 hex>"}` to every
  connected member who reads the changed record (`notifications.md` "The push signal";
  `notify(companyId, userIds, event)`; tests `server/tests/unit/push-channel.test.ts`,
  `record-signal.test.ts`). Released apps drop it (unknown kind); the app only
  refetches the policy on `policy` (`client/tests/agent-stop.test.ts`) and, on `records`, asks the
  server again for the member's received minutes (`minutes.md` "The app",
  `client/tests/minutes-app.test.ts`) and 「あなたの番」. Since the notices (`notifications.md`):
  `event: notifications` + `{"kind":"notifications","version":"<fresh 32 hex>"}` to a member whose
  notices or read state changed; the app only asks `/me/notifications` again. Nothing else.
- **No content in an event**: kind + version only — never a reason, name or folder
  (`parsePushEvent` in `shared/types/agent-stop.ts` is the one shape; test "sends only kind +
  version, never the reason or a name").
- **Addressed by company × member**: `services/push-channel.ts` files subscribers by company,
  then member; `announce(companyId, versionFor)` reaches only that company, each member with
  their own version (test "an announcement for one company never reaches another company's
  member").
- **Caps**: `PUSH_MAX_PER_MEMBER` (3) open connections per member and company → 429
  `TOO_MANY_CONNECTIONS`; `PUSH_MAX_TOTAL` (5000). A connection ends after `PUSH_LIFETIME_MS`
  (10 min) and the app reconnects with its session (re-authenticated); a member removed from
  the company hears nothing more (checked at each heartbeat). Tests: the cap, heartbeat,
  removed member, lifetime.
- Session in the Cookie header (never the URL); nothing about it is logged (test "never writes
  the session to the log"); the route stays async (`no-exec-sync.test.ts`), no SQL in the route.
- Proxies: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-store, no-transform`,
  `X-Accel-Buffering: no`. Caddy's `reverse_proxy` flushes event streams immediately by itself;
  no `encode` in front of `/api/*`; a load balancer in front needs an idle timeout > 60 s
  (`docs/self-hosting/README*.md`). The admin's Next proxy (`admin/src/proxy.ts`) is only for
  setups without Caddy; the app talks to the server URL directly.

## The app (main process)

- `services/agent-push-channel.ts` (created in `features/agent-control/wire.ts`): one SSE connection per watched
  company (≤ 5; a company is watched from its first chat turn), opened by main with `fetch`,
  the session in the Cookie header, `X-ACB-Agent-Stop: 1`, `redirect: 'error'`. Its **only
  effect** is `refresh(companyId, version)` → main refetches `/me/agent-policy` unless that
  version is already cached; it has no window, file or command capability. The renderer never
  sees the connection or the session.
- **Unknown / malformed events dropped** (`client/shared/agent-stop.ts` `createSseParser`):
  only `event: policy` with data exactly `{ kind, version }` (hex) counts; another kind, an extra
  field, a mismatched name → dropped and logged by name only; a line over 1 KB ends the
  connection. **https only** (`pushChannelUrl`: plain http only for localhost; no credentials in
  the URL); the address is built from the signed-in server URL.
- No data for 60 s → the connection is dropped; reconnect after 1 s doubling to 60 s, ×0.5–1.5
  jitter (`reconnectDelay`), reset once an event arrived; 404 / 403 → that company is no longer
  watched; sign-out and quit close everything. **Fallback**: `refresh(companyId)` every 60 s
  per watched company, plus at each conversation start.
- `services/agent-policy-store.ts`: parses `stop` (`parseAgentStopPolicy`; unknown kinds
  dropped); the last stop received is kept per account and company in
  `<userData>/agent-policy/<user>/<company>.json` (0600, tmp + rename), read back after a
  restart (offline included). **Never received → nothing stops** in a conversation (an answer
  without `stop` from an older server counts as not received). `onStopChange` listeners run on a
  change. `confirmedWithin(companyId, ms)`: the server answered a policy **with** its stop part in
  this app run, for this account and company, at most `ms` ago (a 200, a 304 for such a policy, or
  a push event naming the version held — `confirmVersion`, through `refreshOnPush` in `wire.ts`);
  memory only, so a stop read back from disk is never a confirmation. Timed on a **monotonic**
  clock (`performance.now`), never the wall clock; a clock that went back counts as not confirmed.
  A policy request is given up after 15 s (`fetchTimeoutMs`), so a hung one cannot hold the check.
- `services/agent-stop.ts` (`createAgentStop`): `prepareTurn(companyId)` (watch, refresh with
  3 s, `refused` = 「管理者が AI の利用を一時停止しています。…」 for a whole-AI stop) and the turn's
  live `toolStopped(category)`; a received whole-AI stop calls the chat server's
  `turns.abort(companyId, 'stopped-by-admin')`: the reply gets 「※ 管理者が停止しました。」
  (text, kept with the conversation) and the transient `data-turn-stopped`, the conversation's
  approval and choice cards are cancelled, the agent stops its usual way.
  `oneShotAiAllowed()` is false while any company the account has kept a stop for is
  whole-AI stopped (these jobs cannot tell their company reliably; stopping more is the safe
  side), and then **no AI outside conversations runs** (owner decision 2026-10-31), each falling
  back quietly: sync's commit message → the fixed text (`services/commit-messages.ts`
  `withStop`); chat titles → `/api/generate-title` answers 503 (the renderer keeps its title);
  voice formatting → the transcript as is (`voice-formatter.ts` `aiAllowed`); hand-off memos →
  the job waits and re-checks every 60 s, no error shown (`handoff/service.ts` `aiAllowed`).
- **No person present** (owner decision 2026-11-09): `stopPolicyConfirmed(companyId)` is true only
  while `confirmedWithin(companyId, STOP_POLICY_FRESH_MS)` (3 minutes) — the policy is refreshed
  every 60 s per watched company and on each push event, so a connected app stays inside it, and
  about three missed checks without the server stop new automatic starts. Unconfirmed → the company is watched and
  the policy asked again (3 s budget; after `STOP_POLICY_RETRY_MS` 10 s, doubling to
  `STOP_POLICY_RETRY_MAX_MS` 2 min, reset by any confirmation), so the runner starts by itself once
  the server answers. Never received, restored from disk only, stale, or an
  older server without `stop` → **no AI turn starts** (`aiTurns:claim` refuses before any server
  call; the runner asks `aiTurns:stopConfirmed` each tick while something could start —
  `mayStartAiTurns`: 自動で進める on or a record the member asked for — and shows 「止める設定をサーバーで確かめ
  られないため、…」, `ai-turns.md`). Conversations are unchanged; a run already going keeps today's
  behaviour (a received stop still ends it). Server-side operations (connectors, key broker,
  outbound gate) were already stopped by the server, and the server refuses the run's claim itself
  ("Runs with no person present" above); this covers local commands and file writes.
- `chat-server.ts`: `prepareAgentStop` before anything else of the turn (403 `AI_STOPPED`),
  `toolStop` into the model request and the API-key tools, and a re-check after the turn is
  tracked (a stop that arrived while it was prepared stops it).
- Per agent (no agent-id branching outside the agents; the stop is a request field):
  Claude — PreToolUse (every permission mode, subagents) and canUseTool refuse a stopped kind
  with `AGENT_STOP_MESSAGES.toolRefused`, also when it was stopped while the member was answering
  an approval; Codex — a stopped kind's approval is declined without asking, one that starts
  anyway (`item/started`) ends the turn (`turn/interrupt` + the sentence); API key — inside the
  tools. Every refusal is logged with decision `stopped` (M1: 「AI の停止中のため拒否」).
- Limits: an AI started outside ACB is not stopped (MDM, phase 2); an older app does not know
  the stop (the admin count); a Claude command already running is cut when the turn stops;
  Codex's interrupt may lag; a stop of one member or one tool kind leaves the AI outside
  conversations running. The reason is never shown to members (owner decision).

Tests `client/tests/agent-stop.test.ts`: only an exact policy event counts and the rest is dropped
(mutation: removing the field check fails it); the session goes in a header and an event can
only cause a refetch; no https → no connection but the 60 s check runs; jittered backoff, idle
drop, 404 stops watching; never received → no stop, the last stop survives a restart per
account (0600); no person present: never received / restored from disk only / stale / an answer
without `stop` → not confirmed, a fresh answer or a push of the held version confirms, an
unconfirmed check asks the server again and resumes by itself, a consultation still runs; a 304
and a push of the held version confirm; per account and company; the monotonic clock (a clock
gone back is not recent); the doubling re-poll wait reset by any confirmation; a hung request
given up (each mutation-checked); a whole-AI stop stops that company's turns only; the fixed commit message, no
title, the raw voice transcript and no hand-off memo while stopped (each mutation-checked);
Claude / Codex / API key refuse a stopped kind and log `stopped`; the chat server refuses a new
turn before any agent starts. `client/tests/agent-tool-events.test.ts`: the stop text and part.

## Admin console (「AI の緊急停止」)

- **On every page** (owner/admin): `components/agent-stop/stop-bar.tsx` at the top of the main
  area (`AppShell`) — 「AI を止める」 and, while something is stopped, 「AI を止めています（N 件）。
  一覧と解除」. The dialog (`stop-dialog.tsx`): だれの AI を (全員 / one member, a native select),
  何を止めるか (AI のすべて (default) / コマンドの実行 / ファイルの書き込み / Web へのアクセス /
  外部の MCP), 理由 (optional, ≤ 500, admins only), a sentence of what will happen, 止める. The
  bar and the page share one query (`agent-stop-context.tsx`, `AgentStopProvider` in
  `AppShell`), so a stop shows on both at once. Members and managers never load it.
- **Page** `admin/src/app/companies/[id]/advanced/ai-safety/stop/page.tsx` (「詳しい設定 › AI の安全 › AI を止める」, owner/admin; the old `/agent-stop` redirects; the only place with 「すべての鍵を止める」):
  いま止めているもの with 解除 (asks first, `ConfirmDialog`), 「停止に対応していないアプリ: N 人」 (names
  and builds behind 「一覧を表示」, 「版は不明」), API キー (counts, 「すべての鍵を止める」 →
  `POST /broker/stop-all` with a confirmation, a link to 「API キー」; shown only while the broker
  is on), これまでの停止と解除. Words: `admin/src/lib/agent-stop.ts` (`Record` per tool kind).
  Types re-exported from `admin/src/lib/api.ts` (`agentStopApi`), pinned by `admin-contract.test.ts`.
- The log shows stopped calls as 「AI の停止中のため拒否」 (decision `stopped`, `agent-events.md`).
  Tests `admin/tests/agent-stop.test.tsx`: owners/admins only and a manager loads nothing; the
  bar stops exactly the chosen member + kind and then shows the stop; the default is everyone +
  the whole AI; a release asks first and sends that stop's id; the unsupported count and names.
