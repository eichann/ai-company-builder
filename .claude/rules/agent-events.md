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
---

# AI action log (monitoring M1): server side

The app records one event per tool call (`chat-and-agents.md`, "AI action log"); the server
stores and serves them. Sending from the app is not built yet (PR 3); nothing calls the
ingest in production.

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
(`index.ts`). Version gate placeholder: `AGENT_EVENTS_CLIENT_COMMIT_DATE` = null in
`lib/client-version.ts` until the app's sending merges (PR 4 lists members whose app is older).
