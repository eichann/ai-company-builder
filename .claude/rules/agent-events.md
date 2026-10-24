---
paths:
  - "shared/types/agent-events.ts"
  - "client/shared/agent-events.ts"
  - "server/src/routes/agent-events.ts"
  - "server/src/services/agent-events.ts"
  - "server/src/ports/agent-events.ts"
  - "server/src/adapters/sqlite/agent-events.ts"
  - "server/src/lib/agent-event-retention.ts"
  - "server/tests/unit/agent-events.test.ts"
  - "server/tests/integration/agent-events.test.ts"
  - "client/electron/services/agent-event-sender.ts"
  - "client/tests/agent-event-sender.test.ts"
  - "client/src/lib/agentLogNotice.ts"
  - "client/src/components/chat/AgentLogNotice.tsx"
  - "admin/src/app/companies/*/agent-events/**"
  - "admin/src/components/agent-events/**"
  - "admin/src/lib/agent-events.ts"
  - "admin/tests/agent-events.test.tsx"
---

# AI action log (monitoring M1): sending, the server side, the admin page

The app records one event per tool call (`chat-and-agents.md`, "AI action log"), sends them
(below), the server stores and serves them, and the admin console shows them (last section).

## Sending from the app (`client/electron/services/agent-event-sender.ts`)

The recorder's sink, created in `main.ts` (tests `client/tests/agent-event-sender.test.ts`, fake
clock + fake fetch).

- **Whose events**: `services/session.ts` `userId()` is the account /api/me confirmed for the
  current cookies (set in `auth:getSession`, which the renderer calls after every sign-in and at
  start; new cookies forget it). An event is filed under the account signed in when its turn
  first reported (`turnId` → account, so a turn never changes account); no account or no
  `companyId` → dropped (counted, logged once). A queue is sent only while its own account is
  signed in, with that account's cookie; another account's queue waits on disk.
- **Disk**: `<userData>/agent-events/<user>/<company>.jsonl` (ids percent-encoded, dirs 0700,
  files 0600), one `{ t, e }` line per event. Appends batched (1 s) and async; after a send the
  file is rewritten (tmp + rename, removed when empty). A torn / unreadable line is skipped and
  the file rewritten. ≤ 10 MB and 7 days per queue, oldest dropped (counted, logged). Quit
  (`will-quit` → `flushSync`): timers stop, the in-memory part is written synchronously; while an
  async read/write of the queue may still land, the whole queue goes to `<company>.jsonl.quit`,
  merged (dedupe by id) at the next start.
