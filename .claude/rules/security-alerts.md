---
paths:
  - "shared/types/security-alerts.ts"
  - "server/src/services/security-alerts.ts"
  - "server/src/routes/security-alerts.ts"
  - "server/src/ports/security-alerts.ts"
  - "server/src/adapters/sqlite/security-alerts.ts"
  - "server/src/db/schema/security-alerts.ts"
  - "server/tests/unit/security-alerts.test.ts"
  - "server/tests/integration/security-alerts.test.ts"
  - "admin/src/app/companies/*/alerts/**"
  - "admin/src/components/security-alerts/**"
---

# 「気になる動き」 (suspicious activity for owners / admins)

Goal: if something goes wrong, an owner notices fast — without noise (the owner dislikes it).
Detection sits on records the server already keeps; the only new records are a per-member
hourly download counter and the alerts themselves.

## Rules (`SECURITY_ALERT_RULES`, `services/security-alerts.ts`)

| kind | found from | when |
|---|---|---|
| `sign_in_failures` | app.ts's Better Auth route (memory, 15 min per account) | 10 wrong passwords in 15 min |
| `sign_in_after_failures` | same | a success after ≥ 5 wrong passwords in 15 min |
| `bulk_download` | `member_download_hours` (git-http counts upload-pack output per member and hour) | last 24 h ≥ 1 GiB **and** ≥ 10× the member's daily average of the 14 days before; not for a member first counted < 7 days ago (a new member's first clone); 「深夜」 when half of it was 0–5 時 company time |
| `push_probing` | `push_rejections` | last hour ≥ 10 refusals **and** ≥ 10 different paths (a stuck sync retries the same ones) |
| `plugin_reads` | `plugin_access_log` (contract 3) | last hour ≥ 300 **and** ≥ 10× the member's hourly average of the 7 days before |
| `plugin_paced` | `plugin_call_paced` | ≥ 100 refused by the pace in the last 2 hours |
| `key_use` | `broker_usage` (the relay, Google relay included; `:refused` counters left out) | today (broker day) ≥ 2000 requests **and** ≥ 5× the member's daily average of the 7 days before |
| `role_raised` | `memberships` (`updated_at`) | someone became owner / admin in the last 24 h (not the founding owner) |
| `company_key_added` | `broker_keys` (`scope = 'company'`) | created in the last 24 h (members' own keys are not reported) |
| `skill_editing_opened` | `skill_editing_settings` | 「全員が直せる」 on, switched in the last 24 h |
| `internal_hosts_added` | `broker_history` (`settings`) | an internal-host exception added in the last 24 h |

- Per-member rules are written once per member and company day (`dedupe_key`); changes once per
  change. A second sweep, a restart or a sweep after downtime adds nothing more.
- Wrong passwords for an address that is no account are not counted (nothing to attribute;
  Better Auth's own rate limit covers them). One IP across accounts is **not** a rule yet: the
  server would need a trusted-proxy setting to know the client's address.
- File API reads (`/files/content`) are not counted (the admin console's reader; the app reads
  its own checkout).

## Where it runs

- The server clock (`notifications.md` "The server clock") calls `securitySweep` for every
  company first, records feature on or off: the rules, then delivery, then pruning (alerts after
  90 days, download hours after 30). Queries are per company through the handle
  (`securityAlerts`, `ports/security-alerts.ts`), aggregate first; a member's baseline is read
  only when the recent count passed the floor.
- On the request path only: one UPSERT per finished fetch (git-http's observer, `sentBytes`) and
  the in-memory sign-in counter (map capped at 10 000 accounts). Both never throw.
- app.ts reads only the `email` of a sign-in body (a clone), after Better Auth answered 200 / 401.

## What is stored and shown

- `security_alerts.facts`: counts and fixed words only (role, service id). **No path, file,
  folder or private-folder name, no secret, no password, no IP.** The Japanese words (title,
  detail, what to do) are built when read (`alertWords`); members are named by account name.
- Owners / admins only: `GET /security-alerts` (30 days, ≤ 100), the home's
  `attention.securityAlerts` (7 days, ≤ 5; a department manager gets `[]`), `PUT
  /security-alerts/settings { slackDm }`. Others 403. The admin console: a card on the home
  (only when there is something), the page `/companies/[id]/alerts` (also linked from 詳しい設定
  › 会社の情報).
- Slack: off by default (`security_alert_settings`). When on, each sweep sends **one** DM per
  owner / admin through the notices' DM (`slack-connector.md` "Notice DMs": only people who
  connected Slack with notices on), naming the first alert and the count. Alerts are marked
  looked-at either way, so turning it on later does not send old ones. No e-mail channel: the
  server has no company mail of its own (outbound mail is members' Gmail drafts).

## Tests

`server/tests/unit/security-alerts.test.ts` (each rule's threshold and its member-normal check,
first download, stuck sync, founding owner, old changes, dedupe, other company, Slack gate and
recipients, who reads, the clock runs the sweep with records off — mutation-checked),
`server/tests/integration/security-alerts.test.ts` (app.ts's sign-in hook through the route and
the home), `git-http-access.test.ts` (a fetch is counted for that member only), permission
matrix rows, `admin-contract.test.ts`, `admin/tests/pages.test.tsx`.
