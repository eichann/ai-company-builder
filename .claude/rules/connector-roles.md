---
paths:
  - "shared/core/connector-roles.ts"
  - "server/src/ports/connector-roles.ts"
  - "server/src/services/connector-roles.ts"
  - "server/tests/unit/connector-roles.test.ts"
  - "shared/core/builtin-connectors.ts"
  - "shared/types/core-connectors.ts"
  - "server/src/composition/connectors.ts"
  - "server/src/ports/mail.ts"
  - "server/src/ports/meeting-records.ts"
  - "server/src/services/connector-role-providers.ts"
  - "server/src/services/core-connectors.ts"
  - "server/src/routes/core-connectors.ts"
  - "server/tests/unit/connector-role-providers.test.ts"
  - "server/tests/unit/connector-boundary.test.ts"
  - "admin/src/app/companies/*/integrations/connected-services.tsx"
---

# The core roles (役目) and which connector serves them (stage 3)

The core app asks a core connector (Google Workspace, Microsoft 365, Slack) for a **role**, never
for a service by name. The four roles, their operations and optional capabilities live in one
place, `shared/core/connector-roles.ts` (`CONNECTOR_ROLES`): `calendar` 予定を読む (read),
`mail` メールを読む・送る (read, send), `meetings` 会議の記録を読む (read; optional `transcript`,
`attendees`), `chat` チャットの連絡を受け取る・返す (receive, reply). Drive is not a role: it is a
Google-specific capability a business plugin uses by name. A connector declares what it serves
(`RoleServing`; `roleServingProblems` refuses unknown roles, operations, capabilities, a role
twice); `services/connector-roles.ts` registers connectors (`RoleConnector`: id, servings,
`usable(companyId)` = set up, on, not operator-stopped; a throw counts as not usable) and
resolves with the pure `resolveRole`: the only usable connector serving the role (and
operation), else the admin's choice for the role among the usable ones
(`ConnectorRoleChoiceRepository`; asked once, only when two exist), else `choice-needed` — never
a guess; a chosen connector that is off is not replaced while two remain; a choice is per
company. An optional capability is asked (`hasRoleCapability`), never assumed. Wired in
`composition/connectors.ts` (`wireCoreConnectors`, called once from the Google block of
`composition.ts` before the core services that take the roles; it also returns `inboxSources`,
the Gmail `InboxSource` by connector id, which `wireInboxLane` registers); Slack (A3) is registered in
`wireConnectorsLane` (resolution is per call, so a later registration is in time), which also
builds 「つないでいるサービス」 with both connectors' switches.
Tests: `server/tests/unit/connector-roles.test.ts`.

## Built-in connectors (A1: Google, A3: Slack)

`shared/core/builtin-connectors.ts` (`BUILTIN_CONNECTORS`) declares the core connectors whose
code ships with ACB: id (= the role resolver's connector id and the operator stop file's name),
label, a sentence for the admin, the roles it serves (`RoleServing`) and its **own capabilities**
(not roles; Google: `drive`, which only a business plugin uses by name). They are not packages in
`PLUGINS_DIR`, but are put in and taken out like one, through the connector's existing switches:
the company's on / off (Google: its client's `enabled`) and the operator's stop file
(`<PLUGINS_DIR>/stopped` naming `google` or `*`). Google stays where its code is (`google-*.ts`,
plan §5-2); it registers with `usable` = set up, on, vault on, not operator-stopped
(`googleConnector.usable`). Google serves `calendar` read, `mail` read + send, `meetings` read
(capabilities `transcript`, `attendees`). Slack serves `chat` receive + reply (`slack-connector.md`;
usable = its app set up and on, vault on, not operator-stopped).

The admin's 「つないでいるサービス」 (`services/core-connectors.ts`, `routes/core-connectors.ts`,
owner / admin; members 403): `GET /api/companies/:id/connectors` (`CoreConnectorsView`: each
built-in connector with its status `not-configured` / `off` / `operator-stopped` / `on`, the
roles it serves, its own capabilities; each role with its usable candidates, the admin's choice
and who serves it now), `PUT /connectors/:connectorId/enabled { enabled }` (the connector's own
switch: Google's `setEnabled`, same checks and history), `PUT /connector-roles/:role
{ connectorId | null }` (`connectorRoles.choose`). (`/connector-roles/:role` rather than
`/connectors/roles/:role`: two patterns overlapping there made Hono's router fall back and stop
matching `/api/auth/**` — the permission matrix caught it.) The choice is stored behind the
company handle (`connector_role_choices`, `ConnectorRepository.roleChoice` / `setRoleChoice`,
one history line in `connector_history` with provider `roles`). Screen: admin 「つなぎ先」→
「つないでいるサービス」 (`connected-services.tsx`): each service with its state, what it does
(the roles' labels and its own capabilities), 「<名前> をオフにする / オンにする」; per role the
service that does it, a choice only when two could. No role / connector / plugin words on screen.

## Role providers: how the core services ask

`services/connector-role-providers.ts` (`createRoleProviders(resolver, implementations)`) gives
one provider-neutral port per role, resolving the connector **per call** and handing the call to
that connector's implementation (a connector wired later adds its own with `provide`): `calendar` (`ports/calendar.ts` `CalendarReader`), `meetings`
(`ports/meeting-records.ts` `MeetingRecordsReader`, errors `MeetingReadFailed`), `mailReader`
(`ports/mail.ts` `MailReader`, incl. `getThread`), `mailSender` (`MailSender`, `send(…, { threadId })`),
`chatReader` / `chatSender` (`ports/chat.ts`, Slack: `slack-chat.ts`). No usable connector: the calendar
answers `stopped`, mail reading `stopped`, a send `not-sent` `no-connector` (and `senderAccount`
`unavailable`), meetings throw `not-sent` `no-connector`; two without the admin's choice:
`choice-needed` — nothing is called. Users: 「今日の予定」 (`calendar.md`), the minutes intake
(`minutes.md`), outbound mail (`outbound-mail.md`), and `services.mailReader` for the inbox
(lane B). Google's implementations: `google-calendar.ts`, `google-meetings.ts`, `google-mail.ts`.

**Boundary** (`tests/unit/connector-boundary.test.ts`): no service outside the `google-*.ts`
files imports a Google module (`services/google-*`, `shared/core/google*`,
`shared/types/google*`); a core service takes the role's port. (Provider-neutral member OAuth
compares emails with `normalizeEmail` itself; another connector's own module is listed in the
test with its reason.) Tests: `tests/unit/connector-role-providers.test.ts`
(the one usable connector, none → nothing called, the admin's choice between two),
`tests/integration/google-inbox.test.ts` (「つないでいるサービス」, off serves no role from the
next call).