- **Schedule** (owner decision: not every few seconds, for app and server load): every 60 s
  while events wait (`AGENT_EVENTS_SEND_INTERVAL_MS`; never with an empty queue), 2 s after each
  chat turn ends (`onChatActivity(…, false)` in `features/chat/server-config.ts` → recorder
  `turnEnded()` → sink `turnEnded`; the delay lets the turn's closing events land), at once for
  a full batch (200) or for events left from before at sign-in. A turn end never jumps a backoff.
  The log is for looking back; the emergency stop (M2) does not depend on this path.
- **Sending**: ≤ 200 per POST (and ≤ 900 KB); one request per queue. 2xx → removed (the
  server's `rejected` count is logged); 401 → kept until `sessionStarted` (next sign-in);
  404 `Company not found or access denied` → queue and file deleted (any other 404 = older
  server: retry in 5 min); 400 / 413 → batch halved, a single refused event dropped; 429 →
  `Retry-After`; network / 5xx / other → 10 s doubling to 5 min. Sign-out stops sending (queues
  kept). Logs counts and status codes only.
- **Telling the member** (owner decision): `src/lib/agentLogNotice.ts` holds the sentence; the
  chat shows `AgentLogNotice` once per account on this PC (localStorage
  `acb.agentLogNoticeSeen:<userId>`; non-modal `role="dialog"`, OK focused, Esc closes), and
  the settings nav always shows the sentence. Spec `client/tests/ui/agent-log-notice.spec.ts`
  (`chat-header-ui.html?notice=1`; the other previews mark it seen).

## Contract

`shared/types/agent-events.ts` is the one copy: `AgentToolEvent` (what the app sends; the client
re-exports it from `client/shared/agent-events.ts`, and `agent` is checked against the app's
`AuthMode` by the compiler), `parseAgentToolEvent` (the server's per-event validation:
required fields must be valid or the event is rejected, an invalid optional value is dropped,
unknown fields dropped, paths NFC; `client/tests/agent-events.test.ts` feeds the tracker's
events through it), the read shapes and the limits. The admin re-exports the read types from it
(`admin/src/lib/api.ts` `agentEventsApi`), pinned by `admin-contract.test.ts`.

## Endpoints (`routes/agent-events.ts` → `services/agent-events.ts`, under `/api/companies/:id`)

- `POST /agent-events` `{ events }`: any member; user = the session's, never the body's;
  ≤ 200 events (413 `TOO_MANY_EVENTS`), body ≤ 1 MB; 3,000 events per member per 10 minutes
  (in memory, 429 `RATE_LIMITED` + `Retry-After`); `(company, id)` unique, so re-sends count as
  `duplicates`; `at` outside [now − 8 days, now + 5 min] is stored as `received_at`
  (`at_adjusted`, `client_at` keeps the app's); the app build from `X-ACB-Client-Version`.
  → `{ accepted, duplicates, rejected }`. Contents are never logged.
- `GET /agent-events?from&to&userId&category&decision&conversationId&q&cursor&limit` (newest
  first, `at` then `seq`; opaque cursor `<at>_<seq>`), `GET /agent-events/summary?from&to&tzOffsetMinutes`
  (per member and day: total, denied, by category; default the last 30 days, ≤ 400).
- `GET|PUT /agent-events/settings` (owner/admin): `retentionDays` 7–3650 (default 180),
  `viewers` `admins` (default) | `admins-and-managers`; every change writes
  `agent_event_settings_history` (who, when, before → after), the GET carries the latest 20.
  `GET …/settings/retention-preview?days=N` → `{ days, olderThan, wouldDelete }`;
  `GET /agent-events/viewers?mode=` → who would see the log (`all`, or `departments` with names).

## Who reads what

- Owner/admin: everything. Members: 403. A department manager: only while `viewers` is
  `admins-and-managers`, and then only events whose `department` (the chat's active department)
  or a file in whose target lies in a department they manage (first path segment, NFC + A–Z
  folded, stored at ingest as `department_key` / `target_roots`; a renamed department's older
  events stay under the old name).
- For a manager every path they cannot read (`resolveAccess`: a private folder they are not a
  viewer of, a folder closed to them) becomes `{ kind: 'hidden' }` (no path, no name), the
  department too, and the target search (`q`, SQL `LIKE` over the full target) is re-checked
  on the masked target, so a hidden name never matches.

## Retention

`prune()` deletes events older than each company's retention in chunks of 500, yielding to the
event loop between chunks; `lib/agent-event-retention.ts` runs it 5 s after start and daily
(`index.ts`). Version gate: `AGENT_EVENTS_CLIENT_COMMIT_DATE` in `lib/client-version.ts` is
the committer date (UTC) of #206's merge commit, `20261024181341`; the admin log page lists the
members whose app is older.

## Admin console (「AI の操作の記録」, `admin/src/app/companies/[id]/agent-events/page.tsx`)

- **Navigation**: `NAV_ITEMS` entry `agent-events`, shown when `isAdmin || canViewAgentEvents`.
  `GET /me/capabilities` carries `canViewAgentEvents` (`agentEvents.canRead(member)`, composed
  in `routes/permissions.ts`: owner/admin, or a manager while `viewers` is
  `admins-and-managers`); the context falls back to the role until capabilities arrive. A
  member who opens the URL anyway gets 403 from the list → a plain empty state.
- **Words**: `admin/src/lib/agent-events.ts` holds every label as `Record<enum, …>` (category,
  decision + tone, guard reason, agent, outcome, sensitive place, viewer mode), the target
  description (`hidden` → 「非公開（表示できません）」, `outside` → 「会社フォルダの外」 + the
  secret place's kind), the URL filters and the periods. A new enum value in
  `shared/types/agent-events.ts` without a label fails the compiler and
  `admin/tests/agent-events.test.tsx`. The console says 「部署の責任者」 for managers, as everywhere
  else in the admin.
- **Log tab** (`components/agent-events/log-view.tsx`): filters in the URL (`period` today / 7d
  (default) / 30d / custom with `from`/`to` days, `member`, `category`, `decision`, `q`,
  `conversation`) so a view can be shared; periods are whole local days. Rows newest first,
  「もっと見る」 follows `nextCursor`. 「この会話の流れ」 sets `conversation`: only that filter is
  sent (no period), shown oldest first. Summary strip from `/summary` with the browser's
  `tzOffsetMinutes`. 「記録を送っていないアプリ」 (owner/admin): members whose
  `GET /client-activity` row has `supportsAgentEvents: false` (`lib/client-version.ts`
  `supportsAgentEvents`: build older than `AGENT_EVENTS_CLIENT_COMMIT_DATE`, or unknown).
- **Settings tab** (owner/admin, `?tab=settings`, `components/agent-events/settings-view.tsx`):
  retention 30 / 90 / 180 / 1年 / custom (7–3650), viewers as two radio cards each with its
  live `GET /viewers?mode=` list (shown for the selected card, and for the other on hover /
  focus). Changes are a draft; the bar lists them (「保存期間: 180日 → 90日」) and 保存 sends only
  what changed. A shorter retention first asks `retention-preview` and confirms 「N日より前の記録
  N 件が消えます。よろしいですか？」. History from the settings' `history`.
